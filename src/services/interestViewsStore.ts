import { appLog } from "../utils/logger";

type StoredInterestView = {
	profileId: string;
	displayName: string;
	imageHash: string | null;
	timestamp: number | null;
	viewCount: number | null;
	/**
	 * Individual view times we've actually observed, newest first.
	 *
	 * The API never returns a per-view history — each viewer entry carries only
	 * a running `viewedCount.totalCount` and the timestamp of their most recent
	 * view. So this is accumulated locally: every time an upsert reports a
	 * timestamp we haven't recorded yet, it's appended here. That makes the
	 * history exact (these are the server's own view timestamps, not poll
	 * times) but necessarily incomplete — it only covers views observed since
	 * this profile was first stored, and views that land between two polls
	 * collapse into the single most recent timestamp. Always <= viewCount.
	 */
	viewTimestamps?: number[];
	/**
	 * When this profile was first captured locally. Unlike `updatedAt` this is
	 * written once and never bumped, so it can serve as a stable age anchor for
	 * rows the server never gave a real view timestamp for.
	 *
	 * Without it, expiry fell back to `updatedAt` — which every poll rewrote —
	 * so any row with a null `timestamp` reset its own age on every sweep and
	 * could never age out. Those immortal rows are what drove the store to its
	 * cap and made the saved-profile count meaningless.
	 */
	firstSeenAt?: number;
	updatedAt: number;
};

/**
 * Per-account database naming. The store used to be a single device-global
 * `open-grind-interest` db, which meant a profile that viewed account A kept
 * showing up — with A's view count and history — after switching to account B:
 * account switching clears the query cache and repoints the chat db
 * (setActiveChatDbUser), but nothing ever touched this one. Each account now
 * gets its own database, mirroring how chatDb gives each account its own
 * sqlite file, so switching can neither leak nor merge viewer history.
 */
const DB_NAME_PREFIX = "open-grind-interest";
/**
 * The pre-multi-account database name. Kept only as a migration source: the
 * first account to activate adopts its rows, exactly as chatDb's legacy file
 * is renamed into the first account that opens it. Which account that history
 * belonged to can't be known after the fact, so "whoever logs in first" is the
 * same best guess chat already makes.
 */
const LEGACY_DB_NAME = DB_NAME_PREFIX;
const LEGACY_ADOPTED_KEY = "fg-interest-db-legacy-adopted";
const DB_VERSION = 1;
const STORE_NAME = "views";

/**
 * The active account id, as AuthContext already persists it for exactly this
 * purpose (chatService reads the same key). Reading it synchronously
 * is what makes the store self-sufficient: an earlier version waited to be told
 * which account it belonged to, and any path that reached the store first — a
 * cold-start Interest fetch, or a hot-reload that reset module state without
 * remounting AuthContext — silently read an empty database. Every profile then
 * came back as a locked "Unknown Profile" preview, because view recovery
 * matches incoming previews against these very rows.
 */
const AUTH_USER_ID_STORAGE_KEY = "fg-user-id";

/**
 * Set only by setActiveInterestViewsUser. `undefined` means "nobody has told us
 * yet" — fall back to the persisted id above, which is already correct for a
 * cold start since it survives from the previous session. Once AuthContext does
 * speak, its value wins, so an account switch takes effect immediately rather
 * than waiting for the storage write.
 */
let activeDbNameOverride: string | null | undefined = undefined;

function dbNameForUser(profileId: number | string | null): string | null {
	return profileId != null && String(profileId).length > 0
		? `${DB_NAME_PREFIX}-${profileId}`
		: null;
}

/**
 * Never returns null. When the account genuinely can't be determined — first
 * ever launch, logged out, storage unavailable — the store falls back to the
 * shared pre-multi-account database rather than parking on an empty one.
 *
 * That is the old, unisolated behaviour, and it is deliberately the floor
 * here: isolation matters, but silently reading an empty database is the worse
 * failure. It makes every incoming preview unmatchable, so the Interest list
 * renders as a wall of locked "Unknown Profile" rows and the sweep's banked
 * profile ids look lost. An unidentifiable account is also the one case where
 * there is no other account's data to leak into.
 */
function resolveDbName(): string {
	if (activeDbNameOverride !== undefined) {
		return activeDbNameOverride ?? LEGACY_DB_NAME;
	}
	try {
		return (
			dbNameForUser(window.localStorage.getItem(AUTH_USER_ID_STORAGE_KEY)) ??
			LEGACY_DB_NAME
		);
	} catch {
		return LEGACY_DB_NAME;
	}
}

/**
 * Hard cap on retained profiles. Deliberately generous: the whole point of the
 * background sweep is to bank real profile IDs before they fall behind the
 * paywall, so evicting them defeats the feature. Rows are small (a few hundred
 * bytes plus at most MAX_VIEW_TIMESTAMPS numbers), so even a full store is a
 * handful of MB in IndexedDB.
 */
