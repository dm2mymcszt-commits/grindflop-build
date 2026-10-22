import type { RealtimeStatus, RealtimeStatusReason } from "../types/chat-realtime";

/**
 * The live-connection dot and its history. The dot has three colours; this
 * turns the stream of raw socket states into the coloured periods the user
 * sees, with why each one started.
 *
 * A failing connection cycles connecting → error → reconnecting every few
 * seconds. Read raw, that would flash the dot and fill the history with
 * thousands of lines. So a colour only counts once it has held for
 * SETTLE_MS; everything in between is folded into the period it belongs to
 * (as connection attempts and problems).
 */

export type ConnectionColor = "green" | "orange" | "red";

export const SETTLE_MS = 1_500;
export const MAX_EPISODES = 100;
/** A gap this long between a period's last sign of life and the next app start means the app was closed. */
export const APP_CLOSED_GAP_MS = 2 * 60_000;
const MAX_PENDING = 50;
const MAX_DETAIL_LENGTH = 160;

export type ConnectionNote = { at: number; reason: RealtimeStatusReason };

export type ConnectionEpisode = {
	color: ConnectionColor;
	status: RealtimeStatus;
	since: number;
	/** Last moment this state was known to still hold. */
	lastAt: number;
	/** What made this period start: the first problem, or what the app was doing. */
	cause: RealtimeStatusReason | null;
	/** First period after the app started. */
	appStart?: boolean;
	/** Connection attempts during the period. */
	attempts: number;
	/** Problems after the one that started the period. */
	problems: number;
	lastProblem: ConnectionNote | null;
};

export type ConnectionLogState = {
	episodes: ConnectionEpisode[];
	/** Whether this app session has settled a colour yet; until then the history's last line is from before. */
	sessionSettled: boolean;
	raw: { status: RealtimeStatus; color: ConnectionColor; colorSince: number } | null;
	/** When the raw state left the colour on screen. */
	divergedAt: number | null;
	/** Notes gathered while the raw colour differs from the one on screen. */
	pending: ConnectionNote[];
};

export function colorOfStatus(status: RealtimeStatus): ConnectionColor {
	if (status === "connected") return "green";
	if (status === "disconnected" || status === "error") return "red";
	return "orange";
}

/**
 * Something that cost the connection. A socket "error" is not counted on its
 * own: the close that follows it is (carrying the same text), so one failed
 * attempt counts once.
 */
export function isProblemReason(reason: RealtimeStatusReason): boolean {
	return (
		reason.kind === "closed"
		|| reason.kind === "silent"
		|| reason.kind === "setup_failed"
		|| reason.kind === "offline"
	);
}

/**
 * Error texts can echo a URL, and the socket URL carries the session key.
 * Nothing that looks like a key goes into the history.
 */
