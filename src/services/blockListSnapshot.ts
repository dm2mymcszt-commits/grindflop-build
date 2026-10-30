/**
 * blockListSnapshot.ts — a copy of the account's block list kept in its own
 * database, next to the automation settings, so Export still works when
 * Grindr's servers are down or the account can't be reached.
 *
 * It is refreshed whenever the whole list comes back from Grindr, and kept up
 * to date in between from every block and unblock the app sends. The setting
 * isn't in CLOUD_SYNCABLE_DB_SETTING_KEYS, so it stays on this device (ten
 * thousand ids rewritten on every block would flood Drive sync), but local
 * backups carry it with the rest of the settings table.
 */
import { getActiveChatDbUser, getSetting, selectStatsRows, setSetting } from "./chatDb";
import { appLog } from "../utils/logger";
import {
	RECENT_CHANGE_WINDOW_MS,
	applyBlockChanges,
	blockedFromStatsLog,
	mergeFullBlockList,
	readSavedBlockList,
	type BlockChange,
	type SavedBlockList,
} from "../utils/blockListSnapshotRules";

const SNAPSHOT_KEY = "blockListSnapshot";
/** Batches the blocks of a scan or an import into one write. */
const FLUSH_DELAY_MS = 3000;

let writeQueue: Promise<void> = Promise.resolve();
let changes: { owner: number; pending: BlockChange[]; recent: BlockChange[] } | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function enqueue(task: () => Promise<void>): Promise<void> {
	writeQueue = writeQueue.then(task).catch((error) => {
		appLog.warn("[block-list-snapshot] failed to save the block list on this device", error);
	});
	return writeQueue;
}

function changesFor(owner: number) {
	// Another account's changes belong to a database that is already closed.
	if (changes?.owner !== owner) changes = { owner, pending: [], recent: [] };
	return changes;
}

async function readSnapshot(): Promise<SavedBlockList | null> {
	return readSavedBlockList(await getSetting<unknown>(SNAPSHOT_KEY));
}

function flushChanges(): Promise<void> {
	if (flushTimer) {
		clearTimeout(flushTimer);
		flushTimer = null;
	}
	const current = changes;
	if (!current || current.pending.length === 0) return writeQueue;
	const pending = current.pending;
	current.pending = [];
	return enqueue(async () => {
		if (getActiveChatDbUser() !== current.owner) return;
		const saved = await readSnapshot();
		await setSetting(SNAPSHOT_KEY, {
			version: 1,
			savedAt: Date.now(),
			fullListAt: saved?.fullListAt ?? null,
			profileIds: applyBlockChanges(saved?.profileIds ?? [], pending),
		} satisfies SavedBlockList);
	});
}

/** The account whose database a block list read or change should land in. */
export function blockListOwner(): number | null {
	return getActiveChatDbUser();
}

/**
 * Saves the whole list Grindr just sent. `owner` and `requestedAt` are taken
 * before the request goes out, so an answer that arrives after an account
 * switch is dropped instead of landing in the other account's database.
 */
export function rememberFullBlockList(owner: number | null, profileIds: readonly string[], requestedAt: number): void {
	if (owner == null || getActiveChatDbUser() !== owner) return;
	const tracked = changesFor(owner);
	const now = Date.now();
	tracked.recent = tracked.recent.filter((change) => now - change.at < RECENT_CHANGE_WINDOW_MS);
	const merged = mergeFullBlockList(profileIds, requestedAt, tracked.recent);
	// The merged list already holds these; writing them again after it would be harmless but wasted.
	tracked.pending = [];
	if (flushTimer) {
		clearTimeout(flushTimer);
		flushTimer = null;
	}
	void enqueue(async () => {
		if (getActiveChatDbUser() !== owner) return;
		await setSetting(SNAPSHOT_KEY, {
			version: 1,
			savedAt: now,
			fullListAt: requestedAt,
			profileIds: merged,
		} satisfies SavedBlockList);
	});
}

/** Records one block or unblock that Grindr accepted. */
export function rememberBlockChange(owner: number | null, profileId: string, blocked: boolean): void {
	if (owner == null || getActiveChatDbUser() !== owner) return;
	const tracked = changesFor(owner);
	const change = { profileId, blocked, at: Date.now() };
	tracked.pending.push(change);
	tracked.recent.push(change);
	if (!flushTimer) flushTimer = setTimeout(() => void flushChanges(), FLUSH_DELAY_MS);
}

/** After Unblock All: nobody is blocked any more. */
export function rememberAllUnblocked(owner: number | null, requestedAt: number): void {
	if (owner == null || getActiveChatDbUser() !== owner) return;
	changesFor(owner).recent = [];
	rememberFullBlockList(owner, [], requestedAt);
}

export type LocalBlockList = {
	profileIds: string[];
	/** When the copy was last updated; null when it came from the Stats log alone. */
	savedAt: number | null;
	/** False when it may be missing people: built without Grindr ever sending the whole list. */
	complete: boolean;
};

/**
 * The block list as this device knows it. A copy Grindr once sent in full is
 * used as it is. Otherwise whatever there is gets topped up from the Stats
 * block log, which only covers blocks made while Stats was on.
 */
export async function getLocalBlockList(): Promise<LocalBlockList> {
	await flushChanges();
	const saved = await readSnapshot();
	if (saved?.fullListAt != null) {
		return { profileIds: saved.profileIds, savedAt: saved.savedAt, complete: true };
	}
	const logged = blockedFromStatsLog(
		await selectStatsRows<{ profile_id: string | null; event_type: string; timestamp: number }>(
			"SELECT profile_id, event_type, timestamp FROM stats_block_log WHERE profile_id IS NOT NULL",
		),
	);
	return {
		profileIds: [...new Set([...(saved?.profileIds ?? []), ...logged])],
		savedAt: saved?.savedAt ?? null,
		complete: false,
	};
}