const MAX_STORED_VIEWS = 10000;
const MAX_VIEW_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
/** Per-profile cap on the locally accumulated view history. */
const MAX_VIEW_TIMESTAMPS = 100;
/**
 * Minimum gap between cleanup passes. cleanup() reads and rewrites the whole
 * store, and every upsert used to trigger one — at a 10s sweep interval that
 * was a full scan every 10 seconds for no benefit, since nothing ages out that
 * fast.
 */
const CLEANUP_MIN_INTERVAL_MS = 5 * 60 * 1000;

let lastCleanupAt = 0;

function isPreviewId(profileId: string): boolean {
	return profileId.startsWith("preview:");
}

/**
 * The timestamp a row's age is measured from: when they actually viewed us if
 * the server told us, otherwise when we first saw the row. Never `updatedAt`,
 * which moves every time we re-persist an unchanged row.
 */
function viewAgeAnchor(row: StoredInterestView): number {
	return row.timestamp ?? row.firstSeenAt ?? row.updatedAt;
}

/**
 * Single source of truth for "should this row still be visible/counted".
 * getAll, summarizeStored, getByProfileId and cleanup all defer to it so the
 * number shown in Settings can never drift from what the Interest list holds.
 */
function isRetainableRow(row: StoredInterestView, now: number): boolean {
	if (!row?.profileId || isPreviewId(row.profileId)) return false;
	return now - viewAgeAnchor(row) < MAX_VIEW_AGE_MS;
}

/**
 * Folds a newly reported "most recent view" time into a profile's accumulated
 * history, newest first and de-duplicated. Seeds the history from the row's
 * own timestamp the first time we see a profile, so a viewer we already knew
 * about before this feature existed still gets one real entry rather than
 * starting empty.
 */
function mergeViewTimestamps(
	existing: StoredInterestView | undefined,
	incomingTimestamp: number | null | undefined,
): number[] | undefined {
	const history = existing?.viewTimestamps ?? [];
	const seeded =
		history.length === 0 && existing?.timestamp != null ? [existing.timestamp] : history;

	if (incomingTimestamp == null) {
		return seeded.length > 0 ? seeded : undefined;
	}
	if (seeded.includes(incomingTimestamp)) {
		return seeded;
	}

	return [incomingTimestamp, ...seeded]
		.sort((a, b) => b - a)
		.slice(0, MAX_VIEW_TIMESTAMPS);
}

/**
 * The count to store for a viewer, which must never drop below what we can
 * already prove.
 *
 * The incoming row's count is rebuilt from the API on every poll, so writing
 * it straight through let a smaller server figure overwrite a larger one — and
 * overwrite the count implied by the view history this store accumulates
 * itself. That is how a profile could show "2" next to a list of 8 recorded
 * views. Each view history entry is a distinct view time, so its length is a
 * floor; the previously stored count is another, since nobody can un-view a
 * profile. Taking the largest also matches what mergeStoredInterestViews
 * already does when two devices' rows meet during a sync.
 */
function resolveViewCount(
	existing: StoredInterestView | undefined,
	incomingViewCount: number | null | undefined,
	viewTimestamps: number[] | undefined,
): number | null {
	return (
		Math.max(
			existing?.viewCount ?? 0,
			incomingViewCount ?? 0,
			viewTimestamps?.length ?? 0,
		) || null
	);
}

/**
 * Whether an incoming row actually carries new information versus what's
 * already stored. Compares only the fields we persist from the server plus the
 * derived view history — deliberately not `updatedAt`, which is the bookkeeping
 * field this check exists to avoid touching.
 */
function hasMeaningfulChange(
	existing: StoredInterestView,
	incoming: Omit<StoredInterestView, "updatedAt">,
	nextViewTimestamps: number[] | undefined,
	nextViewCount: number | null,
): boolean {
	if (
		existing.displayName !== incoming.displayName ||
		existing.imageHash !== incoming.imageHash ||
		existing.timestamp !== incoming.timestamp ||
		existing.viewCount !== nextViewCount
	) {
		return true;
	}

	// Backfill for rows written before firstSeenAt existed, so they pick up a
	// stable age anchor on their next genuine update instead of relying on
	// updatedAt forever.
	if (existing.firstSeenAt == null) {
		return true;
	}

	const previous = existing.viewTimestamps;
	if (previous === nextViewTimestamps) return false;
	if (!previous || !nextViewTimestamps) return previous !== nextViewTimestamps;
	if (previous.length !== nextViewTimestamps.length) return true;
	return previous.some((value, index) => value !== nextViewTimestamps[index]);
}

