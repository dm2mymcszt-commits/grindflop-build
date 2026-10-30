/**
 * Saved copies of other people's profiles, on this device only.
 *
 * Grindr stops showing a profile the moment there is a block in either
 * direction, or the account is deleted: GET /v7/profiles/:id then answers
 * with an empty stub (see classifyProfileAccess). Every real answer is
 * therefore kept here as it passes through the API layer, so the profile page
 * can still show who someone was once only the stub is left.
 *
 * Two tiers share one store:
 *  - recent: profiles that could still be read when last asked. Capped, and
 *    the oldest go first — they can always be fetched again.
 *  - kept: profiles that can no longer be read (the stub came back, or this
 *    account blocked them). Their copy can't be replaced, so they are exempt
 *    from the recent cap and only trimmed against their own, larger one.
 *
 * One IndexedDB database per account, like interestViewsStore, so switching
 * accounts can neither leak nor mix copies. Not synced anywhere.
 */

import { profileDetailItemSchema, type ProfileDetail } from "../types/grid";
import { appLog } from "../utils/logger";
import { classifyProfileAccess } from "../utils/profileAccessStatus";
import {
	COPY_CLEANUP_INTERVAL_MS,
	KEPT_COPY_CAP,
	RECENT_COPY_CAP,
	compactProfileForStorage,
	countCopiesOverCap,
	isCopyRewriteDue,
} from "../utils/profileCopyRules";
import { getActiveChatDbUser } from "./chatDb";

const DB_NAME_PREFIX = "fg-profile-copies";
const DB_VERSION = 1;
const STORE_NAME = "copies";
const TIER_INDEX = "byTierSavedAt";

const RECENT = 0;
const KEPT = 1;
type Tier = typeof RECENT | typeof KEPT;

type StoredProfileCopy = {
	profileId: string;
	savedAt: number;
	/** IndexedDB can't index a boolean, hence the number. */
	kept: Tier;
	profile: Record<string, unknown>;
};

export type ProfileCopy = {
	profile: ProfileDetail;
	savedAt: number;
};

/** Last write or keep-mark per `${owner}:${profileId}`, to skip repeats. */
const lastTouchedAt = new Map<string, number>();
const MAX_TRACKED_TOUCHES = 5000;
const lastCleanupAt = new Map<number, number>();

