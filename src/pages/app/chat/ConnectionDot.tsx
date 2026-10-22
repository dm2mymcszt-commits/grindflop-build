import { X } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { BottomSheet } from "../../../components/ui/bottom-sheet";
import {
	getConnectionLogSnapshot,
	subscribeConnectionLog,
} from "../../../services/connectionLog";
import type { RealtimeStatus, RealtimeStatusReason } from "../../../types/chat-realtime";
import {
	episodeEnd,
	type ConnectionColor,
	type ConnectionEpisode,
} from "../../../utils/connectionLogRules";

/**
 * The live-connection dot next to the Inbox title. Green, orange or red as
 * before; when the colour changes it says what the new colour means, and a
 * tap opens what each colour means plus the history of changes.
 */

const DOT_COLORS: Record<ConnectionColor, string> = {
	green: "oklch(0.72 0.18 142)",
	orange: "oklch(0.75 0.17 75)",
	red: "oklch(0.65 0.22 25)",
};

const CALLOUT_MS = 12_000;

function colorName(t: TFunction, color: ConnectionColor): string {
	switch (color) {
		case "green":
			return t("chat.realtime.color_green");
		case "orange":
			return t("chat.realtime.color_orange");
		case "red":
			return t("chat.realtime.color_red");
	}
}

function colorMeaning(t: TFunction, color: ConnectionColor): string {
	switch (color) {
		case "green":
			return t("chat.realtime.meaning_green");
		case "orange":
			return t("chat.realtime.meaning_orange");
		case "red":
			return t("chat.realtime.meaning_red");
	}
}

function statusLabel(t: TFunction, status: RealtimeStatus): string {
	switch (status) {
		case "connected":
			return t("chat.realtime.connected");
		case "connecting":
			return t("chat.realtime.connecting");
		case "reconnecting":
			return t("chat.realtime.reconnecting");
		case "polling":
			return t("chat.realtime.polling");
		case "idle":
			return t("chat.realtime.idle");
		case "disconnected":
			return t("chat.realtime.offline");
		case "error":
			return t("chat.realtime.error");
	}
}

function withDetail(text: string, detail: string | undefined): string {
	return detail ? `${text} (${detail})` : text;
}

function reasonText(t: TFunction, reason: RealtimeStatusReason): string {
	switch (reason.kind) {
		case "starting":
			return t("chat.realtime.reason_starting");
		case "opened":
			return t("chat.realtime.reason_opened");
		case "closed":
			// 1006 is what a socket reports when it dropped without any close
			// message — a network cut or a refused handshake, not Grindr saying no.
			return withDetail(
				reason.code === 1006
					? t("chat.realtime.reason_closed_abnormal")
					: t("chat.realtime.reason_closed", { code: reason.code }),
				reason.reason,
			);
		case "error":
			return withDetail(t("chat.realtime.reason_error"), reason.message);
		case "silent":
			return t("chat.realtime.reason_silent", { minutes: Math.max(1, Math.round(reason.seconds / 60)) });
		case "setup_failed":
			return withDetail(t("chat.realtime.reason_setup_failed"), reason.message);
		case "offline":
			return t("chat.realtime.reason_offline");
		case "stopped":
			return t("chat.realtime.reason_stopped");
	}
}

function formatTime(at: number, language: string, now: number): string {
	const date = new Date(at);
	const time = date.toLocaleTimeString(language, { hour: "2-digit", minute: "2-digit" });
	if (date.toDateString() === new Date(now).toDateString()) return time;
	return `${date.toLocaleDateString(language, { day: "numeric", month: "short" })} ${time}`;
}

function formatDuration(t: TFunction, ms: number): string {
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 1) return t("chat.realtime.duration_under_minute");
	if (minutes < 60) return t("chat.realtime.duration_minutes", { minutes });
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return t("chat.realtime.duration_hours", { hours, minutes: minutes % 60 });
	return t("chat.realtime.duration_days", { days: Math.floor(hours / 24), hours: hours % 24 });
}

function Dot({ color, className = "h-2 w-2" }: { color: ConnectionColor; className?: string }) {
	return (
		<span
			aria-hidden
			className={`inline-block shrink-0 rounded-full transition-colors duration-500 ${className}`}
			style={{ backgroundColor: DOT_COLORS[color] }}
		/>
	);
}

/** Re-renders once a minute so "since … (13 h)" keeps moving while the sheet is open. */
function useNow(active: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 30_000);
		return () => clearInterval(timer);
	}, [active]);
	return now;
}