function openDatabaseByName(name: string): Promise<IDBDatabase | null> {
	if (typeof window === "undefined" || !("indexedDB" in window)) {
		return Promise.resolve(null);
	}

	return new Promise((resolve) => {
		try {
			const request = window.indexedDB.open(name, DB_VERSION);

			request.onupgradeneeded = () => {
				const db = request.result;
				if (!db.objectStoreNames.contains(STORE_NAME)) {
					db.createObjectStore(STORE_NAME, { keyPath: "profileId" });
				}
			};

			request.onsuccess = () => resolve(request.result);
			request.onerror = (e) => {
				appLog.error("[interestStore] IDB Open Error", e);
				resolve(null);
			};
		} catch (err) {
			appLog.error("[interestStore] IDB Fatal Error", err);
			resolve(null);
		}
	});
}

/**
 * Every store operation funnels through here, so legacy adoption is awaited
 * before the first read rather than racing it. Without that, the first
 * getAll() after upgrading could return an empty account database while the
 * copy was still in flight, and the Interest list would render a full page of
 * unrecoverable previews.
 */
async function openDatabase(): Promise<IDBDatabase | null> {
	const dbName = resolveDbName();
	await ensureLegacyAdopted(dbName);
	return openDatabaseByName(dbName);
}

/** null on failure, as distinct from an empty (or absent) database. */
function readAllRows(dbName: string): Promise<StoredInterestView[] | null> {
	return openDatabaseByName(dbName).then(
		(db) =>
			new Promise<StoredInterestView[] | null>((resolve) => {
				if (!db) {
					resolve(null);
					return;
				}
				try {
					const request = db
						.transaction(STORE_NAME, "readonly")
						.objectStore(STORE_NAME)
						.getAll();
					request.onsuccess = () => {
						const rows = (request.result as StoredInterestView[]) || [];
						db.close();
						resolve(rows);
					};
					request.onerror = () => {
						db.close();
						resolve(null);
					};
				} catch {
					db.close();
					resolve(null);
				}
			}),
	);
}

/**
 * Copies rows verbatim — a raw `put`, not upsertMany — so adopted rows keep
 * their own firstSeenAt/updatedAt/viewTimestamps. Rewriting them through the
 * normal upsert path would stamp today's `updatedAt` on 30-day-old rows and
 * reset the very age anchors the expiry sweep reads.
 */
function writeRowsVerbatim(dbName: string, rows: StoredInterestView[]): Promise<boolean> {
	return openDatabaseByName(dbName).then(
		(db) =>
			new Promise<boolean>((resolve) => {
				if (!db) {
					resolve(false);
					return;
				}
				try {
					const tx = db.transaction(STORE_NAME, "readwrite");
					const store = tx.objectStore(STORE_NAME);
					for (const row of rows) {
						if (row?.profileId && !isPreviewId(row.profileId)) {
							store.put(row);
						}
					}
					tx.oncomplete = () => {
						db.close();
						resolve(true);
					};
					tx.onerror = () => {
						db.close();
						resolve(false);
					};
				} catch {
					db.close();
					resolve(false);
				}
			}),
	);
}

/**
 * Hands the pre-multi-account store's rows to the first account that asks for
 * one.
 *
 * Deliberately never deletes the legacy database. An earlier version did, and
 * combined with the activation gap above that meant a single failed adoption
 * would have destroyed every banked profile id on the device — the one thing
 * the background sweep exists to accumulate. The adoption marker already stops
 * a second account from inheriting the same history, so keeping the old
 * database costs an unread copy on disk and buys an undo. clear() removes it
 * along with everything else when the user actually asks to wipe the store.
 *
 * Marks adoption complete only after the copy is verified present in the
 * target, so a read or write that failed is retried on the next launch instead
 * of being silently recorded as done.
 */
async function adoptLegacyDatabase(targetDbName: string): Promise<void> {
	if (typeof window === "undefined" || !("indexedDB" in window)) return;
	if (targetDbName === LEGACY_DB_NAME) return;

	try {
		if (window.localStorage.getItem(LEGACY_ADOPTED_KEY)) return;
	} catch {
		// No localStorage means no way to record that adoption happened, and
		// re-adopting on every switch would copy one account's viewers into
		// every other. Skipping is the safe direction.
		return;
	}

	try {
		const legacyRows = await readAllRows(LEGACY_DB_NAME);
		if (legacyRows === null) {
			appLog.warn("[interestStore] legacy read failed; will retry next launch");
			return;
		}

		// writeRowsVerbatim deliberately drops preview placeholders, which older
		// versions of the sweep did persist. The verification below therefore
		// has to count what was actually eligible to copy — measuring against
		// the raw legacy count leaves adoption permanently "unverified" the
		// moment the legacy database holds a single preview row, and every
		// account that activates afterwards adopts the same history again.
		const eligibleRows = legacyRows.filter(
			(row) => row?.profileId && !isPreviewId(row.profileId),
		);

		if (eligibleRows.length > 0) {
			const wrote = await writeRowsVerbatim(targetDbName, eligibleRows);
			if (!wrote) {
				appLog.warn("[interestStore] legacy copy failed; will retry next launch");
				return;
			}
			const targetRows = await readAllRows(targetDbName);
			if (targetRows === null || targetRows.length < eligibleRows.length) {
				appLog.warn("[interestStore] legacy copy unverified; will retry next launch");
				return;
			}
			appLog.info(
				`[interestStore] adopted ${eligibleRows.length} legacy rows -> ${targetDbName}`,
			);
		}
	} catch (err) {
		appLog.warn("[interestStore] legacy adoption failed", err);
		return;
	}

	try {
		window.localStorage.setItem(LEGACY_ADOPTED_KEY, "1");
	} catch {}
}

