import { useCallback, useEffect, useRef, useState } from "react";
import { Radio } from "lucide-react";
import toast from "react-hot-toast";
import { useTranslation } from "react-i18next";
import { ToggleRow } from "../ui/toggle-row";
import {
	BACKGROUND_EXECUTION_EVENT,
	backgroundExecutionResponse,
	backgroundExecutionStatus,
	cachedBackgroundExecutionState,
	mayHaveBackgroundExecution,
	requestBackgroundExecutionState,
	setBackgroundExecution,
} from "../../utils/backgroundExecution";
import { backgroundTimeline, describeBackgroundTrace } from "../../utils/backgroundTrace";
import {
	BACKGROUND_REPORT_EVENT,
	backgroundReportStartedAt,
	backgroundReportSummary,
	backgroundReportText,
	resetBackgroundReport,
} from "../../services/backgroundReportStore";

/** The day report: one line on screen, the full text copied for whoever fixes the app. */
function BackgroundReportSection({ detail }: { detail: string }) {
	const { t, i18n } = useTranslation();
	const [, setRevision] = useState(0);
	useEffect(() => {
		const refresh = () => setRevision((value) => value + 1);
		window.addEventListener(BACKGROUND_REPORT_EVENT, refresh);
		return () => window.removeEventListener(BACKGROUND_REPORT_EVENT, refresh);
	}, []);
	const summary = backgroundReportSummary();
	const since = new Date(backgroundReportStartedAt()).toLocaleString(i18n.language, {
		weekday: "short",
		hour: "2-digit",
		minute: "2-digit",
	});
	const copy = async () => {
		try {
			const version = import.meta.env.VITE_APP_VERSION;
			await navigator.clipboard.writeText(
				backgroundReportText([`app ${version ?? "?"} · ${detail}`]),
			);
			toast.success(t("behavior.background_report_copied"));
		} catch {
			toast.error(t("behavior.background_report_copy_failed"));
		}
	};
	return (
		<div className="border-t border-[var(--border)] px-4 py-3.5 text-xs text-[var(--text-muted)]">
			<p className="font-semibold text-[var(--text)]">{t("behavior.background_report_title")}</p>
			<p className="mt-1">
				{summary.locks === 0
					? t("behavior.background_report_empty")
					: t("behavior.background_report_summary", {
							since,
							messages: summary.messages,
							onTime: summary.onTime,
							late: summary.late.length,
							missed: summary.missedByLive + summary.lostAfterLive,
						})}
			</p>
			<div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
				<button type="button" className="font-semibold text-[var(--accent)]" onClick={() => void copy()}>
					{t("behavior.background_report_copy")}
				</button>
				<button
					type="button"
					className="underline"
					onClick={() => {
						resetBackgroundReport();
						setRevision((value) => value + 1);
					}}
				>
					{t("behavior.background_report_reset")}
				</button>
			</div>
		</div>
	);
}

export function BackgroundExecutionCard() {
	const { t } = useTranslation();
	const [state, setState] = useState(cachedBackgroundExecutionState);
	const [pending, setPending] = useState(true);
	const [timedOut, setTimedOut] = useState(false);
	const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);
	const beginRequest = useCallback(() => {
		if (timeout.current) clearTimeout(timeout.current);
		setPending(true);
		setTimedOut(false);
		timeout.current = setTimeout(() => {
			setPending(false);
			setTimedOut(true);
		}, 5000);
	}, []);

	useEffect(() => {
		if (!mayHaveBackgroundExecution()) return;
		const receive = (event: Event) => {
			const report = backgroundExecutionResponse(
				(event as CustomEvent<unknown>).detail,
			);
			if (timeout.current) clearTimeout(timeout.current);
			setState(report);
			setPending(false);
			setTimedOut(false);
		};
		window.addEventListener(BACKGROUND_EXECUTION_EVENT, receive);
		beginRequest();
		requestBackgroundExecutionState();
		return () => {
			window.removeEventListener(BACKGROUND_EXECUTION_EVENT, receive);
			if (timeout.current) clearTimeout(timeout.current);
		};
	}, [beginRequest]);

	if (!mayHaveBackgroundExecution()) return null;
	return (
		<div
			id="behavior-background-execution"
			className="surface-card overflow-hidden"
		>
			<fieldset disabled={pending || !state?.supported}>
				<ToggleRow
					icon={<Radio className="h-5 w-5" />}
					iconClass="bg-sky-500/15 text-sky-400"
					label={t("behavior.background_execution")}
					description={t("behavior.background_execution_desc")}
					checked={state?.enabled ?? false}
					onChange={(enabled) => {
						if (pending) return;
						beginRequest();
						setBackgroundExecution(enabled);
					}}
				/>
			</fieldset>
			<p className="px-4 pb-3.5 text-xs text-[var(--text-muted)]" role="status">
				{t(`behavior.${backgroundExecutionStatus(state, pending, timedOut)}`)}
			</p>
			{/* While enabled, the details say what holds the app (sound, page, storage). */}
			{!pending && (timedOut || state?.failure || !state?.supported || (state?.enabled && state.detail)) && (
				<div className="px-4 pb-3.5 text-xs text-[var(--text-muted)]">
					<button type="button" className="underline" onClick={() => {
						beginRequest();
						requestBackgroundExecutionState();
					}}>{t("behavior.background_execution_retry")}</button>
					<details className="mt-2">
						<summary>{t("behavior.background_execution_details")}</summary>
						<p className="mt-1 break-words select-text">
							{timedOut ? "native-response-timeout" : [state?.failure || (state?.enabled ? "" : "unsupported"), state?.detail,
								state?.systemVersion && `iOS ${state.systemVersion}`].filter(Boolean).join(" · ")}
						</p>
						{describeBackgroundTrace() && (
							<p className="mt-1 break-words select-text">{describeBackgroundTrace()}</p>
						)}
						{/* One line per event while away: the time tells which part stopped. */}
						{backgroundTimeline().length > 0 && (
							<ol className="mt-2 space-y-0.5 font-mono text-[11px] leading-4 select-text">
								{backgroundTimeline().map((line, index) => (
									<li key={index}>{line}</li>
								))}
							</ol>
						)}
					</details>
				</div>
			)}
			{state?.enabled && (
				<BackgroundReportSection
					detail={[state.detail, state.systemVersion && `iOS ${state.systemVersion}`].filter(Boolean).join(" · ")}
				/>
			)}
		</div>
	);
}
