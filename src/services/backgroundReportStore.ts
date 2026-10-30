/**
 * Keeps the background day report (utils/backgroundReport.ts) on the phone:
 * opens a lock period when the app goes out of sight with "Keep Running in
 * Background" on, closes it on return, reads the battery from the native side,
 * and while away checks the first inbox page every two minutes so a message
 * the live connection never delivered still shows up in the report.
 *
 * The inbox check only reads: it never blocks, notifies or changes a chat.
 * It exists to measure, not to catch up.
 */

import {
	closeAbandonedLock,
	dropLabel,
	endLock,
	formatReport,
	isLocked,
	newReport,
	noteDrop,
	noteInboxCheck,
	noteMessage,
	noteOutcome,
	notePause,
	parseReport,
	startLock,
	summarize,
	toMs,
	type BackgroundReport,
	type BatteryReading,
	type ReportSummary,
} from "../utils/backgroundReport";
import { cachedBackgroundExecutionState, requestBackgroundExecutionState } from "../utils/backgroundExecution";
import { postToNative } from "../utils/nativeBridge";
import type { RealtimeStatus, RealtimeStatusReason } from "../types/chat-realtime";

const STORAGE_KEY = "fg-background-report";
export const BACKGROUND_REPORT_EVENT = "fg:background-report";
const BEAT_MS = 20_000;
const INBOX_CHECK_MS = 120_000;
const SAVE_EVERY_MS = 60_000;

export type InboxPreview = {
	conversationId: string;
	messageId?: string;
	senderId?: number;
	lastActivityTimestamp?: number | null;
};

let report: BackgroundReport | null = null;
let battery: BatteryReading | null = null;
let beat: ReturnType<typeof setInterval> | null = null;
let inboxTimer: ReturnType<typeof setInterval> | null = null;
let peekInbox: (() => Promise<InboxPreview[]>) | null = null;
let lastSaved = 0;

function load(): BackgroundReport {
	if (report) return report;
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		report = raw ? parseReport(JSON.parse(raw)) : null;
	} catch {
		report = null;
	}
	if (!report) report = newReport(Date.now());
	return report;
}

function save(force = false): void {
	if (!report) return;
	const now = Date.now();
	if (!force && now - lastSaved < SAVE_EVERY_MS) return;
	lastSaved = now;
	try {
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify(report));
	} catch {
		// Storage refused: the report still lives for this session.
	}
	window.dispatchEvent(new Event(BACKGROUND_REPORT_EVENT));
}