function HistoryRow({
	episode,
	end,
	appClosed,
	isCurrent,
	now,
}: {
	episode: ConnectionEpisode;
	end: number;
	appClosed: boolean;
	isCurrent: boolean;
	now: number;
}) {
	const { t, i18n } = useTranslation();
	const language = i18n.language;
	const start = formatTime(episode.since, language, now);
	const finish = isCurrent ? t("chat.realtime.now") : formatTime(end, language, now);

	return (
		<li className="flex gap-3 py-2.5">
			<Dot color={episode.color} className="mt-1.5 h-2.5 w-2.5" />
			<div className="min-w-0 flex-1">
				<p className="text-sm font-semibold text-[var(--text)]">
					{colorName(t, episode.color)} · {statusLabel(t, episode.status)}
				</p>
				<p className="text-xs text-[var(--text-muted)]">
					{start} → {finish} · {formatDuration(t, Math.max(0, end - episode.since))}
				</p>
				{episode.appStart && (
					<p className="mt-0.5 text-xs text-[var(--text-muted)]">{t("chat.realtime.app_started")}</p>
				)}
				{episode.cause && (
					<p className="mt-0.5 text-xs text-[var(--text)]">{reasonText(t, episode.cause)}</p>
				)}
				{episode.color !== "green" && episode.attempts > 0 && (
					<p className="mt-0.5 text-xs text-[var(--text-muted)]">
						{t("chat.realtime.attempts", { count: episode.attempts })}
					</p>
				)}
				{episode.color === "green" && episode.problems > 0 && (
					<p className="mt-0.5 text-xs text-[var(--text-muted)]">
						{t("chat.realtime.short_drops", { count: episode.problems })}
					</p>
				)}
				{episode.lastProblem && (
					<p className="mt-0.5 text-xs text-[var(--text-muted)]">
						{t("chat.realtime.last_problem", {
							time: formatTime(episode.lastProblem.at, language, now),
							reason: reasonText(t, episode.lastProblem.reason),
						})}
					</p>
				)}
				{appClosed && (
					<p className="mt-0.5 text-xs text-[var(--text-muted)]">{t("chat.realtime.app_closed")}</p>
				)}
			</div>
		</li>
	);
}

function ConnectionSheet({ isDesktop, onClose }: { isDesktop: boolean; onClose: () => void }) {
	const { t, i18n } = useTranslation();
	const log = useSyncExternalStore(subscribeConnectionLog, getConnectionLogSnapshot, getConnectionLogSnapshot);
	const now = useNow(true);
	const episodes = log.episodes;
	const lastIndex = episodes.length - 1;

	return (
		<BottomSheet onClose={onClose} isDesktop={isDesktop} panelClassName="max-h-[82dvh]">
			<div className="flex flex-col gap-4 overflow-y-auto px-4 pb-6">
				<div className="flex items-start gap-3">
					<Dot color={log.color} className="mt-1.5 h-3.5 w-3.5" />
					<div className="min-w-0">
						<h2 className="text-base font-bold text-[var(--text)]">{t("chat.realtime.title")}</h2>
						<p className="text-sm font-semibold text-[var(--text)]">
							{colorName(t, log.color)} · {statusLabel(t, log.status)}
						</p>
						{log.since !== null && (
							<p className="text-xs text-[var(--text-muted)]">
								{t("chat.realtime.since", {
									time: formatTime(log.since, i18n.language, now),
									duration: formatDuration(t, Math.max(0, now - log.since)),
								})}
							</p>
						)}
						<p className="mt-1.5 text-sm leading-snug text-[var(--text-muted)]">{colorMeaning(t, log.color)}</p>
					</div>
				</div>

				<section>
					<h3 className="mb-1.5 text-xs font-bold uppercase tracking-wide text-[var(--text-muted)]">
						{t("chat.realtime.colors_title")}
					</h3>
					<ul className="flex flex-col gap-2">
						{(["green", "orange", "red"] as const).map((color) => (
							<li key={color} className="flex gap-3">
								<Dot color={color} className="mt-1.5 h-2.5 w-2.5" />
								<p className="text-sm leading-snug text-[var(--text)]">
									<span className="font-semibold">{colorName(t, color)}</span>
									{" — "}
									<span className="text-[var(--text-muted)]">{colorMeaning(t, color)}</span>
								</p>
							</li>
						))}
					</ul>
				</section>

				<section>
					<h3 className="mb-1 text-xs font-bold uppercase tracking-wide text-[var(--text-muted)]">
						{t("chat.realtime.history_title")}
					</h3>
					{episodes.length === 0 ? (
						<p className="text-sm text-[var(--text-muted)]">{t("chat.realtime.history_empty")}</p>
					) : (
						<ul className="divide-y divide-[var(--border)]">
							{episodes
								.map((episode, index) => {
									const isCurrent = index === lastIndex && log.sessionSettled;
									const { end, appClosed } = episodeEnd(episodes, index, { now, isCurrent });
									return { episode, end, appClosed, isCurrent, key: `${episode.since}-${index}` };
								})
								.reverse()
								.map(({ key, ...row }) => (
									<HistoryRow key={key} {...row} now={now} />
								))}
						</ul>
					)}
				</section>
			</div>
		</BottomSheet>
	);
}