/**
 * One adoption attempt per database per session, awaited by every caller so
 * none of them can read past a copy still in progress.
 */
const adoptionByDbName = new Map<string, Promise<void>>();

function ensureLegacyAdopted(dbName: string): Promise<void> {
	let pending = adoptionByDbName.get(dbName);
	if (!pending) {
		pending = adoptLegacyDatabase(dbName).catch(() => {});
		adoptionByDbName.set(dbName, pending);
	}
	return pending;
}

/**
 * Points the viewer store at the given account's own database. Called from the
 * same AuthContext effect that repoints the chat db, so every account-scoped
 * store switches together. Passing null (logged out) parks the store: reads
 * return empty and writes no-op until an account is active again.
 *
 * This is an override, not the only source of truth — the store falls back to
 * the persisted account id when it hasn't been called, so a missed call can no
 * longer strand it on an empty database.
 */
export function setActiveInterestViewsUser(
	profileId: number | string | null,
): Promise<void> {
	const nextDbName = dbNameForUser(profileId);
	if (nextDbName === activeDbNameOverride) return Promise.resolve();

	// Deliberately NOT an async function: the switch has to land synchronously
	// at the call site. AuthContext observes the account change and then awaits
	// the chat db swap; anything that reads or writes viewer rows in that gap —
	// a remounted BackgroundViewScanner, a refetched Interest query — would
	// otherwise still resolve to the previous account's database and mix the
	// new account's viewers into it.
	activeDbNameOverride = nextDbName;
	// The new database has its own expiry backlog; don't let the previous
	// account's rate limit suppress its first sweep.
	lastCleanupAt = 0;

	return nextDbName ? ensureLegacyAdopted(nextDbName) : Promise.resolve();
}

/**
 * Opaque token for "which account's store is active right now". A caller that
 * is about to fetch grabs one first and hands it back with the write, so a
 * response that arrives after an account switch is dropped instead of being
 * persisted into whichever account happens to be active by then.
 */
export function getActiveInterestViewsAccount(): string {
	return resolveDbName();
}

/** Stable account token used by callers that must reject account-switch races. */
export function getInterestViewsAccountForUser(
	profileId: number | string | null,
): string {
	return dbNameForUser(profileId) ?? LEGACY_DB_NAME;
}

