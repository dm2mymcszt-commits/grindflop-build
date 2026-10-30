import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	countMergeableMessages,
	mergeConversationSteps,
	type SqlStep,
} from "../src/utils/conversationMergeSql";

// The tables are built from the very statements chatDb creates them with, so
// a column these steps name wrongly fails here and not on someone's history.
const chatDbSource = readFileSync(join(import.meta.dir, "..", "src", "services", "chatDb.ts"), "utf8");

function createTableSql(name: string): string {
	const match = chatDbSource.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\(([\\s\\S]*?)\\n\\s*\\)\\s*\``));
	if (!match) throw new Error(`chatDb no longer creates ${name} the way this test reads it`);
	return `CREATE TABLE ${name} (${match[1]}\n)`;
}

const TABLES = ["conversations", "conversation_meta", "messages", "media_files", "content_checks", "albums"];

// The app's database layer numbers its parameters ($1, $2); bound by
// position here, they have to be written the way SQLite numbers them.
function run(db: Database, step: SqlStep) {
	return db.query(step.sql.replace(/\$(\d+)/g, "?$1")).all(...(step.params as never[]));
}

const SOURCE = "100:900";
const TARGET = "200:900";
const OTHER = "300:900";
const NOW = 1_800_000_000_000;

let db: Database;

function conversation(id: string, archived: number, lastActivity: number) {
	db.query(
		`INSERT INTO conversations (conversation_id, other_profile_id, participants_json, last_activity_timestamp, archived, created_at, updated_at)
		 VALUES (?1, ?2, '[]', ?3, ?4, 1, 1)`,
	).run(id, id.split(":")[0], lastActivity, archived);
}

function message(id: string, conversationId: string, senderId: number, timestamp: number, type: string | null) {
	db.query(
		`INSERT INTO messages (message_id, conversation_id, sender_id, timestamp, type, created_at, updated_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, 1, 1)`,
	).run(id, conversationId, senderId, timestamp, type);
}

function column<T>(sql: string, ...params: unknown[]): T[] {
	return (db.query(sql).all(...(params as never[])) as Record<string, T>[]).map((row) => Object.values(row)[0]);
}

function messagesOf(conversationId: string): string[] {
	return column<string>("SELECT message_id FROM messages WHERE conversation_id = ?1 ORDER BY timestamp", conversationId);
}

function merge() {
	for (const step of mergeConversationSteps(SOURCE, TARGET, NOW)) run(db, step);
}

beforeEach(() => {
	db = new Database(":memory:");
	for (const table of TABLES) db.run(createTableSql(table));

	conversation(SOURCE, 1, 5_000);
	conversation(TARGET, 0, 9_000);
	conversation(OTHER, 1, 4_000);
	db.query("INSERT INTO conversation_meta (conversation_id, last_read_timestamp) VALUES (?1, 4000)").run(SOURCE);
	db.query("INSERT INTO conversation_meta (conversation_id, last_read_timestamp) VALUES (?1, 8500)").run(TARGET);

	message("s1", SOURCE, 100, 1_000, "Text");
	message("s2", SOURCE, 900, 2_000, "Image");
	// Older rows carry no type at all; they are content too.
	message("s3", SOURCE, 100, 3_000, null);
	message("s-blocked-by-me", SOURCE, 0, 4_000, "SystemBlockedBySelf");
	message("s-blocked", SOURCE, 0, 5_000, "SystemBlocked");
	message("t1", TARGET, 200, 8_000, "Text");
	message("t2", TARGET, 900, 9_000, "Text");
	message("o1", OTHER, 300, 4_000, "Text");
	message("o-blocked", OTHER, 0, 4_100, "SystemBlockedBySelf");

	db.query("INSERT INTO media_files (media_key, conversation_id, message_id, kind, data_base64, fetched_at) VALUES ('m-s', ?1, 's2', 'image', '', 1)").run(SOURCE);
	db.query("INSERT INTO media_files (media_key, conversation_id, message_id, kind, data_base64, fetched_at) VALUES ('m-o', ?1, 'o1', 'image', '', 1)").run(OTHER);
	db.query("INSERT INTO content_checks (media_key, message_id, conversation_id, kind, model, checked_at) VALUES ('m-s', 's2', ?1, 'image', 'test', 1)").run(SOURCE);
	db.query("INSERT INTO content_checks (media_key, message_id, conversation_id, kind, model, checked_at) VALUES ('m-o', 'o1', ?1, 'image', 'test', 1)").run(OTHER);
	db.query("INSERT INTO albums (album_id, conversation_id, created_at, updated_at) VALUES ('a-s', ?1, 1, 1)").run(SOURCE);
	db.query("INSERT INTO albums (album_id, conversation_id, created_at, updated_at) VALUES ('a-o', ?1, 1, 1)").run(OTHER);
});

