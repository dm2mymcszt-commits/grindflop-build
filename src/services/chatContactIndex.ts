import Database from "@tauri-apps/plugin-sql";
import { BaseDirectory, exists, rename } from "@tauri-apps/plugin-fs";
import type {
	ChatContactIndexRecord,
	GridContactIndexInput,
	InboxContactIndexInput,
} from "../types/chat-contact-index";
import { appLog } from "../utils/logger";
import { guardAgainstClosedPool } from "./sqlitePoolGuard";

const LEGACY_CHAT_INDEX_DB_FILENAME = "chat_contact_index.sqlite3";
const LEGACY_CHAT_INDEX_DB = `sqlite:${LEGACY_CHAT_INDEX_DB_FILENAME}`;
const SQLITE_BUSY_TIMEOUT_MS = 5_000;
const SQLITE_LOCK_RETRY_DELAYS_MS = [30, 80, 180, 350] as const;

type ChatContactIndexRow = {
	profile_id: string;
	conversation_id: string | null;
	last_message_timestamp: number | null;
	unread_count: number;
	has_chatted: number | boolean;
	updated_at: number;
};

type LocalNicknameRow = {
	profile_id: string;
	local_nickname: string;
};

let dbPromise: Promise<Database> | null = null;
let writeQueue: Promise<void> = Promise.resolve();
let activeChatIndexDbName = LEGACY_CHAT_INDEX_DB;
let activeChatIndexProfileId: number | null = null;

