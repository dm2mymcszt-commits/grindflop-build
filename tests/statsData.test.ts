import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as chatDb from "../src/services/chatDb";
import * as interestViews from "../src/services/interestViewsStore";
import {
	loadAlbumSharers,
	loadAlbumsReceived,
	loadBlockData,
	loadChatCounts,
	loadConversationSummaries,
	loadMessageRecords,
	loadMessagesByWeekHour,
	loadMessagesPerDay,
	loadMessageTypes,
	loadMostMessages,
	loadProfileEdits,
	loadProfileOpens,
	loadReactions,
	loadReplyGaps,
	loadSavedPhraseUse,
	loadStatsContext,
	loadViewDistances,
} from "../src/pages/app/stats/statsData";
import { resolvePeriod } from "../src/pages/app/stats/statsCompute";

const ME = 100;
const THEM = 7;
const OTHER = 8;
const NOW = new Date(2026, 8, 17, 15, 0).getTime();
const at = (day: number, hour: number, minute = 0) =>
	new Date(2026, 8, day, hour, minute).getTime();

// The chat database tables the Stats queries touch, as chatDb creates them.
const SCHEMA = `
CREATE TABLE conversations (
	conversation_id TEXT PRIMARY KEY, other_profile_id TEXT, name TEXT, participants_json TEXT NOT NULL,
	last_activity_timestamp INTEGER, unread_count INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0,
	muted INTEGER NOT NULL DEFAULT 0, favorite INTEGER NOT NULL DEFAULT 0, preview_json TEXT,
	archived INTEGER NOT NULL DEFAULT 0, archived_reason TEXT, archived_at INTEGER, last_seen_in_inbox_at INTEGER,
	created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, block_state TEXT,
	messages_synced_activity_timestamp INTEGER, hidden INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE messages (
	message_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, sender_id INTEGER NOT NULL, timestamp INTEGER NOT NULL,
	type TEXT, chat1_type TEXT, body_json TEXT, unsent INTEGER NOT NULL DEFAULT 0, local_history INTEGER NOT NULL DEFAULT 0,
	reply_to_message_id TEXT, reply_preview_json TEXT, reactions_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX idx_messages_conversation_ts ON messages(conversation_id, timestamp);
CREATE TABLE past_messages (
	message_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, sender_id INTEGER NOT NULL, timestamp INTEGER NOT NULL,
	type TEXT, chat1_type TEXT, body_json TEXT, unsent INTEGER NOT NULL DEFAULT 0, local_history INTEGER NOT NULL DEFAULT 0,
	reply_to_message_id TEXT, reply_preview_json TEXT, reactions_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
	source_profile_id TEXT NOT NULL
);
CREATE TABLE past_views (profile_id TEXT PRIMARY KEY, source_profile_id TEXT NOT NULL, row_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE VIEW stats_messages AS
	SELECT message_id, conversation_id, sender_id, timestamp, type, chat1_type, body_json, unsent, local_history, reply_to_message_id, reply_preview_json, reactions_json, created_at, updated_at FROM messages
	UNION ALL
	SELECT message_id, conversation_id, sender_id, timestamp, type, chat1_type, body_json, unsent, local_history, reply_to_message_id, reply_preview_json, reactions_json, created_at, updated_at FROM past_messages;
CREATE TABLE albums (
	album_id TEXT PRIMARY KEY, owner_profile_id TEXT, album_name TEXT, conversation_id TEXT, shared_via_message_id TEXT,
	created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, preview_cover_base64 TEXT, preview_cover_mime_type TEXT
);
CREATE TABLE album_media (
	content_id TEXT PRIMARY KEY, album_id TEXT NOT NULL, content_type TEXT, data_base64 TEXT, thumb_data_base64 TEXT,
	remaining_views INTEGER, is_viewable INTEGER, fetched_at INTEGER
);
CREATE TABLE saved_phrases (phrase TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
CREATE TABLE block_events (
	id TEXT PRIMARY KEY, profile_id TEXT, conversation_id TEXT NOT NULL, event_type TEXT NOT NULL, timestamp INTEGER NOT NULL,
	display_name TEXT, avatar_media_hash TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE stats_block_log (
	id TEXT PRIMARY KEY, event_type TEXT NOT NULL, profile_id TEXT, timestamp INTEGER NOT NULL, method TEXT NOT NULL,
	source TEXT NOT NULL, reason_kind TEXT, reason_detail TEXT, reason_label TEXT, rule_id TEXT, rule_name TEXT,
	device_id TEXT NOT NULL, device_name TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE stats_location_log (
	id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, geohash TEXT NOT NULL, lat REAL, lon REAL, name TEXT,
	automatic INTEGER NOT NULL DEFAULT 0, device_id TEXT NOT NULL, device_name TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE stats_coverage_log (
	id TEXT PRIMARY KEY, hour_start INTEGER NOT NULL, first_at INTEGER NOT NULL, source TEXT NOT NULL,
	device_id TEXT NOT NULL, device_name TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE stats_profile_edit_log (
	id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, fields_json TEXT NOT NULL, device_id TEXT NOT NULL,
	device_name TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE stats_profile_open_log (
	id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, timestamp INTEGER NOT NULL, view_recorded INTEGER NOT NULL DEFAULT 0,
	surface TEXT NOT NULL, device_id TEXT NOT NULL, device_name TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE stats_view_distance_log (
	id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, view_timestamp INTEGER NOT NULL, observed_at INTEGER NOT NULL,
	distance_meters REAL NOT NULL, source TEXT NOT NULL, device_id TEXT NOT NULL, device_name TEXT, created_at INTEGER NOT NULL
);
`;