describe("merging a conversation into another", () => {
	test("counts what was said, not the app's own notes", () => {
		expect(run(db, countMergeableMessages(SOURCE))).toEqual([{ count: 3 }]);
		expect(run(db, countMergeableMessages("nobody:here"))).toEqual([{ count: 0 }]);
	});

	test("moves what was said into the target, in with what was already there", () => {
		merge();
		expect(messagesOf(TARGET)).toEqual(["s1", "s2", "s3", "t1", "t2"]);
	});

	test("the moved messages are marked as kept on this device only, the target's own are not", () => {
		merge();
		expect(column<string>("SELECT message_id FROM messages WHERE local_history = 1 ORDER BY timestamp")).toEqual(["s1", "s2", "s3"]);
		expect(column<number>("SELECT updated_at FROM messages WHERE message_id = 's1'")).toEqual([NOW]);
		expect(column<number>("SELECT updated_at FROM messages WHERE message_id = 't1'")).toEqual([1]);
	});

	test("who sent a message is left as it was", () => {
		merge();
		expect(column<number>("SELECT sender_id FROM messages WHERE message_id IN ('s1', 's2') ORDER BY message_id")).toEqual([100, 900]);
	});

	test("the notes about who blocked whom do not come along", () => {
		merge();
		expect(column<string>("SELECT message_id FROM messages WHERE type LIKE 'System%' ORDER BY message_id")).toEqual(["o-blocked"]);
	});

	test("media, the verdicts on it and albums follow their conversation", () => {
		merge();
		expect(column<string>("SELECT conversation_id FROM media_files WHERE media_key = 'm-s'")).toEqual([TARGET]);
		expect(column<string>("SELECT conversation_id FROM content_checks WHERE media_key = 'm-s'")).toEqual([TARGET]);
		expect(column<string>("SELECT conversation_id FROM albums WHERE album_id = 'a-s'")).toEqual([TARGET]);
	});

	test("the source is closed, with nothing left under its name", () => {
		merge();
		expect(column<string>("SELECT conversation_id FROM conversations ORDER BY conversation_id")).toEqual([TARGET, OTHER]);
		expect(column<string>("SELECT conversation_id FROM conversation_meta")).toEqual([TARGET]);
		expect(messagesOf(SOURCE)).toEqual([]);
	});

	test("no other conversation is touched", () => {
		merge();
		expect(messagesOf(OTHER)).toEqual(["o1", "o-blocked"]);
		expect(column<string>("SELECT conversation_id FROM media_files WHERE media_key = 'm-o'")).toEqual([OTHER]);
		expect(column<string>("SELECT conversation_id FROM content_checks WHERE media_key = 'm-o'")).toEqual([OTHER]);
		expect(column<string>("SELECT conversation_id FROM albums WHERE album_id = 'a-o'")).toEqual([OTHER]);
		expect(column<number>("SELECT archived FROM conversations WHERE conversation_id = ?1", OTHER)).toEqual([1]);
	});

	test("the target keeps its place when the merged history is older", () => {
		merge();
		expect(column<number>("SELECT last_activity_timestamp FROM conversations WHERE conversation_id = ?1", TARGET)).toEqual([9_000]);
		expect(column<number>("SELECT last_read_timestamp FROM conversation_meta WHERE conversation_id = ?1", TARGET)).toEqual([8_500]);
	});

	test("and moves up when the merged history is the more recent", () => {
		message("s-late", SOURCE, 100, 20_000, "Text");
		merge();
		expect(column<number>("SELECT last_activity_timestamp FROM conversations WHERE conversation_id = ?1", TARGET)).toEqual([20_000]);
	});

	test("a note written after the last message does not move the target up", () => {
		message("s-late-note", SOURCE, 0, 30_000, "SystemUnblockedBySelf");
		merge();
		expect(column<number>("SELECT last_activity_timestamp FROM conversations WHERE conversation_id = ?1", TARGET)).toEqual([9_000]);
	});

	test("running it twice changes nothing more", () => {
		merge();
		const after = db.query("SELECT message_id, conversation_id, local_history FROM messages ORDER BY message_id").all();
		merge();
		expect(db.query("SELECT message_id, conversation_id, local_history FROM messages ORDER BY message_id").all()).toEqual(after);
		expect(column<string>("SELECT conversation_id FROM conversations ORDER BY conversation_id")).toEqual([TARGET, OTHER]);
	});

	// Nothing runs as one transaction, so it can stop between any two steps.
	// Wherever it stops, the source must still be there to merge again, and
	// doing so must end exactly where an uninterrupted merge ends.
	test("stopped after any step, the source is still there and a second run finishes the job", () => {
		const steps = mergeConversationSteps(SOURCE, TARGET, NOW);
		for (let stoppedAfter = 0; stoppedAfter < steps.length - 1; stoppedAfter += 1) {
			db.close();
			db = new Database(":memory:");
			for (const table of TABLES) db.run(createTableSql(table));
			conversation(SOURCE, 1, 5_000);
			conversation(TARGET, 0, 9_000);
			message("s1", SOURCE, 100, 1_000, "Text");
			message("s-blocked", SOURCE, 0, 5_000, "SystemBlocked");
			message("t1", TARGET, 200, 8_000, "Text");

			for (const step of steps.slice(0, stoppedAfter + 1)) run(db, step);
			expect(column<string>("SELECT conversation_id FROM conversations WHERE conversation_id = ?1", SOURCE)).toEqual([SOURCE]);
			// What was said is never lost on the way: it is under one or the other.
			expect(column<string>("SELECT message_id FROM messages WHERE message_id = 's1'")).toEqual(["s1"]);

			merge();
			expect(messagesOf(TARGET)).toEqual(["s1", "t1"]);
			expect(column<string>("SELECT conversation_id FROM conversations")).toEqual([TARGET]);
			expect(column<string>("SELECT message_id FROM messages WHERE type LIKE 'System%'")).toEqual([]);
		}
	});
});
