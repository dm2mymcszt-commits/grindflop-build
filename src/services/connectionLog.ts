import type { RealtimeStatus, RealtimeStatusReason } from "../types/chat-realtime";
import {
	applyRawStatus,
	createConnectionLogState,
	currentConnectionState,
	parseStoredEpisodes,
	serializeEpisodes,
	settleDueAt,
	settleIfDue,
	touchConnectionLog,
	type ConnectionColor,
	type ConnectionEpisode,
	type ConnectionLogState,
} from "../utils/connectionLogRules";

/**
 * History of the live-connection dot, kept on this device across restarts.
 * The realtime bridge feeds every raw socket state in; the dot reads the
 * settled colour and the history back.
 */

const STORAGE_KEY = "fg-realtime-connection-log";
const TOUCH_INTERVAL_MS = 60_000;

export type ConnectionLogSnapshot = {
	color: ConnectionColor;
	status: RealtimeStatus;
	since: number | null;
	episodes: readonly ConnectionEpisode[];
	/** Goes up by one each time the colour on screen changes. */
	changeSeq: number;
	/** Whether the newest history line belongs to this app session. */
	sessionSettled: boolean;
};

function load(): ConnectionEpisode[] {
	try {
		return parseStoredEpisodes(window.localStorage.getItem(STORAGE_KEY));
	} catch {
		return [];
	}
}

function save(): void {
	try {
		window.localStorage.setItem(STORAGE_KEY, serializeEpisodes(state.episodes));
	} catch {
		// Storage refused: the history still lives for this session.
	}
}

let state: ConnectionLogState = createConnectionLogState(typeof window === "undefined" ? [] : load());
let changeSeq = 0;
let snapshot: ConnectionLogSnapshot = buildSnapshot();
const listeners = new Set<() => void>();
let settleTimer: ReturnType<typeof setTimeout> | null = null;
let touchTimer: ReturnType<typeof setInterval> | null = null;

function buildSnapshot(): ConnectionLogSnapshot {
	const current = currentConnectionState(state);
	return {
		...current,
		episodes: state.episodes,
		changeSeq,
		sessionSettled: state.sessionSettled,
	};
}

function emit(): void {
	snapshot = buildSnapshot();
	for (const listener of listeners) listener();
}

function scheduleSettle(): void {
	if (settleTimer) {
		clearTimeout(settleTimer);
		settleTimer = null;
	}
	const due = settleDueAt(state);
	if (due === null) return;
	settleTimer = setTimeout(runSettle, Math.max(0, due - Date.now()) + 20);
}

function runSettle(): void {
	settleTimer = null;
	const result = settleIfDue(state, Date.now());
	if (result.changed) {
		state = result.state;
		changeSeq += 1;
		save();
		emit();
		return;
	}
	scheduleSettle();
}

function ensureTouchTimer(): void {
	if (touchTimer || typeof window === "undefined") return;
	touchTimer = setInterval(() => {
		state = touchConnectionLog(state, Date.now());
		save();
	}, TOUCH_INTERVAL_MS);
}

export function recordRealtimeStatus(status: RealtimeStatus, reason?: RealtimeStatusReason): void {
	const before = state.episodes;
	state = applyRawStatus(state, status, reason, Date.now());
	ensureTouchTimer();
	scheduleSettle();
	if (state.episodes !== before) save();
	emit();
}

export function subscribeConnectionLog(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function getConnectionLogSnapshot(): ConnectionLogSnapshot {
	return snapshot;
}
