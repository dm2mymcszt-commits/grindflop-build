import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
	armSyncChangeJournalOn,
	clearSyncChangesThroughOn,
	disarmSyncChangeJournalOn,
	readSyncChangeMarkOn,
	readSyncChangesOn,
	syncChangeJournalSignature,
	syncChangeTriggerNames,
	type SyncJournalDb,
	type SyncJournalTable,
} from "../src/services/syncChangeJournal";

/** The same shapes as the real chat tables: TEXT primary keys. */
const TABLES: SyncJournalTable[] = [
	{ name: "conversations", primaryKey: "conversation_id" },
	{ name: "messages", primaryKey: "message_id" },
	{ name: "settings", primaryKey: "key" },
];

function chatDatabase() {
	const database = new Database(":memory:");
	database.run(`CREATE TABLE conversations (
		conversation_id TEXT PRIMARY KEY, name TEXT, archived INTEGER NOT NULL DEFAULT 0,
		hidden INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0
	)`);
	database.run(`CREATE TABLE messages (
		message_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, body TEXT
	)`);
	database.run("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
	const db: SyncJournalDb = {
		async execute(query, bindValues = []) {
			database.query(query).run(...(bindValues as never[]));
		},
		async select<T>(query: string, bindValues: unknown[] = []) {
			return database.query(query).all(...(bindValues as never[])) as T;
		},
	};
	return { database, db };
}

let nextId = 0;
const newId = () => `journal-${++nextId}`;

async function changes(db: SyncJournalDb) {
	const mark = await readSyncChangeMarkOn(db);
	const entries = await readSyncChangesOn(db, mark.throughId);
	return entries.map((entry) => `${entry.table}:${entry.key}`).sort();
}

describe("sync change journal", () => {
	test("arming creates the triggers once and keeps the same journal after that", async () => {
		const { database, db } = chatDatabase();
		const first = await armSyncChangeJournalOn(db, TABLES, newId);
		expect(first.rearmed).toBe(true);
		const again = await armSyncChangeJournalOn(db, TABLES, newId);
		expect(again).toEqual({ journalId: first.journalId, rearmed: false });
		const triggers = database
			.query("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
			.all() as Array<{ name: string }>;
		expect(triggers.map((row) => row.name)).toEqual(syncChangeTriggerNames(TABLES));
	});

	test("every kind of write logs the row key, once per row however often it changed", async () => {
		const { database, db } = chatDatabase();
		await armSyncChangeJournalOn(db, TABLES, newId);
		database.run("INSERT INTO conversations (conversation_id, name) VALUES ('c1', 'One')");
		database.run("UPDATE conversations SET name = 'Uno' WHERE conversation_id = 'c1'");
		database.run("UPDATE conversations SET name = 'Eins' WHERE conversation_id = 'c1'");
		database.run("INSERT INTO messages VALUES ('m1', 'c1', 'hi'), ('m2', 'c1', 'yo')");
		database.run("DELETE FROM messages WHERE message_id = 'm2'");
		// The upsert the app uses for every table, and the plain replace.
		database.run(`INSERT INTO settings (key, value) VALUES ('privacy', '{}')
			ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
		database.run(`INSERT INTO settings (key, value) VALUES ('privacy', '{"a":1}')
			ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
		database.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('stats', 'on')");
		database.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('stats', 'off')");
		expect(await changes(db)).toEqual([
			"conversations:c1",
			"messages:m1",
			"messages:m2",
			"settings:privacy",
			"settings:stats",
		]);
	});

	test("writes that change nothing are not logged", async () => {
		const { database, db } = chatDatabase();
		database.run("INSERT INTO settings (key, value) VALUES ('privacy', '{}')");
		await armSyncChangeJournalOn(db, TABLES, newId);
		database.run(`INSERT INTO settings (key, value) VALUES ('privacy', 'x')
			ON CONFLICT(key) DO NOTHING`);
		database.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('privacy', 'y')");
		expect(await changes(db)).toEqual([]);
	});

	test("a re-keyed row is logged under its old and its new key", async () => {
		const { database, db } = chatDatabase();
		database.run("INSERT INTO messages VALUES ('old-id', 'c1', 'hi')");
		await armSyncChangeJournalOn(db, TABLES, newId);
		database.run("UPDATE messages SET message_id = 'new-id' WHERE message_id = 'old-id'");
		expect(await changes(db)).toEqual(["messages:new-id", "messages:old-id"]);
	});

	test("a bulk delete logs every row it removes", async () => {
		const { database, db } = chatDatabase();
		database.run(`INSERT INTO conversations (conversation_id, archived)
			VALUES ('a', 1), ('b', 1), ('c', 0)`);
		await armSyncChangeJournalOn(db, TABLES, newId);
		database.run("DELETE FROM conversations WHERE archived = 1");
		expect(await changes(db)).toEqual(["conversations:a", "conversations:b"]);
	});

	test("a row with no key is written normally and simply not logged", async () => {
		const { database, db } = chatDatabase();
		await armSyncChangeJournalOn(db, TABLES, newId);
		// SQLite lets a non-integer primary key be NULL; the app write must not fail.
		database.run("INSERT INTO settings (key, value) VALUES (NULL, 'v')");
		database.run("INSERT OR FAIL INTO settings (key, value) VALUES (NULL, 'w')");
		expect((database.query("SELECT COUNT(*) AS n FROM settings").get() as { n: number }).n).toBe(2);
		expect(await changes(db)).toEqual([]);
	});

	test("clearing removes only what a pass read, so later writes wait for the next pass", async () => {
		const { database, db } = chatDatabase();
		const { journalId } = await armSyncChangeJournalOn(db, TABLES, newId);
		database.run("INSERT INTO messages VALUES ('m1', 'c1', 'hi')");
		const mark = await readSyncChangeMarkOn(db);
		database.run("INSERT INTO messages VALUES ('m2', 'c1', 'later')");
		database.run("UPDATE messages SET body = 'edited' WHERE message_id = 'm1'");
		await clearSyncChangesThroughOn(db, journalId, mark.throughId);
		expect(await changes(db)).toEqual(["messages:m1", "messages:m2"]);
	});

	test("a clear meant for an older journal deletes nothing", async () => {
		const { database, db } = chatDatabase();
		const { journalId } = await armSyncChangeJournalOn(db, TABLES, newId);
		database.run("INSERT INTO messages VALUES ('m1', 'c1', 'hi')");
		const mark = await readSyncChangeMarkOn(db);
		// The tables are re-armed (the ids start over) before the old pass clears.
		database.run("DROP TRIGGER fg_sync_chg_messages_ins");
		const rearmed = await armSyncChangeJournalOn(db, TABLES, newId);
		expect(rearmed.rearmed).toBe(true);
		database.run("INSERT INTO messages VALUES ('m2', 'c1', 'after')");
		await clearSyncChangesThroughOn(db, journalId, mark.throughId);
		expect(await changes(db)).toEqual(["messages:m2"]);
	});

	test("a table rebuilt by a migration loses its triggers, and arming notices", async () => {
		const { database, db } = chatDatabase();
		const first = await armSyncChangeJournalOn(db, TABLES, newId);
		database.run("ALTER TABLE settings RENAME TO settings_old");
		database.run("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
		database.run("INSERT INTO settings SELECT * FROM settings_old");
		database.run("DROP TABLE settings_old");
		const again = await armSyncChangeJournalOn(db, TABLES, newId);
		expect(again.rearmed).toBe(true);
		expect(again.journalId).not.toBe(first.journalId);
		database.run("INSERT INTO settings (key, value) VALUES ('stats', 'on')");
		expect(await changes(db)).toEqual(["settings:stats"]);
	});

	test("syncing a different set of tables re-arms", async () => {
		const { db } = chatDatabase();
		const first = await armSyncChangeJournalOn(db, TABLES, newId);
		const fewer = await armSyncChangeJournalOn(db, TABLES.slice(0, 2), newId);
		expect(fewer.rearmed).toBe(true);
		expect(fewer.journalId).not.toBe(first.journalId);
		expect(syncChangeJournalSignature(TABLES)).not.toBe(
			syncChangeJournalSignature(TABLES.slice(0, 2)),
		);
	});

	test("an oversized log is reset instead of replayed", async () => {
		const { database, db } = chatDatabase();
		const first = await armSyncChangeJournalOn(db, TABLES, newId, 2);
		database.run("INSERT INTO messages VALUES ('m1', 'c', ''), ('m2', 'c', ''), ('m3', 'c', '')");
		const again = await armSyncChangeJournalOn(db, TABLES, newId, 2);
		expect(again.rearmed).toBe(true);
		expect(again.journalId).not.toBe(first.journalId);
		expect(await changes(db)).toEqual([]);
	});

	test("disarming removes the triggers and the log", async () => {
		const { database, db } = chatDatabase();
		await armSyncChangeJournalOn(db, TABLES, newId);
		await disarmSyncChangeJournalOn(db);
		database.run("INSERT INTO messages VALUES ('m1', 'c1', 'hi')");
		expect(await readSyncChangeMarkOn(db)).toEqual({
			journalId: null,
			throughId: 0,
			rowCount: 0,
		});
		const triggers = database
			.query("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger'")
			.get() as { n: number };
		expect(triggers.n).toBe(0);
	});

	test("refuses table names that are not plain identifiers", async () => {
		const { db } = chatDatabase();
		await expect(
			armSyncChangeJournalOn(db, [{ name: "messages; DROP TABLE x", primaryKey: "id" }], newId),
		).rejects.toThrow("Not a safe SQL identifier");
	});
});
