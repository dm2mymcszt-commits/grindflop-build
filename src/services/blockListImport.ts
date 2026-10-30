/**
 * blockListImport.ts — exports this account's block list to a file, and
 * blocks a list from such a file: slowly, over hours or days, or all in one
 * go with the Instant pace.
 *
 * The import is a job kept in localStorage per account, so it survives
 * restarts and picks up where it stopped. It only runs while the account that
 * started it is signed in, through the runner that ProtectedLayout attaches.
 * The pacing rules live in utils/blockListImportRules.ts.
 */
import { findConversationByProfileId } from "./chatDb";
import { applySelfBlockAction, markConversationDeleteHandled } from "./conversationArchive";
import { ApiFunctionError } from "./apiHelpers";
import { createBackupWriter, type BackupDestination } from "./backupFile";
import { getLocalBlockList } from "./blockListSnapshot";
import type { createApiFunctions } from "./apiFunctions";
import { markSelfBlockAction } from "../utils/selfBlockActions";
import { appLog } from "../utils/logger";
import {
	BLOCK_IMPORT_STORAGE_PREFIX,
	IMPORT_PACES,
	blocksUntilBreak,
	buildBlockListFile,
	classifyBlockFailure,
	dailyWindow,
	isImportPace,
	nextToSend,
	randomInRange,
	settleInstantRound,
	type BlockImportStopReason,
	type ImportPace,
	type RoundOutcome,
} from "../utils/blockListImportRules";

type ApiFunctions = ReturnType<typeof createApiFunctions>;

const JOB_KEY = `${BLOCK_IMPORT_STORAGE_PREFIX}:job:`;
const IDS_KEY = `${BLOCK_IMPORT_STORAGE_PREFIX}:ids:`;

/** Longest single timer. Longer waits are re-checked, so a laptop waking from sleep doesn't oversleep. */
const MAX_TIMER_MS = 60_000;

export type BlockImportWait = "gap" | "break" | "daily_limit" | "rate_limited" | "retry";

