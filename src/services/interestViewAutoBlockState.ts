/**
 * interestViewAutoBlockState.ts — durable, account-scoped memory of which
 * Interest views the auto-blocker has already evaluated.
 *
 * The scanner used to keep this in a `useRef<Map>` that was cleared on mount
 * and on every requested rescan, so enabling the feature, restarting the app
 * or merely saving the block rules re-evaluated (and blocked) every profile
 * already sitting in the Interest list. This module is the durable
 * replacement, and it answers exactly one question: "is this a view I have
 * not handled yet?"
 *
 * Two mechanisms, deliberately both:
 * - a **watermark**: anything at or below it is history. It is set to the
 *   newest view at the baseline, which is what makes the very first
 *   activation a baseline instead of a mass block, and afterwards trails the
 *   newest view handled by WATERMARK_TRAIL_MS, so storage stays flat no
 *   matter how many viewers exist.
 * - a bounded per-profile **ledger**: the last view time (and view count) we
 *   settled for a profile, so a repeat viewer whose timestamp moves — or
 *   whose count increments without one — is still recognised as new, and an
 *   unchanged view never costs another profile/block API call.
 *
 * Storage is localStorage, keyed per signed-in account, and synchronous on
 * purpose: the live `VIEW_RECEIVED_EVENT` handler has to decide immediately,
 * before the viewer can open a chat.
 */

import { appLog } from "../utils/logger";

const STORAGE_KEY_PREFIX = "fg-view-autoblock-state";
const STATE_VERSION = 1;

/**
 * Hard cap on the per-profile ledger. Only profiles evaluated *after* the
 * baseline ever get an entry (the baseline itself writes none), so this is
 * generous in practice. Evicted entries are always the oldest; at about a
 * thousand viewers a day they are hours below the watermark, so eviction
 * cannot resurrect an already-handled view.
 */
const MAX_LEDGER_ENTRIES = 2000;

/**
 * How far the watermark stays behind the newest view handled.
 *
 * It used to sit right on it, and that silently dropped viewers: Grindr's
 * list gives a view a time 1 s to 4 min later than the live event does
 * (median 20 s, 128 views measured on 2026-10-21), and the live event does not
 * come for every view. A viewer with no live event reached the sweep with a
 * list time already under a later viewer's live time, so the sweep skipped
 * them, and they could write before any rule looked at them: about half of
 * the 777 listed viewers of the previous 20 hours were never checked. Inside
 * this window the per-profile ledger alone decides, and it is large enough to
 * cover it many times over.
 */
const WATERMARK_TRAIL_MS = 30 * 60 * 1000;

/**
 * How far back a catch-up sweep may reach. Views newer than the watermark but
 * older than this are never treated as new, so an app that was closed (or a
 * feature that was disabled) for a long stretch cannot come back and block a
 * month of accumulated history in one pass.
 */
export const MAX_CATCHUP_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Below this, a "timestamp" is seconds, not milliseconds. */
const SECONDS_TO_MS_THRESHOLD = 100_000_000_000;

type LedgerEntry = {
	/** Last view timestamp settled for this profile (ms). */
	t: number;
	/** Last `viewedCount.totalCount` seen with it, when the server reported one. */
	c: number | null;
};

type ViewAutoBlockState = {
	v: number;
	/** When the baseline was taken — kept for diagnostics, never compared. */
	baselineAt: number;
	watermark: number;
	ledger: Record<string, LedgerEntry>;
};

/**
 * Mirrors what was last written, so a sweep that runs faster than storage
 * (or a device where localStorage throws) still behaves correctly for the
 * rest of the session.
 */
const stateCache = new Map<string, ViewAutoBlockState>();

function storageKey(account: string): string {
	return `${STORAGE_KEY_PREFIX}:${account}`;
}

function sanitizeLedger(value: unknown): Record<string, LedgerEntry> {
	const ledger: Record<string, LedgerEntry> = {};
	if (!value || typeof value !== "object") return ledger;
	for (const [profileId, entry] of Object.entries(value as Record<string, unknown>)) {
		if (!entry || typeof entry !== "object") continue;
		const { t, c } = entry as { t?: unknown; c?: unknown };
		if (typeof t !== "number" || !Number.isFinite(t)) continue;
		ledger[profileId] = { t, c: typeof c === "number" && Number.isFinite(c) ? c : null };
	}
	return ledger;
}

function readState(account: string): ViewAutoBlockState | null {
	const cached = stateCache.get(account);
	if (cached) return cached;
	if (typeof window === "undefined") return null;

	try {
		const raw = window.localStorage.getItem(storageKey(account));
		if (!raw) return null;
		const parsed = JSON.parse(raw) as Partial<ViewAutoBlockState> | null;
		// A corrupt or older-versioned blob is treated as "no baseline yet":
		// the next sweep re-baselines from the current list, which is the safe
		// direction — nothing already visible gets blocked retroactively.
		if (!parsed || parsed.v !== STATE_VERSION || typeof parsed.watermark !== "number") {
			return null;
		}
		const state: ViewAutoBlockState = {
			v: STATE_VERSION,
			baselineAt: typeof parsed.baselineAt === "number" ? parsed.baselineAt : Date.now(),
			watermark: parsed.watermark,
			ledger: sanitizeLedger(parsed.ledger),
		};
		stateCache.set(account, state);
		return state;
	} catch (error) {
		appLog.warn("[view-autoblock-state] failed to read stored state", error);
		return null;
	}
}