export const interestViewsStore = {
	/**
	 * Raw row count, including preview placeholders and rows past the age
	 * window that cleanup hasn't collected yet. Almost never what a UI wants —
	 * use summarizeStored() for anything user-facing.
	 */
	async count(): Promise<number> {
		const db = await openDatabase();
		if (!db) return 0;

		return new Promise((resolve) => {
			try {
				const tx = db.transaction(STORE_NAME, "readonly");
				const store = tx.objectStore(STORE_NAME);
				const req = store.count();

				req.onsuccess = () => {
					const c = req.result || 0;
					db.close();
					resolve(c);
				};
				req.onerror = () => {
					db.close();
					resolve(0);
				};
			} catch {
				db.close();
				resolve(0);
			}
		});
	},

	/**
	 * How many real, in-window profiles we're actually holding — the number
	 * that matches what the Interest list can show and what the sweep has
	 * genuinely banked — plus how far back that reaches.
	 *
	 * Counts against the same predicate getAll() filters by, so the two can't
	 * disagree. It deliberately does NOT apply getAll()'s display cap: this is
	 * "how many did we save", not "how many fit on screen", and reporting the
	 * cap back as if it were a total is what made the old counter read a flat
	 * 2000 once the store saturated.
	 *
	 * `count` can briefly exceed `capacity`: upserts land immediately, but the
	 * trim back down to the cap waits for the rate-limited cleanup.
	 * `oldestKeptAt` is measured past that pending trim — the age anchor of the
	 * oldest row cleanup will keep, using the same ordering it evicts by — so it
	 * shows how much of the MAX_VIEW_AGE_MS window the cap actually leaves.
	 */
	async summarizeStored(): Promise<{
		count: number;
		capacity: number;
		oldestKeptAt: number | null;
	}> {
		const empty = { count: 0, capacity: MAX_STORED_VIEWS, oldestKeptAt: null };
		const db = await openDatabase();
		if (!db) return empty;

		return new Promise((resolve) => {
			try {
				const tx = db.transaction(STORE_NAME, "readonly");
				const store = tx.objectStore(STORE_NAME);
				const request = store.getAll();

				request.onsuccess = () => {
					const rows = (request.result as StoredInterestView[]) || [];
					const now = Date.now();
					const anchors: number[] = [];
					for (const row of rows) {
						if (isRetainableRow(row, now)) anchors.push(viewAgeAnchor(row));
					}
					anchors.sort((a, b) => b - a);
					const kept = Math.min(anchors.length, MAX_STORED_VIEWS);
					db.close();
					resolve({
						count: anchors.length,
						capacity: MAX_STORED_VIEWS,
						oldestKeptAt: kept > 0 ? anchors[kept - 1] : null,
					});
				};
				request.onerror = (event) => {
					appLog.error("[interestStore] summarizeStored request failed", event);
					db.close();
					resolve(empty);
				};
			} catch (err) {
				appLog.error("[interestStore] summarizeStored failed", err);
				db.close();
				resolve(empty);
			}
		});
	},

	/**
	 * Single-profile lookup — profileId is the store's keyPath, so this is a
	 * direct key hit rather than the full scan + sort + slice getAll() does.
	 * Applies the same age/preview filtering as getAll() so callers can't get
	 * a row back here that getAll() would have dropped.
	 */
	async getByProfileId(profileId: string): Promise<StoredInterestView | null> {
		if (!profileId || isPreviewId(profileId)) return null;

		const db = await openDatabase();
		if (!db) return null;

		return new Promise((resolve) => {
			try {
				const tx = db.transaction(STORE_NAME, "readonly");
				const store = tx.objectStore(STORE_NAME);
				const request = store.get(profileId);

				request.onsuccess = () => {
					const row = (request.result as StoredInterestView | undefined) ?? null;
					db.close();
					if (!row) {
						resolve(null);
						return;
					}
					resolve(isRetainableRow(row, Date.now()) ? row : null);
				};

				request.onerror = (event) => {
					appLog.error("[interestStore] getByProfileId request failed", event);
					db.close();
					resolve(null);
				};
			} catch (err) {
				appLog.error("[interestStore] getByProfileId failed", err);
				db.close();
				resolve(null);
			}
		});
	},

	async getAll(): Promise<StoredInterestView[]> {
		const db = await openDatabase();
		if (!db) return [];

		return new Promise((resolve) => {
			const tx = db.transaction(STORE_NAME, "readonly");
			const store = tx.objectStore(STORE_NAME);
			const request = store.getAll();

			request.onsuccess = () => {
				const rows = (request.result as StoredInterestView[]) || [];
				const now = Date.now();

				// 1. Filter: Only return data younger than 30 days & non-previews
				const activeRows = rows.filter((row) => isRetainableRow(row, now));

				// 2. Sort: Newest first
				activeRows.sort((a, b) => viewAgeAnchor(b) - viewAgeAnchor(a));

				db.close();

				// 3. Limit: Return maximum MAX_STORED_VIEWS entries
				resolve(activeRows.slice(0, MAX_STORED_VIEWS));
			};

			request.onerror = (event) => {
				appLog.error("[interestStore] getAll request failed", event);
				db.close();
				resolve([]);
			};
		});
	},

	async upsertMany(
		rows: Omit<StoredInterestView, "updatedAt">[],
		expectedAccount?: string,
	): Promise<void> {
		// Late arrival from a fetch that started under a different account.
		// Writing it now would file one account's viewers under another.
		if (expectedAccount !== undefined && expectedAccount !== resolveDbName()) {
			appLog.warn("[interestStore] dropped write from a previous account");
			return;
		}

		// Preview placeholders are transient UI artifacts, not captures: their
		// synthetic ids aren't even stable across refreshes (an unhashed preview
		// keys off its list index), so persisting them mints fresh junk rows on
		// every poll. The sweep already filtered them out; enforce it here too so
		// no caller can reintroduce the leak.
		const writableRows = rows.filter((row) => row?.profileId && !isPreviewId(row.profileId));
		if (writableRows.length === 0) return;

		const db = await openDatabase();
		if (!db) return;

		return new Promise((resolve) => {
			// A session can end by completing, erroring or aborting. Each path has
			// to close the connection and settle the caller exactly once.
			let settled = false;
			const settle = () => {
				if (settled) return;
				settled = true;
				db.close();
				resolve();
			};

			let tx: IDBTransaction;
			try {
				tx = db.transaction(STORE_NAME, "readwrite");
			} catch (error) {
				appLog.warn("[interestStore] could not start an upsert transaction", error);
				settle();
				return;
			}
			const store = tx.objectStore(STORE_NAME);
			const now = Date.now();

			// Once a transaction has aborted — iOS can end one when it suspends
			// the app — every request still queued reports an error, and a put
			// issued from those handlers throws rather than failing quietly.
			// Nothing caught that, so it surfaced as the full-screen crash overlay.
			const putSafely = (value: StoredInterestView) => {
				try {
					store.put(value);
				} catch (error) {
					appLog.warn("[interestStore] skipped a write to a finished transaction", error);
				}
			};

			for (const row of writableRows) {
				// Read-modify-write rather than a blind put: the incoming row is
				// rebuilt from the API response and has no viewTimestamps, so
				// overwriting would wipe the locally accumulated history on every
				// poll. Every writer funnels through here, so this is the one place
				// that needs to own the accumulation.
				const existingRequest = store.get(row.profileId);
				existingRequest.onsuccess = () => {
					const existing = existingRequest.result as StoredInterestView | undefined;
					const viewTimestamps = mergeViewTimestamps(existing, row.timestamp);
					const viewCount = resolveViewCount(existing, row.viewCount, viewTimestamps);

					// Skip writes that would change nothing. Callers hand us the whole
					// merged cache every sweep, so the vast majority of rows are
					// identical to what's already stored — rewriting them burned
					// thousands of IDB ops per poll and, worse, kept bumping
					// `updatedAt`, which is what let stale rows dodge expiry forever.
					if (
						existing &&
						!hasMeaningfulChange(existing, row, viewTimestamps, viewCount)
					) {
						return;
					}

					putSafely({
						...row,
						viewCount,
						viewTimestamps,
						// Set once on first capture, preserved on every later write.
						firstSeenAt: existing?.firstSeenAt ?? row.timestamp ?? now,
						updatedAt: now,
					});
				};
				existingRequest.onerror = (event) => {
					// Left alone, one failed read aborts the whole batch and takes every
					// other row's write with it. Keep the transaction alive, and keep the
					// error from bubbling to tx.onerror, which would settle mid-batch.
					event.preventDefault();
					event.stopPropagation();
					// Couldn't read the prior row — still store the update rather than
					// dropping it, just without carrying history forward.
					const viewTimestamps = row.timestamp != null ? [row.timestamp] : undefined;
					putSafely({
						...row,
						viewCount: resolveViewCount(undefined, row.viewCount, viewTimestamps),
						viewTimestamps,
						firstSeenAt: row.timestamp ?? now,
						updatedAt: now,
					});
				};
			}

			tx.oncomplete = () => {
				settle();
				void this.maybeCleanup();
			};

			tx.onerror = (e) => {
				appLog.error("[interestStore] IDB Upsert Error", e);
				settle();
			};

			// Without this an aborted session never settled: the caller's await
			// hung forever and the connection stayed open.
			tx.onabort = () => {
				appLog.warn("[interestStore] upsert transaction aborted", tx.error);
				settle();
			};
		});
	},

	/**
	 * Rate-limited cleanup for the hot path. Nothing ages out fast enough to
	 * justify a full-store scan after every sweep, and at a 10s scan interval
	 * that was exactly what used to happen.
	 */
	async maybeCleanup(): Promise<void> {
		const now = Date.now();
		if (now - lastCleanupAt < CLEANUP_MIN_INTERVAL_MS) return;
		lastCleanupAt = now;
		await this.cleanup();
	},

	async cleanup(): Promise<void> {
		lastCleanupAt = Date.now();
		const db = await openDatabase();
		if (!db) return;

		return new Promise((resolve) => {
			const tx = db.transaction(STORE_NAME, "readwrite");
			const store = tx.objectStore(STORE_NAME);
			const request = store.getAll();

			request.onsuccess = () => {
				const rows = (request.result as StoredInterestView[]) || [];
				const now = Date.now();
				// A Set, not an array: the old code ran `toDelete.includes(...)`
				// inside a filter over every row, which is quadratic and got
				// genuinely slow once the store filled up.
				const toDelete = new Set<string>();

				// 1. Drop preview placeholders and anything past the age window.
				//    Note this never blanket-clears the store the way the old
				//    ">3000 rows" escape hatch did — that threw away every real
				//    profile ID the sweep had banked, which is the exact data this
				//    feature exists to keep.
				const keepable: StoredInterestView[] = [];
				for (const row of rows) {
					if (!row?.profileId) continue;
					if (isRetainableRow(row, now)) {
						keepable.push(row);
					} else {
						toDelete.add(row.profileId);
					}
				}

				// 2. If still over the cap, evict the oldest views first.
				if (keepable.length > MAX_STORED_VIEWS) {
					keepable.sort((a, b) => viewAgeAnchor(b) - viewAgeAnchor(a));
					for (const row of keepable.slice(MAX_STORED_VIEWS)) {
						toDelete.add(row.profileId);
					}
				}

				for (const id of toDelete) {
					store.delete(id);
				}
			};

			tx.oncomplete = () => {
				db.close();
				resolve();
			};

			tx.onerror = (event) => {
				appLog.error("[interestStore] cleanup transaction failed", event);
				db.close();
				resolve();
			};
		});
	},

	async clear(): Promise<void> {
		const dbName = resolveDbName();

		// The one place the legacy database is removed: the user explicitly
		// asked to wipe saved profiles, so leaving an unread copy behind would
		// be the wrong kind of safe.
		try {
			window.indexedDB.deleteDatabase(LEGACY_DB_NAME);
		} catch {}

		const db = await openDatabase();
		if (!db) {
			try {
				window.indexedDB.deleteDatabase(dbName);
			} catch {}
			return;
		}

		return new Promise((resolve) => {
			let isDone = false;
			const finish = () => {
				if (isDone) return;
				isDone = true;
				try { db.close(); } catch {}
				resolve();
			};

			try {
				const tx = db.transaction(STORE_NAME, "readwrite");
				const store = tx.objectStore(STORE_NAME);
				store.clear();

				tx.oncomplete = finish;
				tx.onerror = finish;
			} catch {
				finish();
			}

			// Timeout fallback
			setTimeout(() => {
				if (!isDone) {
					finish();
					try { window.indexedDB.deleteDatabase(dbName); } catch {}
				}
			}, 1000);
		});
	},

	async deleteMany(ids: string[]): Promise<void> {
		const db = await openDatabase();
		if (!db) return;

		return new Promise((resolve) => {
			const tx = db.transaction(STORE_NAME, "readwrite");
			const store = tx.objectStore(STORE_NAME);
			for (const id of ids) {
				store.delete(id);
			}

			tx.oncomplete = () => {
				db.close();
				resolve();
			};

			tx.onerror = (event) => {
				appLog.error("[interestStore] deleteMany transaction failed", event);
				db.close();
				resolve();
			};
		});
	},
};

