/**
 * The sync change journal. Triggers on each synchronized chat table write the
 * key of every inserted, updated or deleted row into one small log table, so
 * Google Drive sync can read just those rows instead of every row of every
 * table on every pass (about 80,000 rows on the PC in October 2026).
 *
 * This module holds the SQL and the logic over a minimal database interface,
 * with no Tauri import: chatDb.ts runs it on the chat database, and the tests
 * run the very same functions on bun:sqlite.
 *
 * The triggers must never make an app write fail. They only insert into a
 * table with no constraint that can be violated, and skip a NULL key instead
 * of inserting it.
 */

export const SYNC_CHANGE_LOG_TABLE = "fg_sync_change_log";
export const SYNC_CHANGE_META_TABLE = "fg_sync_change_meta";
export const SYNC_CHANGE_TRIGGER_PREFIX = "fg_sync_chg_";

/**
 * Bumped whenever the trigger SQL changes, so journals armed by an older build
 * are rebuilt (and their next sync does one full scan) instead of trusted.
 */
export const SYNC_CHANGE_JOURNAL_VERSION = 1;

/**
 * Past this many logged writes a journal is reset rather than read: a full
 * scan is cheaper than replaying it, and it bounds the log when no sync runs
 * for a long time (sync turned off, an older build in use).
 */
export const SYNC_CHANGE_JOURNAL_MAX_ROWS = 1_000_000;

export type SyncJournalTable = Readonly<{ name: string; primaryKey: string }>;

/** The two calls the journal needs; Tauri SQL and bun:sqlite both fit. */
export interface SyncJournalDb {
	execute(query: string, bindValues?: unknown[]): Promise<unknown>;
	select<T>(query: string, bindValues?: unknown[]): Promise<T>;
}

export type SyncChangeJournalArmResult = Readonly<{ journalId: string; rearmed: boolean }>;
export type SyncChangeMark = Readonly<{
	journalId: string | null;
	throughId: number;
	rowCount: number;
}>;
export type SyncChangeEntry = Readonly<{ table: string; key: string }>;

const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]*$/;

function assertIdentifier(value: string): string {
	if (!IDENTIFIER_PATTERN.test(value)) {
		throw new Error(`Not a safe SQL identifier for the sync journal: ${value}`);
	}
	return value;
}

const CREATE_LOG_SQL = `
	CREATE TABLE IF NOT EXISTS ${SYNC_CHANGE_LOG_TABLE} (
		id INTEGER PRIMARY KEY,
		table_name TEXT NOT NULL,
		row_key TEXT
	)
`;

const CREATE_META_SQL = `
	CREATE TABLE IF NOT EXISTS ${SYNC_CHANGE_META_TABLE} (
		singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
		journal_id TEXT NOT NULL,
		signature TEXT NOT NULL
	)
`;

const SELECT_TRIGGERS_SQL = `
	SELECT name FROM sqlite_master
	WHERE type = 'trigger'
	  AND substr(name, 1, ${SYNC_CHANGE_TRIGGER_PREFIX.length}) = '${SYNC_CHANGE_TRIGGER_PREFIX}'
`;

const SELECT_META_SQL = `
	SELECT journal_id, signature FROM ${SYNC_CHANGE_META_TABLE} WHERE singleton_id = 1
`;

/** Rotating the id first is what makes an interrupted re-arm safe. */
const UPSERT_META_SQL = `
	INSERT INTO ${SYNC_CHANGE_META_TABLE} (singleton_id, journal_id, signature)
	VALUES (1, $1, $2)
	ON CONFLICT(singleton_id) DO UPDATE SET
		journal_id = excluded.journal_id,
		signature = excluded.signature
`;

const SELECT_MARK_SQL = `
	SELECT COALESCE(MAX(id), 0) AS through_id, COUNT(*) AS row_count
	FROM ${SYNC_CHANGE_LOG_TABLE}
`;

const SELECT_CHANGES_SQL = `
	SELECT table_name, row_key FROM ${SYNC_CHANGE_LOG_TABLE}
	WHERE id <= $1 AND row_key IS NOT NULL
	GROUP BY table_name, row_key
`;

