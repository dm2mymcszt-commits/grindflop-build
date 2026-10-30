/**
 * blockListImportRules.ts — the pure parts of moving a block list from one
 * account to another: the file format, and how fast an import may go.
 *
 * Kept free of storage and network so the pacing, which is what keeps a
 * 10,000-profile import from arriving as one burst of blocks, can be tested
 * on its own.
 */

/**
 * Every localStorage key an import keeps starts with this. Backups leave them
 * out: a restored device must not start blocking alongside the one that is
 * already doing it.
 */
export const BLOCK_IMPORT_STORAGE_PREFIX = "fg-block-import";

export const BLOCK_LIST_FORMAT = "grindflop-block-list";
export const BLOCK_LIST_VERSION = 1;

const DAY_MS = 24 * 60 * 60 * 1000;

export type BlockListFile = {
	format: typeof BLOCK_LIST_FORMAT;
	version: number;
	exportedAt: string;
	count: number;
	profileIds: string[];
};

// Grindr profile ids are positive integers. Anything else in a file is not an
// id, and must never be sent to the block endpoint as one.
const PROFILE_ID = /^[1-9]\d{0,14}$/;

export function normalizeProfileId(value: unknown): string | null {
	if (typeof value === "number") {
		return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
	}
	if (typeof value === "string") {
		const trimmed = value.trim();
		return PROFILE_ID.test(trimmed) ? trimmed : null;
	}
	return null;
}

function unique(ids: readonly string[]): string[] {
	return [...new Set(ids)];
}

/**
 * The exported file holds profile ids only. The exporting account's own id is
 * left out on purpose: the file is meant to be handed to other people.
 */
export function buildBlockListFile(profileIds: readonly string[], now = new Date()): BlockListFile {
	const ids = unique(
		profileIds.map(normalizeProfileId).filter((id): id is string => id !== null),
	);
	return {
		format: BLOCK_LIST_FORMAT,
		version: BLOCK_LIST_VERSION,
		exportedAt: now.toISOString(),
		count: ids.length,
		profileIds: ids,
	};
}

export type BlockListParseErrorCode =
	| "empty"
	| "wrong_format"
	| "newer_version"
	| "not_ids";

export class BlockListParseError extends Error {
	readonly code: BlockListParseErrorCode;

	constructor(code: BlockListParseErrorCode) {
		super(`Not a usable block list (${code})`);
		this.name = "BlockListParseError";
		this.code = code;
	}
}

export type ParsedBlockList = {
	profileIds: string[];
	/** Entries in a JSON list that weren't a profile id, and were dropped. */
	invalid: number;
	duplicates: number;
};

function entryToId(entry: unknown): string | null {
	if (typeof entry === "object" && entry !== null) {
		return normalizeProfileId((entry as { profileId?: unknown }).profileId);
	}
	return normalizeProfileId(entry);
}

function fromEntries(entries: readonly unknown[]): ParsedBlockList {
	const ids: string[] = [];
	let invalid = 0;
	for (const entry of entries) {
		const id = entryToId(entry);
		if (id === null) invalid += 1;
		else ids.push(id);
	}
	const deduped = unique(ids);
	if (deduped.length === 0) {
		throw new BlockListParseError(entries.length === 0 ? "empty" : "not_ids");
	}
	return { profileIds: deduped, invalid, duplicates: ids.length - deduped.length };
}

function listFromJson(payload: unknown): unknown[] {
	if (Array.isArray(payload)) return payload;
	if (typeof payload !== "object" || payload === null) {
		throw new BlockListParseError("wrong_format");
	}
	const record = payload as Record<string, unknown>;
	if (record.format !== undefined) {
		if (record.format !== BLOCK_LIST_FORMAT) throw new BlockListParseError("wrong_format");
		if (typeof record.version === "number" && record.version > BLOCK_LIST_VERSION) {
			throw new BlockListParseError("newer_version");
		}
	}
	if (Array.isArray(record.profileIds)) return record.profileIds;
	// Grindr's own GET /v3.1/me/blocks response, saved as-is.
	if (Array.isArray(record.blocking)) return record.blocking;
	throw new BlockListParseError("wrong_format");
}

/**
 * Reads a block list: this app's export, a bare JSON list of ids, Grindr's
 * own blocks response, or plain text holding nothing but ids.
 *
 * Plain text is all-or-nothing. A spreadsheet export with a timestamp or
 * age column would otherwise have those numbers read as profile ids and
 * blocked, so a single token that isn't an id rejects the whole file.
 */
export function parseBlockListFile(text: string): ParsedBlockList {
	const trimmed = text.replace(/^\uFEFF/, "").trim();
	if (trimmed.length === 0) throw new BlockListParseError("empty");

	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		let payload: unknown;
		try {
			payload = JSON.parse(trimmed);
		} catch {
			throw new BlockListParseError("wrong_format");
		}
		return fromEntries(listFromJson(payload));
	}

	const tokens = trimmed.split(/[\s,;]+/).filter((token) => token.length > 0);
	if (tokens.some((token) => normalizeProfileId(token) === null)) {
		throw new BlockListParseError("not_ids");
	}
	return fromEntries(tokens);
}

