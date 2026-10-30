/**
 * The "Keep Running in Background" day report: what happened to each message
 * that came in while the app was out of sight, how often the live connection
 * dropped, and what that cost in battery. Built up over a normal day so the
 * user does not have to stage a test, then copied as text.
 *
 * Pure: every function takes the report and the time, and changes nothing
 * else. Storage, timers and the inbox check live in
 * services/backgroundReportStore.ts.
 *
 * Message ids and conversation ids are kept so the live connection and the
 * inbox check can be matched up; the copied text has counts and delays only,
 * never ids, names or message text.
 */

export type MessageSource = "live" | "inbox";

export type ReportMessage = {
	id: string;
	conversationId: string;
	/** When Grindr says it was sent, in ms. */
	sentAt: number;
	/** When the live connection handed it over. */
	liveAt?: number;
	/** When the background inbox check first saw it. */
	inboxAt?: number;
	notifiedAt?: number;
	/** "notified", "blocked", or why it was not announced. */
	outcome?: string;
};

export type ReportLock = {
	from: number;
	to?: number;
	/** Battery level 0-100 at each end, when the phone said. */
	batteryFrom?: number;
	batteryTo?: number;
	/** Charging at either end: left out of the battery figure. */
	charging?: boolean;
};

export type BackgroundReport = {
	version: 1;
	startedAt: number;
	locks: ReportLock[];
	messages: ReportMessage[];
	/** Live connection drops while away, by reason. */
	drops: Record<string, number>;
	inboxChecks: { ok: number; failed: number };
	/** Pauses of the page longer than a minute, in ms. */
	pauses: number[];
	/** Last sign of life while away, so a lock the app never came back from can be closed. */
	lastBeat?: number;
	/** Times the app (or its page) had restarted when the user came back: iOS ended it while away. */
	ended?: number;
};

export type BatteryReading = { level: number; charging: boolean };

const MESSAGES_KEPT = 500;
const LOCKS_KEPT = 300;
const PAUSES_KEPT = 200;
/** A notification this soon after the message was sent counts as on time. */
export const ON_TIME_MS = 60_000;
/** The inbox check and the live connection can disagree a little on the time. */
const SAME_MESSAGE_WINDOW_MS = 2_000;

export function newReport(now: number): BackgroundReport {
	return { version: 1, startedAt: now, locks: [], messages: [], drops: {}, inboxChecks: { ok: 0, failed: 0 }, pauses: [], ended: 0 };
}

/** A report read back from storage, or null when it is not one. */
export function parseReport(value: unknown): BackgroundReport | null {
	if (!value || typeof value !== "object") return null;
	const report = value as Partial<BackgroundReport>;
	if (report.version !== 1 || typeof report.startedAt !== "number") return null;
	if (!Array.isArray(report.locks) || !Array.isArray(report.messages)) return null;
	return {
		version: 1,
		startedAt: report.startedAt,
		locks: report.locks,
		messages: report.messages,
		drops: report.drops && typeof report.drops === "object" ? report.drops : {},
		inboxChecks: report.inboxChecks ?? { ok: 0, failed: 0 },
		pauses: Array.isArray(report.pauses) ? report.pauses : [],
		lastBeat: typeof report.lastBeat === "number" ? report.lastBeat : undefined,
		ended: typeof report.ended === "number" ? report.ended : 0,
	};
}

/**
 * At app start: a lock still open means the app did not live to see the
 * user come back. It is closed at its last sign of life and counted.
 */
export function closeAbandonedLock(report: BackgroundReport): boolean {
	const open = report.locks[report.locks.length - 1];
	if (!open || open.to != null) return false;
	open.to = Math.max(open.from, report.lastBeat ?? open.from);
	report.ended = (report.ended ?? 0) + 1;
	return true;
}

/** Grindr sends some times in seconds and some in milliseconds. */
export function toMs(timestamp: number): number {
	return timestamp < 100_000_000_000 ? timestamp * 1000 : timestamp;
}

function isCharging(reading: BatteryReading | null | undefined): boolean {
	return reading?.charging === true;
}

export function startLock(report: BackgroundReport, now: number, battery: BatteryReading | null): void {
	const open = report.locks[report.locks.length - 1];
	if (open && open.to == null) return;
	report.locks.push({
		from: now,
		batteryFrom: battery?.level,
		charging: isCharging(battery) || undefined,
	});
	if (report.locks.length > LOCKS_KEPT) report.locks.splice(0, report.locks.length - LOCKS_KEPT);
}

export function endLock(report: BackgroundReport, now: number, battery: BatteryReading | null): void {
	const open = report.locks[report.locks.length - 1];
	if (!open || open.to != null) return;
	open.to = now;
	open.batteryTo = battery?.level;
	if (isCharging(battery)) open.charging = true;
}