let db: Database;
const restores: Array<() => void> = [];

function message(
	id: string,
	conversationId: string,
	sender: number,
	timestamp: number,
	type = "Text",
	body: unknown = { text: "hi" },
	extra: { unsent?: number; reactions?: unknown } = {},
) {
	db.query(
		`INSERT INTO messages (message_id, conversation_id, sender_id, timestamp, type, body_json, unsent, reactions_json, created_at, updated_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, 0)`,
	).run(
		id,
		conversationId,
		sender,
		timestamp,
		type,
		body === undefined
			? null
			: typeof body === "string"
				? body
				: JSON.stringify(body),
		extra.unsent ?? 0,
		extra.reactions === undefined ? null : JSON.stringify(extra.reactions),
	);
}

beforeAll(() => {
	db = new Database(":memory:");
	db.exec(SCHEMA);

	db.query(
		`INSERT INTO conversations (conversation_id, other_profile_id, name, participants_json, favorite, block_state, created_at, updated_at)
		 VALUES ('c1', '7', 'Sam', '[{"profileId":7,"primaryMediaHash":"hash7"}]', 1, NULL, 0, 0),
		        ('c2', '8', 'Leo', 'not json', 0, 'blocked_by_me', 0, 0)`,
	).run();

	// c1: Sam opens with "Hey!", you answer after 4 minutes, Sam replies after a minute.
	message(
		"m1",
		"c1",
		THEM,
		at(15, 20, 0),
		"Text",
		{ text: "Hey!" },
		{ reactions: [{ profileId: ME }] },
	);
	message(
		"m2",
		"c1",
		ME,
		at(15, 20, 4),
		"Text",
		{ text: "How's it going?" },
		{ reactions: [{ profileId: THEM }] },
	);
	message("m3", "c1", THEM, at(15, 20, 5), "Album", { albumId: 1 });
	message("m4", "c1", THEM, at(15, 20, 6), "Text", "{broken json", {
		unsent: 1,
	});
	// c2: Leo opens with a photo and is blocked.
	message("m5", "c2", OTHER, at(16, 9, 0), "Image", { url: "x" });
	message("m6", "c2", 0, at(16, 9, 30), "SystemBlockedBySelf", null);

	db.query("INSERT INTO saved_phrases VALUES ('How''s it going?', 0)").run();
	db.query(
		`INSERT INTO albums (album_id, owner_profile_id, created_at, updated_at) VALUES ('a1', '7', ?1, 0)`,
	).run(at(15, 20, 5));
	db.query(
		"INSERT INTO album_media (content_id, album_id) VALUES ('p1', 'a1'), ('p2', 'a1')",
	).run();

	db.query(
		`INSERT INTO stats_block_log VALUES
		 ('pc:1', 'block', '8', ?1, 'auto', 'inbox_scan', 'first_media', NULL, 'Scanner: First message was media (Bot evasion)', NULL, NULL, 'pc', 'Windows', 0),
		 ('ios:1', 'block', '8', ?2, 'auto', 'inbox_scan', 'first_media', NULL, 'Scanner: First message was media (Bot evasion)', NULL, NULL, 'ios', 'iOS', 0)`,
	).run(at(16, 9, 30), at(16, 9, 31));
	db.query(
		`INSERT INTO block_events VALUES ('e1', '7', 'c1', 'blocked', ?1, 'Sam', 'hash7', 0)`,
	).run(at(16, 22, 0));
	db.query(
		`INSERT INTO stats_coverage_log VALUES ('pc:1', ?1, ?1, 'view_scan', 'pc', 'Windows', 0)`,
	).run(at(16, 10));
	db.query(
		`INSERT INTO stats_location_log VALUES ('pc:1', ?1, 'u09tvw0f6szy', 48.85, 2.35, 'Home', 0, 'pc', 'Windows', 0)`,
	).run(at(14, 8));
	db.query(
		`INSERT INTO stats_profile_edit_log VALUES ('pc:1', ?1, '["mainPhoto"]', 'pc', 'Windows', 0)`,
	).run(at(15, 8));
	db.query(
		`INSERT INTO stats_profile_open_log VALUES ('pc:1', '7', ?1, 1, 'profile_page', 'pc', 'Windows', 0)`,
	).run(at(15, 19));
	db.query(
		`INSERT INTO stats_view_distance_log VALUES ('7:1', '7', ?1, ?2, 850, 'views_list', 'pc', 'Windows', 0)`,
	).run(at(15, 19, 30), at(15, 19, 31));

	const selectSpy = spyOn(chatDb, "selectStatsRows").mockImplementation(
		async (sql: string, params: unknown[] = []) =>
			db
				.query(sql.replace(/\$(\d+)/g, "?$1"))
				.all(...(params as never[])) as never,
	);
	const viewersSpy = spyOn(
		interestViews.interestViewsStore,
		"getAll",
	).mockResolvedValue([
		{
			profileId: "7",
			displayName: "Sam",
			imageHash: null,
			timestamp: at(15, 19, 30),
			viewCount: 2,
			viewTimestamps: [at(15, 19, 30), at(14, 11)],
			updatedAt: 0,
		},
	]);
	restores.push(
		() => selectSpy.mockRestore(),
		() => viewersSpy.mockRestore(),
	);
});