export type BlockImportPlan = {
	/** In file order, minus anything this account has already blocked. */
	toBlock: string[];
	alreadyBlocked: number;
	/** The file lists the importing account itself, which is left out. */
	skippedSelf: boolean;
};

export function planBlockImport(
	fileIds: readonly string[],
	currentlyBlocked: readonly string[],
	ownProfileId: string | number | null,
): BlockImportPlan {
	const blocked = new Set(currentlyBlocked.map(String));
	const own = ownProfileId == null ? null : String(ownProfileId);
	const toBlock: string[] = [];
	let alreadyBlocked = 0;
	let skippedSelf = false;
	for (const id of unique(fileIds)) {
		if (id === own) {
			skippedSelf = true;
		} else if (blocked.has(id)) {
			alreadyBlocked += 1;
		} else {
			toBlock.push(id);
		}
	}
	return { toBlock, alreadyBlocked, skippedSelf };
}

// ---------------------------------------------------------------------------
// Pacing
// ---------------------------------------------------------------------------

export type ImportPace = "careful" | "balanced" | "fast" | "instant";

export type PaceSettings = {
	/** Wait between two rounds of blocks, picked at random inside this range. */
	gapMs: readonly [number, number];
	/** A longer break after about this many blocks (give or take a fifth), or null for none. */
	breakEvery: number | null;
	breakMs: readonly [number, number];
	/** Most blocks sent in any 24 hours, or null for no limit. */
	dailyLimit: number | null;
	/** Blocks sent at once in each round. */
	concurrency: number;
};

export const IMPORT_PACES: Record<ImportPace, PaceSettings> = {
	careful: {
		gapMs: [10_000, 20_000],
		breakEvery: 50,
		breakMs: [5 * 60_000, 10 * 60_000],
		dailyLimit: 1_000,
		concurrency: 1,
	},
	balanced: {
		gapMs: [5_000, 10_000],
		breakEvery: 100,
		breakMs: [2 * 60_000, 5 * 60_000],
		dailyLimit: 2_500,
		concurrency: 1,
	},
	fast: {
		gapMs: [2_000, 4_000],
		breakEvery: 200,
		breakMs: [60_000, 2 * 60_000],
		dailyLimit: null,
		concurrency: 1,
	},
	// Everything, as fast as the connection allows. Not literally all at once:
	// thousands of requests in flight together would mostly time out and stall
	// the app, so it sends this many at a time, one round straight after another.
	instant: {
		gapMs: [0, 0],
		breakEvery: null,
		breakMs: [0, 0],
		dailyLimit: null,
		concurrency: 10,
	},
};

/** Rough time for one round of Instant: the requests plus the local chat lookups around them. */
export const INSTANT_ROUND_MS = 600;

export const DEFAULT_IMPORT_PACE: ImportPace = "balanced";

export function isImportPace(value: unknown): value is ImportPace {
	return value === "careful" || value === "balanced" || value === "fast" || value === "instant";
}

export function randomInRange(range: readonly [number, number], random: () => number): number {
	return Math.round(range[0] + (range[1] - range[0]) * random());
}

/** How many blocks until the next break, varied so breaks don't fall on round numbers. */
export function blocksUntilBreak(pace: ImportPace, random: () => number): number {
	const every = IMPORT_PACES[pace].breakEvery;
	return every == null ? 0 : Math.max(1, Math.round(every * (0.8 + 0.4 * random())));
}

/** Average time an import of `count` profiles takes at `pace`, breaks and daily limit included. */
export function estimateImportMs(count: number, pace: ImportPace): number {
	const settings = IMPORT_PACES[pace];
	if (count <= 0) return 0;
	if (settings.concurrency > 1) return Math.ceil(count / settings.concurrency) * INSTANT_ROUND_MS;

	const averageGap = (settings.gapMs[0] + settings.gapMs[1]) / 2;
	const averageBreak = (settings.breakMs[0] + settings.breakMs[1]) / 2;
	const breakEvery = settings.breakEvery;
	const activeMs = (blocks: number) =>
		blocks * averageGap + (breakEvery == null ? 0 : Math.floor(blocks / breakEvery) * averageBreak);

	if (settings.dailyLimit == null || count <= settings.dailyLimit) return activeMs(count);
	// Every full day's quota fits inside its day, then waits for the next one.
	const fullDays = Math.floor((count - 1) / settings.dailyLimit);
	return fullDays * DAY_MS + activeMs(count - fullDays * settings.dailyLimit);
}

/**
 * The next profiles to send: any waiting for another try come first, then
 * the queue from the cursor.
 */
export function nextToSend(
	retryIds: readonly string[],
	queue: readonly string[],
	cursor: number,
	total: number,
	count: number,
): { ids: string[]; fromRetry: number; fromQueue: number } {
	const retry = retryIds.slice(0, count);
	const end = Math.min(queue.length, total);
	const fresh = queue.slice(Math.min(cursor, end), Math.min(cursor + count - retry.length, end));
	return { ids: [...retry, ...fresh], fromRetry: retry.length, fromQueue: fresh.length };
}