function openDatabase(owner: number): Promise<IDBDatabase | null> {
	if (typeof indexedDB === "undefined") {
		return Promise.resolve(null);
	}
	return new Promise((resolve) => {
		try {
			const request = indexedDB.open(`${DB_NAME_PREFIX}-${owner}`, DB_VERSION);
			request.onupgradeneeded = () => {
				const db = request.result;
				if (!db.objectStoreNames.contains(STORE_NAME)) {
					const store = db.createObjectStore(STORE_NAME, { keyPath: "profileId" });
					store.createIndex(TIER_INDEX, ["kept", "savedAt"]);
				}
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = (event) => {
				appLog.warn("[profile-copies] could not open the store", event);
				resolve(null);
			};
		} catch (error) {
			appLog.warn("[profile-copies] could not open the store", error);
			resolve(null);
		}
	});
}

/** Runs `work` in one transaction and resolves once it has committed. */
async function withStore<T>(
	owner: number,
	mode: IDBTransactionMode,
	work: (store: IDBObjectStore, done: (value: T) => void) => void,
	fallback: T,
): Promise<T> {
	const db = await openDatabase(owner);
	if (!db) return fallback;
	return new Promise<T>((resolve) => {
		let result = fallback;
		try {
			const tx = db.transaction(STORE_NAME, mode);
			tx.oncomplete = () => {
				db.close();
				resolve(result);
			};
			tx.onerror = tx.onabort = (event) => {
				appLog.warn("[profile-copies] transaction failed", event);
				db.close();
				resolve(fallback);
			};
			work(tx.objectStore(STORE_NAME), (value) => {
				result = value;
			});
		} catch (error) {
			appLog.warn("[profile-copies] transaction failed", error);
			db.close();
			resolve(fallback);
		}
	});
}

function wasTouchedRecently(key: string, now: number): boolean {
	if (!isCopyRewriteDue(lastTouchedAt.get(key), now)) return true;
	if (lastTouchedAt.size >= MAX_TRACKED_TOUCHES) lastTouchedAt.clear();
	lastTouchedAt.set(key, now);
	return false;
}

function tierRange(tier: Tier): IDBKeyRange {
	return IDBKeyRange.bound([tier, 0], [tier, Number.MAX_SAFE_INTEGER]);
}

/** Drops the oldest copies of each tier beyond its cap. */
function trim(owner: number): Promise<void> {
	return withStore<void>(
		owner,
		"readwrite",
		(store) => {
			const index = store.index(TIER_INDEX);
			const tiers: Array<[Tier, number]> = [
				[RECENT, RECENT_COPY_CAP],
				[KEPT, KEPT_COPY_CAP],
			];
			for (const [tier, cap] of tiers) {
				const countRequest = index.count(tierRange(tier));
				countRequest.onsuccess = () => {
					let remaining = countCopiesOverCap(countRequest.result, cap);
					if (remaining === 0) return;
					// The index runs oldest first within a tier.
					const cursorRequest = index.openCursor(tierRange(tier));
					cursorRequest.onsuccess = () => {
						const cursor = cursorRequest.result;
						if (!cursor || remaining === 0) return;
						cursor.delete();
						remaining -= 1;
						cursor.continue();
					};
				};
			}
		},
		undefined,
	);
}

function trimIfDue(owner: number, now: number): void {
	const last = lastCleanupAt.get(owner) ?? 0;
	if (now - last < COPY_CLEANUP_INTERVAL_MS) return;
	lastCleanupAt.set(owner, now);
	void trim(owner);
}

/** The account whose store a profile answer should land in. */
export function profileCopyOwner(): number | null {
	return getActiveChatDbUser();
}

/**
 * Marks whatever copy exists for this profile as one that can't be replaced.
 * Nothing happens when there is no copy.
 */
export function keepProfileCopy(owner: number | null, profileId: string): void {
	if (owner == null || typeof indexedDB === "undefined") return;
	const id = String(profileId);
	if (wasTouchedRecently(`${owner}:keep:${id}`, Date.now())) return;
	void withStore<void>(
		owner,
		"readwrite",
		(store) => {
			const request = store.get(id);
			request.onsuccess = () => {
				const row = request.result as StoredProfileCopy | undefined;
				if (row && row.kept !== KEPT) {
					store.put({ ...row, kept: KEPT } satisfies StoredProfileCopy);
				}
			};
		},
		undefined,
	);
}

/**
 * Called with every answer of GET /v7/profiles/:id. `owner` is taken before
 * the request goes out, so an answer that arrives after an account switch
 * still lands in the store of the account that asked.
 *
 * A real profile is saved (again at most every few minutes). The stub means
 * the profile can no longer be read: the copy from before, if any, is now all
 * there is and gets marked to be kept.
 */
export function rememberProfileAnswer(owner: number | null, profile: ProfileDetail): void {
	if (owner == null || typeof indexedDB === "undefined") return;
	const profileId = String(profile.profileId);
	// This account's own profile is never the one that goes missing.
	if (profileId === String(owner)) return;

	if (classifyProfileAccess(profile) !== "accessible") {
		keepProfileCopy(owner, profileId);
		return;
	}

	const now = Date.now();
	if (wasTouchedRecently(`${owner}:save:${profileId}`, now)) return;
	// Readable again (an unblock): any earlier keep-mark no longer applies.
	lastTouchedAt.delete(`${owner}:keep:${profileId}`);
	const row: StoredProfileCopy = {
		profileId,
		savedAt: now,
		kept: RECENT,
		profile: compactProfileForStorage(profile),
	};
	void withStore<void>(owner, "readwrite", (store) => void store.put(row), undefined).then(() =>
		trimIfDue(owner, now),
	);
}

/** The saved copy of someone's profile for the active account, if there is one. */
export async function getProfileCopy(
	profileId: string,
	owner: number | null = getActiveChatDbUser(),
): Promise<ProfileCopy | null> {
	if (owner == null) return null;
	const id = String(profileId);
	const row = await withStore<StoredProfileCopy | null>(
		owner,
		"readonly",
		(store, done) => {
			const request = store.get(id);
			request.onsuccess = () => done((request.result as StoredProfileCopy | undefined) ?? null);
		},
		null,
	);
	if (!row) return null;
	// Through the schema again: it restores the defaults left out when saving,
	// and rejects a row written by a version whose shape no longer fits.
	const parsed = profileDetailItemSchema.safeParse({ ...row.profile, profileId: row.profileId });
	return parsed.success ? { profile: parsed.data, savedAt: row.savedAt } : null;
}