export type { StoredInterestView };

/**
 * Another account's stored viewers on this device, for moving its history.
 * Null when they can't be read; an account that never stored any reads as
 * empty.
 */
export function readInterestViewRowsForAccount(
	profileId: number | string,
): Promise<StoredInterestView[] | null> {
	const dbName = dbNameForUser(profileId);
	return dbName ? readAllRows(dbName) : Promise.resolve(null);
}
// ---------------------------------------------------------------------------
// Backup export/import
//
// Thin wrappers over the adoption primitives above, which already do exactly
// the right thing for a device transfer. writeRowsVerbatim in particular is
// the reason this isn't just `upsertMany`: it copies rows with a raw `put`, so
// firstSeenAt / updatedAt / viewTimestamps survive intact. Re-importing
// through the normal upsert path would stamp today's updatedAt onto month-old
// rows and reset the very age anchors the expiry sweep reads.
// ---------------------------------------------------------------------------

/** Every banked viewer row for the active account, or null if unreadable. */
export function exportInterestViewRows(): Promise<StoredInterestView[] | null> {
	return readAllRows(resolveDbName());
}

/**
 * Folds imported rows into whatever this device already banked.
 *
 * Deliberately not a plain `put`. Two devices scanning independently each
 * observe views the other never saw, so the union is the only result that
 * satisfies "same stats on both". A blind overwrite would also let a backup
 * taken on a device that had been closed for days replace a live row with a
 * staler one, throwing away view history the importing device had collected
 * in the meantime.
 *
 * Field by field: view times are unioned, `firstSeenAt` keeps the earliest
 * sighting (it is the age anchor the expiry sweep reads, so the older one is
 * the true one), counters take the larger side, and the descriptive fields
 * follow whichever row was updated more recently.
 */