function writeState(account: string, state: ViewAutoBlockState): void {
	stateCache.set(account, state);
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(storageKey(account), JSON.stringify(state));
	} catch (error) {
		// Out of quota or a private-mode store. The in-memory copy above still
		// prevents a replay for the rest of this session.
		appLog.warn("[view-autoblock-state] failed to persist state", error);
	}
}

/** Keeps only the newest entries, so the blob can never grow without bound. */
function trimLedger(ledger: Record<string, LedgerEntry>): Record<string, LedgerEntry> {
	const entries = Object.entries(ledger);
	if (entries.length <= MAX_LEDGER_ENTRIES) return ledger;
	entries.sort((a, b) => b[1].t - a[1].t);
	return Object.fromEntries(entries.slice(0, MAX_LEDGER_ENTRIES));
}

/**
 * Coerces a reported view time to milliseconds, matching the normalisation
 * `applySelfBlockAction` already does for conversation timestamps. Returns
 * null for anything that isn't a usable time.
 */
export function normalizeViewTimestamp(value: number | null | undefined): number | null {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
	return Math.round(value < SECONDS_TO_MS_THRESHOLD ? value * 1000 : value);
}

/** Whether this account has already been baselined. */
export function hasViewAutoBlockBaseline(account: string): boolean {
	return readState(account) !== null;
}

/**
 * Records the Interest list as it stands right now as "already seen".
 *
 * Idempotent: once an account has a baseline this is a no-op, so a rescan
 * requested by saving the block rules can never re-baseline (or replay) the
 * list. Writes no ledger entries — the watermark alone covers every row that
 * exists at this moment, however many there are.
 */
export function establishViewAutoBlockBaseline(
	account: string,
	viewTimestamps: readonly (number | null)[],
): void {
	if (readState(account)) return;

	let watermark = 0;
	for (const timestamp of viewTimestamps) {
		if (timestamp != null && timestamp > watermark) watermark = timestamp;
	}

	writeState(account, {
		v: STATE_VERSION,
		baselineAt: Date.now(),
		watermark,
		ledger: {},
	});
}

/**
 * Baselines from a live websocket view when no sweep has managed to yet.
 *
 * A pushed view is by definition one that just happened, so it is safe to
 * treat it as new — but the state has to exist before it is handled, or the
 * sweep that follows would find no baseline and re-evaluate the entire list.
 * The watermark is seeded just below the pushed view so that view (and only
 * it) still counts as new.
 */
export function seedViewAutoBlockBaselineFromLiveView(
	account: string,
	timestamp: number | null,
): void {
	if (readState(account)) return;
	writeState(account, {
		v: STATE_VERSION,
		baselineAt: Date.now(),
		watermark: timestamp != null ? Math.max(0, timestamp - 1) : 0,
		ledger: {},
	});
}

/**
 * Whether this view is one the auto-blocker has not settled yet.
 *
 * Callers must have established (or seeded) a baseline first — without one
 * this deliberately returns false rather than guessing, since "no state" is
 * exactly the situation in which the whole list would otherwise look new.
 */
export function isNewViewEvent(
	account: string,
	profileId: string,
	timestamp: number | null,
	viewCount: number | null,
): boolean {
	// No usable server view time. Cache rows fall back to their own write
	// time (see interestUtils' fromStoredView), which moves whenever the
	// recovery store is rewritten — trusting it here is precisely how ordinary
	// cache churn would look like a wave of fresh views.
	if (timestamp == null) return false;

	const state = readState(account);
	if (!state) return false;

	const existing = state.ledger[profileId];
	if (existing) {
		if (timestamp > existing.t) return true;
		// A repeat view the server reported without moving the timestamp.
		return viewCount != null && existing.c != null && viewCount > existing.c;
	}

	if (timestamp < Date.now() - MAX_CATCHUP_AGE_MS) return false;
	return timestamp > state.watermark;
}

/**
 * Marks a view as fully evaluated — blocked, whitelisted, already blocked, or
 * simply not matching. Every settled outcome records one, so an unchanged
 * view never costs another profile fetch on the next sweep.
 *
 * Deliberately NOT called when an evaluation throws: a transient failure has
 * to stay eligible for a retry.
 */
export function markViewProcessed(
	account: string,
	profileId: string,
	timestamp: number | null,
	viewCount: number | null,
): void {
	if (timestamp == null) return;

	const state = readState(account) ?? {
		v: STATE_VERSION,
		baselineAt: Date.now(),
		watermark: 0,
		ledger: {},
	};

	writeState(account, {
		...state,
		watermark: Math.max(state.watermark, timestamp - WATERMARK_TRAIL_MS),
		ledger: trimLedger({
			...state.ledger,
			[profileId]: { t: timestamp, c: viewCount },
		}),
	});
}