export function ConnectionDot({ isDesktop }: { isDesktop: boolean }) {
	const { t } = useTranslation();
	const log = useSyncExternalStore(subscribeConnectionLog, getConnectionLogSnapshot, getConnectionLogSnapshot);
	const [calloutSeq, setCalloutSeq] = useState<number | null>(null);
	const [isSheetOpen, setIsSheetOpen] = useState(false);
	const seenSeq = useRef(log.changeSeq);

	// Each colour change while the Inbox is on screen gets its explanation.
	// The app's own start going green is the normal case and says nothing.
	useEffect(() => {
		if (log.changeSeq === seenSeq.current) return;
		seenSeq.current = log.changeSeq;
		const latest = log.episodes[log.episodes.length - 1];
		if (latest?.appStart && latest.color === "green") return;
		const seq = log.changeSeq;
		setCalloutSeq(seq);
		const timer = setTimeout(() => {
			setCalloutSeq((current) => (current === seq ? null : current));
		}, CALLOUT_MS);
		return () => clearTimeout(timer);
	}, [log.changeSeq, log.episodes]);

	const latest = log.episodes[log.episodes.length - 1];
	const showCallout = calloutSeq !== null && calloutSeq === log.changeSeq;
	const label = `${colorName(t, log.color)} · ${statusLabel(t, log.status)}`;

	return (
		<>
			<button
				type="button"
				onClick={() => {
					setCalloutSeq(null);
					setIsSheetOpen(true);
				}}
				className="absolute -right-4 -top-2 flex h-5 w-5 items-center justify-center rounded-full"
				aria-label={t("chat.realtime.dot_label", { status: label })}
				title={label}
			>
				{showCallout && (
					<span
						aria-hidden
						className="absolute h-2 w-2 animate-ping rounded-full opacity-75"
						style={{ backgroundColor: DOT_COLORS[log.color] }}
					/>
				)}
				<Dot color={log.color} />
			</button>

			{showCallout && (
				<span
					role="status"
					className="absolute left-0 top-full z-30 mt-2 block w-[min(21rem,calc(100vw-2rem))] rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3 text-left text-[13px] font-normal leading-snug tracking-normal text-[var(--text)] shadow-xl"
					style={{ animation: "modal-top-in 0.3s cubic-bezier(0.16, 1, 0.3, 1) both" }}
				>
					<span className="flex items-center gap-2 font-semibold">
						<Dot color={log.color} className="h-2.5 w-2.5" />
						<span className="min-w-0 flex-1">{label}</span>
						<button
							type="button"
							onClick={() => setCalloutSeq(null)}
							className="-m-1 rounded-full p-1 text-[var(--text-muted)] hover:text-[var(--text)]"
							aria-label={t("common.close")}
						>
							<X className="h-3.5 w-3.5" />
						</button>
					</span>
					<span className="mt-1 block text-[var(--text-muted)]">{colorMeaning(t, log.color)}</span>
					{latest?.cause && log.color !== "green" && (
						<span className="mt-1 block text-[12px] text-[var(--text)]">{reasonText(t, latest.cause)}</span>
					)}
					<button
						type="button"
						onClick={() => {
							setCalloutSeq(null);
							setIsSheetOpen(true);
						}}
						className="mt-2 text-[12px] font-semibold text-[var(--accent)]"
					>
						{t("chat.realtime.see_history")}
					</button>
				</span>
			)}

			{/* Out of the title and the header's stacking layer, or the title's
			    font and the header's z-index would apply to the sheet. Into #app,
			    not <body>: on the PC #app is the rounded window frame and only
			    clips what is inside it, so from <body> the backdrop squared the
			    window's corners. */}
			{isSheetOpen && createPortal(
				<ConnectionSheet isDesktop={isDesktop} onClose={() => setIsSheetOpen(false)} />,
				document.getElementById("app") ?? document.body,
			)}
		</>
	);
}