export type BlockImportJob = {
	id: string;
	ownerId: string;
	pace: ImportPace;
	status: "running" | "paused" | "done";
	stopReason: BlockImportStopReason | null;
	lastError: string | null;
	/** Profiles queued, after leaving out the ones already blocked. */
	total: number;
	/** In the file, but already blocked on this account when the import started. */
	alreadyBlocked: number;
	cursor: number;
	blocked: number;
	failed: number;
	startedAt: number;
	finishedAt: number | null;
	waitUntil: number | null;
	waitReason: BlockImportWait | null;
	windowStartedAt: number | null;
	countInWindow: number;
	sinceBreak: number;
	nextBreakAfter: number;
	attempts: number;
	rateLimitStrikes: number;
	consecutiveFailures: number;
	/**
	 * Refused during an Instant round because of the account or the pace, not
	 * the profile. Sent before the queue carries on, whatever the pace by then.
	 */
	retryIds: string[];
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const listeners = new Set<() => void>();
const jobs = new Map<string, BlockImportJob | null>();
const queues = new Map<string, string[] | null>();

function emit(): void {
	for (const listener of listeners) listener();
}

export function subscribeBlockImport(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

function readJson(key: string): unknown {
	try {
		const raw = window.localStorage.getItem(key);
		return raw == null ? null : JSON.parse(raw);
	} catch {
		return null;
	}
}

function isJob(value: unknown): value is BlockImportJob {
	if (typeof value !== "object" || value === null) return false;
	const job = value as Partial<BlockImportJob>;
	return (
		typeof job.id === "string" &&
		typeof job.ownerId === "string" &&
		isImportPace(job.pace) &&
		(job.status === "running" || job.status === "paused" || job.status === "done") &&
		typeof job.cursor === "number" &&
		typeof job.total === "number"
	);
}

/** Returns the same object until the job changes, as useSyncExternalStore needs. */
export function getBlockImportJob(ownerId: string): BlockImportJob | null {
	if (!jobs.has(ownerId)) {
		const stored = readJson(JOB_KEY + ownerId);
		jobs.set(
			ownerId,
			isJob(stored)
				? {
						...stored,
						retryIds: Array.isArray(stored.retryIds)
							? stored.retryIds.filter((id): id is string => typeof id === "string")
							: [],
					}
				: null,
		);
	}
	return jobs.get(ownerId) ?? null;
}

function getQueue(ownerId: string): string[] | null {
	if (!queues.has(ownerId)) {
		const stored = readJson(IDS_KEY + ownerId);
		queues.set(
			ownerId,
			Array.isArray(stored) && stored.every((id) => typeof id === "string") ? stored : null,
		);
	}
	return queues.get(ownerId) ?? null;
}

function saveJob(job: BlockImportJob): void {
	try {
		window.localStorage.setItem(JOB_KEY + job.ownerId, JSON.stringify(job));
	} catch (error) {
		// Progress still moves in memory; a restart would repeat a few blocks,
		// which Grindr accepts without complaint.
		appLog.warn("[block-import] could not save progress", error);
	}
	jobs.set(job.ownerId, job);
	emit();
}

function updateJob(
	ownerId: string,
	change: (job: BlockImportJob) => BlockImportJob,
): BlockImportJob | null {
	const job = getBlockImportJob(ownerId);
	if (!job) return null;
	const next = change(job);
	saveJob(next);
	return next;
}

export function clearBlockImport(ownerId: string): void {
	try {
		window.localStorage.removeItem(JOB_KEY + ownerId);
		window.localStorage.removeItem(IDS_KEY + ownerId);
	} catch {
		// Nothing more can be done; the in-memory copy is cleared below.
	}
	jobs.set(ownerId, null);
	queues.set(ownerId, null);
	emit();
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

export function startBlockImport(input: {
	ownerId: string;
	profileIds: string[];
	alreadyBlocked: number;
	pace: ImportPace;
}): BlockImportJob {
	const now = Date.now();
	// The queue is written first and once. If it doesn't fit, nothing starts.
	window.localStorage.setItem(IDS_KEY + input.ownerId, JSON.stringify(input.profileIds));
	queues.set(input.ownerId, input.profileIds);
	const job: BlockImportJob = {
		id: `${now}`,
		ownerId: input.ownerId,
		pace: input.pace,
		status: input.profileIds.length > 0 ? "running" : "done",
		stopReason: null,
		lastError: null,
		total: input.profileIds.length,
		alreadyBlocked: input.alreadyBlocked,
		cursor: 0,
		blocked: 0,
		failed: 0,
		startedAt: now,
		finishedAt: input.profileIds.length > 0 ? null : now,
		waitUntil: null,
		waitReason: null,
		windowStartedAt: null,
		countInWindow: 0,
		sinceBreak: 0,
		nextBreakAfter: blocksUntilBreak(input.pace, Math.random),
		attempts: 0,
		rateLimitStrikes: 0,
		consecutiveFailures: 0,
		retryIds: [],
	};
	saveJob(job);
	return job;
}

export function pauseBlockImport(ownerId: string): void {
	updateJob(ownerId, (job) =>
		job.status === "running" ? { ...job, status: "paused", stopReason: "user" } : job,
	);
}

export function resumeBlockImport(ownerId: string): void {
	updateJob(ownerId, (job) => {
		if (job.status !== "paused") return job;
		// Any wait still running when the user paused (a break, the daily
		// limit, a rate-limit backoff) still holds; pausing and resuming must
		// not be a way around it. An automatic stop has none left.
		return {
			...job,
			status: "running",
			stopReason: null,
			lastError: null,
			attempts: 0,
			rateLimitStrikes: 0,
			consecutiveFailures: 0,
		};
	});
}

export function setBlockImportPace(ownerId: string, pace: ImportPace): void {
	updateJob(ownerId, (job) => {
		if (job.pace === pace) return job;
		// The gap or break the old pace chose goes with it. The daily limit and
		// a rate-limit backoff stay: they are about what was already sent.
		const dropWait = job.waitReason === "gap" || job.waitReason === "break";
		return {
			...job,
			pace,
			sinceBreak: 0,
			nextBreakAfter: blocksUntilBreak(pace, Math.random),
			waitUntil: dropWait ? null : job.waitUntil,
			waitReason: dropWait ? null : job.waitReason,
		};
	});
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export type BlockImportEvent =
	| { type: "finished"; job: BlockImportJob }
	| { type: "stopped"; job: BlockImportJob };

type Runner = {
	ownerId: string;
	api: ApiFunctions;
	onEvent: (event: BlockImportEvent) => void;
	timer: ReturnType<typeof setTimeout> | null;
	detached: boolean;
};

/**
 * One block request (or Instant round) at a time, across runners. A runner
 * re-attached while the previous one still waits on a request would otherwise
 * send the same profile again and then move the cursor twice, skipping the
 * next one.
 */
let stepInFlight = false;
let activeRunner: Runner | null = null;

function schedule(runner: Runner): void {
	if (runner.detached || stepInFlight) return;
	if (runner.timer) {
		clearTimeout(runner.timer);
		runner.timer = null;
	}
	const job = getBlockImportJob(runner.ownerId);
	if (!job || job.status !== "running") return;
	const delay = Math.min(Math.max(0, (job.waitUntil ?? 0) - Date.now()), MAX_TIMER_MS);
	runner.timer = setTimeout(() => {
		runner.timer = null;
		void step(runner);
	}, delay);
}

type SendOutcome = RoundOutcome & { message: string | null };

async function sendBlock(api: ApiFunctions, profileId: string): Promise<SendOutcome> {
	try {
		await api.blockProfile(profileId);
		return { profileId, result: "ok", message: null };
	} catch (error) {
		return {
			profileId,
			result: error instanceof ApiFunctionError ? error.status : null,
			message: error instanceof Error ? error.message : String(error),
		};
	}
}

type Batch = ReturnType<typeof nextToSend>;

/** Moves past what `batch` took, from the retry list and from the queue. */
function consumed(job: BlockImportJob, batch: Batch): Pick<BlockImportJob, "retryIds" | "cursor"> {
	return { retryIds: job.retryIds.slice(batch.fromRetry), cursor: job.cursor + batch.fromQueue };
}

function stop(runner: Runner, job: BlockImportJob, reason: BlockImportStopReason): void {
	const stopped: BlockImportJob = { ...job, status: "paused", stopReason: reason, waitUntil: null, waitReason: null };
	saveJob(stopped);
	// Not announced to an account switched to while the request was out.
	if (!runner.detached) runner.onEvent({ type: "stopped", job: stopped });
}

/** The paced modes: one block, then a gap, a retry wait or a stop. */
function settleSingle(runner: Runner, latest: BlockImportJob, batch: Batch, outcome: SendOutcome): void {
	const doneAt = Date.now();
	const gap = () => doneAt + randomInRange(IMPORT_PACES[latest.pace].gapMs, Math.random);

	if (outcome.result === "ok") {
		saveJob({
			...latest,
			...consumed(latest, batch),
			blocked: latest.blocked + 1,
			attempts: 0,
			rateLimitStrikes: 0,
			consecutiveFailures: 0,
			lastError: null,
			waitUntil: gap(),
			waitReason: "gap",
		});
		void applySelfBlockAction(outcome.profileId, "block").catch(() => {});
		return;
	}

	appLog.warn("[block-import] block failed", outcome);
	const status = outcome.result;
	const counters = {
		attempts: latest.attempts + 1,
		rateLimitStrikes: status === 429 ? latest.rateLimitStrikes + 1 : latest.rateLimitStrikes,
		consecutiveFailures: latest.consecutiveFailures + (status === 429 ? 0 : 1),
	};
	const action = classifyBlockFailure(status, counters);
	const withCounters = { ...latest, ...counters, lastError: outcome.message };

	if (action.kind === "retry") {
		saveJob({
			...withCounters,
			waitUntil: doneAt + action.delayMs,
			waitReason: action.rateLimited ? "rate_limited" : "retry",
		});
	} else if (action.kind === "skip") {
		saveJob({
			...withCounters,
			...consumed(latest, batch),
			failed: latest.failed + 1,
			attempts: 0,
			waitUntil: gap(),
			waitReason: "gap",
		});
	} else {
		stop(runner, withCounters, action.reason);
	}
}

/** Instant: a whole round at once, then straight on to the next, or a stop. */
async function settleRound(
	runner: Runner,
	latest: BlockImportJob,
	batch: Batch,
	outcomes: SendOutcome[],
	withConversation: ReadonlySet<string>,
): Promise<void> {
	const settled = settleInstantRound(outcomes, latest.consecutiveFailures);
	const failures = outcomes.filter((outcome) => outcome.result !== "ok");
	if (failures.length > 0) appLog.warn("[block-import] instant round had failures", failures);
	const next: BlockImportJob = {
		...latest,
		cursor: latest.cursor + batch.fromQueue,
		retryIds: [...latest.retryIds.slice(batch.fromRetry), ...settled.retry],
		blocked: latest.blocked + settled.blocked.length,
		failed: latest.failed + settled.failed,
		consecutiveFailures: settled.consecutiveFailures,
		lastError: failures[0]?.message ?? latest.lastError,
		waitUntil: null,
		waitReason: null,
	};
	if (settled.stop) stop(runner, next, settled.stop);
	else saveJob(next);

	// Awaited, unlike the paced modes, so the local chat updates keep step with
	// the rounds instead of piling up thousands deep. Only chats that exist here
	// need one; for anyone else there is nothing to archive.
	await Promise.all(
		settled.blocked
			.filter((profileId) => withConversation.has(profileId))
			.map((profileId) => applySelfBlockAction(profileId, "block").catch(() => {})),
	);
}

async function step(runner: Runner): Promise<void> {
	if (runner.detached || stepInFlight) return;
	const job = getBlockImportJob(runner.ownerId);
	if (!job || job.status !== "running") return;

	const now = Date.now();
	if (job.waitUntil != null && job.waitUntil > now) {
		schedule(runner);
		return;
	}

	const pace = IMPORT_PACES[job.pace];
	const batch = nextToSend(job.retryIds, getQueue(runner.ownerId) ?? [], job.cursor, job.total, pace.concurrency);
	if (batch.ids.length === 0) {
		const finished = updateJob(runner.ownerId, (current) => ({
			...current,
			status: "done",
			finishedAt: now,
			waitUntil: null,
			waitReason: null,
		}));
		if (finished) runner.onEvent({ type: "finished", job: finished });
		return;
	}

	const quota = dailyWindow(job, pace.dailyLimit, now);
	if (quota.waitUntil != null) {
		updateJob(runner.ownerId, (current) => ({
			...current,
			windowStartedAt: quota.windowStartedAt,
			countInWindow: quota.countInWindow,
			waitUntil: quota.waitUntil,
			waitReason: "daily_limit",
		}));
		schedule(runner);
		return;
	}
	if (pace.breakEvery != null && job.sinceBreak >= job.nextBreakAfter) {
		updateJob(runner.ownerId, (current) => ({
			...current,
			sinceBreak: 0,
			nextBreakAfter: blocksUntilBreak(current.pace, Math.random),
			waitUntil: now + randomInRange(pace.breakMs, Math.random),
			waitReason: "break",
		}));
		schedule(runner);
		return;
	}

	stepInFlight = true;
	try {
		// Same order as useBlockProfile: mark the conversation as ours before
		// the request, or the delete event the block triggers can land first
		// and be read as this person blocking us.
		const conversations = await Promise.all(
			batch.ids.map((profileId) => findConversationByProfileId(profileId).catch(() => null)),
		);
		const current = getBlockImportJob(runner.ownerId);
		// Checked again right before sending: the account may have been
		// switched, or the import paused, while the lookups ran.
		if (runner.detached || !current || current.id !== job.id || current.status !== "running") return;
		const withConversation = new Set<string>();
		conversations.forEach((conversation, index) => {
			if (!conversation) return;
			markSelfBlockAction(conversation.conversationId, "block");
			markConversationDeleteHandled(conversation.conversationId);
			withConversation.add(batch.ids[index]);
		});
		// Requests count toward the break and the daily limit whatever their outcome.
		saveJob({
			...current,
			windowStartedAt: quota.windowStartedAt,
			countInWindow: quota.countInWindow + batch.ids.length,
			sinceBreak: current.sinceBreak + batch.ids.length,
		});

		const outcomes = await Promise.all(batch.ids.map((profileId) => sendBlock(runner.api, profileId)));

		// Cancelled while the requests were out: their results no longer belong anywhere.
		const latest = getBlockImportJob(runner.ownerId);
		if (!latest || latest.id !== job.id) return;
		// Settled the way it was sent, even if the pace changed meanwhile.
		if (pace.concurrency > 1) await settleRound(runner, latest, batch, outcomes, withConversation);
		else settleSingle(runner, latest, batch, outcomes[0]);
	} finally {
		stepInFlight = false;
		if (activeRunner) schedule(activeRunner);
	}
}

/**
 * Runs `ownerId`'s import, if it has one, until the returned function is
 * called. Attach it only while that account is the one signed in.
 */
export function attachBlockImportRunner(
	ownerId: string,
	api: ApiFunctions,
	onEvent: (event: BlockImportEvent) => void,
): () => void {
	const runner: Runner = { ownerId, api, onEvent, timer: null, detached: false };
	activeRunner = runner;
	// Pause, resume, a new import or a pace change all come through here.
	const unsubscribe = subscribeBlockImport(() => schedule(runner));
	schedule(runner);
	return () => {
		runner.detached = true;
		if (runner.timer) clearTimeout(runner.timer);
		if (activeRunner === runner) activeRunner = null;
		unsubscribe();
	};
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function blockListFileName(now = new Date()): string {
	return `grindflop-block-list-${now.toISOString().slice(0, 10)}.json`;
}

/** Where an export's list came from: Grindr, or the copy on this device when Grindr didn't answer. */
export type BlockListExportSource =
	| { kind: "grindr" }
	| { kind: "device"; savedAt: number | null; complete: boolean; grindrError: unknown };

export async function exportBlockList(
	api: ApiFunctions,
): Promise<{ count: number; destination: BackupDestination | null; source: BlockListExportSource }> {
	let profileIds: string[];
	let source: BlockListExportSource;
	try {
		// Asked fresh rather than read from the query cache, which can be minutes old.
		profileIds = await api.getBlockedProfileIds();
		source = { kind: "grindr" };
	} catch (error) {
		const local = await getLocalBlockList();
		if (local.profileIds.length === 0) throw error;
		appLog.warn("[block-list-export] Grindr didn't answer, exporting the copy on this device", error);
		profileIds = local.profileIds;
		source = { kind: "device", savedAt: local.savedAt, complete: local.complete, grindrError: error };
	}
	const file = buildBlockListFile(profileIds);
	if (file.count === 0) return { count: 0, destination: null, source };
	const destination = await createBackupWriter(blockListFileName());
	try {
		await destination.writer.write(JSON.stringify(file, null, 1));
		await destination.writer.close();
	} catch (error) {
		await destination.writer.abort().catch(() => {});
		throw error;
	}
	return { count: file.count, destination, source };
}
