import { useCallback, useEffect, useRef, useState } from "react";
import { Radio } from "lucide-react";
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
		</div>
	);
}
