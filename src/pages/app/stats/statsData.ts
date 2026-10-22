/**
 * Everything the Stats page reads, gathered when the page (or one of its
 * sections) opens and never otherwise. Counting happens in SQLite wherever it
 * can, so a phone never holds a whole message table in memory; the viewer
 * store is the exception, since it lives in IndexedDB and is small.
 */

import * as chatDb from "../../../services/chatDb";
import { deriveOtherProfileIdFromConversationId } from "../../../services/conversationArchive";
import { interestViewsStore } from "../../../services/interestViewsStore";
import type { StatsPeriod } from "./statsCompute";
import {
	collapseBlockLog,
	firstViewByProfile,
	flattenViews,
	type BlockLogRow,
	type ConversationSummary,
	type LocationEntry,
	type ReplyGap,
	type ViewEvent,
	type ViewerRow,
} from "./statsCompute";

function select<T>(sql: string, params: unknown[] = []): Promise<T[]> {
	return chatDb.selectStatsRows<T>(sql, params);
}

/** SQLite has no "no lower bound": all time starts at zero. */
function lower(period: { start: number | null }): number {
	return period.start ?? 0;
}

const LOCAL_DAY =
	"strftime('%Y-%m-%d', timestamp / 1000, 'unixepoch', 'localtime')";

// ---------------------------------------------------------------------------
// Shared context — loaded once when the page opens
// ---------------------------------------------------------------------------

export type PersonInfo = {
	profileId: string;
	name: string | null;
	imageHash: string | null;
};

export type ChatContact = {
	conversationId: string;
	profileId: string;
	name: string | null;
	imageHash: string | null;
	favorite: boolean;
	blockState: string | null;
	firstIn: number | null;
	firstOut: number | null;
};

export type StatsContext = {
	me: number;
	loadedAt: number;
	viewers: ViewerRow[];
	views: ViewEvent[];
	firstViews: Map<string, number>;
	contactsByProfile: Map<string, ChatContact>;
	contactsByConversation: Map<string, ChatContact>;
	coverageHours: number[];
	/** The first moment any Stats log recorded anything, on any device. */
	trackingStart: number | null;
	locations: LocationEntry[];
	sources: {
		messages: number;
		firstMessageAt: number | null;
		conversations: number;
		statsRows: number;
		/** Some of the messages or viewers were moved from an earlier account. */
		movedFromOldAccount: boolean;
	};
};

export function personName(
	context: StatsContext,
	profileId: string,
): PersonInfo {
	const contact = context.contactsByProfile.get(profileId);
	const viewer = context.viewers.find((row) => row.profileId === profileId);
	return {
		profileId,
		name: contact?.name?.trim() || viewer?.displayName?.trim() || null,
		imageHash: contact?.imageHash ?? viewer?.imageHash ?? null,
	};
}

/**
 * This account's stored viewers plus those moved from an earlier account
 * (`past_views`). The moved ones stay out of the live viewer store so the
 * Interest list never shows them as visitors of this account.
 */
async function loadViewerRows(): Promise<ViewerRow[]> {
	const [current, past] = await Promise.all([
		interestViewsStore.getAll(),
		select<{ row_json: string }>("SELECT row_json FROM past_views").catch(() => []),
	]);
	const moved: ViewerRow[] = [];
	for (const row of past) {
		try {
			const parsed = JSON.parse(row.row_json) as ViewerRow;
			if (parsed && typeof parsed.profileId === "string") moved.push(parsed);
		} catch {
			// One unreadable row is not worth losing the page over.
		}
	}
	return [...current, ...moved];
}