async function getDb(): Promise<Database> {
	if (!dbPromise) {
		dbPromise = (async () => {
			const db = guardAgainstClosedPool(await Database.load(activeChatIndexDbName), "chat-index");
			// Enable WAL mode and a reasonable busy timeout to improve concurrency.
			// Note: We avoid manual BEGIN transactions because the Tauri plugin uses a connection pool
			// without session affinity, which makes manual transactions unreliable.
			try {
				await db.execute("PRAGMA journal_mode = WAL");
				await db.execute("PRAGMA synchronous = NORMAL");
				await db.execute(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
			} catch (error) {
				appLog.warn("[chat-index] failed to set pragmas", error);
			}

			// Ensure tables are created inside the serialized queue.
			await executeWithLockRetry(db, "init-tables", async () => {
				await db.execute(`
				CREATE TABLE IF NOT EXISTS chat_contact_index (
					profile_id TEXT PRIMARY KEY,
					conversation_id TEXT,
					last_message_timestamp INTEGER,
					unread_count INTEGER NOT NULL DEFAULT 0,
					has_chatted INTEGER NOT NULL DEFAULT 0,
					updated_at INTEGER NOT NULL
				)
			`);
				await db.execute(
					"CREATE INDEX IF NOT EXISTS idx_chat_contact_index_updated_at ON chat_contact_index(updated_at DESC)",
				);
				await db.execute(
					"CREATE INDEX IF NOT EXISTS idx_chat_contact_index_last_message ON chat_contact_index(last_message_timestamp DESC)",
				);
				await db.execute(`
				CREATE TABLE IF NOT EXISTS chat_local_profile_meta (
					profile_id TEXT PRIMARY KEY,
					local_nickname TEXT NOT NULL,
					updated_at INTEGER NOT NULL
				)
			`);
				await db.execute(
					"CREATE INDEX IF NOT EXISTS idx_chat_local_profile_meta_updated_at ON chat_local_profile_meta(updated_at DESC)",
				);
			});

			return db;
		})();
	}

	return dbPromise;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function isSqliteLockedError(error: unknown): boolean {
	if (typeof error !== "string") {
		const message = error instanceof Error ? error.message : JSON.stringify(error);
		if (!message) {
			return false;
		}
		return /database is locked|\(code:\s*(5|517)\)/i.test(message);
	}

	return /database is locked|\(code:\s*(5|517)\)/i.test(error);
}

async function executeWithLockRetry(
	_db: Database,
	label: string,
	run: () => Promise<void>,
): Promise<void> {
	const queuedRun = async () => {
		const maxAttempts = SQLITE_LOCK_RETRY_DELAYS_MS.length + 1;

		for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
			try {
				await run();
				if (attempt > 1) {
					appLog.warn("[chat-index] recovered from sqlite lock", {
						label,
						attempt,
					});
				}
				return;
			} catch (error) {
				const locked = isSqliteLockedError(error);
				if (!locked || attempt >= maxAttempts) {
					throw error;
				}

				const delayMs = SQLITE_LOCK_RETRY_DELAYS_MS[attempt - 1] ?? 400;
				appLog.warn("[chat-index] sqlite lock during write, retrying", {
					label,
					attempt,
					delayMs,
				});
				await sleep(delayMs);
			}
		}
	};

	const current = writeQueue.then(queuedRun, queuedRun);
	writeQueue = current.then(() => undefined, () => undefined);
	await current;
}

export async function initChatContactIndex(): Promise<void> {
	await getDb();
}

async function migrateLegacyContactIndexIfNeeded(profileId: number): Promise<void> {
	const targetFilename = `chat-contact-index-${profileId}.sqlite3`;
	try {
		const [targetExists, legacyExists] = await Promise.all([
			exists(targetFilename, { baseDir: BaseDirectory.AppData }),
			exists(LEGACY_CHAT_INDEX_DB_FILENAME, { baseDir: BaseDirectory.AppData }),
		]);
		if (!targetExists && legacyExists) {
			await rename(LEGACY_CHAT_INDEX_DB_FILENAME, targetFilename, {
				oldPathBaseDir: BaseDirectory.AppData,
				newPathBaseDir: BaseDirectory.AppData,
			});
			appLog.info(`[chat-index] migrated legacy contact index -> ${targetFilename}`);
		}
	} catch (error) {
		appLog.warn("[chat-index] legacy database migration check failed", error);
	}
}

/**
 * Selects the contact/nickname index belonging to the active Grindr profile.
 * The legacy shared database is adopted only once, by the first signed-in
 * profile that does not already have an account-specific index.
 */
export async function setActiveChatContactIndexUser(profileId: number | null): Promise<void> {
	const nextDbName =
		profileId != null
			? `sqlite:chat-contact-index-${profileId}.sqlite3`
			: LEGACY_CHAT_INDEX_DB;
	if (nextDbName === activeChatIndexDbName && dbPromise) {
		return;
	}

	if (dbPromise) {
		try {
			const db = await dbPromise;
			await db.close(db.path);
		} catch (error) {
			appLog.warn("[chat-index] failed to close previous connection", error);
		}
	}

	dbPromise = null;
	writeQueue = Promise.resolve();
	activeChatIndexDbName = nextDbName;
	activeChatIndexProfileId = profileId;

	if (profileId != null) {
		await migrateLegacyContactIndexIfNeeded(profileId);
	}
	await getDb();
}

export function getActiveChatContactIndexUser(): number | null {
	return activeChatIndexProfileId;
}

export async function upsertChatContactIndexFromInbox(
	entries: InboxContactIndexInput[],
): Promise<void> {
	if (entries.length === 0) {
		return;
	}

	const db = await getDb();
	const now = Date.now();

	await executeWithLockRetry(db, "upsert-from-inbox", async () => {
		for (const entry of entries) {
			const profileId = entry.profileId.trim();
			if (!profileId) {
				continue;
			}

			await db.execute(
				`
			INSERT INTO chat_contact_index (
				profile_id,
				conversation_id,
				last_message_timestamp,
				unread_count,
				has_chatted,
				updated_at
			) VALUES ($1, $2, $3, $4, 1, $5)
			ON CONFLICT(profile_id) DO UPDATE SET
				conversation_id = COALESCE(excluded.conversation_id, chat_contact_index.conversation_id),
				last_message_timestamp = CASE
					WHEN excluded.last_message_timestamp IS NULL THEN chat_contact_index.last_message_timestamp
					WHEN chat_contact_index.last_message_timestamp IS NULL THEN excluded.last_message_timestamp
					WHEN excluded.last_message_timestamp > chat_contact_index.last_message_timestamp THEN excluded.last_message_timestamp
					ELSE chat_contact_index.last_message_timestamp
				END,
				unread_count = COALESCE(excluded.unread_count, chat_contact_index.unread_count),
				has_chatted = 1,
				updated_at = excluded.updated_at
			`,
				[
					profileId,
					entry.conversationId,
					entry.lastMessageTimestamp,
					Math.max(0, entry.unreadCount ?? 0),
					now,
				],
			);
		}
	});

	// appLog.debug("[chat-index] upsert from inbox", { count: entries.length });
}

export async function upsertChatContactIndexFromGrid(
	entries: GridContactIndexInput[],
): Promise<void> {
	if (entries.length === 0) {
		return;
	}

	const db = await getDb();
	const now = Date.now();

	await executeWithLockRetry(db, "upsert-from-grid", async () => {
		for (const entry of entries) {
			const profileId = entry.profileId.trim();
			if (!profileId) {
				continue;
			}

			const unreadCount = Math.max(0, entry.unreadCount ?? 0);

			await db.execute(
				`
			INSERT INTO chat_contact_index (
				profile_id,
				conversation_id,
				last_message_timestamp,
				unread_count,
				has_chatted,
				updated_at
			) VALUES ($1, NULL, NULL, $2, CASE WHEN $2 > 0 THEN 1 ELSE 0 END, $3)
			ON CONFLICT(profile_id) DO UPDATE SET
				unread_count = CASE
					WHEN excluded.unread_count > chat_contact_index.unread_count THEN excluded.unread_count
					ELSE chat_contact_index.unread_count
				END,
				has_chatted = CASE
					WHEN chat_contact_index.has_chatted = 1 THEN 1
					WHEN excluded.unread_count > 0 THEN 1
					ELSE 0
				END,
				updated_at = excluded.updated_at
			`,
				[profileId, unreadCount, now],
			);
		}
	});
}

const SQLITE_MAX_VARIABLES = 900;

export async function getChatContactIndexForProfiles(
	profileIds: string[],
): Promise<ChatContactIndexRecord[]> {
	if (profileIds.length === 0) {
		return [];
	}

	const db = await getDb();
	const ids = profileIds.map((id) => id.trim()).filter(Boolean);
	if (ids.length === 0) {
		return [];
	}

	const results: ChatContactIndexRecord[] = [];
	for (let offset = 0; offset < ids.length; offset += SQLITE_MAX_VARIABLES) {
		const chunk = ids.slice(offset, offset + SQLITE_MAX_VARIABLES);
		const placeholders = chunk.map((_, index) => `$${index + 1}`).join(", ");
		const rows = await db.select<ChatContactIndexRow[]>(
			`
			SELECT
				profile_id,
				conversation_id,
				last_message_timestamp,
				unread_count,
				has_chatted,
				updated_at
			FROM chat_contact_index
			WHERE profile_id IN (${placeholders})
			`,
			chunk,
		);

		for (const row of rows) {
			results.push({
				profileId: row.profile_id,
				conversationId: row.conversation_id,
				lastMessageTimestamp: row.last_message_timestamp,
				unreadCount: row.unread_count,
				hasChatted: Boolean(row.has_chatted),
				updatedAt: row.updated_at,
			});
		}
	}

	return results;
}

export function indexChatContactRecordsByProfileId(
	records: ChatContactIndexRecord[],
): Record<string, ChatContactIndexRecord> {
	const next: Record<string, ChatContactIndexRecord> = {};
	for (const record of records) {
		next[record.profileId] = record;
	}
	return next;
}

/**
 * Increment the unread count for a profile in the local index.
 * Useful for realtime message arrivals when the full inbox isn't being reloaded.
 */
export async function incrementUnreadCountForProfile(
	profileId: string,
	conversationId: string,
	lastMessageTimestamp: number,
): Promise<void> {
	const normalizedProfileId = profileId?.trim();
	if (!normalizedProfileId || normalizedProfileId === "undefined" || normalizedProfileId === "null") {
		return;
	}

	const db = await getDb();
	const now = Date.now();

	await executeWithLockRetry(db, "increment-unread", async () => {
		await db.execute(
			`
			INSERT INTO chat_contact_index (
				profile_id,
				conversation_id,
				last_message_timestamp,
				unread_count,
				has_chatted,
				updated_at
			) VALUES ($1, $2, $3, 1, 1, $4)
			ON CONFLICT(profile_id) DO UPDATE SET
				conversation_id = COALESCE(excluded.conversation_id, chat_contact_index.conversation_id),
				last_message_timestamp = CASE
					WHEN excluded.last_message_timestamp > COALESCE(chat_contact_index.last_message_timestamp, 0)
					THEN excluded.last_message_timestamp
					ELSE chat_contact_index.last_message_timestamp
				END,
				unread_count = chat_contact_index.unread_count + 1,
				has_chatted = 1,
				updated_at = excluded.updated_at
			`,
			[normalizedProfileId, conversationId, lastMessageTimestamp, now],
		);
	});
}

/**
 * Reset the unread count to zero for a profile in the local index.
 */
export async function clearUnreadCountForProfile(
	profileId: string,
): Promise<void> {
	const normalizedProfileId = profileId.trim();
	if (!normalizedProfileId) {
		return;
	}

	const db = await getDb();
	const now = Date.now();

	await executeWithLockRetry(db, "clear-unread", async () => {
		await db.execute(
			`
			UPDATE chat_contact_index
			SET unread_count = 0, updated_at = $2
			WHERE profile_id = $1
			`,
			[normalizedProfileId, now],
		);
	});
}

export async function setLocalNicknameForProfile(
	profileId: string,
	nickname: string | null,
): Promise<void> {
	const normalizedProfileId = profileId.trim();
	if (!normalizedProfileId) {
		return;
	}

	const normalizedNickname = nickname?.trim() ?? "";
	const db = await getDb();

	await executeWithLockRetry(db, "set-local-nickname", async () => {
		if (!normalizedNickname) {
			await db.execute(
				"DELETE FROM chat_local_profile_meta WHERE profile_id = $1",
				[normalizedProfileId],
			);
			return;
		}

		await db.execute(
			`
			INSERT INTO chat_local_profile_meta (
				profile_id,
				local_nickname,
				updated_at
			) VALUES ($1, $2, $3)
			ON CONFLICT(profile_id) DO UPDATE SET
				local_nickname = excluded.local_nickname,
				updated_at = excluded.updated_at
			`,
			[normalizedProfileId, normalizedNickname, Date.now()],
		);
	});
}

export async function getLocalNicknamesForProfiles(
	profileIds: string[],
): Promise<Record<string, string>> {
	if (profileIds.length === 0) {
		return {};
	}

	const ids = profileIds.map((id) => id.trim()).filter(Boolean);
	if (ids.length === 0) {
		return {};
	}

	const db = await getDb();
	const next: Record<string, string> = {};
	for (let offset = 0; offset < ids.length; offset += SQLITE_MAX_VARIABLES) {
		const chunk = ids.slice(offset, offset + SQLITE_MAX_VARIABLES);
		const placeholders = chunk.map((_, index) => `$${index + 1}`).join(", ");
		const rows = await db.select<LocalNicknameRow[]>(
			`
			SELECT profile_id, local_nickname
			FROM chat_local_profile_meta
			WHERE profile_id IN (${placeholders})
			`,
			chunk,
		);

		for (const row of rows) {
			const nickname = row.local_nickname.trim();
			if (nickname) {
				next[row.profile_id] = nickname;
			}
		}
	}

	return next;
}

/**
 * Every nickname given on this account. There are only as many as people the
 * user chose to rename, so a screen that shows thousands of profiles reads
 * them all once rather than asking about each id it shows.
 */
export async function getAllLocalNicknames(): Promise<Record<string, string>> {
	const db = await getDb();
	const rows = await db.select<LocalNicknameRow[]>(
		"SELECT profile_id, local_nickname FROM chat_local_profile_meta",
	);

	const next: Record<string, string> = {};
	for (const row of rows) {
		const nickname = row.local_nickname.trim();
		if (nickname) {
			next[row.profile_id] = nickname;
		}
	}
	return next;
}

// ---------------------------------------------------------------------------
// Backup export/import
//
// This database is account-scoped (matching chatDb). It is by far the largest
// contributor to "profiles my laptop knows about and my phone doesn't": every
// grid tile's chatted/unread badge is resolved from chat_contact_index, so a
// fresh install renders tens of thousands of profiles as never-contacted.
// ---------------------------------------------------------------------------

/** Raw column lists — the only names ever interpolated into the SQL below. */
const INDEX_TABLES = {
	chat_contact_index: {
		primaryKey: "profile_id",
		columns: [
			"profile_id", "conversation_id", "last_message_timestamp",
			"unread_count", "has_chatted", "updated_at",
		],
	},
	chat_local_profile_meta: {
		primaryKey: "profile_id",
		columns: ["profile_id", "local_nickname", "updated_at"],
	},
} as const;

export type ContactIndexTableName = keyof typeof INDEX_TABLES;

export type ContactIndexPortableRow = Record<string, unknown>;

export type ContactIndexUpsertOptions = { respectUpdatedAt?: boolean };

export type ContactIndexRowMutation =
	| {
			kind: "upsert";
			row: ContactIndexPortableRow;
			options?: ContactIndexUpsertOptions;
	  }
	| { kind: "delete" };

export type ContactIndexCompareAndApplyResult =
	| "already-current"
	| "changed"
	| "applied";

export type ContactIndexRowPredicate = (
	currentRow: Readonly<ContactIndexPortableRow> | null,
) => boolean;

export type ContactIndexCompareAndApplyOptions = {
	/** Checked first so replaying an operation that already landed is a no-op. */
	matchesIncoming: ContactIndexRowPredicate;
	/** The local row observed before the remote winner was selected. */
	matchesExpected: ContactIndexRowPredicate;
};

export const CONTACT_INDEX_TABLE_NAMES = Object.keys(INDEX_TABLES) as ContactIndexTableName[];

/** Names arriving from an import file are strings, so re-check them at runtime. */
export function isContactIndexTable(name: string): name is ContactIndexTableName {
	return Object.prototype.hasOwnProperty.call(INDEX_TABLES, name);
}

export async function countContactIndexRows(name: ContactIndexTableName): Promise<number> {
	const db = await getDb();
	const rows = await db.select<{ count: number }[]>(`SELECT COUNT(*) as count FROM ${name}`);
	return rows[0]?.count ?? 0;
}

/** One page, ordered by primary key so paging stays stable between calls. */
export async function selectContactIndexPage(
	name: ContactIndexTableName,
	offset: number,
	limit: number,
	options?: { since?: number },
): Promise<Record<string, unknown>[]> {
	const table = INDEX_TABLES[name];
	// Both tables carry updated_at, so an incremental export filters on it.
	const since = options?.since;
	const where = since ? "WHERE updated_at > $1" : "";
	const params = where ? [since] : [];
	const db = await getDb();
	return db.select<Record<string, unknown>[]>(
		`SELECT ${table.columns.join(", ")} FROM ${name} ${where}
		 ORDER BY ${table.primaryKey} LIMIT ${Math.trunc(limit)} OFFSET ${Math.trunc(offset)}`,
		params,
	);
}

/** Rows a delta export would carry — drives the "N changes" count in the UI. */
export async function countContactIndexRowsSince(
	name: ContactIndexTableName,
	since: number,
): Promise<number> {
	const db = await getDb();
	const rows = await db.select<{ count: number }[]>(
		`SELECT COUNT(*) as count FROM ${name} WHERE updated_at > $1`,
		[since],
	);
	return rows[0]?.count ?? 0;
}

async function upsertContactIndexRowsUnlocked(
	db: Database,
	name: ContactIndexTableName,
	rows: ContactIndexPortableRow[],
	options: ContactIndexUpsertOptions,
): Promise<number> {
	const table = INDEX_TABLES[name];
	const placeholders = table.columns.map((_, index) => `$${index + 1}`).join(", ");
	const updates = table.columns
		.filter((column) => column !== table.primaryKey)
		.map((column) => `${column} = excluded.${column}`)
		.join(", ");
	// Last-writer-wins on updated_at. A blind overwrite here would let a backup
	// from a device that had been closed for days roll back live unread counts
	// and last-message times for tens of thousands of profiles.
	const guard =
		options.respectUpdatedAt === false
			? ""
			: ` WHERE COALESCE(excluded.updated_at, 0) >= COALESCE(${name}.updated_at, 0)`;
	const sql = `
		INSERT INTO ${name} (${table.columns.join(", ")})
		VALUES (${placeholders})
		ON CONFLICT(${table.primaryKey}) DO UPDATE SET ${updates}${guard}
	`;

	let written = 0;
	for (const row of rows) {
		if (!row || typeof row !== "object" || row[table.primaryKey] == null) {
			continue;
		}
		await db.execute(sql, table.columns.map((column) => row[column] ?? null));
		written += 1;
	}
	return written;
}

export async function upsertContactIndexRows(
	name: ContactIndexTableName,
	rows: ContactIndexPortableRow[],
	options: ContactIndexUpsertOptions = {},
): Promise<number> {
	if (rows.length === 0) {
		return 0;
	}

	let written = 0;
	const db = await getDb();
	await executeWithLockRetry(db, `import-${name}`, async () => {
		written = await upsertContactIndexRowsUnlocked(db, name, rows, options);
	});
	return written;
}

/** Stable keyset paging for cloud reconciliation scans. */
/**
 * How much of the contact index a device contributes to cloud sync. The index
 * is dominated by profiles that were only ever browsed, so a phone otherwise
 * spends every cycle scanning tens of thousands of rows it will never use.
 */
export type ContactIndexSyncScope =
	| "conversations"
	| "conversations-and-recent"
	| "everything";

export const CONTACT_INDEX_RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;

export async function selectContactIndexPageAfter(
	name: ContactIndexTableName,
	afterProfileId: string | null,
	limit: number,
	scope: ContactIndexSyncScope = "everything",
	recentSinceMs?: number,
): Promise<Record<string, unknown>[]> {
	const table = INDEX_TABLES[name];
	const clauses: string[] = [];
	const params: unknown[] = [];
	if (afterProfileId != null) {
		params.push(afterProfileId);
		clauses.push(`profile_id > $${params.length}`);
	}
	// Only the contact index carries these columns, and every fragment below is
	// a code constant with bound parameters - no caller-supplied SQL.
	if (name === "chat_contact_index" && scope !== "everything") {
		if (scope === "conversations") {
			clauses.push("has_chatted = 1");
		} else {
			params.push(
				recentSinceMs ?? Date.now() - CONTACT_INDEX_RECENT_WINDOW_MS,
			);
			clauses.push(`(has_chatted = 1 OR updated_at > $${params.length})`);
		}
	}
	const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
	const db = await getDb();
	return db.select<Record<string, unknown>[]>(
		`SELECT ${table.columns.join(", ")} FROM ${name} ${where}
		 ORDER BY profile_id LIMIT ${Math.max(1, Math.trunc(limit))}`,
		params,
	);
}

async function selectContactIndexRowUnlocked(
	db: Database,
	name: ContactIndexTableName,
	profileId: string,
): Promise<ContactIndexPortableRow | null> {
	const table = INDEX_TABLES[name];
	const rows = await db.select<ContactIndexPortableRow[]>(
		`SELECT ${table.columns.join(", ")} FROM ${name}
		 WHERE ${table.primaryKey} = $1 LIMIT 1`,
		[profileId],
	);
	return rows[0] ?? null;
}

async function deleteContactIndexRowUnlocked(
	db: Database,
	name: ContactIndexTableName,
	profileId: string,
): Promise<void> {
	await db.execute(`DELETE FROM ${name} WHERE profile_id = $1`, [profileId]);
}

/**
 * Atomically compares and applies one portable index row relative to this
 * module's serialized write queue. Predicates are synchronous and must be
 * pure because the whole unit can be repeated after a transient SQLite lock.
 */
export async function compareAndApplyContactIndexRow(
	name: ContactIndexTableName,
	profileId: string,
	mutation: ContactIndexRowMutation,
	options: ContactIndexCompareAndApplyOptions,
): Promise<ContactIndexCompareAndApplyResult> {
	if (!profileId) {
		throw new Error(`Cannot compare ${name} without a profile id`);
	}
	const table = INDEX_TABLES[name];
	if (
		mutation.kind === "upsert" &&
		(
			mutation.row[table.primaryKey] == null ||
			String(mutation.row[table.primaryKey]) !== profileId
		)
	) {
		throw new Error(`The ${name} upsert row does not match its profile id`);
	}

	const db = await getDb();
	let result: ContactIndexCompareAndApplyResult | null = null;
	await executeWithLockRetry(db, `compare-and-apply-${name}`, async () => {
		result = null;
		const currentRow = await selectContactIndexRowUnlocked(db, name, profileId);
		if (options.matchesIncoming(currentRow)) {
			result = "already-current";
			return;
		}
		if (!options.matchesExpected(currentRow)) {
			result = "changed";
			return;
		}

		if (mutation.kind === "upsert") {
			await upsertContactIndexRowsUnlocked(
				db,
				name,
				[mutation.row],
				mutation.options ?? {},
			);
		} else {
			await deleteContactIndexRowUnlocked(db, name, profileId);
		}
		result = "applied";
	});
	if (result == null) {
		throw new Error(`The ${name} compare-and-apply operation did not complete`);
	}
	return result;
}

export async function deleteContactIndexRow(
	name: ContactIndexTableName,
	profileId: string,
): Promise<void> {
	if (!profileId) {
		return;
	}
	const db = await getDb();
	await executeWithLockRetry(db, `delete-${name}-row`, async () => {
		await deleteContactIndexRowUnlocked(db, name, profileId);
	});
}

export async function clearContactIndexTables(names: ContactIndexTableName[]): Promise<void> {
	if (names.length === 0) {
		return;
	}
	const db = await getDb();
	await executeWithLockRetry(db, "clear-contact-index", async () => {
		for (const name of names) {
			await db.execute(`DELETE FROM ${name}`);
		}
	});
}