afterAll(() => {
	for (const restore of restores) restore();
	db.close();
});

describe("Stats queries run against the real schema", () => {
	const week = resolvePeriod("7d", NOW);

	test("context", async () => {
		const context = await loadStatsContext(ME);
		expect(context.views).toHaveLength(2);
		expect(context.contactsByProfile.get("7")).toMatchObject({
			conversationId: "c1",
			imageHash: "hash7",
			favorite: true,
			firstIn: at(15, 20, 0),
			firstOut: at(15, 20, 4),
		});
		// Unreadable participants JSON does not break the query.
		expect(context.contactsByProfile.get("8")?.imageHash).toBeNull();
		expect(context.trackingStart).toBe(at(14, 8));
		expect(context.sources).toEqual({
			messages: 5,
			firstMessageAt: at(15, 20, 0),
			conversations: 2,
			statsRows: 7,
			movedFromOldAccount: false,
		});
	});

	test("messages per day and hour, excluding system notes", async () => {
		// bun test runs JavaScript in UTC while SQLite follows the system zone, so
		// the expected local day and hour come from SQLite itself.
		const local = (timestamp: number, format: string) =>
			(
				db
					.query(
						`SELECT strftime('${format}', ?1 / 1000, 'unixepoch', 'localtime') AS value`,
					)
					.get(timestamp) as {
					value: string;
				}
			).value;
		const perDay = await loadMessagesPerDay(ME, week);
		expect(perDay).toEqual([
			{ day: local(at(15, 20, 0), "%Y-%m-%d"), received: 3, sent: 1 },
			{ day: local(at(16, 9, 0), "%Y-%m-%d"), received: 1, sent: 0 },
		]);
		const byHour = await loadMessagesByWeekHour(ME, week);
		expect(
			byHour.find((row) => row.hour === Number(local(at(15, 20, 0), "%H"))),
		).toMatchObject({
			received: 3,
			sent: 1,
		});
	});

	test("conversation summaries, even with a broken message body", async () => {
		const summaries = await loadConversationSummaries(ME, week);
		const sam = summaries.find((entry) => entry.conversationId === "c1");
		expect(sam).toMatchObject({
			firstSender: THEM,
			firstText: "Hey!",
			lastSender: THEM,
			total: 4,
			mine: 1,
			firstAlbumInTs: at(15, 20, 5),
			favorite: true,
		});
		const leo = summaries.find((entry) => entry.conversationId === "c2");
		expect(leo).toMatchObject({
			firstType: "Image",
			firstText: null,
			blockState: "blocked_by_me",
		});
		expect(await loadChatCounts(ME, week)).toEqual({ started: 2, real: 1 });
	});

	test("reply gaps, types, reactions and saved phrases", async () => {
		const gaps = await loadReplyGaps(ME, week);
		expect(gaps.map((gap) => [gap.mine, gap.gapMs])).toEqual([
			[true, 4 * 60_000],
			[false, 60_000],
		]);
		const types = await loadMessageTypes(ME, week);
		expect(
			types.find((row) => row.type === "Text" && row.mine === 0),
		).toMatchObject({ count: 2, unsent: 1 });
		expect(await loadReactions(ME, week)).toEqual({ received: 1, given: 1 });
		expect(await loadSavedPhraseUse(ME, week)).toEqual([
			{ phrase: "How's it going?", sent: 1, answered: 1 },
		]);
	});

	test("rankings, albums and records", async () => {
		expect((await loadMostMessages(week, 5))[0]).toMatchObject({
			conversationId: "c1",
			count: 4,
		});
		expect(await loadAlbumsReceived(ME, week)).toEqual([at(15, 20, 5)]);
		expect(await loadAlbumSharers(ME, 5)).toEqual([
			{ profileId: "7", albums: 1, items: 2 },
		]);
		const records = await loadMessageRecords(ME);
		expect(records.busiestMessageDay?.count).toBe(4);
		expect(records.fastestReply).toMatchObject({
			conversationId: "c1",
			gap: 60_000,
		});
		expect(records.biggestAlbum).toMatchObject({ profileId: "7", items: 2 });
	});

	test("block data collapses the two devices' copies and keeps earlier notes apart", async () => {
		const blocks = await loadBlockData(ME);
		expect(blocks.log).toHaveLength(1);
		// The note is not before the log started, so it is not counted twice.
		expect(blocks.earlierSelfBlocks).toHaveLength(0);
		expect(blocks.blockedYou[0]).toMatchObject({
			profileId: "7",
			firstTs: at(15, 20, 0),
			firstOutTs: at(15, 20, 4),
		});
	});

	test("the other logs", async () => {
		expect(await loadProfileEdits()).toEqual([
			{ timestamp: at(15, 8), fields: ["mainPhoto"] },
		]);
		expect(await loadProfileOpens(week)).toEqual([
			{ profileId: "7", timestamp: at(15, 19), viewRecorded: true },
		]);
		expect(await loadViewDistances(week)).toEqual([
			{
				profileId: "7",
				viewTimestamp: at(15, 19, 30),
				observedAt: at(15, 19, 31),
				meters: 850,
			},
		]);
	});

	// Last on purpose: it adds rows, and the tests above count exact totals.
	test("history moved from an earlier account is counted with this account's", async () => {
		const before = await loadStatsContext(ME);
		db.query(
			`INSERT INTO past_messages (message_id, conversation_id, sender_id, timestamp, type, body_json, created_at, updated_at, source_profile_id)
			 VALUES ('old1', '9:100', 9, ?1, 'Text', '{"text":"hi"}', 0, 0, '50'),
			        ('old2', '9:100', 100, ?2, 'Text', '{"text":"hello"}', 0, 0, '50')`,
		).run(at(1, 10), at(1, 11));
		db.query("INSERT INTO past_views VALUES ('9', '50', ?1, 0)").run(
			JSON.stringify({
				profileId: "9",
				displayName: "Old viewer",
				imageHash: null,
				timestamp: at(1, 9),
				viewCount: 1,
				viewTimestamps: [at(1, 9)],
			}),
		);

		const after = await loadStatsContext(ME);
		expect(after.sources.messages).toBe(before.sources.messages + 2);
		expect(after.sources.firstMessageAt).toBe(at(1, 10));
		expect(after.views).toHaveLength(before.views.length + 1);
		expect(after.viewers.some((row) => row.profileId === "9")).toBe(true);
		expect(after.sources.movedFromOldAccount).toBe(true);
		// A chat with no conversations row still counts as a chat with them.
		expect(after.contactsByProfile.get("9")).toMatchObject({
			conversationId: "9:100",
			firstIn: at(1, 10),
			firstOut: at(1, 11),
		});
		// The re-homed conversation reads like any other: one in, one out.
		const summaries = await loadConversationSummaries(ME, resolvePeriod("all", NOW));
		expect(summaries.some((row) => row.conversationId === "9:100")).toBe(true);
	});
});