export function mergeInterestViewRow(
	existing: StoredInterestView | undefined,
	incoming: StoredInterestView,
): StoredInterestView {
	if (!existing) {
		return incoming;
	}

	const times = new Set<number>([
		...(existing.viewTimestamps ?? []),
		...(incoming.viewTimestamps ?? []),
	]);
	for (const row of [existing, incoming]) {
		if (row.timestamp != null) {
			times.add(row.timestamp);
		}
	}
	const viewTimestamps = [...times].sort((a, b) => b - a).slice(0, MAX_VIEW_TIMESTAMPS);
	const newer = (incoming.updatedAt ?? 0) >= (existing.updatedAt ?? 0) ? incoming : existing;

	return {
		profileId: existing.profileId,
		displayName: newer.displayName || existing.displayName || incoming.displayName,
		imageHash: newer.imageHash ?? existing.imageHash ?? incoming.imageHash,
		timestamp: Math.max(existing.timestamp ?? 0, incoming.timestamp ?? 0) || null,
		viewCount: Math.max(existing.viewCount ?? 0, incoming.viewCount ?? 0) || null,
		viewTimestamps: viewTimestamps.length > 0 ? viewTimestamps : undefined,
		firstSeenAt:
			Math.min(
				existing.firstSeenAt ?? existing.updatedAt ?? Infinity,
				incoming.firstSeenAt ?? incoming.updatedAt ?? Infinity,
			) || undefined,
		updatedAt: Math.max(existing.updatedAt ?? 0, incoming.updatedAt ?? 0),
	};
}