export type DailyWindow = {
	windowStartedAt: number;
	countInWindow: number;
	/** Set when the limit is reached: nothing more may be sent before this. */
	waitUntil: number | null;
};

/**
 * The 24-hour window the daily limit counts in. It opens with the first block
 * sent after the previous one closed, so a paused import doesn't come back to
 * a window that expired while it waited.
 */
export function dailyWindow(
	state: { windowStartedAt: number | null; countInWindow: number },
	dailyLimit: number | null,
	now: number,
): DailyWindow {
	if (state.windowStartedAt == null || now >= state.windowStartedAt + DAY_MS) {
		return { windowStartedAt: now, countInWindow: 0, waitUntil: null };
	}
	const reached = dailyLimit != null && state.countInWindow >= dailyLimit;
	return {
		windowStartedAt: state.windowStartedAt,
		countInWindow: state.countInWindow,
		waitUntil: reached ? state.windowStartedAt + DAY_MS : null,
	};
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

export const MAX_ATTEMPTS_PER_PROFILE = 3;
export const RETRY_DELAY_MS = 60_000;
export const RATE_LIMIT_BASE_MS = 10 * 60_000;
export const RATE_LIMIT_MAX_MS = 60 * 60_000;
/** Rate-limited this many times in a row, with no block getting through, stops the import. */
export const MAX_RATE_LIMIT_STRIKES = 6;
/** This many failed blocks in a row means something is wrong with more than one profile. */
export const MAX_CONSECUTIVE_FAILURES = 10;

export type BlockImportStopReason = "user" | "forbidden" | "rate_limited" | "too_fast" | "failing";

export type BlockFailureAction =
	| { kind: "retry"; delayMs: number; rateLimited: boolean }
	| { kind: "skip" }
	| { kind: "stop"; reason: Exclude<BlockImportStopReason, "user" | "too_fast"> };

/**
 * What to do after a block request fails. `status` is the HTTP status, or
 * null when the request never got an answer. The counters already include
 * this failure.
 */
export function classifyBlockFailure(
	status: number | null,
	counters: { attempts: number; rateLimitStrikes: number; consecutiveFailures: number },
): BlockFailureAction {
	if (status === 429) {
		if (counters.rateLimitStrikes >= MAX_RATE_LIMIT_STRIKES) {
			return { kind: "stop", reason: "rate_limited" };
		}
		const delayMs = Math.min(
			RATE_LIMIT_BASE_MS * 2 ** Math.max(0, counters.rateLimitStrikes - 1),
			RATE_LIMIT_MAX_MS,
		);
		return { kind: "retry", delayMs, rateLimited: true };
	}
	// The account itself was refused. Carrying on would only add to whatever
	// Grindr already objects to.
	if (status === 401 || status === 403) return { kind: "stop", reason: "forbidden" };
	if (counters.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
		return { kind: "stop", reason: "failing" };
	}
	// Any other 4xx is about this one profile (deleted, banned, invalid).
	if (status !== null && status >= 400 && status < 500) return { kind: "skip" };
	if (counters.attempts < MAX_ATTEMPTS_PER_PROFILE) {
		return { kind: "retry", delayMs: RETRY_DELAY_MS, rateLimited: false };
	}
	return { kind: "skip" };
}

/** One request of an Instant round: "ok", the HTTP status it failed with, or null for no answer. */
export type RoundOutcome = { profileId: string; result: "ok" | number | null };

export type SettledRound = {
	blocked: string[];
	/** Given up on: this import won't try them again. */
	failed: number;
	/** Refused because of the account or the pace, not the profile: kept to send later. */
	retry: string[];
	stop: "forbidden" | "too_fast" | "failing" | null;
	consecutiveFailures: number;
};

/**
 * Settles one Instant round. Unlike the paced modes, Instant never waits and
 * tries again: if Grindr says to slow down or refuses the account, it stops
 * at once, keeping the refused profiles for when the user resumes. A profile
 * that fails for any other reason counts as not blocked; importing the same
 * file again later sends only those, since the rest are then already blocked.
 */
export function settleInstantRound(
	outcomes: readonly RoundOutcome[],
	consecutiveFailuresBefore: number,
): SettledRound {
	const blocked: string[] = [];
	const retry: string[] = [];
	let failed = 0;
	let forbidden = false;
	let tooFast = false;
	for (const { profileId, result } of outcomes) {
		if (result === "ok") {
			blocked.push(profileId);
		} else if (result === 401 || result === 403) {
			forbidden = true;
			retry.push(profileId);
		} else if (result === 429) {
			tooFast = true;
			retry.push(profileId);
		} else {
			failed += 1;
		}
	}
	const consecutiveFailures = blocked.length > 0 ? 0 : consecutiveFailuresBefore + failed;
	const stop = forbidden
		? "forbidden"
		: tooFast
			? "too_fast"
			: consecutiveFailures >= MAX_CONSECUTIVE_FAILURES
				? "failing"
				: null;
	return { blocked, failed, retry, stop, consecutiveFailures };
}