/** Whether the app is out of sight right now, as the report sees it. */
export function isLocked(report: BackgroundReport): boolean {
	const open = report.locks[report.locks.length - 1];
	return open != null && open.to == null;
}

function findMessage(report: BackgroundReport, id: string, conversationId: string, sentAt: number): ReportMessage | undefined {
	return report.messages.find(
		(m) =>
			m.id === id ||
			(m.conversationId === conversationId && Math.abs(m.sentAt - sentAt) <= SAME_MESSAGE_WINDOW_MS),
	);
}

/** An incoming message, seen by the live connection or by the inbox check. */
export function noteMessage(
	report: BackgroundReport,
	message: { id: string; conversationId: string; sentAt: number },
	source: MessageSource,
	now: number,
): void {
	let entry = findMessage(report, message.id, message.conversationId, message.sentAt);
	if (!entry) {
		entry = { id: message.id, conversationId: message.conversationId, sentAt: message.sentAt };
		report.messages.push(entry);
		if (report.messages.length > MESSAGES_KEPT) report.messages.splice(0, report.messages.length - MESSAGES_KEPT);
	}
	if (source === "live") {
		// The live id is the one outcomes are reported under.
		entry.id = message.id;
		if (entry.liveAt == null) entry.liveAt = now;
	}
	if (source === "inbox" && entry.inboxAt == null) entry.inboxAt = now;
}

/** What became of a message the live connection handed over. Only the first outcome counts. */
export function noteOutcome(report: BackgroundReport, id: string, outcome: string, now: number): void {
	const entry = report.messages.find((m) => m.id === id);
	if (!entry || entry.outcome) return;
	entry.outcome = outcome;
	if (outcome === "notified") entry.notifiedAt = now;
}

/** A short reason for a drop of the live connection; nothing after a "?" (addresses can carry keys). */
export function dropLabel(reason: { kind: string; code?: number; reason?: string; message?: string; seconds?: number } | undefined): string {
	const clean = (text: string | undefined) => (text ?? "").split("?")[0].trim().slice(0, 80);
	if (!reason) return "unknown";
	switch (reason.kind) {
		case "closed": {
			const why = clean(reason.reason);
			return why ? `closed ${reason.code} (${why})` : `closed ${reason.code}`;
		}
		case "error":
		case "setup_failed": {
			const why = clean(reason.message);
			return why ? `${reason.kind.replace("_", " ")}: ${why}` : reason.kind.replace("_", " ");
		}
		case "silent":
			return `silent ${Math.max(1, Math.round((reason.seconds ?? 0) / 60))} min`;
		default:
			return reason.kind;
	}
}

export function noteDrop(report: BackgroundReport, reason: string): void {
	report.drops[reason] = (report.drops[reason] ?? 0) + 1;
}

export function notePause(report: BackgroundReport, ms: number): void {
	report.pauses.push(ms);
	if (report.pauses.length > PAUSES_KEPT) report.pauses.splice(0, report.pauses.length - PAUSES_KEPT);
}

export function noteInboxCheck(report: BackgroundReport, ok: boolean): void {
	if (ok) report.inboxChecks.ok += 1;
	else report.inboxChecks.failed += 1;
}

export type ReportSummary = {
	hours: number;
	lockedHours: number;
	locks: number;
	/** % per hour while locked and not charging; null without two readings. */
	batteryPerHour: number | null;
	batteryHours: number;
	messages: number;
	onTime: number;
	/** Delays of late notifications, in seconds, longest first. */
	late: number[];
	blocked: number;
	/** Not announced on purpose or by a failing notification, by reason. */
	notAnnounced: Record<string, number>;
	/** Never handed over by the live connection; only the inbox check saw them. */
	missedByLive: number;
	/** Handed over by the live connection but nothing came of it. */
	lostAfterLive: number;
	/** Handed over late: the inbox check had seen them first. */
	liveAfterInbox: number;
	/** How long the live connection took to hand messages over, in seconds. */
	liveDelayMedian: number | null;
	liveDelayMax: number | null;
	drops: Record<string, number>;
	inboxChecks: { ok: number; failed: number };
	pauses: number;
	longestPauseMin: number;
	ended: number;
};

function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