/**
 * Only clears what a pass has journaled, and only while the journal is still
 * the one that pass read: after a re-arm the ids start over, and deleting by
 * an old high-water mark would drop writes nobody has looked at.
 */
const DELETE_THROUGH_SQL = `
	DELETE FROM ${SYNC_CHANGE_LOG_TABLE}
	WHERE id <= $1 AND EXISTS (
		SELECT 1 FROM ${SYNC_CHANGE_META_TABLE} WHERE singleton_id = 1 AND journal_id = $2
	)
`;

/** What the armed triggers cover. A different signature means re-arm. */
export function syncChangeJournalSignature(tables: readonly SyncJournalTable[]): string {
	const parts = [...tables]
		.map((table) => `${assertIdentifier(table.name)}.${assertIdentifier(table.primaryKey)}`)
		.sort();
	return `v${SYNC_CHANGE_JOURNAL_VERSION}:${parts.join(",")}`;
}

export function syncChangeTriggerNames(tables: readonly SyncJournalTable[]): string[] {
	return tables
		.flatMap((table) => {
			const name = assertIdentifier(table.name);
			return ["ins", "upd", "del"].map(
				(kind) => `${SYNC_CHANGE_TRIGGER_PREFIX}${name}_${kind}`,
			);
		})
		.sort();
}

/**
 * Three triggers per table. An update logs the new key, and the old one too
 * when the key itself changed, so a re-keyed row is both sent under its new
 * key and removed under its old one. `INSERT OR REPLACE` is covered by the
 * insert trigger: it logs the replacing row's key, which is the same key.
 */
export function createSyncChangeTriggersSql(table: SyncJournalTable): string[] {
	const name = assertIdentifier(table.name);
	const key = assertIdentifier(table.primaryKey);
	const log = SYNC_CHANGE_LOG_TABLE;
	const prefix = SYNC_CHANGE_TRIGGER_PREFIX;
	return [
		`CREATE TRIGGER IF NOT EXISTS ${prefix}${name}_ins AFTER INSERT ON ${name}
		 BEGIN
			INSERT INTO ${log} (table_name, row_key)
			SELECT '${name}', NEW.${key} WHERE NEW.${key} IS NOT NULL;
		 END`,
		`CREATE TRIGGER IF NOT EXISTS ${prefix}${name}_upd AFTER UPDATE ON ${name}
		 BEGIN
			INSERT INTO ${log} (table_name, row_key)
			SELECT '${name}', NEW.${key} WHERE NEW.${key} IS NOT NULL;
			INSERT INTO ${log} (table_name, row_key)
			SELECT '${name}', OLD.${key}
			WHERE OLD.${key} IS NOT NULL AND OLD.${key} IS NOT NEW.${key};
		 END`,
		`CREATE TRIGGER IF NOT EXISTS ${prefix}${name}_del AFTER DELETE ON ${name}
		 BEGIN
			INSERT INTO ${log} (table_name, row_key)
			SELECT '${name}', OLD.${key} WHERE OLD.${key} IS NOT NULL;
		 END`,
	];
}

function dropTriggerSql(triggerName: string): string {
	if (!triggerName.startsWith(SYNC_CHANGE_TRIGGER_PREFIX)) {
		throw new Error(`Refusing to drop a trigger the sync journal does not own: ${triggerName}`);
	}
	return `DROP TRIGGER IF EXISTS ${assertIdentifier(triggerName)}`;
}

/**
 * Whether the triggers in the database are exactly the ones expected. Extra
 * ones (a table no longer synced) and missing ones (a table rebuilt by a
 * migration loses its triggers) both mean writes may have gone unlogged.
 */
export function syncChangeTriggersMatch(
	existing: readonly string[],
	tables: readonly SyncJournalTable[],
): boolean {
	const expected = syncChangeTriggerNames(tables);
	const actual = [...existing].sort();
	return (
		expected.length === actual.length &&
		expected.every((name, index) => name === actual[index])
	);
}

/**
 * Makes sure exactly the expected triggers exist. When they do not (first
 * use, a table rebuilt by a migration, a newer trigger version, an oversized
 * log) the journal gets a new id before anything else changes, so a sync that
 * last saw the old id knows writes may have gone unlogged and scans in full.
 *
 * Callers run this inside their write queue; every step is idempotent, so a
 * retry after a lock simply starts over.
 */