export function scrubDetail(text: string | null | undefined): string | undefined {
	if (!text) return undefined;
	const cleaned = text
		.replace(/(token|key|auth|authorization|session)=([^&\s"']+)/gi, "$1=…")
		.replace(/Grindr3\s+\S+/g, "Grindr3 …")
		.replace(/[A-Za-z0-9_-]{32,}(?:\.[A-Za-z0-9_-]+)*/g, "…")
		.replace(/\s+/g, " ")
		.trim();
	if (!cleaned) return undefined;
	return cleaned.length > MAX_DETAIL_LENGTH ? `${cleaned.slice(0, MAX_DETAIL_LENGTH - 1)}…` : cleaned;
}

export function cleanReason(reason: RealtimeStatusReason): RealtimeStatusReason {
	switch (reason.kind) {
		case "closed":
			return { kind: "closed", code: reason.code, reason: scrubDetail(reason.reason) };
		case "error":
			return { kind: "error", message: scrubDetail(reason.message) };
		case "setup_failed":
			return { kind: "setup_failed", message: scrubDetail(reason.message) };
		default:
			return reason;
	}
}

export function createConnectionLogState(episodes: ConnectionEpisode[] = []): ConnectionLogState {
	return { episodes, sessionSettled: false, raw: null, divergedAt: null, pending: [] };
}

function shownEpisode(state: ConnectionLogState): ConnectionEpisode | null {
	if (!state.sessionSettled) return null;
	return state.episodes[state.episodes.length - 1] ?? null;
}

function noteOn(episode: ConnectionEpisode, note: ConnectionNote): ConnectionEpisode {
	if (note.reason.kind === "starting") {
		return { ...episode, attempts: episode.attempts + 1 };
	}
	if (isProblemReason(note.reason)) {
		return { ...episode, problems: episode.problems + 1, lastProblem: note };
	}
	return episode;
}

/** One raw state from the socket manager. */
export function applyRawStatus(
	state: ConnectionLogState,
	status: RealtimeStatus,
	reason: RealtimeStatusReason | undefined,
	now: number,
): ConnectionLogState {
	const color = colorOfStatus(status);
	const note = reason ? { at: now, reason: cleanReason(reason) } : null;
	const raw = {
		status,
		color,
		colorSince: state.raw && state.raw.color === color ? state.raw.colorSince : now,
	};
	const shown = shownEpisode(state);

	if (shown && shown.color === color) {
		// Still, or back to, the colour on screen: whatever happened while it
		// looked like changing was a blip of this same period.
		let episode: ConnectionEpisode = { ...shown, lastAt: Math.max(shown.lastAt, now) };
		for (const pending of state.pending) episode = noteOn(episode, pending);
		if (note) episode = noteOn(episode, note);
		return {
			...state,
			episodes: [...state.episodes.slice(0, -1), episode],
			raw,
			divergedAt: null,
			pending: [],
		};
	}

	return {
		...state,
		raw,
		divergedAt: state.divergedAt ?? now,
		pending: note ? [...state.pending, note].slice(-MAX_PENDING) : state.pending,
	};
}

/** When the raw colour will have held long enough to show, or null if nothing is waiting. */
export function settleDueAt(state: ConnectionLogState): number | null {
	if (!state.raw) return null;
	const shown = shownEpisode(state);
	if (shown && shown.color === state.raw.color) return null;
	return state.raw.colorSince + SETTLE_MS;
}

/** Makes the raw colour the one on screen once it has held for SETTLE_MS. */
export function settleIfDue(
	state: ConnectionLogState,
	now: number,
): { state: ConnectionLogState; changed: boolean } {
	const due = settleDueAt(state);
	if (due === null || now < due || !state.raw) return { state, changed: false };

	const problems = state.pending.filter((note) => isProblemReason(note.reason));
	const firstProblem = problems[0] ?? null;
	const latest = state.pending[state.pending.length - 1] ?? null;
	const since = state.divergedAt ?? state.raw.colorSince;

	const episode: ConnectionEpisode = {
		color: state.raw.color,
		status: state.raw.status,
		since,
		lastAt: now,
		cause: firstProblem?.reason ?? latest?.reason ?? null,
		attempts: state.pending.filter((note) => note.reason.kind === "starting").length,
		problems: Math.max(0, problems.length - 1),
		lastProblem: problems.length > 1 ? problems[problems.length - 1] : null,
	};
	if (!state.sessionSettled) episode.appStart = true;

	const previous = state.episodes.slice();
	const last = previous[previous.length - 1];
	if (last && state.sessionSettled) {
		// Held right up to the moment things started to change.
		previous[previous.length - 1] = { ...last, lastAt: Math.max(last.lastAt, since) };
	}

	return {
		state: {
			...state,
			episodes: [...previous, episode].slice(-MAX_EPISODES),
			sessionSettled: true,
			divergedAt: null,
			pending: [],
		},
		changed: true,
	};
}

/** Marks the period on screen as still holding, so a later app start can tell the app was closed in between. */
export function touchConnectionLog(state: ConnectionLogState, now: number): ConnectionLogState {
	const shown = shownEpisode(state);
	if (!shown) return state;
	return {
		...state,
		episodes: [...state.episodes.slice(0, -1), { ...shown, lastAt: Math.max(shown.lastAt, now) }],
	};
}

/** The colour and status the dot shows right now. */
export function currentConnectionState(state: ConnectionLogState): {
	color: ConnectionColor;
	status: RealtimeStatus;
	since: number | null;
} {
	const shown = shownEpisode(state);
	if (shown) {
		const status = state.raw && state.raw.color === shown.color ? state.raw.status : shown.status;
		return { color: shown.color, status, since: shown.since };
	}
	// The app has just started and nothing has settled yet.
	if (state.raw) return { color: state.raw.color, status: state.raw.status, since: null };
	return { color: "orange", status: "connecting", since: null };
}

/**
 * Where a period ended, for the history: the next period's start, or — when
 * the app was closed in between — its last sign of life.
 */
export function episodeEnd(
	episodes: readonly ConnectionEpisode[],
	index: number,
	options: { now: number; isCurrent: boolean },
): { end: number; appClosed: boolean } {
	const episode = episodes[index];
	if (options.isCurrent) return { end: options.now, appClosed: false };
	const next = episodes[index + 1];
	if (!next) return { end: episode.lastAt, appClosed: true };
	if (next.appStart && next.since - episode.lastAt > APP_CLOSED_GAP_MS) {
		return { end: episode.lastAt, appClosed: true };
	}
	return { end: next.since, appClosed: false };
}

const COLORS = new Set<ConnectionColor>(["green", "orange", "red"]);

/** Reads back what was stored; anything malformed is dropped, never thrown. */
export function parseStoredEpisodes(raw: string | null): ConnectionEpisode[] {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw) as { v?: number; episodes?: unknown };
		if (parsed?.v !== 1 || !Array.isArray(parsed.episodes)) return [];
		return parsed.episodes
			.filter((item): item is ConnectionEpisode => {
				const episode = item as Partial<ConnectionEpisode> | null;
				return Boolean(
					episode
					&& COLORS.has(episode.color as ConnectionColor)
					&& typeof episode.status === "string"
					&& typeof episode.since === "number"
					&& typeof episode.lastAt === "number",
				);
			})
			.map((episode) => ({
				...episode,
				attempts: typeof episode.attempts === "number" ? episode.attempts : 0,
				problems: typeof episode.problems === "number" ? episode.problems : 0,
				cause: episode.cause ?? null,
				lastProblem: episode.lastProblem ?? null,
			}))
			.slice(-MAX_EPISODES);
	} catch {
		return [];
	}
}

export function serializeEpisodes(episodes: readonly ConnectionEpisode[]): string {
	return JSON.stringify({ v: 1, episodes });
}