export type InterestViewRowMutation =
	| { kind: "upsert"; row: StoredInterestView }
	| { kind: "delete" };

export type InterestViewCompareAndApplyResult =
	| "already-current"
	| "changed"
	| "applied";

export type InterestViewRowPredicate = (
	currentRow: Readonly<StoredInterestView> | null,
) => boolean;

/**
 * Compares and mutates one viewer row inside a single IndexedDB read/write
 * transaction. Transactions touching the same object store are ordered by
 * IndexedDB, so a concurrent local write is either visible to the predicates
 * or runs afterwards and remains the final value.
 */
export async function compareAndApplyInterestViewRow(
	profileId: string,
	mutation: InterestViewRowMutation,
	options: Readonly<{
		matchesIncoming: InterestViewRowPredicate;
		matchesExpected: InterestViewRowPredicate;
	}>,
): Promise<InterestViewCompareAndApplyResult> {
	if (!profileId || isPreviewId(profileId)) {
		throw new Error("A synchronized viewed-profile row requires a real profile id");
	}
	if (mutation.kind === "upsert" && mutation.row.profileId !== profileId) {
		throw new Error("The synchronized viewed-profile row does not match its profile id");
	}

	const db = await openDatabase();
	if (!db) {
		throw new Error("The viewed-profile database could not be opened");
	}

	return new Promise<InterestViewCompareAndApplyResult>((resolve, reject) => {
		let result: InterestViewCompareAndApplyResult | null = null;
		let failure: unknown = null;
		let settled = false;
		const fail = (error: unknown) => {
			failure ??= error;
		};
		const finish = (
			complete: (value: InterestViewCompareAndApplyResult) => void,
		) => {
			if (settled) return;
			settled = true;
			try {
				db.close();
			} catch {
				// The transaction result is already authoritative.
			}
			if (failure !== null || result === null) {
				reject(
					failure instanceof Error
						? failure
						: new Error("The viewed-profile compare-and-apply transaction failed"),
				);
				return;
			}
			complete(result);
		};

		try {
			const transaction = db.transaction(STORE_NAME, "readwrite");
			const store = transaction.objectStore(STORE_NAME);
			const request = store.get(profileId);
			request.onsuccess = () => {
				try {
					const current = (request.result as StoredInterestView | undefined) ?? null;
					if (options.matchesIncoming(current)) {
						result = "already-current";
						return;
					}
					if (!options.matchesExpected(current)) {
						result = "changed";
						return;
					}
					if (mutation.kind === "delete") {
						store.delete(profileId);
					} else {
						store.put(
							mergeInterestViewRow(current ?? undefined, mutation.row),
						);
					}
					result = "applied";
				} catch (error) {
					fail(error);
					transaction.abort();
				}
			};
			request.onerror = () => {
				fail(request.error ?? new Error("The viewed-profile row could not be read"));
				transaction.abort();
			};
			transaction.oncomplete = () => finish(resolve);
			transaction.onerror = () => {
				fail(transaction.error);
				finish(resolve);
			};
			transaction.onabort = () => {
				fail(transaction.error);
				finish(resolve);
			};
		} catch (error) {
			fail(error);
			finish(resolve);
		}
	});
}

/** Merges imported rows into this account's store. False if the write failed. */
export async function importInterestViewRows(
	rows: StoredInterestView[],
): Promise<boolean> {
	const dbName = resolveDbName();
	const current = await readAllRows(dbName);
	if (current === null) {
		// Can't read what's here, so a write would be a blind overwrite.
		return false;
	}

	const byId = new Map(current.map((row) => [row.profileId, row]));
	const merged = rows
		.filter((row) => row?.profileId && !isPreviewId(row.profileId))
		.map((row) => mergeInterestViewRow(byId.get(row.profileId), row));

	return writeRowsVerbatim(dbName, merged);
}