export async function armSyncChangeJournalOn(
	db: SyncJournalDb,
	tables: readonly SyncJournalTable[],
	newJournalId: () => string,
	maxRows = SYNC_CHANGE_JOURNAL_MAX_ROWS,
): Promise<SyncChangeJournalArmResult> {
	const signature = syncChangeJournalSignature(tables);
	await db.execute(CREATE_LOG_SQL);
	await db.execute(CREATE_META_SQL);
	const [meta] = await db.select<Array<{ journal_id: string; signature: string }>>(
		SELECT_META_SQL,
	);
	const triggers = await db.select<Array<{ name: string }>>(SELECT_TRIGGERS_SQL);
	const [mark] = await db.select<Array<{ through_id: number; row_count: number }>>(
		SELECT_MARK_SQL,
	);
	const intact =
		meta != null &&
		meta.signature === signature &&
		syncChangeTriggersMatch(
			triggers.map((trigger) => trigger.name),
			tables,
		) &&
		Number(mark?.row_count ?? 0) <= maxRows;
	if (intact) return { journalId: meta.journal_id, rearmed: false };

	const journalId = newJournalId();
	await db.execute(UPSERT_META_SQL, [journalId, signature]);
	for (const trigger of triggers) {
		await db.execute(dropTriggerSql(trigger.name));
	}
	for (const table of tables) {
		for (const statement of createSyncChangeTriggersSql(table)) {
			await db.execute(statement);
		}
	}
	await db.execute(`DELETE FROM ${SYNC_CHANGE_LOG_TABLE}`);
	return { journalId, rearmed: true };
}

/** The current journal id and its high-water mark; a pass reads up to it. */
export async function readSyncChangeMarkOn(db: SyncJournalDb): Promise<SyncChangeMark> {
	const tables = await db.select<Array<{ name: string }>>(
		`SELECT name FROM sqlite_master WHERE type = 'table'
		 AND name IN ('${SYNC_CHANGE_LOG_TABLE}', '${SYNC_CHANGE_META_TABLE}')`,
	);
	if (tables.length < 2) return { journalId: null, throughId: 0, rowCount: 0 };
	const [meta] = await db.select<Array<{ journal_id: string }>>(SELECT_META_SQL);
	const [mark] = await db.select<Array<{ through_id: number; row_count: number }>>(
		SELECT_MARK_SQL,
	);
	return {
		journalId: meta?.journal_id ?? null,
		throughId: Number(mark?.through_id ?? 0),
		rowCount: Number(mark?.row_count ?? 0),
	};
}

/** Each changed row once, however many times it was written. */
export async function readSyncChangesOn(
	db: SyncJournalDb,
	throughId: number,
): Promise<SyncChangeEntry[]> {
	if (!Number.isSafeInteger(throughId) || throughId <= 0) return [];
	const rows = await db.select<Array<{ table_name: string; row_key: unknown }>>(
		SELECT_CHANGES_SQL,
		[throughId],
	);
	return rows
		.filter((row) => row.row_key != null)
		.map((row) => ({ table: row.table_name, key: String(row.row_key) }));
}

export async function clearSyncChangesThroughOn(
	db: SyncJournalDb,
	journalId: string,
	throughId: number,
): Promise<void> {
	if (!Number.isSafeInteger(throughId) || throughId <= 0) return;
	await db.execute(DELETE_THROUGH_SQL, [throughId, journalId]);
}

/** Removes the triggers and the log, for a profile that no longer syncs. */
export async function disarmSyncChangeJournalOn(db: SyncJournalDb): Promise<void> {
	const triggers = await db.select<Array<{ name: string }>>(SELECT_TRIGGERS_SQL);
	for (const trigger of triggers) {
		await db.execute(dropTriggerSql(trigger.name));
	}
	await db.execute(`DROP TABLE IF EXISTS ${SYNC_CHANGE_LOG_TABLE}`);
	await db.execute(`DROP TABLE IF EXISTS ${SYNC_CHANGE_META_TABLE}`);
}