export function summarize(report: BackgroundReport, now: number): ReportSummary {
	let lockedMs = 0;
	let batteryDrop = 0;
	let batteryMs = 0;
	for (const lock of report.locks) {
		const end = lock.to ?? now;
		lockedMs += Math.max(0, end - lock.from);
		if (
			lock.to != null &&
			!lock.charging &&
			lock.batteryFrom != null &&
			lock.batteryTo != null &&
			lock.batteryTo <= lock.batteryFrom
		) {
			batteryDrop += lock.batteryFrom - lock.batteryTo;
			batteryMs += lock.to - lock.from;
		}
	}

	let onTime = 0;
	let blocked = 0;
	let missedByLive = 0;
	let lostAfterLive = 0;
	let liveAfterInbox = 0;
	const late: number[] = [];
	const liveDelays: number[] = [];
	const notAnnounced: Record<string, number> = {};
	for (const m of report.messages) {
		if (m.liveAt != null) {
			liveDelays.push(Math.max(0, Math.round((m.liveAt - m.sentAt) / 1000)));
			if (m.inboxAt != null && m.inboxAt < m.liveAt) liveAfterInbox += 1;
		}
		if (m.outcome === "notified" && m.notifiedAt != null) {
			const delay = m.notifiedAt - m.sentAt;
			if (delay <= ON_TIME_MS) onTime += 1;
			else late.push(Math.round(delay / 1000));
		} else if (m.outcome === "blocked") {
			blocked += 1;
		} else if (m.outcome) {
			notAnnounced[m.outcome] = (notAnnounced[m.outcome] ?? 0) + 1;
		} else if (m.liveAt == null) {
			missedByLive += 1;
		} else {
			lostAfterLive += 1;
		}
	}
	late.sort((a, b) => b - a);
	const batteryHours = batteryMs / 3_600_000;

	return {
		hours: Math.max(0, (now - report.startedAt) / 3_600_000),
		lockedHours: lockedMs / 3_600_000,
		locks: report.locks.length,
		batteryPerHour: batteryHours >= 0.25 ? batteryDrop / batteryHours : null,
		batteryHours,
		messages: report.messages.length,
		onTime,
		late,
		blocked,
		notAnnounced,
		missedByLive,
		lostAfterLive,
		liveAfterInbox,
		liveDelayMedian: median(liveDelays),
		liveDelayMax: liveDelays.length ? Math.max(...liveDelays) : null,
		drops: { ...report.drops },
		inboxChecks: { ...report.inboxChecks },
		pauses: report.pauses.length,
		longestPauseMin: report.pauses.length ? Math.round(Math.max(...report.pauses) / 60_000) : 0,
		ended: report.ended ?? 0,
	};
}

function hoursText(hours: number): string {
	const whole = Math.floor(hours);
	const minutes = Math.round((hours - whole) * 60);
	return `${whole} h ${String(minutes).padStart(2, "0")}`;
}

function countsText(counts: Record<string, number>): string {
	const entries = Object.entries(counts);
	return entries.length ? entries.map(([key, count]) => `${key} ×${count}`).join(", ") : "none";
}

/**
 * The text the user copies and pastes back. English on purpose: it is read
 * by whoever fixes the app, like the diagnostic details, not shown on screen.
 */
export function formatReport(report: BackgroundReport, now: number, header: string[] = []): string {
	const s = summarize(report, now);
	const battery =
		s.batteryPerHour == null
			? `battery: not enough readings (${hoursText(s.batteryHours)} measured)`
			: `battery: ${s.batteryPerHour.toFixed(1)} %/h over ${hoursText(s.batteryHours)} locked, not charging`;
	const lateText = s.late.length
		? `${s.late.length} late (${s.late.slice(0, 10).map((sec) => (sec >= 120 ? `${Math.round(sec / 60)} min` : `${sec} s`)).join(", ")})`
		: "0 late";
	return [
		"GrindFlop background report",
		...header,
		`since ${new Date(report.startedAt).toISOString()} (${hoursText(s.hours)})`,
		`away ${hoursText(s.lockedHours)} in ${s.locks} periods · ${battery}`,
		`messages while away: ${s.messages} · ${s.onTime} notified < 1 min · ${lateText} · ${s.blocked} blocked by rules`,
		`not announced: ${countsText(s.notAnnounced)}`,
		`missed: ${s.missedByLive} never came through the live connection (inbox check found them) · ${s.lostAfterLive} came through but nothing happened`,
		`live connection: median ${s.liveDelayMedian ?? "-"} s, max ${s.liveDelayMax ?? "-"} s after sending · ${s.liveAfterInbox} arrived after the inbox check had seen them`,
		`drops while away: ${countsText(s.drops)}`,
		`inbox checks: ${s.inboxChecks.ok} ok, ${s.inboxChecks.failed} failed · page paused ${s.pauses}× (longest ${s.longestPauseMin} min) · app or page restarted while away ${s.ended}×`,
	].join("\n");
}