export async function loadStatsContext(me: number): Promise<StatsContext> {
	const [viewers, contacts, coverage, trackingRows, locations, sourceRows, chatTimes, movedRows] =
		await Promise.all([
			loadViewerRows(),
			select<{
				conversation_id: string;
				other_profile_id: string;
				name: string | null;
				favorite: number;
				block_state: string | null;
				avatar_hash: string | null;
				first_in: number | null;
				first_out: number | null;
			}>(
				`SELECT c.conversation_id, c.other_profile_id, c.name, c.favorite, c.block_state,
				CASE WHEN json_valid(c.participants_json)
					THEN json_extract(c.participants_json, '$[0].primaryMediaHash') END AS avatar_hash,
				(SELECT MIN(m.timestamp) FROM stats_messages m
					WHERE m.conversation_id = c.conversation_id AND m.sender_id NOT IN (0, $1)) AS first_in,
				(SELECT MIN(m.timestamp) FROM stats_messages m
					WHERE m.conversation_id = c.conversation_id AND m.sender_id = $1) AS first_out
			 FROM conversations c
			 WHERE c.other_profile_id IS NOT NULL`,
				[me],
			),
			select<{ hour_start: number }>(
				"SELECT DISTINCT hour_start FROM stats_coverage_log",
			),
			select<{ first: number | null }>(
				`SELECT MIN(first) AS first FROM (
				SELECT MIN(first_at) AS first FROM stats_coverage_log
				UNION ALL SELECT MIN(timestamp) FROM stats_block_log
				UNION ALL SELECT MIN(timestamp) FROM stats_location_log
				UNION ALL SELECT MIN(timestamp) FROM stats_profile_edit_log
				UNION ALL SELECT MIN(timestamp) FROM stats_profile_open_log
				UNION ALL SELECT MIN(observed_at) FROM stats_view_distance_log
			)`,
			),
			select<LocationEntry>(
				"SELECT timestamp, geohash, name, lat, lon FROM stats_location_log ORDER BY timestamp ASC",
			),
			select<{
				messages: number;
				first_message_at: number | null;
				conversations: number;
				stats_rows: number;
			}>(
				`SELECT
				(SELECT COUNT(*) FROM stats_messages WHERE sender_id != 0) AS messages,
				(SELECT MIN(timestamp) FROM stats_messages WHERE sender_id != 0) AS first_message_at,
				(SELECT COUNT(*) FROM conversations) AS conversations,
				(SELECT COUNT(*) FROM stats_block_log) + (SELECT COUNT(*) FROM stats_location_log)
					+ (SELECT COUNT(*) FROM stats_coverage_log) + (SELECT COUNT(*) FROM stats_profile_edit_log)
					+ (SELECT COUNT(*) FROM stats_profile_open_log) + (SELECT COUNT(*) FROM stats_view_distance_log)
					AS stats_rows`,
			),
			// First message each way for every chat that has messages, so a
			// chat with no conversations row (deleted here, or moved from an
			// earlier account) still counts as a chat with that person.
			select<{ conversation_id: string; first_in: number | null; first_out: number | null }>(
				`SELECT conversation_id,
					MIN(CASE WHEN sender_id != $1 THEN timestamp END) AS first_in,
					MIN(CASE WHEN sender_id = $1 THEN timestamp END) AS first_out
				 FROM stats_messages WHERE sender_id != 0 GROUP BY conversation_id`,
				[me],
			),
			select<{ moved: number }>(
				`SELECT (EXISTS(SELECT 1 FROM past_messages) OR EXISTS(SELECT 1 FROM past_views)) AS moved`,
			).catch(() => []),
		]);

	const views = flattenViews(viewers);
	const contactsByProfile = new Map<string, ChatContact>();
	const contactsByConversation = new Map<string, ChatContact>();
	for (const row of contacts) {
		const contact: ChatContact = {
			conversationId: row.conversation_id,
			profileId: String(row.other_profile_id),
			name: row.name,
			imageHash: row.avatar_hash,
			favorite: Boolean(row.favorite),
			blockState: row.block_state,
			firstIn: row.first_in,
			firstOut: row.first_out,
		};
		contactsByConversation.set(contact.conversationId, contact);
		// A profile can have more than one conversation id over time (a
		// deleted and restarted chat). Keep the one with the earliest message.
		const existing = contactsByProfile.get(contact.profileId);
		const earliest = (value: ChatContact) =>
			Math.min(value.firstIn ?? Infinity, value.firstOut ?? Infinity);
		if (!existing || earliest(contact) < earliest(existing)) {
			contactsByProfile.set(contact.profileId, contact);
		}
	}
	for (const row of chatTimes) {
		if (contactsByConversation.has(row.conversation_id)) continue;
		const profileId = deriveOtherProfileIdFromConversationId(row.conversation_id, me);
		if (!profileId) continue;
		const contact: ChatContact = {
			conversationId: row.conversation_id,
			profileId,
			name: null,
			imageHash: null,
			favorite: false,
			blockState: null,
			firstIn: row.first_in,
			firstOut: row.first_out,
		};
		contactsByConversation.set(contact.conversationId, contact);
		if (!contactsByProfile.has(profileId)) contactsByProfile.set(profileId, contact);
	}
	const source = sourceRows[0];
	return {
		me,
		loadedAt: Date.now(),
		viewers,
		views,
		firstViews: firstViewByProfile(views),
		contactsByProfile,
		contactsByConversation,
		coverageHours: coverage.map((row) => row.hour_start),
		trackingStart: trackingRows[0]?.first ?? null,
		locations,
		sources: {
			messages: source?.messages ?? 0,
			firstMessageAt: source?.first_message_at ?? null,
			conversations: source?.conversations ?? 0,
			statsRows: source?.stats_rows ?? 0,
			movedFromOldAccount: Boolean(movedRows[0]?.moved),
		},
	};
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type ChatCounts = { started: number; real: number };

/** Chats started in a range, and how many of those both of you wrote in. */
export async function loadChatCounts(
	me: number,
	range: { start: number | null; end: number },
): Promise<ChatCounts> {
	const rows = await select<{ started: number | null; real: number | null }>(
		`WITH s AS (
			SELECT conversation_id, MIN(timestamp) AS first_ts,
				SUM(CASE WHEN sender_id = $1 THEN 1 ELSE 0 END) AS mine,
				SUM(CASE WHEN sender_id != $1 THEN 1 ELSE 0 END) AS theirs
			FROM stats_messages WHERE sender_id != 0 GROUP BY conversation_id
		)
		SELECT COUNT(*) AS started, SUM(CASE WHEN mine > 0 AND theirs > 0 THEN 1 ELSE 0 END) AS real
		FROM s WHERE first_ts >= $2 AND first_ts < $3`,
		[me, lower(range), range.end],
	);
	return { started: rows[0]?.started ?? 0, real: rows[0]?.real ?? 0 };
}

export type DayMessages = { day: string; received: number; sent: number };

export function loadMessagesPerDay(
	me: number,
	period: { start: number | null; end: number },
): Promise<DayMessages[]> {
	return select<DayMessages>(
		`SELECT ${LOCAL_DAY} AS day,
			SUM(CASE WHEN sender_id != $1 THEN 1 ELSE 0 END) AS received,
			SUM(CASE WHEN sender_id = $1 THEN 1 ELSE 0 END) AS sent
		 FROM stats_messages
		 WHERE sender_id != 0 AND timestamp >= $2 AND timestamp < $3
		 GROUP BY day`,
		[me, lower(period), period.end],
	);
}

export type WeekHourCount = {
	weekday: number;
	hour: number;
	received: number;
	sent: number;
};

export function loadMessagesByWeekHour(
	me: number,
	period: StatsPeriod,
): Promise<WeekHourCount[]> {
	return select<WeekHourCount>(
		`SELECT CAST(strftime('%w', timestamp / 1000, 'unixepoch', 'localtime') AS INTEGER) AS weekday,
			CAST(strftime('%H', timestamp / 1000, 'unixepoch', 'localtime') AS INTEGER) AS hour,
			SUM(CASE WHEN sender_id != $1 THEN 1 ELSE 0 END) AS received,
			SUM(CASE WHEN sender_id = $1 THEN 1 ELSE 0 END) AS sent
		 FROM stats_messages
		 WHERE sender_id != 0 AND timestamp >= $2 AND timestamp < $3
		 GROUP BY weekday, hour`,
		[me, lower(period), period.end],
	);
}

/** Conversations whose first stored message falls in the period, one summary each. */
export async function loadConversationSummaries(
	me: number,
	period: StatsPeriod,
): Promise<ConversationSummary[]> {
	const rows = await select<{
		conversation_id: string;
		other_profile_id: string | null;
		name: string | null;
		block_state: string | null;
		favorite: number | null;
		first_sender: number;
		first_ts: number;
		first_type: string | null;
		first_text: string | null;
		last_sender: number;
		last_ts: number;
		total: number;
		mine: number;
		first_in_ts: number | null;
		first_out_ts: number | null;
		first_in_text_ts: number | null;
		first_album_in_ts: number | null;
	}>(
		`WITH ordered AS (
			SELECT conversation_id, sender_id, timestamp, type,
				CASE WHEN json_valid(body_json) THEN json_extract(body_json, '$.text') END AS text,
				ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY timestamp ASC, message_id ASC) AS rn_first,
				ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY timestamp DESC, message_id DESC) AS rn_last
			FROM stats_messages
			WHERE sender_id != 0
		),
		summary AS (
			SELECT conversation_id,
				MAX(CASE WHEN rn_first = 1 THEN sender_id END) AS first_sender,
				MIN(timestamp) AS first_ts,
				MAX(CASE WHEN rn_first = 1 THEN type END) AS first_type,
				MAX(CASE WHEN rn_first = 1 THEN text END) AS first_text,
				MAX(CASE WHEN rn_last = 1 THEN sender_id END) AS last_sender,
				MAX(timestamp) AS last_ts,
				COUNT(*) AS total,
				SUM(CASE WHEN sender_id = $1 THEN 1 ELSE 0 END) AS mine,
				MIN(CASE WHEN sender_id != $1 THEN timestamp END) AS first_in_ts,
				MIN(CASE WHEN sender_id = $1 THEN timestamp END) AS first_out_ts,
				MIN(CASE WHEN sender_id != $1 AND text IS NOT NULL AND trim(text) != '' THEN timestamp END) AS first_in_text_ts,
				MIN(CASE WHEN sender_id != $1 AND type IN ('Album', 'ExpiringAlbum') THEN timestamp END) AS first_album_in_ts
			FROM ordered
			GROUP BY conversation_id
		)
		SELECT s.*, c.other_profile_id, c.name, c.block_state, c.favorite
		FROM summary s
		LEFT JOIN conversations c ON c.conversation_id = s.conversation_id
		WHERE s.first_ts >= $2 AND s.first_ts < $3`,
		[me, lower(period), period.end],
	);
	return rows.map((row) => ({
		conversationId: row.conversation_id,
		otherProfileId: row.other_profile_id,
		name: row.name,
		blockState: row.block_state,
		favorite: Boolean(row.favorite),
		firstSender: Number(row.first_sender),
		firstTs: row.first_ts,
		firstType: row.first_type,
		firstText: typeof row.first_text === "string" ? row.first_text : null,
		lastSender: Number(row.last_sender),
		lastTs: row.last_ts,
		total: row.total,
		mine: row.mine,
		firstInTs: row.first_in_ts,
		firstOutTs: row.first_out_ts,
		firstInTextTs: row.first_in_text_ts,
		firstAlbumInTs: row.first_album_in_ts,
	}));
}

/** Every change of speaker within the period: the gap before a reply. */
export async function loadReplyGaps(
	me: number,
	period: StatsPeriod,
): Promise<ReplyGap[]> {
	const rows = await select<{
		conversation_id: string;
		mine: number;
		gap: number;
		timestamp: number;
	}>(
		`WITH ordered AS (
			SELECT conversation_id, sender_id, timestamp,
				LAG(sender_id) OVER (PARTITION BY conversation_id ORDER BY timestamp, message_id) AS prev_sender,
				LAG(timestamp) OVER (PARTITION BY conversation_id ORDER BY timestamp, message_id) AS prev_ts
			FROM stats_messages
			WHERE sender_id != 0
		)
		SELECT conversation_id, CASE WHEN sender_id = $1 THEN 1 ELSE 0 END AS mine,
			timestamp - prev_ts AS gap, timestamp
		FROM ordered
		WHERE prev_sender IS NOT NULL AND prev_sender != sender_id
			AND timestamp >= $2 AND timestamp < $3
			AND timestamp - prev_ts BETWEEN 0 AND 43200000`,
		[me, lower(period), period.end],
	);
	return rows.map((row) => ({
		conversationId: row.conversation_id,
		mine: row.mine === 1,
		gapMs: row.gap,
		timestamp: row.timestamp,
	}));
}

export type TypeCount = {
	type: string | null;
	mine: number;
	count: number;
	unsent: number;
};

export function loadMessageTypes(
	me: number,
	period: StatsPeriod,
): Promise<TypeCount[]> {
	return select<TypeCount>(
		`SELECT type, CASE WHEN sender_id = $1 THEN 1 ELSE 0 END AS mine,
			COUNT(*) AS count, SUM(CASE WHEN unsent = 1 THEN 1 ELSE 0 END) AS unsent
		 FROM stats_messages
		 WHERE sender_id != 0 AND timestamp >= $2 AND timestamp < $3
		 GROUP BY type, mine`,
		[me, lower(period), period.end],
	);
}

export async function loadReactions(
	me: number,
	period: StatsPeriod,
): Promise<{ received: number; given: number }> {
	const rows = await select<{ received: number | null; given: number | null }>(
		`SELECT
			SUM(CASE WHEN m.sender_id = $1
				AND CAST(json_extract(r.value, '$.profileId') AS INTEGER) != $1 THEN 1 ELSE 0 END) AS received,
			SUM(CASE WHEN m.sender_id != $1
				AND CAST(json_extract(r.value, '$.profileId') AS INTEGER) = $1 THEN 1 ELSE 0 END) AS given
		 FROM stats_messages m,
			json_each(CASE WHEN json_valid(m.reactions_json) THEN m.reactions_json ELSE '[]' END) r
		 WHERE m.sender_id != 0 AND m.timestamp >= $2 AND m.timestamp < $3`,
		[me, lower(period), period.end],
	);
	return { received: rows[0]?.received ?? 0, given: rows[0]?.given ?? 0 };
}

export type PhraseUse = { phrase: string; sent: number; answered: number };

/**
 * How often each saved phrase was sent, and how often the other person wrote
 * back within a day.
 */
export async function loadSavedPhraseUse(
	me: number,
	period: StatsPeriod,
): Promise<PhraseUse[]> {
	const rows = await select<{ phrase: string; sent: number; answered: number }>(
		`WITH phrases AS (
			SELECT phrase, lower(trim(phrase)) AS normalized FROM saved_phrases
		),
		sent AS (
			SELECT m.conversation_id, m.timestamp,
				lower(trim(CASE WHEN json_valid(m.body_json) THEN json_extract(m.body_json, '$.text') END)) AS normalized
			FROM stats_messages m
			WHERE m.sender_id = $1 AND m.timestamp >= $2 AND m.timestamp < $3
		)
		SELECT p.phrase, COUNT(s.timestamp) AS sent,
			SUM(CASE WHEN EXISTS (
				SELECT 1 FROM stats_messages r
				WHERE r.conversation_id = s.conversation_id AND r.sender_id NOT IN (0, $1)
					AND r.timestamp > s.timestamp AND r.timestamp <= s.timestamp + 86400000
			) THEN 1 ELSE 0 END) AS answered
		FROM phrases p JOIN sent s ON s.normalized = p.normalized
		GROUP BY p.phrase
		ORDER BY sent DESC`,
		[me, lower(period), period.end],
	);
	return rows;
}

export type ConversationCount = {
	conversationId: string;
	count: number;
	lastTs: number;
};

export async function loadMostMessages(
	period: StatsPeriod,
	limit: number,
): Promise<ConversationCount[]> {
	const rows = await select<{
		conversation_id: string;
		count: number;
		last_ts: number;
	}>(
		`SELECT conversation_id, COUNT(*) AS count, MAX(timestamp) AS last_ts
		 FROM stats_messages
		 WHERE sender_id != 0 AND timestamp >= $1 AND timestamp < $2
		 GROUP BY conversation_id
		 ORDER BY count DESC, last_ts DESC
		 LIMIT $3`,
		[lower(period), period.end, limit],
	);
	return rows.map((row) => ({
		conversationId: row.conversation_id,
		count: row.count,
		lastTs: row.last_ts,
	}));
}

/** Timestamps of albums other people shared in chat. */
export async function loadAlbumsReceived(
	me: number,
	period: StatsPeriod,
): Promise<number[]> {
	const rows = await select<{ timestamp: number }>(
		`SELECT timestamp FROM stats_messages
		 WHERE type IN ('Album', 'ExpiringAlbum') AND sender_id NOT IN (0, $1)
			AND timestamp >= $2 AND timestamp < $3`,
		[me, lower(period), period.end],
	);
	return rows.map((row) => row.timestamp);
}

export type AlbumSharer = { profileId: string; albums: number; items: number };

export async function loadAlbumSharers(
	me: number,
	limit: number,
): Promise<AlbumSharer[]> {
	const rows = await select<{
		owner_profile_id: string;
		albums: number;
		items: number;
	}>(
		`SELECT a.owner_profile_id, COUNT(DISTINCT a.album_id) AS albums, COUNT(am.content_id) AS items
		 FROM albums a
		 LEFT JOIN album_media am ON am.album_id = a.album_id
		 WHERE a.owner_profile_id IS NOT NULL AND a.owner_profile_id != $1
		 GROUP BY a.owner_profile_id
		 ORDER BY albums DESC, items DESC
		 LIMIT $2`,
		[String(me), limit],
	);
	return rows.map((row) => ({
		profileId: String(row.owner_profile_id),
		albums: row.albums,
		items: row.items,
	}));
}

export type RecordRows = {
	busiestMessageDay: { day: string; count: number } | null;
	fastestReply: {
		conversationId: string;
		gap: number;
		timestamp: number;
	} | null;
	biggestAlbum: { profileId: string; items: number; createdAt: number } | null;
};

export async function loadMessageRecords(me: number): Promise<RecordRows> {
	const [busiest, fastest, album] = await Promise.all([
		select<{ day: string; count: number }>(
			`SELECT ${LOCAL_DAY} AS day, COUNT(*) AS count FROM stats_messages
			 WHERE sender_id != 0 GROUP BY day ORDER BY count DESC LIMIT 1`,
		),
		select<{ conversation_id: string; gap: number; timestamp: number }>(
			`WITH ordered AS (
				SELECT conversation_id, sender_id, timestamp,
					LAG(sender_id) OVER (PARTITION BY conversation_id ORDER BY timestamp, message_id) AS prev_sender,
					LAG(timestamp) OVER (PARTITION BY conversation_id ORDER BY timestamp, message_id) AS prev_ts
				FROM stats_messages WHERE sender_id != 0
			)
			SELECT conversation_id, timestamp - prev_ts AS gap, timestamp FROM ordered
			WHERE prev_sender = $1 AND sender_id != $1 AND timestamp - prev_ts > 0
			ORDER BY gap ASC LIMIT 1`,
			[me],
		),
		select<{ owner_profile_id: string; items: number; created_at: number }>(
			`SELECT a.owner_profile_id, COUNT(am.content_id) AS items, a.created_at
			 FROM albums a JOIN album_media am ON am.album_id = a.album_id
			 WHERE a.owner_profile_id IS NOT NULL AND a.owner_profile_id != $1
			 GROUP BY a.album_id ORDER BY items DESC LIMIT 1`,
			[String(me)],
		),
	]);
	return {
		busiestMessageDay: busiest[0] ?? null,
		fastestReply: fastest[0]
			? {
					conversationId: fastest[0].conversation_id,
					gap: fastest[0].gap,
					timestamp: fastest[0].timestamp,
				}
			: null,
		biggestAlbum: album[0]
			? {
					profileId: String(album[0].owner_profile_id),
					items: album[0].items,
					createdAt: album[0].created_at,
				}
			: null,
	};
}

// ---------------------------------------------------------------------------
// Blocking
// ---------------------------------------------------------------------------

export type BlockData = {
	/** The Stats block log, duplicates from two devices collapsed. */
	log: BlockLogRow[];
	/** When you blocked people before the log existed, from the chat notes. */
	earlierSelfBlocks: {
		timestamp: number;
		profileId: string | null;
		conversationId: string;
	}[];
	blockedYou: {
		profileId: string | null;
		conversationId: string;
		timestamp: number;
		name: string | null;
		imageHash: string | null;
		firstTs: number | null;
		firstOutTs: number | null;
	}[];
};

export async function loadBlockData(me: number): Promise<BlockData> {
	const [log, selfNotes, blockedYou] = await Promise.all([
		select<BlockLogRow>("SELECT * FROM stats_block_log ORDER BY timestamp ASC"),
		select<{
			timestamp: number;
			profile_id: string | null;
			conversation_id: string;
		}>(
			`SELECT m.timestamp, c.other_profile_id AS profile_id, m.conversation_id
			 FROM stats_messages m LEFT JOIN conversations c ON c.conversation_id = m.conversation_id
			 WHERE m.type = 'SystemBlockedBySelf'`,
		),
		select<{
			profile_id: string | null;
			conversation_id: string;
			timestamp: number;
			display_name: string | null;
			avatar_media_hash: string | null;
			first_ts: number | null;
			first_out_ts: number | null;
		}>(
			`SELECT be.profile_id, be.conversation_id, be.timestamp, be.display_name, be.avatar_media_hash,
				(SELECT MIN(m.timestamp) FROM stats_messages m
					WHERE m.conversation_id = be.conversation_id AND m.sender_id != 0) AS first_ts,
				(SELECT MIN(m.timestamp) FROM stats_messages m
					WHERE m.conversation_id = be.conversation_id AND m.sender_id = $1) AS first_out_ts
			 FROM block_events be
			 WHERE be.event_type = 'blocked'
			 ORDER BY be.timestamp DESC`,
			[me],
		),
	]);
	const collapsed = collapseBlockLog(log);
	const logStart = collapsed[0]?.timestamp ?? Infinity;
	// A deleted chat has no conversations row, but its id still names them.
	const profileOf = (profileId: string | null, conversationId: string) =>
		profileId != null
			? String(profileId)
			: deriveOtherProfileIdFromConversationId(conversationId, me);
	return {
		log: collapsed,
		earlierSelfBlocks: selfNotes
			.filter((note) => note.timestamp < logStart)
			.map((note) => ({
				timestamp: note.timestamp,
				profileId: profileOf(note.profile_id, note.conversation_id),
				conversationId: note.conversation_id,
			})),
		blockedYou: blockedYou.map((row) => ({
			profileId: profileOf(row.profile_id, row.conversation_id),
			conversationId: row.conversation_id,
			timestamp: row.timestamp,
			name: row.display_name,
			imageHash: row.avatar_media_hash,
			firstTs: row.first_ts,
			firstOutTs: row.first_out_ts,
		})),
	};
}

// ---------------------------------------------------------------------------
// Other logs
// ---------------------------------------------------------------------------

export type ProfileEdit = { timestamp: number; fields: string[] };

export async function loadProfileEdits(): Promise<ProfileEdit[]> {
	const rows = await select<{ timestamp: number; fields_json: string }>(
		"SELECT timestamp, fields_json FROM stats_profile_edit_log ORDER BY timestamp ASC",
	);
	return rows.map((row) => {
		let fields: string[] = [];
		try {
			const parsed = JSON.parse(row.fields_json);
			if (Array.isArray(parsed))
				fields = parsed.filter(
					(item): item is string => typeof item === "string",
				);
		} catch {
			// A row that cannot be read names no fields.
		}
		return { timestamp: row.timestamp, fields };
	});
}

export type ProfileOpen = {
	profileId: string;
	timestamp: number;
	viewRecorded: boolean;
};

export async function loadProfileOpens(
	period: StatsPeriod,
): Promise<ProfileOpen[]> {
	const rows = await select<{
		profile_id: string;
		timestamp: number;
		view_recorded: number;
	}>(
		`SELECT profile_id, timestamp, view_recorded FROM stats_profile_open_log
		 WHERE timestamp >= $1 AND timestamp < $2 ORDER BY timestamp ASC`,
		[lower(period), period.end],
	);
	return rows.map((row) => ({
		profileId: String(row.profile_id),
		timestamp: row.timestamp,
		viewRecorded: row.view_recorded === 1,
	}));
}

export type ViewDistance = {
	profileId: string;
	viewTimestamp: number;
	observedAt: number;
	meters: number;
};

export async function loadViewDistances(
	period: StatsPeriod,
): Promise<ViewDistance[]> {
	const rows = await select<{
		profile_id: string;
		view_timestamp: number;
		observed_at: number;
		distance_meters: number;
	}>(
		`SELECT profile_id, view_timestamp, observed_at, distance_meters FROM stats_view_distance_log
		 WHERE view_timestamp >= $1 AND view_timestamp < $2`,
		[lower(period), period.end],
	);
	return rows.map((row) => ({
		profileId: String(row.profile_id),
		viewTimestamp: row.view_timestamp,
		observedAt: row.observed_at,
		meters: row.distance_meters,
	}));
}

export async function loadDownloadedMedia() {
	return chatDb.getDownloadedMediaEntries();
}