function isHidden(): boolean {
	return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/** Recording only happens while away with the switch on. */
function recording(): BackgroundReport | null {
	const current = load();
	return isLocked(current) ? current : null;
}

function myUserId(): number | null {
	try {
		const raw = window.localStorage.getItem("fg-user-id");
		const id = raw == null ? NaN : Number(raw);
		return Number.isFinite(id) ? id : null;
	} catch {
		return null;
	}
}

function readBattery(value: unknown): BatteryReading | null {
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	const level = typeof record.level === "number" ? record.level : -1;
	if (level < 0 || level > 1) return null;
	return { level: Math.round(level * 100), charging: record.charging === true };
}

function requestBattery(): void {
	postToNative({ type: "getBattery" });
}

async function checkInbox(): Promise<void> {
	const current = recording();
	if (!current || !peekInbox) return;
	const lock = current.locks[current.locks.length - 1];
	const me = myUserId();
	try {
		const entries = await peekInbox();
		const now = Date.now();
		for (const entry of entries) {
			if (!entry.messageId || entry.senderId == null || entry.lastActivityTimestamp == null) continue;
			if (me != null && Number(entry.senderId) === me) continue;
			const sentAt = toMs(entry.lastActivityTimestamp);
			// Only what was sent while away; older last messages were seen in the open.
			if (sentAt < lock.from) continue;
			noteMessage(current, { id: entry.messageId, conversationId: entry.conversationId, sentAt }, "inbox", now);
		}
		noteInboxCheck(current, true);
	} catch {
		noteInboxCheck(current, false);
	}
	save(true);
}

function heartbeat(): void {
	const current = recording();
	if (!current) return;
	const now = Date.now();
	const last = current.lastBeat ?? now;
	if (now - last > 60_000) notePause(current, now - last);
	current.lastBeat = now;
	save();
}

function stopTimers(): void {
	if (beat != null) clearInterval(beat);
	if (inboxTimer != null) clearInterval(inboxTimer);
	beat = null;
	inboxTimer = null;
}

function onVisibilityChange(): void {
	const current = load();
	const now = Date.now();
	if (isHidden()) {
		if (!cachedBackgroundExecutionState()?.enabled) return;
		startLock(current, now, battery);
		current.lastBeat = now;
		requestBattery();
		stopTimers();
		beat = setInterval(heartbeat, BEAT_MS);
		inboxTimer = setInterval(() => void checkInbox(), INBOX_CHECK_MS);
		save(true);
		return;
	}
	stopTimers();
	if (!isLocked(current)) return;
	// A pause that lasted until now counts too.
	heartbeat();
	endLock(current, now, battery);
	// The reading may be a little old; the fresh one, when it comes, replaces it.
	requestBattery();
	save(true);
}

function onBattery(event: Event): void {
	const reading = readBattery((event as CustomEvent).detail);
	if (!reading) return;
	battery = reading;
	const current = load();
	const lock = current.locks[current.locks.length - 1];
	if (!lock) return;
	// The reply to the request made at the lock's start or end, a moment later.
	if (lock.to == null && Date.now() - lock.from < 10_000) {
		lock.batteryFrom = reading.level;
	} else if (lock.to != null && Date.now() - lock.to < 10_000) {
		lock.batteryTo = reading.level;
	}
	if (reading.charging) {
		if (lock.to == null || Date.now() - lock.to < 10_000) lock.charging = true;
	}
	save(true);
}

/** The bridge hands over the inbox reader, which needs the signed-in API. */
export function setBackgroundInboxPeeker(peeker: (() => Promise<InboxPreview[]>) | null): void {
	peekInbox = peeker;
}

/** An incoming message from the live connection. */
export function reportLiveMessage(message: { messageId: string; conversationId: string; timestamp: number }): void {
	const current = recording();
	if (!current) return;
	noteMessage(
		current,
		{ id: message.messageId, conversationId: message.conversationId, sentAt: toMs(message.timestamp) },
		"live",
		Date.now(),
	);
	save(true);
}

/** "notified", "blocked", or why the message was not announced. */
export function reportMessageOutcome(messageId: string, outcome: string): void {
	const current = recording();
	if (!current) return;
	noteOutcome(current, messageId, outcome, Date.now());
	save(true);
}

export function reportConnectionStatus(status: RealtimeStatus, reason?: RealtimeStatusReason): void {
	const current = recording();
	if (!current) return;
	// "error" is followed by the close that carries its text; counting both would double it.
	if (status !== "reconnecting" && status !== "disconnected") return;
	if (reason?.kind === "stopped") return;
	noteDrop(current, dropLabel(reason));
	save(true);
}

export function backgroundReportSummary(): ReportSummary {
	return summarize(load(), Date.now());
}

export function backgroundReportStartedAt(): number {
	return load().startedAt;
}

export function backgroundReportText(header: string[]): string {
	return formatReport(load(), Date.now(), header);
}

/** Starts a fresh report, for the next test day. */
export function resetBackgroundReport(): void {
	report = newReport(Date.now());
	save(true);
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
	const current = load();
	if (closeAbandonedLock(current)) save(true);
	window.addEventListener("fg:battery", onBattery);
	document.addEventListener("visibilitychange", onVisibilityChange);
	requestBattery();
	// Whether the switch is on is read when the app goes away; ask now, since
	// the native side's own report at launch can come before the page is ready.
	requestBackgroundExecutionState();
}
