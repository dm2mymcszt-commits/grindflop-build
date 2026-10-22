/**
 * chatDb.ts — the durable chat database.
 *
 * Backs conversations, messages, media bytes (base64), albums, and avatars in
 * a single sqlite file. Nothing here is ever deleted by app logic except via
 * the explicit cascade delete used by the user-initiated "Delete conversation"
 * action — everything else (archive, unsend, expiry) is a flag flip, never a
 * row removal.
 *
 * Mirrors the connection/pragma/write-queue/lock-retry pattern already proven
 * in chatContactIndex.ts (the Tauri SQL plugin uses a connection pool without
 * session affinity, so manual BEGIN transactions are unreliable — avoid them).
 *
 * Booleans are bound as literal 1/0 integers (not JS true/false) and JSON
 * fields are JSON.stringify'd before binding — the plugin's JS->Rust bind path
 * has no BLOB-producing branch and serializes anything that isn't a string or
 * number through a generic JSON path, so we own the encoding explicitly rather
 * than rely on its implicit behavior. Media bytes are stored as base64 TEXT
 * for the same reason (no real BLOB write path from JS).
 */

import Database from "@tauri-apps/plugin-sql";
import { appDataDir } from "@tauri-apps/api/path";
import { BaseDirectory, exists, readDir, rename } from "@tauri-apps/plugin-fs";
import type { ConversationEntry, Message } from "../types/messages";
import type {
	AlbumMediaUpsertInput,
	AlbumUpsertInput,
	ArchivedReason,
	BlockEventType,
	BlockState,
	DownloadedMediaEntry,
	FullDbExport,
	MediaFileUpsertInput,
	StoredAlbum,
	StoredAlbumMedia,
	StoredAlbumMediaSummary,
	StoredAvatar,
	StoredBlockEvent,
	StoredContentCheck,
	StoredConversation,
	StoredMediaFile,
	StoredMessage,
} from "../types/chat-db";
import type { IndexedMessage } from "../types/chat-cache";
import {
	blockEventId,
	findSameBlockEvent,
	type StoredBlockEventTime,
} from "../utils/blockEventIdentity";
import {
	isCopyableAccountSetting,
	profileIdFromAccountDbFilename,
} from "../utils/accountSettingsCopyRules";
import type {
	PastContact,
	PastContactLoggedBlock,
	PastContactMessage,
	PastMessage,
} from "../utils/pastContactRules";
import { appLog } from "../utils/logger";
import type { BlockLogEntry } from "../utils/blockExplanation";
import {
	isFalseBlockedByOtherMarker,
	restoredStateAfterFalseMarker,
} from "../utils/blockAttribution";
import { countMergeableMessages, mergeConversationSteps } from "../utils/conversationMergeSql";
import { getMessageText } from "../utils/messageText";
import { guardAgainstClosedPool } from "./sqlitePoolGuard";

// Pre-multi-account file. Once a user is known, the active db switches to a
// per-account file (see setActiveChatDbUser) — this name only stays in play
// before login, and as the migration source for existing installs.
const LEGACY_CHAT_DB_FILENAME = "chat.sqlite3";
const LEGACY_CHAT_DB = `sqlite:${LEGACY_CHAT_DB_FILENAME}`;
const SQLITE_BUSY_TIMEOUT_MS = 5_000;
const SQLITE_LOCK_RETRY_DELAYS_MS = [30, 80, 180, 350] as const;

let activeChatDbName = LEGACY_CHAT_DB;
let activeChatDbProfileId: number | null = null;

type ConversationRow = {
	conversation_id: string;
	other_profile_id: string | null;
	name: string | null;
	participants_json: string;
	last_activity_timestamp: number | null;
	unread_count: number;
	pinned: number;
	muted: number;
	favorite: number;
	preview_json: string | null;
	archived: number;
	archived_reason: string | null;
	archived_at: number | null;
	hidden: number;
	block_state: string | null;
	last_seen_in_inbox_at: number | null;
	messages_synced_activity_timestamp: number | null;
	created_at: number;
	updated_at: number;
};

type MessageRow = {
	message_id: string;
	conversation_id: string;
	sender_id: number;
	timestamp: number;
	type: string | null;
	chat1_type: string | null;
	body_json: string | null;
	unsent: number;
	local_history: number;
	reply_to_message_id: string | null;
	reply_preview_json: string | null;
	reactions_json: string | null;
};

type MediaFileRow = {
	media_key: string;
	conversation_id: string | null;
	message_id: string | null;
	kind: string;
	mime_type: string | null;
	data_base64: string;
	view_once: number;
	size_bytes: number | null;
	fetch_status: string;
	fetched_at: number;
};

type AlbumRow = {
	album_id: string;
	owner_profile_id: string | null;
	album_name: string | null;
	conversation_id: string | null;
	shared_via_message_id: string | null;
	preview_cover_base64: string | null;
	preview_cover_mime_type: string | null;
	created_at: number;
	updated_at: number;
};

type AlbumMediaRow = {
	content_id: string;
	album_id: string;
	content_type: string | null;
	data_base64: string | null;
	thumb_data_base64: string | null;
	remaining_views: number | null;
	is_viewable: number | null;
	fetched_at: number | null;
};

type AvatarRow = {
	media_hash: string;
	data_base64: string;
	mime_type: string | null;
	fetched_at: number;
};

type BlockEventRow = {
	id: string;
	profile_id: string | null;
	conversation_id: string;
	event_type: string;
	timestamp: number;
	display_name: string | null;
	avatar_media_hash: string | null;
	created_at: number;
};

type DownloadedMediaRow = {
	identifier: string;
	platform: string;
	album_id: string | null;
	byte_size: number;
	mime_type: string | null;
	kind: string | null;
	saved_at: number;
};

let dbPromise: Promise<Database> | null = null;
let writeQueue: Promise<void> = Promise.resolve();

async function getDb(): Promise<Database> {
	if (!dbPromise) {
		dbPromise = (async () => {
			const db = guardAgainstClosedPool(await Database.load(activeChatDbName), "chat-db");
			try {
				await db.execute("PRAGMA journal_mode = WAL");
				await db.execute("PRAGMA synchronous = NORMAL");
				await db.execute(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
			} catch (error) {
				appLog.warn("[chat-db] failed to set pragmas", error);
			}

			await executeWithLockRetry(db, "init-tables", async () => {
				await db.execute(`
					CREATE TABLE IF NOT EXISTS conversations (
						conversation_id TEXT PRIMARY KEY,
						other_profile_id TEXT,
						name TEXT,
						participants_json TEXT NOT NULL,
						last_activity_timestamp INTEGER,
						unread_count INTEGER NOT NULL DEFAULT 0,
						pinned INTEGER NOT NULL DEFAULT 0,
						muted INTEGER NOT NULL DEFAULT 0,
						favorite INTEGER NOT NULL DEFAULT 0,
						preview_json TEXT,
						archived INTEGER NOT NULL DEFAULT 0,
						archived_reason TEXT,
						archived_at INTEGER,
						last_seen_in_inbox_at INTEGER,
						created_at INTEGER NOT NULL,
						updated_at INTEGER NOT NULL
					)
				`);
				await db.execute(
					"CREATE INDEX IF NOT EXISTS idx_conversations_other_profile ON conversations(other_profile_id)",
				);
				await db.execute(
					"CREATE INDEX IF NOT EXISTS idx_conversations_archived ON conversations(archived)",
				);
				// Added later: explicit, durable "who blocked whom" state — the
				// source of truth for archive/system-message decisions instead of
				// inferring direction from toggling `archived` on an ambiguous
				// chat.v1.conversation.delete event. NULL = not blocked either way.
				try {
					await db.execute("ALTER TABLE conversations ADD COLUMN block_state TEXT");
				} catch {
					// already migrated
				}
				// Added later: tracks message-fetch progress separately from
				// conversation-metadata freshness so inboxSync can resume an
				// interrupted first sync without re-walking conversations whose
				// messages already landed (see StoredConversation.messagesSyncedActivityTimestamp).
				try {
					await db.execute(
						"ALTER TABLE conversations ADD COLUMN messages_synced_activity_timestamp INTEGER",
					);
				} catch {
					// already migrated
				}
				// Added later: manual, local-only "hide this chat from the inbox"
				// flag — unlike `archived` (server says the conversation is gone),
				// hidden conversations still round-trip through /v4/inbox normally;
				// this only affects the client-side filteredConversations view.
				try {
					await db.execute("ALTER TABLE conversations ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0");
				} catch {
					// already migrated
				}

				await db.execute(`
					CREATE TABLE IF NOT EXISTS conversation_meta (
						conversation_id TEXT PRIMARY KEY,
						last_read_timestamp INTEGER
					)
				`);

				await db.execute(`
					CREATE TABLE IF NOT EXISTS messages (
						message_id TEXT PRIMARY KEY,
						conversation_id TEXT NOT NULL,
						sender_id INTEGER NOT NULL,
						timestamp INTEGER NOT NULL,
						type TEXT,
						chat1_type TEXT,
						body_json TEXT,
						unsent INTEGER NOT NULL DEFAULT 0,
						local_history INTEGER NOT NULL DEFAULT 0,
						reply_to_message_id TEXT,
						reply_preview_json TEXT,
						reactions_json TEXT,
						created_at INTEGER NOT NULL,
						updated_at INTEGER NOT NULL
					)
				`);
				await db.execute(
					"CREATE INDEX IF NOT EXISTS idx_messages_conversation_ts ON messages(conversation_id, timestamp)",
				);
				await db.execute(
					"CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages(reply_to_message_id)",
				);

				await db.execute(`
					CREATE TABLE IF NOT EXISTS media_files (
						media_key TEXT PRIMARY KEY,
						conversation_id TEXT,
						message_id TEXT,
						kind TEXT NOT NULL,
						mime_type TEXT,
						data_base64 TEXT NOT NULL,
						view_once INTEGER NOT NULL DEFAULT 0,
						size_bytes INTEGER,
						fetch_status TEXT NOT NULL DEFAULT 'ok',
						fetched_at INTEGER NOT NULL
					)
				`);
				await db.execute(
					"CREATE INDEX IF NOT EXISTS idx_media_files_message ON media_files(message_id)",
				);

				// What the on-device detector found in a received photo or video
				// (services/contentCheck.ts). The scores are kept rather than a
				// verdict, so a threshold can change without looking at every
				// photo again. Local to this device: nothing here is backed up
				// or synced, since it can always be worked out again.
				await db.execute(`
					CREATE TABLE IF NOT EXISTS content_checks (
						media_key TEXT PRIMARY KEY,
						message_id TEXT,
						conversation_id TEXT,
						kind TEXT NOT NULL,
						explicit_label TEXT,
						explicit_score REAL NOT NULL DEFAULT 0,
						cover_only_score REAL NOT NULL DEFAULT 0,
						face_score REAL NOT NULL DEFAULT 0,
						model TEXT NOT NULL,
						checked_at INTEGER NOT NULL
					)
				`);
				await db.execute(
					"CREATE INDEX IF NOT EXISTS idx_content_checks_message ON content_checks(message_id)",
				);
				// Added later: how much of the photo the face takes up, so "too far
				// away to recognise" can be told from "no face".
				try {
					await db.execute("ALTER TABLE content_checks ADD COLUMN face_share REAL");
				} catch {
					// already migrated
				}

				await db.execute(`
					CREATE TABLE IF NOT EXISTS albums (
						album_id TEXT PRIMARY KEY,
						owner_profile_id TEXT,
						album_name TEXT,
						conversation_id TEXT,
						shared_via_message_id TEXT,
						created_at INTEGER NOT NULL,
						updated_at INTEGER NOT NULL
					)
				`);
				// Added later: the chat bubble's blurred teaser preview, which comes
				// from the sharing message's own body (coverUrl/previewUrl) and is
				// visually distinct from the album's actual (clear) content
				// thumbnails in album_media. Best-effort migration — ignore
				// "duplicate column" once it already exists.
				try {
					await db.execute("ALTER TABLE albums ADD COLUMN preview_cover_base64 TEXT");
				} catch {
					// already migrated
				}
				try {
					await db.execute("ALTER TABLE albums ADD COLUMN preview_cover_mime_type TEXT");
				} catch {
					// already migrated
				}

				await db.execute(`
					CREATE TABLE IF NOT EXISTS album_media (
						content_id TEXT PRIMARY KEY,
						album_id TEXT NOT NULL,
						content_type TEXT,
						data_base64 TEXT,
						thumb_data_base64 TEXT,
						remaining_views INTEGER,
						is_viewable INTEGER,
						fetched_at INTEGER
					)
				`);
				await db.execute(
					"CREATE INDEX IF NOT EXISTS idx_album_media_album ON album_media(album_id)",
				);

				await db.execute(`
					CREATE TABLE IF NOT EXISTS avatars (
						media_hash TEXT PRIMARY KEY,
						data_base64 TEXT NOT NULL,
						mime_type TEXT,
						fetched_at INTEGER NOT NULL
					)
				`);

				await db.execute(`
					CREATE TABLE IF NOT EXISTS downloaded_media (
						identifier TEXT PRIMARY KEY,
						platform TEXT NOT NULL,
						album_id TEXT,
						byte_size INTEGER NOT NULL,
						mime_type TEXT,
						kind TEXT,
						saved_at INTEGER NOT NULL
					)
				`);

				await db.execute(`
					CREATE TABLE IF NOT EXISTS settings (
						key TEXT PRIMARY KEY,
						value TEXT NOT NULL
					)
				`);

				await db.execute(`
					CREATE TABLE IF NOT EXISTS saved_phrases (
						phrase TEXT PRIMARY KEY,
						created_at INTEGER NOT NULL
					)
				`);

				await db.execute(`
					CREATE TABLE IF NOT EXISTS saved_locations (
						id TEXT PRIMARY KEY,
						name TEXT NOT NULL,
						geohash TEXT NOT NULL,
						lat REAL NOT NULL,
						lon REAL NOT NULL,
						created_at INTEGER NOT NULL
					)
				`);

				await db.execute(`
					CREATE TABLE IF NOT EXISTS block_events (
						id TEXT PRIMARY KEY,
						profile_id TEXT,
						conversation_id TEXT NOT NULL,
						event_type TEXT NOT NULL,
						timestamp INTEGER NOT NULL,
						display_name TEXT,
						avatar_media_hash TEXT,
						created_at INTEGER NOT NULL
					)
				`);
				await db.execute(
					"CREATE INDEX IF NOT EXISTS idx_block_events_timestamp ON block_events(timestamp DESC)",
				);

				// Stats logs (services/statsLog.ts). Append-only records the Stats
				// page reads and nothing else does, written only while Stats is on.
				// Every id carries the writing device's id, so two devices never
				// overwrite each other's rows through Google Drive sync; the page
				// collapses the same event recorded by both.
				await db.execute(`
					CREATE TABLE IF NOT EXISTS stats_block_log (
						id TEXT PRIMARY KEY,
						event_type TEXT NOT NULL,
						profile_id TEXT,
						timestamp INTEGER NOT NULL,
						method TEXT NOT NULL,
						source TEXT NOT NULL,
						reason_kind TEXT,
						reason_detail TEXT,
						reason_label TEXT,
						rule_id TEXT,
						rule_name TEXT,
						device_id TEXT NOT NULL,
						device_name TEXT,
						created_at INTEGER NOT NULL
					)
				`);
				await db.execute(
					"CREATE INDEX IF NOT EXISTS idx_stats_block_log_timestamp ON stats_block_log(timestamp)",
				);
				await db.execute(`
					CREATE TABLE IF NOT EXISTS stats_location_log (
						id TEXT PRIMARY KEY,
						timestamp INTEGER NOT NULL,
						geohash TEXT NOT NULL,
						lat REAL,
						lon REAL,
						name TEXT,
						automatic INTEGER NOT NULL DEFAULT 0,
						device_id TEXT NOT NULL,
						device_name TEXT,
						created_at INTEGER NOT NULL
					)
				`);
				await db.execute(
					"CREATE INDEX IF NOT EXISTS idx_stats_location_log_timestamp ON stats_location_log(timestamp)",
				);
				await db.execute(`
					CREATE TABLE IF NOT EXISTS stats_coverage_log (
						id TEXT PRIMARY KEY,
						hour_start INTEGER NOT NULL,
						first_at INTEGER NOT NULL,
						source TEXT NOT NULL,
						device_id TEXT NOT NULL,
						device_name TEXT,
						created_at INTEGER NOT NULL
					)
				`);
				await db.execute(
					"CREATE INDEX IF NOT EXISTS idx_stats_coverage_log_hour ON stats_coverage_log(hour_start)",
				);
				await db.execute(`
					CREATE TABLE IF NOT EXISTS stats_profile_edit_log (
						id TEXT PRIMARY KEY,
						timestamp INTEGER NOT NULL,
						fields_json TEXT NOT NULL,
						device_id TEXT NOT NULL,
						device_name TEXT,
						created_at INTEGER NOT NULL
					)
				`);
				await db.execute(`
					CREATE TABLE IF NOT EXISTS stats_profile_open_log (
						id TEXT PRIMARY KEY,
						profile_id TEXT NOT NULL,
						timestamp INTEGER NOT NULL,
						view_recorded INTEGER NOT NULL DEFAULT 0,
						surface TEXT NOT NULL,
						device_id TEXT NOT NULL,
						device_name TEXT,
						created_at INTEGER NOT NULL
					)
				`);
				await db.execute(
					"CREATE INDEX IF NOT EXISTS idx_stats_profile_open_log_timestamp ON stats_profile_open_log(timestamp)",
				);
				// Keyed by the view itself rather than the device: the view time
				// comes from Grindr, so two devices that see the same view write
				// the same id and it is stored once.
				await db.execute(`
					CREATE TABLE IF NOT EXISTS stats_view_distance_log (
						id TEXT PRIMARY KEY,
						profile_id TEXT NOT NULL,
						view_timestamp INTEGER NOT NULL,
						observed_at INTEGER NOT NULL,
						distance_meters REAL NOT NULL,
						source TEXT NOT NULL,
						device_id TEXT NOT NULL,
						device_name TEXT,
						created_at INTEGER NOT NULL
					)
				`);
				await db.execute(
					"CREATE INDEX IF NOT EXISTS idx_stats_view_distance_log_view ON stats_view_distance_log(view_timestamp)",
				);
				// What an earlier account on this device knew about each person
				// (see utils/pastContactRules.ts), filled when moving to this one.
				await db.execute(`
					CREATE TABLE IF NOT EXISTS past_contacts (
						profile_id TEXT PRIMARY KEY,
						source_profile_id TEXT NOT NULL,
						display_name TEXT,
						their_messages INTEGER NOT NULL DEFAULT 0,
						my_messages INTEGER NOT NULL DEFAULT 0,
						first_message_at INTEGER,
						last_message_at INTEGER,
						last_text TEXT,
						blocked_by_me_at INTEGER,
						block_reason TEXT,
						blocked_me_at INTEGER,
						messages_json TEXT,
						updated_at INTEGER NOT NULL
					)
				`);
				try {
					await db.execute("ALTER TABLE past_contacts ADD COLUMN messages_json TEXT");
				} catch {
					// already there
				}
				// An earlier account's messages and viewers, re-homed to this
				// account (see utils/movedHistoryRules.ts) and read only by Stats.
				// Kept out of `messages` on purpose: chat code adopts messages
				// without a conversation row as a real conversation.
				await db.execute(`
					CREATE TABLE IF NOT EXISTS past_messages (
						message_id TEXT PRIMARY KEY,
						conversation_id TEXT NOT NULL,
						sender_id INTEGER NOT NULL,
						timestamp INTEGER NOT NULL,
						type TEXT,
						chat1_type TEXT,
						body_json TEXT,
						unsent INTEGER NOT NULL DEFAULT 0,
						local_history INTEGER NOT NULL DEFAULT 0,
						reply_to_message_id TEXT,
						reply_preview_json TEXT,
						reactions_json TEXT,
						created_at INTEGER NOT NULL,
						updated_at INTEGER NOT NULL,
						source_profile_id TEXT NOT NULL
					)
				`);
				await db.execute(
					"CREATE INDEX IF NOT EXISTS idx_past_messages_conversation_ts ON past_messages(conversation_id, timestamp)",
				);
				await db.execute(`
					CREATE TABLE IF NOT EXISTS past_views (
						profile_id TEXT PRIMARY KEY,
						source_profile_id TEXT NOT NULL,
						row_json TEXT NOT NULL,
						updated_at INTEGER NOT NULL
					)
				`);
				await db.execute(`
					CREATE VIEW IF NOT EXISTS stats_messages AS
					SELECT message_id, conversation_id, sender_id, timestamp, type, chat1_type, body_json, unsent, local_history, reply_to_message_id, reply_preview_json, reactions_json, created_at, updated_at FROM messages
					UNION ALL
					SELECT message_id, conversation_id, sender_id, timestamp, type, chat1_type, body_json, unsent, local_history, reply_to_message_id, reply_preview_json, reactions_json, created_at, updated_at FROM past_messages
				`);
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
					appLog.warn("[chat-db] recovered from sqlite lock", { label, attempt });
				}
				return;
			} catch (error) {
				const locked = isSqliteLockedError(error);
				if (!locked || attempt >= maxAttempts) {
					throw error;
				}

				const delayMs = SQLITE_LOCK_RETRY_DELAYS_MS[attempt - 1] ?? 400;
				appLog.warn("[chat-db] sqlite lock during write, retrying", {
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

export async function initChatDb(): Promise<void> {
	await getDb();
}

/**
 * On the very first switch to a given account, if that account doesn't have
 * its own db file yet but the pre-multi-account shared file does, rename it
 * into place instead of starting that account fresh — preserves existing
 * installs' chat history instead of silently losing it. Guarded by the
 * target file's existence so it only ever runs once per account.
 */
async function migrateLegacyDbIfNeeded(profileId: number): Promise<void> {
	const targetFilename = `chat-${profileId}.sqlite3`;
	try {
		const [targetExists, legacyExists] = await Promise.all([
			exists(targetFilename, { baseDir: BaseDirectory.AppData }),
			exists(LEGACY_CHAT_DB_FILENAME, { baseDir: BaseDirectory.AppData }),
		]);
		if (!targetExists && legacyExists) {
			await rename(LEGACY_CHAT_DB_FILENAME, targetFilename, {
				oldPathBaseDir: BaseDirectory.AppData,
				newPathBaseDir: BaseDirectory.AppData,
			});
			appLog.info(`[chat-db] migrated legacy chat db -> ${targetFilename}`);
		}
	} catch (error) {
		appLog.warn("[chat-db] legacy db migration check failed", error);
	}
}

/**
 * Points the chat db at the given account's own file, closing the previous
 * connection first — each account's conversations/messages/media live in a
 * fully separate sqlite file, so switching accounts can never show stale
 * data from a previous one, and switching back needs no refetch.
 */
export async function setActiveChatDbUser(profileId: number | null): Promise<void> {
	const nextDbName = profileId != null ? `sqlite:chat-${profileId}.sqlite3` : LEGACY_CHAT_DB;
	if (nextDbName === activeChatDbName && dbPromise) {
		return;
	}

	if (dbPromise) {
		try {
			const db = await dbPromise;
			// Must pass db.path — close() with no argument closes every open
			// sql plugin pool, not just this one, which was killing the
			// unrelated chat-index connection out from under chatContactIndex.ts
			// on every account switch ("acquire a connection on a closed pool").
			await db.close(db.path);
		} catch (error) {
			appLog.warn("[chat-db] failed to close previous connection", error);
		}
	}

	dbPromise = null;
	writeQueue = Promise.resolve();
	activeChatDbName = nextDbName;
	activeChatDbProfileId = profileId;

	if (profileId != null) {
		await migrateLegacyDbIfNeeded(profileId);
		await getDb();
		await repairSyntheticBlockedConversations().catch((error) => {
			appLog.warn("[chat-db] failed to repair synthetic blocked conversations", error);
		});
		await repairArchivedConversationPreviews().catch((error) => {
			appLog.warn("[chat-db] failed to repair archived conversation previews", error);
		});
		await repairFalseBlockedByOtherMarkers().catch((error) => {
			appLog.warn("[chat-db] failed to repair false blocked-by-other markers", error);
		});
		await purgeEmptySyntheticBlockedConversations().catch((error) => {
			appLog.warn("[chat-db] failed to purge empty synthetic blocked conversations", error);
		});
	}
}

export function getActiveChatDbUser(): number | null {
	return activeChatDbProfileId;
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

function rowToStoredConversation(row: ConversationRow): StoredConversation {
	const entry: ConversationEntry = {
		data: {
			conversationId: row.conversation_id,
			name: row.name ?? "",
			participants: JSON.parse(
				row.participants_json,
			) as ConversationEntry["data"]["participants"],
			lastActivityTimestamp: row.last_activity_timestamp,
			unreadCount: row.unread_count,
			preview: row.preview_json
				? (JSON.parse(row.preview_json) as ConversationEntry["data"]["preview"])
				: null,
			muted: Boolean(row.muted),
			pinned: Boolean(row.pinned),
			favorite: Boolean(row.favorite),
		},
	};

	return {
		conversationId: row.conversation_id,
		otherProfileId: row.other_profile_id,
		entry,
		archived: Boolean(row.archived),
		archivedReason: (row.archived_reason as ArchivedReason | null) ?? null,
		archivedAt: row.archived_at,
		hidden: Boolean(row.hidden),
		blockState: (row.block_state as BlockState | null) ?? null,
		lastSeenInInboxAt: row.last_seen_in_inbox_at,
		messagesSyncedActivityTimestamp: row.messages_synced_activity_timestamp,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export async function upsertConversation(
	entry: ConversationEntry,
	otherProfileId: string | null,
): Promise<void> {
	const db = await getDb();
	const now = Date.now();

	await executeWithLockRetry(db, "upsert-conversation", async () => {
		await db.execute(
			`
			INSERT INTO conversations (
				conversation_id, other_profile_id, name, participants_json,
				last_activity_timestamp, unread_count, pinned, muted, favorite,
				preview_json, archived, archived_reason, archived_at,
				last_seen_in_inbox_at, created_at, updated_at
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, NULL, NULL, NULL, $11, $11)
			ON CONFLICT(conversation_id) DO UPDATE SET
				other_profile_id = excluded.other_profile_id,
				name = excluded.name,
				participants_json = excluded.participants_json,
				last_activity_timestamp = excluded.last_activity_timestamp,
				unread_count = excluded.unread_count,
				pinned = excluded.pinned,
				muted = excluded.muted,
				favorite = excluded.favorite,
				preview_json = excluded.preview_json,
				updated_at = excluded.updated_at
			`,
			[
				entry.data.conversationId,
				otherProfileId,
				entry.data.name ?? "",
				JSON.stringify(entry.data.participants ?? []),
				entry.data.lastActivityTimestamp ?? null,
				entry.data.unreadCount ?? 0,
				entry.data.pinned ? 1 : 0,
				entry.data.muted ? 1 : 0,
				entry.data.favorite ? 1 : 0,
				entry.data.preview ? JSON.stringify(entry.data.preview) : null,
				now,
			],
		);
	});
}

/**
 * Records that this conversation's messages are up to date as of
 * `activityTimestamp` (its lastActivityTimestamp at fetch time) — lets
 * inboxSync distinguish "conversation metadata is current" from "messages
 * are current" so a resumed sync only re-fetches conversations that never
 * actually got their messages, instead of every conversation seen so far.
 */
export async function markConversationMessagesSynced(
	conversationId: string,
	activityTimestamp: number | null,
): Promise<void> {
	const db = await getDb();
	await executeWithLockRetry(db, "mark-conversation-messages-synced", async () => {
		await db.execute(
			"UPDATE conversations SET messages_synced_activity_timestamp = $1 WHERE conversation_id = $2",
			[activityTimestamp, conversationId],
		);
	});
}

export async function getConversation(
	conversationId: string,
): Promise<StoredConversation | null> {
	const db = await getDb();
	const rows = await db.select<ConversationRow[]>(
		"SELECT * FROM conversations WHERE conversation_id = $1",
		[conversationId],
	);
	const row = rows[0];
	return row ? rowToStoredConversation(row) : null;
}

export async function listConversations(options?: {
	includeArchived?: boolean;
}): Promise<StoredConversation[]> {
	const db = await getDb();
	const rows = options?.includeArchived
		? await db.select<ConversationRow[]>(
				"SELECT * FROM conversations ORDER BY pinned DESC, last_activity_timestamp DESC",
			)
		: await db.select<ConversationRow[]>(
				"SELECT * FROM conversations WHERE archived = 0 ORDER BY pinned DESC, last_activity_timestamp DESC",
			);
	return rows.map(rowToStoredConversation);
}

/**
 * Unarchived conversations recent (or pinned) enough that they'd belong on
 * the same inbox page as `sinceTimestamp` — used to recover a conversation
 * the server has permanently stopped listing (e.g. it was blocked and
 * deleted there; the server only relists it once someone messages that
 * profile afresh) without falling back to the *entire* local history, which
 * would defeat pagination. `sinceTimestamp` should be the least-recent
 * lastActivityTimestamp actually present in the current live response — a
 * locally-known conversation newer than that would have to appear on this
 * same page too, so its absence means the server can no longer produce it at
 * all, not that it merely fell further down the pagination.
 */
export async function listConversationsSince(sinceTimestamp: number): Promise<StoredConversation[]> {
	const db = await getDb();
	const rows = await db.select<ConversationRow[]>(
		"SELECT * FROM conversations WHERE archived = 0 AND (pinned = 1 OR last_activity_timestamp >= $1) ORDER BY pinned DESC, last_activity_timestamp DESC",
		[sinceTimestamp],
	);
	return rows.map(rowToStoredConversation);
}

export async function findConversationByProfileId(
	profileId: string,
): Promise<StoredConversation | null> {
	const db = await getDb();
	const rows = await db.select<ConversationRow[]>(
		"SELECT * FROM conversations WHERE other_profile_id = $1 ORDER BY updated_at DESC LIMIT 1",
		[profileId],
	);
	const row = rows[0];
	return row ? rowToStoredConversation(row) : null;
}

/**
 * Recovers a conversation whose `conversations` row is gone (e.g. removed via
 * deleteConversationOnly, which only deletes the conversation/meta rows and
 * never touches `messages` — see file header) but whose message history is
 * still sitting in `messages` under a known conversationId. There's nothing
 * left in `conversations` to look this conversationId up by profile id once
 * the row is deleted, so the caller must supply it from elsewhere (chat
 * contact index still remembers it).
 *
 * Returns a synthesized, not-yet-persisted StoredConversation so the caller
 * can hydrate the thread from local history without resurrecting a stale row
 * into the active inbox or assuming the live conversation still exists.
 * The profile itself may still be perfectly reachable, so callers should keep
 * the composer enabled and route sends through the normal targetProfileId
 * path rather than treating this like an archived/read-only thread — a real
 * `conversations` row is only written again once that succeeds (normal
 * upsertConversation path).
 */
export async function recoverOrphanedConversation(
	conversationId: string,
	otherProfileId: string,
): Promise<StoredConversation | null> {
	const db = await getDb();
	const rows = await db.select<MessageRow[]>(
		`SELECT * FROM messages
		 WHERE conversation_id = $1
		 ORDER BY CASE WHEN COALESCE(type, '') LIKE 'System%' THEN 1 ELSE 0 END ASC,
		          timestamp DESC
		 LIMIT 1`,
		[conversationId],
	);
	const lastMessageRow = rows[0];
	if (!lastMessageRow) {
		return null;
	}
	let messageText: string | null = null;
	if (lastMessageRow.body_json) {
		try {
			const body = JSON.parse(lastMessageRow.body_json) as Record<string, unknown>;
			messageText = typeof body.text === "string" ? body.text : null;
		} catch {
			// A malformed historical body should not prevent the conversation
			// itself from being recovered.
		}
	}

	const now = Date.now();
	const entry: ConversationEntry = {
		data: {
			conversationId,
			name: "",
			participants: [{ profileId: Number(otherProfileId) }],
			lastActivityTimestamp: lastMessageRow.timestamp,
			unreadCount: 0,
			preview: {
				conversationId: { value: conversationId },
				messageId: lastMessageRow.message_id,
				senderId: lastMessageRow.sender_id,
				type: lastMessageRow.type ?? "Unknown",
				chat1Type: lastMessageRow.chat1_type,
				text: messageText,
			},
			muted: false,
			pinned: false,
			favorite: false,
		},
	};

	return {
		conversationId,
		otherProfileId,
		entry,
		archived: false,
		archivedReason: null,
		archivedAt: null,
		hidden: false,
		blockState: null,
		lastSeenInInboxAt: null,
		messagesSyncedActivityTimestamp: null,
		createdAt: now,
		updatedAt: now,
	};
}

/**
 * Finds the newest real conversation that has locally saved incoming content
 * from `profileId` but no conversations row. This is the signature left by
 * the old realtime auto-block race: the incoming message was saved under the
 * server id, then applySelfBlockAction could not find its metadata and made a
 * separate `direct:<profileId>` archive shell.
 */
export async function recoverLatestOrphanedConversationForProfile(
	profileId: string,
): Promise<StoredConversation | null> {
	const numericProfileId = Number(profileId);
	if (!Number.isFinite(numericProfileId)) {
		return null;
	}
	const db = await getDb();
	const rows = await db.select<{ conversation_id: string }[]>(
		`
		SELECT m.conversation_id
		FROM messages m
		LEFT JOIN conversations c ON c.conversation_id = m.conversation_id
		WHERE c.conversation_id IS NULL
		  AND m.sender_id = $1
		  AND COALESCE(m.type, '') NOT LIKE 'System%'
		  AND m.conversation_id NOT LIKE 'direct:%'
		GROUP BY m.conversation_id
		ORDER BY MAX(m.timestamp) DESC
		LIMIT 1
		`,
		[numericProfileId],
	);
	const conversationId = rows[0]?.conversation_id;
	return conversationId
		? recoverOrphanedConversation(conversationId, profileId)
		: null;
}

/**
 * Repairs archives produced by the historical realtime auto-block race.
 * Only synthetic rows containing system markers (no user content) are
 * replaced, so a legitimate local `direct:*` draft can never be discarded.
 */
export async function repairSyntheticBlockedConversations(): Promise<number> {
	const correlationWindowMs = 5 * 60_000;
	const syntheticRows = (await listConversations({ includeArchived: true })).filter(
		(conversation) =>
			conversation.archived &&
			conversation.conversationId.startsWith("direct:") &&
			conversation.otherProfileId != null &&
			conversation.blockState != null,
	);
	let repaired = 0;

	for (const synthetic of syntheticRows) {
		const syntheticMessages = await getMessages(synthetic.conversationId);
		if (syntheticMessages.some((message) => !message.type.startsWith("System"))) {
			continue;
		}

		const recovered = await recoverLatestOrphanedConversationForProfile(
			synthetic.otherProfileId!,
		);
		if (!recovered || recovered.conversationId === synthetic.conversationId) {
			continue;
		}
		const markerTimestamp = syntheticMessages.reduce(
			(latest, message) => Math.max(latest, message.timestamp),
			0,
		);
		const recoveredTimestamp = recovered.entry.data.lastActivityTimestamp ?? 0;
		if (
			markerTimestamp === 0 ||
			recoveredTimestamp === 0 ||
			Math.abs(markerTimestamp - recoveredTimestamp) > correlationWindowMs
		) {
			continue;
		}

		await upsertConversation(recovered.entry, synthetic.otherProfileId);
		await setConversationArchived(
			recovered.conversationId,
			true,
			synthetic.archivedReason ?? "ws_delete",
		);
		await setBlockState(recovered.conversationId, synthetic.blockState);

		const recoveredMessages = await getMessages(recovered.conversationId);
		for (const marker of syntheticMessages.filter((message) =>
			message.type.startsWith("System"),
		)) {
			if (!recoveredMessages.some((message) => message.type === marker.type)) {
				await insertSystemMessage(
					recovered.conversationId,
					marker.type as SystemMessageType,
					marker.timestamp,
				);
			}
		}

		await deleteConversationCascade(synthetic.conversationId);
		repaired += 1;
		appLog.info("[chat-db] repaired synthetic blocked conversation", {
			profileId: synthetic.otherProfileId,
			from: synthetic.conversationId,
			to: recovered.conversationId,
		});
	}

	return repaired;
}

/**
 * Ensures archived inbox rows preview their latest real message rather than
 * a synthetic block marker. The marker belongs in the thread timeline, but
 * using it as the conversation preview makes a chat with preserved content
 * render as "No messages yet" in the archived list.
 */
export async function repairArchivedConversationPreviews(): Promise<number> {
	const archivedRows = (await listConversations({ includeArchived: true })).filter(
		(conversation) => conversation.archived,
	);
	let repaired = 0;

	for (const conversation of archivedRows) {
		const currentPreviewType = conversation.entry.data.preview?.type ?? "";
		if (
			conversation.entry.data.preview &&
			!currentPreviewType.startsWith("System")
		) {
			continue;
		}

		const messages = await getMessages(conversation.conversationId);
		const lastContentMessage = [...messages]
			.reverse()
			.find((message) => !message.type.startsWith("System"));
		if (!lastContentMessage) {
			continue;
		}

		const body = lastContentMessage.body as Record<string, unknown> | null | undefined;
		await upsertConversation(
			{
				...conversation.entry,
				data: {
					...conversation.entry.data,
					lastActivityTimestamp: lastContentMessage.timestamp,
					preview: {
						conversationId: { value: conversation.conversationId },
						messageId: lastContentMessage.messageId,
						senderId: lastContentMessage.senderId,
						type: lastContentMessage.type,
						chat1Type: lastContentMessage.chat1Type,
						text: typeof body?.text === "string" ? body.text : null,
					},
				},
			},
			conversation.otherProfileId,
		);
		repaired += 1;
	}

	return repaired;
}

/**
 * Removes "You were blocked" markers that record a block nobody made.
 *
 * ChatPage's 403 handler used to re-derive who blocked whom every time an
 * inaccessible thread was opened, ignoring the block_state already on the
 * conversation. By then this device's own block marker had been spent by the
 * block that set that state, and the two remaining signals both fail *towards*
 * "they blocked me" — an other_profile_id that was never backfilled, and a
 * block-list request that errored. So opening a chat you had blocked wrote a
 * permanent "You were blocked" under your own "You blocked this person", moved
 * block_state to blocked_by_other, and fed a phantom into the Stats "Blocked
 * you" figures. resolveBlockAttribution now prevents new ones; this clears the
 * ones already written.
 *
 * Deliberately narrow — a marker is only false when this account's own block
 * was already in force when it was written:
 *  - "they blocked me" *before* my block is a real block I counter-blocked;
 *  - my block, then my unblock, then theirs is a real block too.
 * Both are left alone. Anything else keeps its marker.
 *
 * Rows are Drive-synced with tombstones, so removing them here propagates to
 * the other devices on the next full reconcile instead of coming back.
 */
export async function repairFalseBlockedByOtherMarkers(): Promise<number> {
	const db = await getDb();
	// insertSystemMessage keys these by type and conversation, so a
	// conversation holds at most one row of each type and the timestamps can
	// simply be compared against each other.
	const markers = await db.select<
		{ conversation_id: string; message_id: string; type: string; timestamp: number }[]
	>(
		`SELECT conversation_id, message_id, type, timestamp FROM messages
		 WHERE type IN ('SystemBlocked', 'SystemBlockedBySelf', 'SystemUnblockedBySelf')`,
	);

	const byConversation = new Map<string, Map<string, { messageId: string; timestamp: number }>>();
	for (const marker of markers) {
		const entry = byConversation.get(marker.conversation_id) ?? new Map();
		entry.set(marker.type, { messageId: marker.message_id, timestamp: marker.timestamp });
		byConversation.set(marker.conversation_id, entry);
	}

	let repaired = 0;
	for (const [conversationId, types] of byConversation) {
		const blockedByOther = types.get("SystemBlocked");
		const blockedBySelf = types.get("SystemBlockedBySelf");
		const markerTimestamps = {
			blockedByOther: blockedByOther?.timestamp ?? null,
			blockedBySelf: blockedBySelf?.timestamp ?? null,
			unblockedBySelf: types.get("SystemUnblockedBySelf")?.timestamp ?? null,
		};
		// A chat this account unblocked cannot still be blocked_by_me. The first
		// version of this pass restored exactly that when it cleared a false
		// marker from an unblocked chat, which stranded it in the archive with
		// no way out: the unblock button only appears while the server's block
		// list still holds that person, and it correctly no longer does. Checked
		// before the false-marker branch because such a chat has already lost
		// its marker and would never reach it.
		if (
			markerTimestamps.unblockedBySelf != null &&
			markerTimestamps.blockedBySelf != null &&
			markerTimestamps.unblockedBySelf > markerTimestamps.blockedBySelf
		) {
			const stranded = await getConversation(conversationId).catch(() => null);
			if (stranded?.blockState === "blocked_by_me") {
				await setBlockState(conversationId, null);
				await setConversationArchived(conversationId, false, null);
				repaired += 1;
				appLog.info("[chat-db] freed a chat left blocked_by_me after its own unblock", {
					conversationId,
				});
			}
		}

		if (!blockedByOther || !isFalseBlockedByOtherMarker(markerTimestamps)) {
			continue;
		}

		await deleteMessageRow(blockedByOther.messageId);
		// The Stats "Blocked you" list reads block_events directly, so the
		// phantom has to come out of there too or it stays in the figures.
		await executeWithLockRetry(db, "delete-false-block-event", async () => {
			await db.execute(
				"DELETE FROM block_events WHERE conversation_id = $1 AND event_type = 'blocked' AND timestamp = $2",
				[conversationId, blockedByOther.timestamp],
			);
		});
		// Only when it still holds the wrong attribution: an unblock since then
		// has legitimately cleared it, and that null must stand.
		const conversation = await getConversation(conversationId).catch(() => null);
		if (conversation?.blockState === "blocked_by_other") {
			const restored = restoredStateAfterFalseMarker(markerTimestamps);
			await setBlockState(conversationId, restored);
			// The false marker is also what archived the chat. If this account's
			// own last move was an unblock, there is nothing left holding it
			// there — leaving it archived is what made an unblocked person look
			// unreachable, with no unblock button to press because the server's
			// block list (correctly) no longer holds them. Unarchiving hands it
			// back to the normal sweeps, which will archive it again, properly
			// attributed, if they really did block this account.
			if (restored === null) {
				await setConversationArchived(conversationId, false, null);
			}
		}

		repaired += 1;
		appLog.info("[chat-db] removed a false \"You were blocked\" marker", {
			conversationId,
			blockedBySelfAt: blockedBySelf?.timestamp ?? null,
			falseMarkerAt: blockedByOther.timestamp,
		});
	}

	return repaired;
}

/**
 * Guards the one-time purge below. Stored per account (settings live in that
 * account's own db file), so each account is cleaned exactly once.
 */
const SYNTHETIC_PLACEHOLDER_PURGE_KEY = "synthetic-block-placeholder-purge-v2";

/**
 * One-time removal of archive shells for people the user never actually had a
 * conversation with.
 *
 * Interest-view auto-blocking fabricated these two ways: applySelfBlockAction
 * minting a `direct:<profileId>` row, and — the one that actually fired in
 * practice — preserveAndAutoBlockProfile accepting an empty message list from
 * a *derived* `<a>:<b>` id as proof that a conversation existed. Both produced
 * archived "chats" reading "No messages yet" carrying a single "You blocked
 * this person" marker. Neither path creates them any more; this clears the
 * ones already on disk, whichever id shape they took.
 *
 * Runs after repairSyntheticBlockedConversations, so any shell whose real
 * conversation could be recovered has already been migrated and is not a
 * candidate here. All four guards have to hold: no preview, no content
 * message, no media, no album. The preview is the load-bearing one — a
 * conversation that genuinely existed was built from an inbox entry and
 * carries its last message as a preview, while a fabricated shell is built
 * with `preview: null` because there was no message to build one from.
 */
export async function purgeEmptySyntheticBlockedConversations(): Promise<number> {
	const alreadyPurged = await getSetting<boolean>(SYNTHETIC_PLACEHOLDER_PURGE_KEY).catch(
		() => null,
	);
	if (alreadyPurged) {
		return 0;
	}

	const candidates = (await listConversations({ includeArchived: true })).filter(
		(conversation) =>
			conversation.archived &&
			conversation.blockState === "blocked_by_me" &&
			!conversation.entry.data.preview,
	);

	let purged = 0;
	for (const candidate of candidates) {
		const messages = await getMessages(candidate.conversationId);
		if (messages.some((message) => !message.type.startsWith("System"))) {
			continue;
		}
		const [media, albums] = await Promise.all([
			getMediaFilesForConversation(candidate.conversationId),
			getAlbumsForConversation(candidate.conversationId),
		]);
		if (media.length > 0 || albums.length > 0) {
			continue;
		}

		await deleteConversationCascade(candidate.conversationId);
		purged += 1;
		appLog.info("[chat-db] purged empty synthetic blocked conversation", {
			conversationId: candidate.conversationId,
			profileId: candidate.otherProfileId,
		});
	}

	await setSetting(SYNTHETIC_PLACEHOLDER_PURGE_KEY, true).catch((error) => {
		appLog.warn("[chat-db] failed to record synthetic placeholder purge", error);
	});
	return purged;
}

/**
 * Bulk lookup of the local block_state for a set of profiles — used to gate
 * profile navigation outside of chat (e.g. Interest/Taps) the same way
 * ChatThreadPanel/ChatInboxPanel gate it via a conversation's archived
 * state, without one DB round trip per row.
 */
export async function getBlockStatesByProfileIds(
	profileIds: string[],
): Promise<Map<string, BlockState>> {
	if (profileIds.length === 0) {
		return new Map();
	}
	const db = await getDb();
	const placeholders = profileIds.map((_, i) => `$${i + 1}`).join(", ");
	const rows = await db.select<{ other_profile_id: string; block_state: string }[]>(
		`SELECT other_profile_id, block_state FROM conversations WHERE other_profile_id IN (${placeholders}) AND block_state IS NOT NULL`,
		profileIds,
	);
	return new Map(rows.map((row) => [row.other_profile_id, row.block_state as BlockState]));
}

/**
 * Backfills other_profile_id for a conversation whose row already exists
 * but was created without it resolved (e.g. a chat.v1.conversation.delete
 * arriving for a conversation started moments earlier, before it's ever been
 * through a normal /v4/inbox sync — upsertConversation is what normally
 * keeps this current, but that requires the participant list from a live
 * inbox entry). Never overwrites a value that's already set.
 */
export async function backfillOtherProfileId(
	conversationId: string,
	otherProfileId: string,
): Promise<void> {
	const db = await getDb();
	const now = Date.now();

	await executeWithLockRetry(db, "backfill-other-profile-id", async () => {
		await db.execute(
			"UPDATE conversations SET other_profile_id = $2, updated_at = $3 WHERE conversation_id = $1 AND other_profile_id IS NULL",
			[conversationId, otherProfileId, now],
		);
	});
}

export async function setConversationArchived(
	conversationId: string,
	archived: boolean,
	reason: ArchivedReason | null,
): Promise<void> {
	const db = await getDb();
	const now = Date.now();

	await executeWithLockRetry(db, "set-conversation-archived", async () => {
		await db.execute(
			`
			UPDATE conversations
			SET archived = $2, archived_reason = $3, archived_at = $4, updated_at = $5,
			    hidden = CASE WHEN $2 = 1 THEN 0 ELSE hidden END
			WHERE conversation_id = $1
			`,
			[conversationId, archived ? 1 : 0, archived ? reason : null, archived ? now : null, now],
		);
	});
}

export async function setConversationHidden(
	conversationId: string,
	hidden: boolean,
): Promise<void> {
	const db = await getDb();
	const now = Date.now();

	await executeWithLockRetry(db, "set-conversation-hidden", async () => {
		await db.execute(
			"UPDATE conversations SET hidden = $2, updated_at = $3 WHERE conversation_id = $1",
			[conversationId, hidden ? 1 : 0, now],
		);
	});
}

/** All conversation ids currently flagged hidden — used to hydrate ChatPage's
 * in-memory set once on mount, since hidden conversations are otherwise
 * indistinguishable from any other row in a normal inbox fetch. */
export async function listHiddenConversationIds(): Promise<string[]> {
	const db = await getDb();
	const rows = await db.select<{ conversation_id: string }[]>(
		"SELECT conversation_id FROM conversations WHERE hidden = 1 AND archived = 0",
	);
	return rows.map((row) => row.conversation_id);
}

/**
 * Sets (or clears, with null) the explicit "who blocked whom" state for a
 * conversation — the source of truth conversationArchive.ts uses to decide
 * archiving/system messages, instead of inferring direction from toggling
 * `archived` on an ambiguous chat.v1.conversation.delete event.
 */
export async function setBlockState(
	conversationId: string,
	blockState: BlockState | null,
): Promise<void> {
	const db = await getDb();
	const now = Date.now();

	await executeWithLockRetry(db, "set-block-state", async () => {
		await db.execute(
			"UPDATE conversations SET block_state = $2, updated_at = $3 WHERE conversation_id = $1",
			[conversationId, blockState, now],
		);
	});
}

/**
 * Puts the favourite star on (or takes it off) the chat with this person,
 * when there is one and it says otherwise. Resolves to whether a row changed.
 * The inbox answer writes the same column for every chat Grindr still lists;
 * this is for a star set outside the chat, and for a chat Grindr no longer
 * lists, which no inbox answer will ever correct.
 */
export async function setConversationFavoriteForProfile(
	otherProfileId: string,
	favorite: boolean,
): Promise<boolean> {
	const db = await getDb();
	// Asked for on every profile answer, and nearly always there is nothing
	// to change: looked up first, so those never queue up as writes.
	const differing = await db.select<{ conversation_id: string }[]>(
		"SELECT conversation_id FROM conversations WHERE other_profile_id = $1 AND favorite != $2 LIMIT 1",
		[otherProfileId, favorite ? 1 : 0],
	);
	if (differing.length === 0) {
		return false;
	}
	let changed = false;

	await executeWithLockRetry(db, "set-conversation-favorite", async () => {
		const result = await db.execute(
			"UPDATE conversations SET favorite = $2, updated_at = $3 WHERE other_profile_id = $1 AND favorite != $2",
			[otherProfileId, favorite ? 1 : 0, Date.now()],
		);
		changed = (result?.rowsAffected ?? 0) > 0;
	});
	return changed;
}

/**
 * Sets the pin on a saved chat directly. Only for a chat Grindr no longer
 * lists: there the pin exists on this device alone, and no inbox answer
 * will ever write this column for it. Every other pin goes to Grindr and
 * comes back with the inbox answer.
 */
export async function setConversationPinned(
	conversationId: string,
	pinned: boolean,
): Promise<void> {
	const db = await getDb();

	await executeWithLockRetry(db, "set-conversation-pinned", async () => {
		await db.execute(
			"UPDATE conversations SET pinned = $2, updated_at = $3 WHERE conversation_id = $1",
			[conversationId, pinned ? 1 : 0, Date.now()],
		);
	});
}

type ParticipantPresence = Pick<
	ConversationEntry["data"]["participants"][number],
	"lastOnline" | "onlineUntil" | "distanceMetres"
>;

/**
 * Rewrites when the other person in a chat was last online and how far away
 * they are. `change` gets what the chat has now and returns the new values,
 * or null to leave it. Resolves to the values written, or null when no chat
 * with this person changed.
 */
export async function updateConversationPresenceForProfile(
	otherProfileId: string,
	change: (current: ParticipantPresence) => ParticipantPresence | null,
): Promise<ParticipantPresence | null> {
	const db = await getDb();
	const rows = await db.select<{ conversation_id: string; participants_json: string }[]>(
		"SELECT conversation_id, participants_json FROM conversations WHERE other_profile_id = $1",
		[otherProfileId],
	);

	let written: ParticipantPresence | null = null;
	for (const row of rows) {
		let participants: ConversationEntry["data"]["participants"];
		try {
			participants = JSON.parse(row.participants_json) as ConversationEntry["data"]["participants"];
		} catch {
			continue;
		}
		const index = participants.findIndex(
			(participant) => String(participant.profileId) === otherProfileId,
		);
		if (index < 0) continue;
		const next = change(participants[index]);
		if (!next) continue;

		participants[index] = { ...participants[index], ...next };
		await executeWithLockRetry(db, "update-conversation-presence", async () => {
			await db.execute(
				"UPDATE conversations SET participants_json = $2, updated_at = $3 WHERE conversation_id = $1",
				[row.conversation_id, JSON.stringify(participants), Date.now()],
			);
		});
		written = next;
	}
	return written;
}

export async function touchConversationSeenInInbox(
	conversationId: string,
): Promise<void> {
	await touchConversationsSeenInInbox([conversationId], Date.now());
}

/**
 * Records that the server's inbox still returns these conversations, as of
 * `seenAt`. A row that stops being stamped while newer ones are is the only
 * cheap signal that a conversation went away — which is what being blocked
 * looks like from this side, since nothing is pushed when it happens off-app.
 */
export async function touchConversationsSeenInInbox(
	conversationIds: string[],
	seenAt: number,
): Promise<void> {
	if (conversationIds.length === 0) {
		return;
	}
	const db = await getDb();
	await executeWithLockRetry(db, "touch-conversations-seen", async () => {
		// Chunked: SQLite caps bound parameters, and a full inbox walk can
		// easily carry more ids than one statement may bind.
		for (let index = 0; index < conversationIds.length; index += 400) {
			const chunk = conversationIds.slice(index, index + 400);
			const placeholders = chunk.map((_, offset) => `$${offset + 2}`).join(", ");
			await db.execute(
				`UPDATE conversations SET last_seen_in_inbox_at = $1
				 WHERE conversation_id IN (${placeholders})`,
				[seenAt, ...chunk],
			);
		}
	});
}

/**
 * Conversations the server's inbox stopped returning: stamped as present at
 * some point, not stamped by the sweep that started at `sweepStartedAt`, and
 * not already archived or attributed to a block.
 *
 * `last_seen_in_inbox_at IS NOT NULL` is what keeps this safe on upgrade. Every
 * row predates the stamping, so treating an unstamped row as missing would
 * accuse the entire inbox at once; a row only becomes eligible after a sweep
 * has actually observed it present.
 */
export async function listConversationsMissingFromInbox(
	sweepStartedAt: number,
): Promise<StoredConversation[]> {
	const db = await getDb();
	const rows = await db.select<ConversationRow[]>(
		`SELECT * FROM conversations
		 WHERE archived = 0
		   AND block_state IS NULL
		   AND other_profile_id IS NOT NULL
		   AND last_seen_in_inbox_at IS NOT NULL
		   AND last_seen_in_inbox_at < $1
		 ORDER BY last_activity_timestamp DESC`,
		[sweepStartedAt],
	);
	return rows.map(rowToStoredConversation);
}

/**
 * Persists a conversation's unread count directly (e.g. clearing it to 0 once
 * read). Needed for archived conversations specifically — they never go
 * through upsertConversation again (that only happens on a live /v4/inbox
 * fetch, which an archived conversation by definition no longer appears in),
 * so without this the stored count would resurface stale on next app start.
 */
export async function setConversationUnreadCount(
	conversationId: string,
	unreadCount: number,
): Promise<void> {
	const db = await getDb();

	await executeWithLockRetry(db, "set-conversation-unread-count", async () => {
		await db.execute(
			"UPDATE conversations SET unread_count = $2, updated_at = $3 WHERE conversation_id = $1",
			[conversationId, unreadCount, Date.now()],
		);
	});
}

export async function deleteConversationCascade(
	conversationId: string,
): Promise<void> {
	const db = await getDb();

	await executeWithLockRetry(db, "delete-conversation-cascade", async () => {
		await db.execute("DELETE FROM messages WHERE conversation_id = $1", [
			conversationId,
		]);
		await db.execute("DELETE FROM media_files WHERE conversation_id = $1", [
			conversationId,
		]);
		await db.execute("DELETE FROM content_checks WHERE conversation_id = $1", [
			conversationId,
		]);
		await db.execute(
			"DELETE FROM album_media WHERE album_id IN (SELECT album_id FROM albums WHERE conversation_id = $1)",
			[conversationId],
		);
		await db.execute("DELETE FROM albums WHERE conversation_id = $1", [
			conversationId,
		]);
		await db.execute("DELETE FROM conversation_meta WHERE conversation_id = $1", [
			conversationId,
		]);
		await db.execute("DELETE FROM conversations WHERE conversation_id = $1", [
			conversationId,
		]);
	});
}

export async function deleteConversationOnly(
	conversationId: string,
): Promise<void> {
	const db = await getDb();

	await executeWithLockRetry(db, "delete-conversation-only", async () => {
		await db.execute("DELETE FROM conversation_meta WHERE conversation_id = $1", [
			conversationId,
		]);
		await db.execute("DELETE FROM conversations WHERE conversation_id = $1", [
			conversationId,
		]);
	});
}

/**
 * Moves what was said in `sourceConversationId` into `targetConversationId`,
 * then closes the source: an archived chat with someone's old profile is
 * folded into the chat with their current one, so the history reads as one
 * thread. A `message_id` is never reused across conversations, so the moved
 * rows cannot collide with the target's.
 *
 * What moves is the conversation itself: messages, their media and the
 * verdicts on it, and the albums shared in it. What does not:
 *  - the "You blocked this person" / "You were blocked" notes. They are about
 *    the old profile, and a conversation may hold one of each kind at most
 *    (see insertSystemMessage); carried over, they would read as being about
 *    the person the target chat is with and be judged as such by
 *    repairFalseBlockedByOtherMarkers. They go with the source.
 *  - the source's block state, for the same reason. The block log and
 *    block_events keep the old profile's history.
 *
 * The moved messages are flagged local history: they exist on this device
 * only, so the thread shows them as such and never asks Grindr about them.
 *
 * The statements, and the order that keeps an interrupted merge safe to run
 * again, are in utils/conversationMergeSql, where a test runs them against
 * a real database.
 */
export async function mergeConversationInto(
	sourceConversationId: string,
	targetConversationId: string,
): Promise<{ movedMessages: number }> {
	if (sourceConversationId === targetConversationId) {
		return { movedMessages: 0 };
	}
	const db = await getDb();

	// Counted up front: a retry after a lock would only see what is left.
	const count = countMergeableMessages(sourceConversationId);
	const countRows = await db.select<{ count: number }[]>(count.sql, count.params);
	const movedMessages = countRows[0]?.count ?? 0;

	await executeWithLockRetry(db, "merge-conversation-into", async () => {
		const steps = mergeConversationSteps(sourceConversationId, targetConversationId, Date.now());
		for (const step of steps) {
			await db.execute(step.sql, step.params);
		}
	});

	return { movedMessages };
}

export async function deleteAllArchivedConversations(): Promise<number> {
	const db = await getDb();
	let count = 0;

	await executeWithLockRetry(db, "delete-all-archived-conversations", async () => {
		const rows = await db.select<{ conversation_id: string }[]>(
			"SELECT conversation_id FROM conversations WHERE archived = 1",
		);
		count = rows.length;
		if (count === 0) return;

		await db.execute(
			"DELETE FROM messages WHERE conversation_id IN (SELECT conversation_id FROM conversations WHERE archived = 1)",
		);
		await db.execute(
			"DELETE FROM media_files WHERE conversation_id IN (SELECT conversation_id FROM conversations WHERE archived = 1)",
		);
		await db.execute(
			"DELETE FROM content_checks WHERE conversation_id IN (SELECT conversation_id FROM conversations WHERE archived = 1)",
		);
		await db.execute(
			"DELETE FROM album_media WHERE album_id IN (SELECT album_id FROM albums WHERE conversation_id IN (SELECT conversation_id FROM conversations WHERE archived = 1))",
		);
		await db.execute(
			"DELETE FROM albums WHERE conversation_id IN (SELECT conversation_id FROM conversations WHERE archived = 1)",
		);
		await db.execute(
			"DELETE FROM conversation_meta WHERE conversation_id IN (SELECT conversation_id FROM conversations WHERE archived = 1)",
		);
		await db.execute("DELETE FROM conversations WHERE archived = 1");
	});

	return count;
}

// ---------------------------------------------------------------------------
// conversation_meta (last-read tracking)
// ---------------------------------------------------------------------------

export async function getLastReadTimestamp(
	conversationId: string,
): Promise<number | null> {
	const db = await getDb();
	const rows = await db.select<{ last_read_timestamp: number | null }[]>(
		"SELECT last_read_timestamp FROM conversation_meta WHERE conversation_id = $1",
		[conversationId],
	);
	const raw = rows[0]?.last_read_timestamp ?? null;
	if (raw == null || raw <= 0) return null;
	return raw < 100_000_000_000 ? raw * 1000 : raw;
}

export async function setLastReadTimestamp(
	conversationId: string,
	timestamp: number | null,
): Promise<void> {
	const db = await getDb();
	const normalizedMs =
		timestamp != null && timestamp > 0
			? (timestamp < 100_000_000_000 ? timestamp * 1000 : timestamp)
			: null;

	await executeWithLockRetry(db, "set-last-read-timestamp", async () => {
		await db.execute(
			`
			INSERT INTO conversation_meta (conversation_id, last_read_timestamp)
			VALUES ($1, $2)
			ON CONFLICT(conversation_id) DO UPDATE SET last_read_timestamp = excluded.last_read_timestamp
			`,
			[conversationId, normalizedMs],
		);
	});
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

function rowToStoredMessage(row: MessageRow): StoredMessage {
	return {
		messageId: row.message_id,
		conversationId: row.conversation_id,
		senderId: row.sender_id,
		timestamp: row.timestamp,
		type: row.type ?? "Unknown",
		chat1Type: row.chat1_type,
		body: row.body_json ? JSON.parse(row.body_json) : null,
		unsent: Boolean(row.unsent),
		reactions: row.reactions_json
			? (JSON.parse(row.reactions_json) as Message["reactions"])
			: [],
		replyToMessage: row.reply_to_message_id,
		replyPreview: row.reply_preview_json ? JSON.parse(row.reply_preview_json) : null,
		localHistory: Boolean(row.local_history),
	};
}

export async function upsertMessages(
	conversationId: string,
	messages: Message[],
): Promise<void> {
	if (messages.length === 0) {
		return;
	}

	const db = await getDb();
	const now = Date.now();

	await executeWithLockRetry(db, "upsert-messages", async () => {
		for (const message of messages) {
			const replyToMessageId =
				typeof message.replyToMessage === "string"
					? message.replyToMessage
					: typeof (message.replyToMessage as Record<string, unknown> | null)
								?.messageId === "string"
						? ((message.replyToMessage as Record<string, unknown>)
								.messageId as string)
						: null;

			await db.execute(
				`
				INSERT INTO messages (
					message_id, conversation_id, sender_id, timestamp, type, chat1_type,
					body_json, unsent, local_history, reply_to_message_id,
					reply_preview_json, reactions_json, created_at, updated_at
				) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, $9, $10, $11, $12, $12)
				ON CONFLICT(message_id) DO UPDATE SET
					sender_id = excluded.sender_id,
					timestamp = excluded.timestamp,
					type = excluded.type,
					chat1_type = excluded.chat1_type,
					body_json = excluded.body_json,
					unsent = excluded.unsent,
					reply_to_message_id = excluded.reply_to_message_id,
					reply_preview_json = excluded.reply_preview_json,
					reactions_json = excluded.reactions_json,
					updated_at = excluded.updated_at
				`,
				[
					message.messageId,
					conversationId,
					message.senderId,
					message.timestamp,
					message.type ?? "Unknown",
					message.chat1Type ?? null,
					message.body != null ? JSON.stringify(message.body) : null,
					message.unsent ? 1 : 0,
					replyToMessageId,
					message.replyPreview != null ? JSON.stringify(message.replyPreview) : null,
					JSON.stringify(message.reactions ?? []),
					now,
				],
			);
		}
	});
}

/**
 * Re-keys every locally stored message, cached media file, shared album, and
 * the read-timestamp record from one conversationId to another in place.
 *
 * Needed specifically for graduating a recovered conversation (see
 * recoverOrphanedConversation) when the server assigns a different id for
 * the re-established live conversation: upsertMessages' `ON CONFLICT
 * (message_id) DO UPDATE` does not touch conversation_id, so simply
 * re-appending the old messages under the new id is a no-op for every row
 * that already exists — they'd silently stay attached to the now-orphaned
 * old id. A direct UPDATE is the only way to actually move them.
 *
 * Deliberately NOT wrapped in a SQL transaction — this file's header already
 * documents why (the Tauri SQL plugin's connection pool has no session
 * affinity, so manual BEGIN/COMMIT can silently land on different
 * connections). Instead the `messages` move — the one table that determines
 * whether the caller's "migration failed, keep showing the old id" fallback
 * actually has anything to show — runs LAST. If any earlier statement here
 * throws, `messages` is guaranteed untouched, so a caller that reacts to the
 * failure by keeping the old conversationId around still finds the full
 * history under it. Only once this call returns cleanly has anything
 * genuinely moved.
 */
export async function reassignConversationId(
	oldConversationId: string,
	newConversationId: string,
): Promise<void> {
	if (oldConversationId === newConversationId) {
		return;
	}
	const db = await getDb();
	await executeWithLockRetry(db, "reassign-conversation-id", async () => {
		await db.execute(
			"UPDATE media_files SET conversation_id = $2 WHERE conversation_id = $1",
			[oldConversationId, newConversationId],
		);
		await db.execute(
			"UPDATE content_checks SET conversation_id = $2 WHERE conversation_id = $1",
			[oldConversationId, newConversationId],
		);
		// albums.album_id is its own primary key (conversation_id is just a
		// plain column here, unlike conversation_meta below), so a direct
		// UPDATE can't collide the way the conversation_meta merge below has
		// to guard against.
		await db.execute(
			"UPDATE albums SET conversation_id = $2 WHERE conversation_id = $1",
			[oldConversationId, newConversationId],
		);
		// conversation_meta is keyed by conversation_id as its primary key, so
		// unlike the two UPDATEs above this can't just rewrite the key in place
		// if a row for newConversationId already exists — merge instead, keeping
		// the old (more complete) read timestamp only when it's newer.
		const oldMeta = await db.select<{ last_read_timestamp: number | null }[]>(
			"SELECT last_read_timestamp FROM conversation_meta WHERE conversation_id = $1",
			[oldConversationId],
		);
		const oldTimestamp = oldMeta[0]?.last_read_timestamp ?? null;
		if (oldTimestamp != null) {
			await db.execute(
				`
				INSERT INTO conversation_meta (conversation_id, last_read_timestamp)
				VALUES ($1, $2)
				ON CONFLICT(conversation_id) DO UPDATE SET
					last_read_timestamp = MAX(conversation_meta.last_read_timestamp, excluded.last_read_timestamp)
				`,
				[newConversationId, oldTimestamp],
			);
		}
		await db.execute("DELETE FROM conversation_meta WHERE conversation_id = $1", [
			oldConversationId,
		]);
		// Last on purpose — see the doc comment above.
		await db.execute(
			"UPDATE messages SET conversation_id = $2 WHERE conversation_id = $1",
			[oldConversationId, newConversationId],
		);
	});
}

export type SystemMessageType =
	| "SystemBlocked"
	| "SystemUnblocked"
	| "SystemBlockedBySelf"
	| "SystemUnblockedBySelf";

/**
 * Inserts a synthetic, locally-generated message marking a block/unblock
 * directly into the conversation's history — never comes from the server,
 * just a local record of when we noticed the conversation got archived
 * (likely blocked) or unarchived (likely unblocked) again.
 */
export async function insertSystemMessage(
	conversationId: string,
	type: SystemMessageType,
	timestamp: number = Date.now(),
): Promise<Message> {
	const message: Message = {
		messageId: `local-system:${type}:${conversationId}`,
		conversationId,
		senderId: 0,
		timestamp,
		unsent: false,
		reactions: [],
		type,
		chat1Type: null,
		body: null,
		replyToMessage: null,
		replyPreview: null,
	};
	await upsertMessages(conversationId, [message]);

	// Only the other side's own action gets a durable block_events row — our
	// own block/unblock is already visible from the confirmation dialog and
	// immediate UI change that triggered it (mirrors the toast in
	// ChatRealtimeBridge.tsx, which skips the "...BySelf" variants the same way).
	if (type === "SystemBlocked" || type === "SystemUnblocked") {
		await recordBlockEvent(
			conversationId,
			type === "SystemBlocked" ? "blocked" : "unblocked",
			timestamp,
		);
	}

	return message;
}

/**
 * Snapshots the other participant's name/avatar into a standalone row at the
 * moment they block/unblock us — deliberately not derived from the
 * SystemBlocked/SystemUnblocked messages on read, since a profile that
 * blocked us can later become fully unresolvable (deleted/banned, or its
 * conversation ages out of the live inbox), which would otherwise leave the
 * history page unable to show who it even was.
 */
async function recordBlockEvent(
	conversationId: string,
	eventType: BlockEventType,
	timestamp: number,
): Promise<void> {
	const conversation = await getConversation(conversationId);
	const otherProfileId = conversation?.otherProfileId ?? null;
	const otherParticipant =
		conversation?.entry.data.participants.find(
			(p) => String(p.profileId) === otherProfileId,
		) ?? conversation?.entry.data.participants[0] ?? null;
	const displayName = conversation?.entry.data.name?.trim() || null;
	const avatarMediaHash = otherParticipant?.primaryMediaHash ?? null;

	const db = await getDb();
	const now = Date.now();
	await executeWithLockRetry(db, "insert-block-event", async () => {
		// Another sighting of an event already stored (the other device's row,
		// or this device noticing twice) updates that row instead of adding
		// one. The conversation's block_state cannot catch this when the chat
		// has no conversations row, which is common for people who blocked us.
		const stored = await db.select<StoredBlockEventTime[]>(
			"SELECT id, event_type, timestamp FROM block_events WHERE conversation_id = $1",
			[conversationId],
		);
		const id =
			findSameBlockEvent(stored, eventType, timestamp)?.id ??
			blockEventId(conversationId, eventType, timestamp);
		// Only fills in what is missing: the time stays that of the first
		// sighting, and a name is never replaced by nothing.
		await db.execute(
			`
			INSERT INTO block_events (
				id, profile_id, conversation_id, event_type, timestamp,
				display_name, avatar_media_hash, created_at
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
			ON CONFLICT(id) DO UPDATE SET
				profile_id = COALESCE(excluded.profile_id, block_events.profile_id),
				display_name = COALESCE(excluded.display_name, block_events.display_name),
				avatar_media_hash = COALESCE(excluded.avatar_media_hash, block_events.avatar_media_hash)
			`,
			[id, otherProfileId, conversationId, eventType, timestamp, displayName, avatarMediaHash, now],
		);
	});
}

function rowToStoredBlockEvent(row: BlockEventRow): StoredBlockEvent {
	return {
		id: row.id,
		profileId: row.profile_id,
		conversationId: row.conversation_id,
		eventType: row.event_type as BlockEventType,
		timestamp: row.timestamp,
		displayName: row.display_name,
		avatarMediaHash: row.avatar_media_hash,
		createdAt: row.created_at,
	};
}

/**
 * All local block/unblock-by-other history, most recent first — backs the
 * Settings block-history page.
 */
export async function listBlockEvents(): Promise<StoredBlockEvent[]> {
	const db = await getDb();
	const rows = await db.select<BlockEventRow[]>(
		"SELECT * FROM block_events ORDER BY timestamp DESC",
	);
	return rows.map(rowToStoredBlockEvent);
}

export async function getMessages(conversationId: string): Promise<StoredMessage[]> {
	const db = await getDb();
	const rows = await db.select<MessageRow[]>(
		"SELECT * FROM messages WHERE conversation_id = $1 ORDER BY timestamp ASC",
		[conversationId],
	);
	return rows.map(rowToStoredMessage);
}

/**
 * One page of messages, most-recent-first within the page but returned in
 * ascending order for display — mirrors the live API's cursor pagination
 * (uses the existing conversation_id+timestamp index) so an archived
 * conversation's "load older messages" behaves identically to a live one,
 * just paging through chatDb instead of the server.
 */
export async function getMessagesPage(
	conversationId: string,
	options: { beforeTimestamp?: number; limit: number },
): Promise<StoredMessage[]> {
	const db = await getDb();
	const rows =
		options.beforeTimestamp != null
			? await db.select<MessageRow[]>(
					"SELECT * FROM messages WHERE conversation_id = $1 AND timestamp < $2 ORDER BY timestamp DESC LIMIT $3",
					[conversationId, options.beforeTimestamp, options.limit],
				)
			: await db.select<MessageRow[]>(
					"SELECT * FROM messages WHERE conversation_id = $1 ORDER BY timestamp DESC LIMIT $2",
					[conversationId, options.limit],
				);
	return rows.map(rowToStoredMessage).sort((a, b) => a.timestamp - b.timestamp);
}

function escapeLikePattern(value: string): string {
	return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Full-database message text search — unlike the in-memory index in
 * pages/app/chat/cache.ts (which only ever sees messages from conversations
 * opened during this session), this scans every conversation's persisted
 * history via chatDb.
 *
 * `body_json` has no dedicated text column, so matching is a raw LIKE over
 * the JSON blob (cheap, no FTS table to maintain) — that can false-positive
 * on a hit inside a non-text field (e.g. a media URL), so rows are
 * re-checked against the same rendered text (getMessageText) used for
 * display before being returned. Over-fetches by 3x to absorb rows dropped
 * by that re-check while still hitting the requested limit when possible.
 */
export async function searchMessages(
	query: string,
	options?: { conversationId?: string; limit?: number },
): Promise<IndexedMessage[]> {
	const needle = query.trim();
	if (!needle) {
		return [];
	}

	const db = await getDb();
	const limit = options?.limit ?? 40;
	const pattern = `%${escapeLikePattern(needle)}%`;

	const rows = options?.conversationId
		? await db.select<MessageRow[]>(
				`
				SELECT * FROM messages
				WHERE conversation_id = $1 AND unsent = 0 AND body_json LIKE $2 ESCAPE '\\'
				ORDER BY timestamp DESC LIMIT $3
				`,
				[options.conversationId, pattern, limit * 3],
			)
		: await db.select<MessageRow[]>(
				`
				SELECT * FROM messages
				WHERE unsent = 0 AND body_json LIKE $1 ESCAPE '\\'
				ORDER BY timestamp DESC LIMIT $2
				`,
				[pattern, limit * 3],
			);

	const needleLower = needle.toLowerCase();
	const results: IndexedMessage[] = [];
	for (const row of rows) {
		const message = rowToStoredMessage(row);
		const text = getMessageText(message);
		const searchText = text.toLowerCase();
		if (!text || !searchText.includes(needleLower)) {
			continue;
		}
		results.push({
			messageId: message.messageId,
			conversationId: message.conversationId,
			senderId: message.senderId,
			timestamp: message.timestamp,
			text,
			searchText,
		});
		if (results.length >= limit) {
			break;
		}
	}

	return results;
}

export async function setMessageLocalHistory(
	messageId: string,
	localHistory: boolean,
): Promise<void> {
	const db = await getDb();

	await executeWithLockRetry(db, "set-message-local-history", async () => {
		await db.execute(
			"UPDATE messages SET local_history = $2, updated_at = $3 WHERE message_id = $1",
			[messageId, localHistory ? 1 : 0, Date.now()],
		);
	});
}

/**
 * Optimistic local path for the user's own unsend: flags the row as both
 * unsent and local_history immediately, without waiting for the server
 * round-trip (which arrives later via the normal upsertMessages merge).
 */
export async function markMessageUnsentLocally(messageId: string): Promise<void> {
	const db = await getDb();

	await executeWithLockRetry(db, "mark-message-unsent-locally", async () => {
		await db.execute(
			"UPDATE messages SET unsent = 1, local_history = 1, updated_at = $2 WHERE message_id = $1",
			[messageId, Date.now()],
		);
	});
}

/** Who sent each of these messages, for the ones stored locally. */
export async function getMessageSenderIds(messageIds: readonly string[]): Promise<Map<string, string>> {
	const unique = [...new Set(messageIds)];
	const senders = new Map<string, string>();
	if (unique.length === 0) return senders;
	const db = await getDb();
	for (let start = 0; start < unique.length; start += 400) {
		const chunk = unique.slice(start, start + 400);
		const placeholders = chunk.map((_, index) => `$${index + 1}`).join(", ");
		const rows = await db.select<Array<{ message_id: string; sender_id: string | number | null }>>(
			`SELECT message_id, sender_id FROM messages WHERE message_id IN (${placeholders})`,
			chunk,
		);
		for (const row of rows) {
			if (row.sender_id != null) senders.set(row.message_id, String(row.sender_id));
		}
	}
	return senders;
}

/** Drops the saved copies of a message's media, which outlive the message row otherwise. */
export async function deleteMediaFilesForMessage(messageId: string): Promise<void> {
	const db = await getDb();

	await executeWithLockRetry(db, "delete-message-media", async () => {
		await db.execute("DELETE FROM media_files WHERE message_id = $1", [messageId]);
		await db.execute("DELETE FROM content_checks WHERE message_id = $1", [messageId]);
	});
}

export async function deleteMessageRow(messageId: string): Promise<void> {
	const db = await getDb();

	await executeWithLockRetry(db, "delete-message", async () => {
		await db.execute("DELETE FROM messages WHERE message_id = $1", [messageId]);
	});
}

export async function exportAllMessages(): Promise<Record<string, Message[]>> {
	const db = await getDb();
	const rows = await db.select<MessageRow[]>(
		"SELECT * FROM messages ORDER BY conversation_id ASC, timestamp ASC",
	);

	const result: Record<string, Message[]> = {};
	for (const row of rows) {
		const stored = rowToStoredMessage(row);
		const { localHistory: _localHistory, ...message } = stored;
		if (!result[row.conversation_id]) {
			result[row.conversation_id] = [];
		}
		result[row.conversation_id].push(message);
	}
	return result;
}

// ---------------------------------------------------------------------------
// Media files
// ---------------------------------------------------------------------------

function rowToStoredMediaFile(row: MediaFileRow): StoredMediaFile {
	return {
		mediaKey: row.media_key,
		conversationId: row.conversation_id,
		messageId: row.message_id,
		kind: row.kind as StoredMediaFile["kind"],
		mimeType: row.mime_type,
		dataBase64: row.data_base64,
		viewOnce: Boolean(row.view_once),
		sizeBytes: row.size_bytes,
		fetchStatus: row.fetch_status as StoredMediaFile["fetchStatus"],
		fetchedAt: row.fetched_at,
	};
}

export async function upsertMediaFile(input: MediaFileUpsertInput): Promise<void> {
	const db = await getDb();
	const now = Date.now();

	await executeWithLockRetry(db, "upsert-media-file", async () => {
		await db.execute(
			`
			INSERT INTO media_files (
				media_key, conversation_id, message_id, kind, mime_type,
				data_base64, view_once, size_bytes, fetch_status, fetched_at
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
			ON CONFLICT(media_key) DO UPDATE SET
				conversation_id = excluded.conversation_id,
				message_id = excluded.message_id,
				kind = excluded.kind,
				mime_type = excluded.mime_type,
				data_base64 = excluded.data_base64,
				view_once = excluded.view_once,
				size_bytes = excluded.size_bytes,
				fetch_status = excluded.fetch_status,
				fetched_at = excluded.fetched_at
			`,
			[
				input.mediaKey,
				input.conversationId,
				input.messageId,
				input.kind,
				input.mimeType,
				input.dataBase64,
				input.viewOnce ? 1 : 0,
				input.sizeBytes,
				input.fetchStatus,
				now,
			],
		);
	});
}

/** Whether media is stored, without reading its bytes back across the bridge. */
export async function getMediaFetchStatus(
	mediaKey: string,
): Promise<StoredMediaFile["fetchStatus"] | null> {
	const db = await getDb();
	const rows = await db.select<{ fetch_status: string }[]>(
		"SELECT fetch_status FROM media_files WHERE media_key = $1",
		[mediaKey],
	);
	return (rows[0]?.fetch_status as StoredMediaFile["fetchStatus"] | undefined) ?? null;
}

export async function getMediaFile(
	mediaKey: string,
): Promise<StoredMediaFile | null> {
	const db = await getDb();
	const rows = await db.select<MediaFileRow[]>(
		"SELECT * FROM media_files WHERE media_key = $1",
		[mediaKey],
	);
	const row = rows[0];
	return row ? rowToStoredMediaFile(row) : null;
}

/**
 * Looks up cached media by message_id rather than media_key — needed when
 * the live message body no longer carries a usable URL (expired, archived
 * conversation, server stopped refreshing it) so the original media_key
 * (often derived from a hash/URL in that body) can't be recomputed anymore.
 * message_id never changes, so this always finds a prior capture.
 */
export async function getMediaFileByMessageId(
	messageId: string,
): Promise<StoredMediaFile | null> {
	const db = await getDb();
	// A single message can own more than one row — replying to a picture with
	// a picture stores both the reply-quote thumbnail and the message's own
	// media under the same message_id. Prefer a usable row over a failed one,
	// and the full-size copy over the thumbnail.
	const rows = await db.select<MediaFileRow[]>(
		`SELECT * FROM media_files
		 WHERE message_id = $1
		 ORDER BY (fetch_status = 'ok') DESC, size_bytes DESC, fetched_at DESC
		 LIMIT 1`,
		[messageId],
	);
	const row = rows[0];
	return row ? rowToStoredMediaFile(row) : null;
}

/**
 * All successfully-cached image/video media for a conversation, newest
 * first — the local, always-available backing for the "received media"
 * panel (chatDb is the single source there, not the live API, since the
 * whole point is staying viewable after the server no longer serves it).
 */
export async function getMediaFilesForConversation(
	conversationId: string,
): Promise<StoredMediaFile[]> {
	const db = await getDb();
	const rows = await db.select<MediaFileRow[]>(
		`
		SELECT mf.* FROM media_files mf
		LEFT JOIN messages m ON m.message_id = mf.message_id
		WHERE mf.conversation_id = $1
			AND mf.fetch_status = 'ok'
			AND mf.kind IN ('image', 'video')
		ORDER BY COALESCE(m.timestamp, mf.fetched_at) DESC
		`,
		[conversationId],
	);
	return rows.map(rowToStoredMediaFile);
}

// ---------------------------------------------------------------------------
// Content checks
// ---------------------------------------------------------------------------

type ContentCheckRow = {
	media_key: string;
	message_id: string | null;
	conversation_id: string | null;
	kind: string;
	explicit_label: string | null;
	explicit_score: number;
	cover_only_score: number;
	face_score: number;
	face_share: number | null;
	model: string;
	checked_at: number;
};

function rowToStoredContentCheck(row: ContentCheckRow): StoredContentCheck {
	return {
		mediaKey: row.media_key,
		messageId: row.message_id,
		conversationId: row.conversation_id,
		kind: row.kind === "video" ? "video" : "image",
		explicitLabel: row.explicit_label,
		explicitScore: Number(row.explicit_score) || 0,
		coverOnlyScore: Number(row.cover_only_score) || 0,
		faceScore: Number(row.face_score) || 0,
		faceShare: row.face_share == null ? null : Number(row.face_share),
		model: row.model,
		checkedAt: row.checked_at,
	};
}

export async function upsertContentCheck(check: StoredContentCheck): Promise<void> {
	const db = await getDb();

	await executeWithLockRetry(db, "upsert-content-check", async () => {
		await db.execute(
			`
			INSERT INTO content_checks (
				media_key, message_id, conversation_id, kind, explicit_label,
				explicit_score, cover_only_score, face_score, model, checked_at, face_share
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
			ON CONFLICT(media_key) DO UPDATE SET
				message_id = COALESCE(excluded.message_id, content_checks.message_id),
				conversation_id = COALESCE(excluded.conversation_id, content_checks.conversation_id),
				kind = excluded.kind,
				explicit_label = excluded.explicit_label,
				explicit_score = excluded.explicit_score,
				cover_only_score = excluded.cover_only_score,
				face_score = excluded.face_score,
				face_share = excluded.face_share,
				model = excluded.model,
				checked_at = excluded.checked_at
			`,
			[
				check.mediaKey,
				check.messageId,
				check.conversationId,
				check.kind,
				check.explicitLabel,
				check.explicitScore,
				check.coverOnlyScore,
				check.faceScore,
				check.model,
				check.checkedAt,
				check.faceShare,
			],
		);
	});
}

export async function getContentCheck(mediaKey: string): Promise<StoredContentCheck | null> {
	const db = await getDb();
	const rows = await db.select<ContentCheckRow[]>(
		"SELECT * FROM content_checks WHERE media_key = $1",
		[mediaKey],
	);
	return rows[0] ? rowToStoredContentCheck(rows[0]) : null;
}

export async function getContentChecksForMessages(
	messageIds: readonly string[],
): Promise<StoredContentCheck[]> {
	const unique = [...new Set(messageIds)];
	if (unique.length === 0) return [];
	const db = await getDb();
	const checks: StoredContentCheck[] = [];
	for (let start = 0; start < unique.length; start += 400) {
		const chunk = unique.slice(start, start + 400);
		const placeholders = chunk.map((_, index) => `$${index + 1}`).join(", ");
		const rows = await db.select<ContentCheckRow[]>(
			`SELECT * FROM content_checks WHERE message_id IN (${placeholders})`,
			chunk,
		);
		checks.push(...rows.map(rowToStoredContentCheck));
	}
	return checks;
}

/**
 * The hashes of profile photos whose check found something explicit, at or
 * above `minScore`. Only checks of the whole photo: an older kind, made piece
 * by piece, overstated what it saw.
 */
export async function getExplicitProfilePhotoHashes(minScore: number): Promise<string[]> {
	const db = await getDb();
	const rows = await db.select<{ media_key: string }[]>(
		`SELECT media_key FROM content_checks
		 WHERE media_key LIKE 'profile:%' AND model LIKE 'nudenet-320n-profile%' AND explicit_score >= $1`,
		[minScore],
	);
	return rows.map((row) => row.media_key.slice("profile:".length));
}

/** Who sent a stored message and when: what a block needs before it can name anyone. */
export async function getMessageSenderAndTime(
	messageId: string,
): Promise<{ senderId: string; timestamp: number } | null> {
	const db = await getDb();
	const rows = await db.select<Array<{ sender_id: string | number | null; timestamp: number | null }>>(
		"SELECT sender_id, timestamp FROM messages WHERE message_id = $1",
		[messageId],
	);
	const row = rows[0];
	if (!row || row.sender_id == null || row.timestamp == null) return null;
	return { senderId: String(row.sender_id), timestamp: Number(row.timestamp) };
}

// ---------------------------------------------------------------------------
// Albums
// ---------------------------------------------------------------------------

function rowToStoredAlbum(row: AlbumRow): StoredAlbum {
	return {
		albumId: row.album_id,
		ownerProfileId: row.owner_profile_id,
		albumName: row.album_name,
		conversationId: row.conversation_id,
		sharedViaMessageId: row.shared_via_message_id,
		previewCoverBase64: row.preview_cover_base64 ?? null,
		previewCoverMimeType: row.preview_cover_mime_type ?? null,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export async function upsertAlbum(input: AlbumUpsertInput): Promise<void> {
	const db = await getDb();
	const now = Date.now();

	await executeWithLockRetry(db, "upsert-album", async () => {
		await db.execute(
			`
			INSERT INTO albums (
				album_id, owner_profile_id, album_name, conversation_id,
				shared_via_message_id, created_at, updated_at
			) VALUES ($1, $2, $3, $4, $5, $6, $6)
			ON CONFLICT(album_id) DO UPDATE SET
				owner_profile_id = COALESCE(excluded.owner_profile_id, owner_profile_id),
				album_name = COALESCE(excluded.album_name, album_name),
				conversation_id = COALESCE(excluded.conversation_id, conversation_id),
				shared_via_message_id = COALESCE(excluded.shared_via_message_id, shared_via_message_id),
				updated_at = excluded.updated_at
			`,
			[
				input.albumId,
				input.ownerProfileId,
				input.albumName,
				input.conversationId,
				input.sharedViaMessageId,
				now,
			],
		);
	});
}

/**
 * Stores the chat bubble's blurred teaser preview for an album — sourced
 * from the sharing message's own body (coverUrl/previewUrl), not the
 * album's actual content. Upserts a minimal row if the album hasn't been
 * captured at all yet (this can run independently of/before the full
 * album capture, since the preview comes from a different source and may
 * still be capturable even if the album API itself is gated).
 */
export async function upsertAlbumPreviewCover(
	albumId: string,
	base64: string,
	mimeType: string | null,
): Promise<void> {
	const db = await getDb();
	const now = Date.now();

	await executeWithLockRetry(db, "upsert-album-preview-cover", async () => {
		await db.execute(
			`
			INSERT INTO albums (
				album_id, owner_profile_id, album_name, conversation_id,
				shared_via_message_id, preview_cover_base64, preview_cover_mime_type,
				created_at, updated_at
			) VALUES ($1, NULL, NULL, NULL, NULL, $2, $3, $4, $4)
			ON CONFLICT(album_id) DO UPDATE SET
				preview_cover_base64 = excluded.preview_cover_base64,
				preview_cover_mime_type = excluded.preview_cover_mime_type,
				updated_at = excluded.updated_at
			`,
			[albumId, base64, mimeType, now],
		);
	});
}

export async function getAllAlbums(): Promise<StoredAlbum[]> {
	const db = await getDb();
	const rows = await db.select<AlbumRow[]>(
		"SELECT * FROM albums ORDER BY updated_at DESC",
	);
	return rows.map(rowToStoredAlbum);
}

export async function getAlbum(albumId: string): Promise<StoredAlbum | null> {
	const db = await getDb();
	const rows = await db.select<AlbumRow[]>(
		"SELECT * FROM albums WHERE album_id = $1",
		[albumId],
	);
	const row = rows[0];
	return row ? rowToStoredAlbum(row) : null;
}

/**
 * Deletes a single album and its cached media — used when the user removes
 * a received album from the shared-albums page, whether or not the share
 * itself is still live server-side.
 */
export async function deleteAlbum(albumId: string): Promise<void> {
	const db = await getDb();

	await executeWithLockRetry(db, "delete-album", async () => {
		await db.execute("DELETE FROM album_media WHERE album_id = $1", [albumId]);
		await db.execute("DELETE FROM albums WHERE album_id = $1", [albumId]);
	});
}

/** All albums ever shared within this conversation, eagerly captured and durable. */
export async function getAlbumsForConversation(
	conversationId: string,
): Promise<StoredAlbum[]> {
	const db = await getDb();
	const rows = await db.select<AlbumRow[]>(
		"SELECT * FROM albums WHERE conversation_id = $1 ORDER BY updated_at DESC",
		[conversationId],
	);
	return rows.map(rowToStoredAlbum);
}

function rowToStoredAlbumMedia(row: AlbumMediaRow): StoredAlbumMedia {
	return {
		contentId: row.content_id,
		albumId: row.album_id,
		contentType: row.content_type,
		dataBase64: row.data_base64,
		thumbDataBase64: row.thumb_data_base64,
		remainingViews: row.remaining_views,
		isViewable: row.is_viewable == null ? null : Boolean(row.is_viewable),
		fetchedAt: row.fetched_at,
	};
}

export async function upsertAlbumMedia(input: AlbumMediaUpsertInput): Promise<void> {
	const db = await getDb();
	const now = Date.now();

	await executeWithLockRetry(db, "upsert-album-media", async () => {
		await db.execute(
			`
			INSERT INTO album_media (
				content_id, album_id, content_type, data_base64, thumb_data_base64,
				remaining_views, is_viewable, fetched_at
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
			ON CONFLICT(content_id) DO UPDATE SET
				album_id = excluded.album_id,
				content_type = excluded.content_type,
				data_base64 = excluded.data_base64,
				thumb_data_base64 = excluded.thumb_data_base64,
				remaining_views = excluded.remaining_views,
				is_viewable = excluded.is_viewable,
				fetched_at = excluded.fetched_at
			`,
			[
				input.contentId,
				input.albumId,
				input.contentType,
				input.dataBase64,
				input.thumbDataBase64,
				input.remainingViews,
				input.isViewable == null ? null : input.isViewable ? 1 : 0,
				now,
			],
		);
	});
}

export async function getAlbumMedia(albumId: string): Promise<StoredAlbumMedia[]> {
	const db = await getDb();
	const rows = await db.select<AlbumMediaRow[]>(
		"SELECT * FROM album_media WHERE album_id = $1",
		[albumId],
	);
	return rows.map(rowToStoredAlbumMedia);
}

/**
 * An album's items without their bytes. getAlbumMedia returns every file in
 * full, and it was being called just to learn which items were saved — which
 * for an album of videos pulled gigabytes across the bridge into the webview.
 */
export async function getAlbumMediaSummaries(albumId: string): Promise<StoredAlbumMediaSummary[]> {
	const db = await getDb();
	const rows = await db.select<
		{
			content_id: string;
			album_id: string;
			content_type: string | null;
			has_data: number;
			remaining_views: number | null;
			is_viewable: number | null;
		}[]
	>(
		`SELECT content_id, album_id, content_type,
			(data_base64 IS NOT NULL AND data_base64 != '') AS has_data,
			remaining_views, is_viewable
		 FROM album_media WHERE album_id = $1`,
		[albumId],
	);
	return rows.map((row) => ({
		contentId: row.content_id,
		albumId: row.album_id,
		contentType: row.content_type,
		hasData: Boolean(row.has_data),
		remainingViews: row.remaining_views,
		isViewable: row.is_viewable == null ? null : Boolean(row.is_viewable),
	}));
}

export type AlbumMediaCounts = {
	albumId: string;
	/** Items whose file is stored on this device. */
	savedCount: number;
	savedVideoCount: number;
};

/**
 * How many items of each album have their file stored, for every album at
 * once. typeof() reads a value's type from the row header, so no file is read.
 */
export async function getAlbumMediaCounts(): Promise<AlbumMediaCounts[]> {
	const db = await getDb();
	const rows = await db.select<{ album_id: string; saved: number | null; saved_videos: number | null }[]>(
		`SELECT album_id,
			SUM(typeof(data_base64) = 'text') AS saved,
			SUM(typeof(data_base64) = 'text' AND content_type LIKE 'video/%') AS saved_videos
		 FROM album_media GROUP BY album_id`,
	);
	return rows.map((row) => ({
		albumId: row.album_id,
		savedCount: row.saved ?? 0,
		savedVideoCount: row.saved_videos ?? 0,
	}));
}

// The preview column, falling back to the file itself, but only when the value
// is at most $2 characters: a video saved without a separate thumbnail keeps
// its whole file in both columns, and that must never be read as a preview.
const ALBUM_THUMB_SQL = `CASE
	WHEN thumb_data_base64 IS NOT NULL AND thumb_data_base64 != '' THEN
		CASE WHEN length(thumb_data_base64) <= $2 THEN thumb_data_base64 END
	WHEN data_base64 IS NOT NULL AND length(data_base64) <= $2 THEN data_base64
END`;

/** Small previews of an album's items, each no longer than `maxChars`. */
export async function getAlbumMediaThumbs(
	albumId: string,
	maxChars: number,
): Promise<{ contentId: string; contentType: string | null; thumbBase64: string }[]> {
	const db = await getDb();
	const rows = await db.select<{ content_id: string; content_type: string | null; thumb: string | null }[]>(
		`SELECT content_id, content_type, ${ALBUM_THUMB_SQL} AS thumb FROM album_media WHERE album_id = $1`,
		[albumId, maxChars],
	);
	return rows.flatMap((row) =>
		row.thumb ? [{ contentId: row.content_id, contentType: row.content_type, thumbBase64: row.thumb }] : [],
	);
}

/** One item's small preview, or null when there is none short enough. */
export async function getAlbumMediaThumb(
	contentId: string,
	maxChars: number,
): Promise<{ contentType: string | null; thumbBase64: string } | null> {
	const db = await getDb();
	const rows = await db.select<{ content_type: string | null; thumb: string | null }[]>(
		`SELECT content_type, ${ALBUM_THUMB_SQL} AS thumb FROM album_media WHERE content_id = $1`,
		[contentId, maxChars],
	);
	const row = rows[0];
	return row?.thumb ? { contentType: row.content_type, thumbBase64: row.thumb } : null;
}

/** Refreshes an item's view state without sending its bytes back to the database. */
export async function updateAlbumMediaViewability(
	contentId: string,
	remainingViews: number | null,
	isViewable: boolean | null,
): Promise<void> {
	const db = await getDb();
	await executeWithLockRetry(db, "update-album-media-viewability", async () => {
		await db.execute(
			"UPDATE album_media SET remaining_views = $1, is_viewable = $2 WHERE content_id = $3",
			[remainingViews, isViewable == null ? null : isViewable ? 1 : 0, contentId],
		);
	});
}

/** Stores an item's preview, keeping any bytes and view state already saved for it. */
export async function setAlbumMediaThumb(input: {
	contentId: string;
	albumId: string;
	contentType: string | null;
	thumbBase64: string;
}): Promise<void> {
	const db = await getDb();
	await executeWithLockRetry(db, "set-album-media-thumb", async () => {
		await db.execute(
			`INSERT INTO album_media (
				content_id, album_id, content_type, data_base64, thumb_data_base64,
				remaining_views, is_viewable, fetched_at
			) VALUES ($1, $2, $3, NULL, $4, NULL, NULL, $5)
			ON CONFLICT(content_id) DO UPDATE SET
				thumb_data_base64 = excluded.thumb_data_base64,
				content_type = COALESCE(album_media.content_type, excluded.content_type)`,
			[input.contentId, input.albumId, input.contentType, input.thumbBase64, Date.now()],
		);
	});
}

// ---------------------------------------------------------------------------
// Avatars
// ---------------------------------------------------------------------------

export async function upsertAvatar(
	mediaHash: string,
	dataBase64: string,
	mimeType: string | null,
): Promise<void> {
	const db = await getDb();
	const now = Date.now();

	await executeWithLockRetry(db, "upsert-avatar", async () => {
		await db.execute(
			`
			INSERT INTO avatars (media_hash, data_base64, mime_type, fetched_at)
			VALUES ($1, $2, $3, $4)
			ON CONFLICT(media_hash) DO UPDATE SET
				data_base64 = excluded.data_base64,
				mime_type = excluded.mime_type,
				fetched_at = excluded.fetched_at
			`,
			[mediaHash, dataBase64, mimeType, now],
		);
	});
}

export async function getAvatar(mediaHash: string): Promise<StoredAvatar | null> {
	const db = await getDb();
	const rows = await db.select<AvatarRow[]>(
		"SELECT * FROM avatars WHERE media_hash = $1",
		[mediaHash],
	);
	const row = rows[0];
	return row
		? {
				mediaHash: row.media_hash,
				dataBase64: row.data_base64,
				mimeType: row.mime_type,
				fetchedAt: row.fetched_at,
			}
		: null;
}

// ---------------------------------------------------------------------------
// Downloaded media manifest (device-local bookkeeping for saved files —
// never part of the portable chat-data export/import below, since asset
// ids/content URIs/paths are meaningless on a different install/device)
// ---------------------------------------------------------------------------

function rowToDownloadedMediaEntry(row: DownloadedMediaRow): DownloadedMediaEntry {
	return {
		identifier: row.identifier,
		platform: row.platform as DownloadedMediaEntry["platform"],
		albumId: row.album_id,
		byteSize: row.byte_size,
		mimeType: row.mime_type,
		kind: row.kind as DownloadedMediaEntry["kind"],
		savedAt: row.saved_at,
	};
}

export async function insertDownloadedMediaEntry(
	entry: DownloadedMediaEntry,
): Promise<void> {
	const db = await getDb();

	await executeWithLockRetry(db, "insert-downloaded-media", async () => {
		await db.execute(
			`
			INSERT INTO downloaded_media (
				identifier, platform, album_id, byte_size, mime_type, kind, saved_at
			) VALUES ($1, $2, $3, $4, $5, $6, $7)
			ON CONFLICT(identifier) DO UPDATE SET
				platform = excluded.platform,
				album_id = excluded.album_id,
				byte_size = excluded.byte_size,
				mime_type = excluded.mime_type,
				kind = excluded.kind,
				saved_at = excluded.saved_at
			`,
			[
				entry.identifier,
				entry.platform,
				entry.albumId,
				entry.byteSize,
				entry.mimeType,
				entry.kind,
				entry.savedAt,
			],
		);
	});
}

export async function getDownloadedMediaEntries(): Promise<DownloadedMediaEntry[]> {
	const db = await getDb();
	const rows = await db.select<DownloadedMediaRow[]>(
		"SELECT * FROM downloaded_media ORDER BY saved_at DESC",
	);
	return rows.map(rowToDownloadedMediaEntry);
}

export async function getDownloadedMediaUsage(): Promise<{ count: number; totalBytes: number }> {
	const db = await getDb();
	const rows = await db.select<{ count: number; total_bytes: number | null }[]>(
		"SELECT COUNT(*) as count, SUM(byte_size) as total_bytes FROM downloaded_media",
	);
	return {
		count: rows[0]?.count ?? 0,
		totalBytes: rows[0]?.total_bytes ?? 0,
	};
}

export async function deleteDownloadedMediaEntries(identifiers: string[]): Promise<void> {
	if (identifiers.length === 0) {
		return;
	}
	const db = await getDb();

	await executeWithLockRetry(db, "delete-downloaded-media", async () => {
		const placeholders = identifiers.map((_, i) => `$${i + 1}`).join(", ");
		await db.execute(
			`DELETE FROM downloaded_media WHERE identifier IN (${placeholders})`,
			identifiers,
		);
	});
}

// ---------------------------------------------------------------------------
// Full database export/import — every table in this profile's db that's
// portable to another install: chat history and media, albums, avatars,
// saved phrases/locations, and the generic settings key/value store
// (automation rules, privacy toggles, browse filters, location, etc).
// Excludes downloaded_media, which is local device bookkeeping (references
// files on this device's filesystem) with no meaning on another install.
// ---------------------------------------------------------------------------

const FULL_EXPORT_TABLES: {
	name: keyof FullDbExport["tables"];
	primaryKey: string;
	columns: string[];
}[] = [
	{
		name: "conversations",
		primaryKey: "conversation_id",
		columns: [
			"conversation_id", "other_profile_id", "name", "participants_json",
			"last_activity_timestamp", "unread_count", "pinned", "muted", "favorite",
			"preview_json", "archived", "archived_reason", "archived_at", "hidden",
			// block_state and messages_synced_activity_timestamp were added by
			// later ALTER TABLE migrations and had been left out here, so an
			// import lost the recorded block direction (leaving it to be
			// re-inferred, wrongly) and forced a full message re-sync.
			"block_state", "messages_synced_activity_timestamp",
			"last_seen_in_inbox_at", "created_at", "updated_at",
		],
	},
	{
		name: "conversation_meta",
		primaryKey: "conversation_id",
		columns: ["conversation_id", "last_read_timestamp"],
	},
	{
		name: "messages",
		primaryKey: "message_id",
		columns: [
			"message_id", "conversation_id", "sender_id", "timestamp", "type",
			"chat1_type", "body_json", "unsent", "local_history",
			"reply_to_message_id", "reply_preview_json", "reactions_json",
			"created_at", "updated_at",
		],
	},
	{
		name: "media_files",
		primaryKey: "media_key",
		columns: [
			"media_key", "conversation_id", "message_id", "kind", "mime_type",
			"data_base64", "view_once", "size_bytes", "fetch_status", "fetched_at",
		],
	},
	{
		name: "albums",
		primaryKey: "album_id",
		columns: [
			"album_id", "owner_profile_id", "album_name", "conversation_id",
			"shared_via_message_id", "preview_cover_base64", "preview_cover_mime_type",
			"created_at", "updated_at",
		],
	},
	{
		name: "album_media",
		primaryKey: "content_id",
		columns: [
			"content_id", "album_id", "content_type", "data_base64",
			"thumb_data_base64", "remaining_views", "is_viewable", "fetched_at",
		],
	},
	{
		name: "avatars",
		primaryKey: "media_hash",
		columns: ["media_hash", "data_base64", "mime_type", "fetched_at"],
	},
	{
		name: "settings",
		primaryKey: "key",
		columns: ["key", "value"],
	},
	{
		name: "saved_phrases",
		primaryKey: "phrase",
		columns: ["phrase", "created_at"],
	},
	{
		name: "saved_locations",
		primaryKey: "id",
		columns: ["id", "name", "geohash", "lat", "lon", "created_at"],
	},
	{
		// Absent from v1 exports, so Block History came up empty on a restored
		// device. v1 files simply won't carry the key and the importer skips
		// any table it doesn't find, so adding it here is backwards compatible.
		name: "block_events",
		primaryKey: "id",
		columns: [
			"id", "profile_id", "conversation_id", "event_type", "timestamp",
			"display_name", "avatar_media_hash", "created_at",
		],
	},
	{
		name: "stats_block_log",
		primaryKey: "id",
		columns: [
			"id", "event_type", "profile_id", "timestamp", "method", "source",
			"reason_kind", "reason_detail", "reason_label", "rule_id", "rule_name",
			"device_id", "device_name", "created_at",
		],
	},
	{
		name: "stats_location_log",
		primaryKey: "id",
		columns: [
			"id", "timestamp", "geohash", "lat", "lon", "name", "automatic",
			"device_id", "device_name", "created_at",
		],
	},
	{
		name: "stats_coverage_log",
		primaryKey: "id",
		columns: [
			"id", "hour_start", "first_at", "source", "device_id", "device_name",
			"created_at",
		],
	},
	{
		name: "stats_profile_edit_log",
		primaryKey: "id",
		columns: ["id", "timestamp", "fields_json", "device_id", "device_name", "created_at"],
	},
	{
		name: "stats_profile_open_log",
		primaryKey: "id",
		columns: [
			"id", "profile_id", "timestamp", "view_recorded", "surface",
			"device_id", "device_name", "created_at",
		],
	},
	{
		name: "stats_view_distance_log",
		primaryKey: "id",
		columns: [
			"id", "profile_id", "view_timestamp", "observed_at", "distance_meters",
			"source", "device_id", "device_name", "created_at",
		],
	},
	{
		name: "past_contacts",
		primaryKey: "profile_id",
		columns: [
			"profile_id", "source_profile_id", "display_name", "their_messages",
			"my_messages", "first_message_at", "last_message_at", "last_text",
			"blocked_by_me_at", "block_reason", "blocked_me_at", "messages_json", "updated_at",
		],
	},
	{
		name: "past_messages",
		primaryKey: "message_id",
		columns: [
			"message_id", "conversation_id", "sender_id", "timestamp", "type", "chat1_type",
			"body_json", "unsent", "local_history", "reply_to_message_id", "reply_preview_json",
			"reactions_json", "created_at", "updated_at", "source_profile_id",
		],
	},
	{
		name: "past_views",
		primaryKey: "profile_id",
		columns: ["profile_id", "source_profile_id", "row_json", "updated_at"],
	},
];

export type StatsLogTable =
	| "stats_block_log"
	| "stats_location_log"
	| "stats_coverage_log"
	| "stats_profile_edit_log"
	| "stats_profile_open_log"
	| "stats_view_distance_log";

/**
 * Appends rows to a Stats log. Rows are immutable once written, so an id that
 * already exists is left as it is: the coverage log relies on that to record
 * each hour once no matter how many sweeps land in it, and the distance log
 * to store a view once however many times it is listed.
 */
export async function insertStatsLogRows(
	name: StatsLogTable,
	rows: PortableTableRow[],
): Promise<void> {
	if (rows.length === 0) return;
	const table = requirePortableTable(name);
	const db = await getDb();
	await executeWithLockRetry(db, `insert-${table.name}`, async () => {
		for (const row of rows) {
			const columns = table.columns.filter((column) => row[column] !== undefined);
			const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");
			await db.execute(
				`INSERT INTO ${table.name} (${columns.join(", ")}) VALUES (${placeholders})
				 ON CONFLICT(${table.primaryKey}) DO NOTHING`,
				columns.map((column) => row[column] ?? null),
			);
		}
	});
}

export function insertStatsLogRow(name: StatsLogTable, row: PortableTableRow): Promise<void> {
	return insertStatsLogRows(name, [row]);
}

/** When the newest "unblock all" was logged (it carries no profile), or null. */
export async function getLatestUnblockAllTimestamp(): Promise<number | null> {
	const db = await getDb();
	const rows = await db.select<{ at: number | null }[]>(
		"SELECT MAX(timestamp) AS at FROM stats_block_log WHERE event_type = 'unblock' AND profile_id IS NULL",
	);
	const at = rows[0]?.at;
	return at == null ? null : Number(at);
}

/**
 * The newest block or unblock the Stats log holds for one person, from any
 * device — what the profile screen reads to say how and why they were blocked.
 * Null when nothing was logged (Stats was off, or the block predates it).
 */
export async function getLatestBlockLogEntry(profileId: string): Promise<BlockLogEntry | null> {
	const db = await getDb();
	const rows = await db.select<
		{
			event_type: string;
			timestamp: number;
			method: string | null;
			source: string | null;
			reason_kind: string | null;
			reason_detail: string | null;
			reason_label: string | null;
			rule_name: string | null;
		}[]
	>(
		`SELECT event_type, timestamp, method, source, reason_kind, reason_detail, reason_label, rule_name
		 FROM stats_block_log WHERE profile_id = $1 ORDER BY timestamp DESC LIMIT 1`,
		[profileId],
	);
	const row = rows[0];
	if (!row) return null;
	return {
		eventType: row.event_type,
		timestamp: Number(row.timestamp),
		method: row.method,
		source: row.source,
		reasonKind: row.reason_kind,
		reasonDetail: row.reason_detail,
		reasonLabel: row.reason_label,
		ruleName: row.rule_name,
	};
}

/** The most recent location in the log, from any device. */
export async function getLatestStatsLocation(): Promise<{
	geohash: string;
	name: string | null;
} | null> {
	const db = await getDb();
	const rows = await db.select<{ geohash: string; name: string | null }[]>(
		"SELECT geohash, name FROM stats_location_log ORDER BY timestamp DESC LIMIT 1",
	);
	return rows[0] ?? null;
}

/**
 * Read-only access for the Stats page (pages/app/stats/statsData.ts), which
 * does its counting in SQL rather than pulling whole tables into memory. The
 * statements are the page's own constants, never user input.
 */
export async function selectStatsRows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
	const db = await getDb();
	return db.select<T[]>(sql, params);
}

export type PortableTable = (typeof FULL_EXPORT_TABLES)[number];

export type PortableTableRow = Record<string, unknown>;

export type PortableTableUpsertOptions = {
	skipColumns?: string[];
	newerThanColumn?: string;
	maxColumns?: string[];
	preserveExistingOnNullOrEmptyColumns?: string[];
	/**
	 * Written when the row is created, then never touched again by this
	 * mutation. For a column that carries a local user decision rather than
	 * server state: a new row still arrives with the right value, but every
	 * later write of the *rest* of the row leaves that decision alone.
	 */
	insertOnlyColumns?: string[];
	/**
	 * Skip rows that do not exist yet instead of inserting them. For a mutation
	 * that only owns a couple of a wider table's columns and therefore cannot
	 * satisfy its NOT NULL constraints on its own — the row's real owner brings
	 * it into existence, in either order.
	 */
	updateOnly?: boolean;
};

export type PortableTableRowMutation =
	| {
			kind: "upsert";
			row: PortableTableRow;
			options?: PortableTableUpsertOptions;
	  }
	| { kind: "delete" };

export type PortableTableCompareAndApplyResult =
	| "already-current"
	| "changed"
	| "applied";

export type PortableTableRowPredicate = (
	currentRow: Readonly<PortableTableRow> | null,
) => boolean;

export type PortableTableCompareAndApplyOptions = {
	/** Columns excluded from the row passed to both predicates, as in a sync scan. */
	omitColumns?: string[];
	/** Checked first so replaying an operation that already landed is a no-op. */
	matchesIncoming: PortableTableRowPredicate;
	/** The local row observed before the remote winner was selected. */
	matchesExpected: PortableTableRowPredicate;
};

/**
 * Table descriptors keyed by name. Every generic read/write below resolves
 * its table through this map rather than accepting a caller-supplied name,
 * which is what keeps arbitrary strings out of the interpolated SQL.
 */
const PORTABLE_TABLES_BY_NAME = new Map<string, PortableTable>(
	FULL_EXPORT_TABLES.map((table) => [table.name as string, table]),
);

export function getPortableTable(name: string): PortableTable | null {
	return PORTABLE_TABLES_BY_NAME.get(name) ?? null;
}

function requirePortableTable(name: string): PortableTable {
	const table = getPortableTable(name);
	if (!table) {
		throw new Error(`Unknown portable table: ${name}`);
	}
	return table;
}

export async function countTableRows(name: string): Promise<number> {
	const table = requirePortableTable(name);
	const db = await getDb();
	const rows = await db.select<{ count: number }[]>(`SELECT COUNT(*) as count FROM ${table.name}`);
	return rows[0]?.count ?? 0;
}

/** Total bytes held by the given TEXT columns — used for the export size preview. */
export async function sumColumnLengths(name: string, columns: string[]): Promise<number> {
	const table = requirePortableTable(name);
	const known = columns.filter((column) => table.columns.includes(column));
	if (known.length === 0) {
		return 0;
	}
	const db = await getDb();
	const expression = known.map((column) => `COALESCE(SUM(LENGTH(${column})), 0)`).join(" + ");
	const rows = await db.select<{ total: number | null }[]>(
		`SELECT ${expression} as total FROM ${table.name}`,
	);
	return rows[0]?.total ?? 0;
}

/**
 * One page of a table, ordered by primary key so paging stays stable across
 * calls. Paging is what keeps a multi-hundred-megabyte media table out of
 * memory during an export — the previous exporter selected every row of
 * every table at once and then stringified the lot.
 */
export async function selectTablePage(
	name: string,
	offset: number,
	limit: number,
	options?: { omitColumns?: string[]; sinceColumn?: string; since?: number },
): Promise<Record<string, unknown>[]> {
	const table = requirePortableTable(name);
	const omit = new Set(options?.omitColumns ?? []);
	const columns = table.columns.filter((column) => !omit.has(column));

	// The watermark column is checked against this table's own schema, so an
	// incremental export can't smuggle an arbitrary identifier into the SQL.
	const sinceColumn =
		options?.sinceColumn && table.columns.includes(options.sinceColumn)
			? options.sinceColumn
			: null;
	const since = options?.since;
	const where = sinceColumn && since ? `WHERE ${sinceColumn} > $1` : "";
	const params = where ? [since] : [];

	const db = await getDb();
	return db.select<Record<string, unknown>[]>(
		`SELECT ${columns.join(", ")} FROM ${table.name} ${where}
		 ORDER BY ${table.primaryKey} LIMIT ${Math.trunc(limit)} OFFSET ${Math.trunc(offset)}`,
		params,
	);
}

/** Rows a delta export would carry — drives the "N changes" count in the UI. */
export async function countTableRowsSince(
	name: string,
	sinceColumn: string,
	since: number,
): Promise<number> {
	const table = requirePortableTable(name);
	if (!table.columns.includes(sinceColumn)) {
		return countTableRows(name);
	}
	const db = await getDb();
	const rows = await db.select<{ count: number }[]>(
		`SELECT COUNT(*) as count FROM ${table.name} WHERE ${sinceColumn} > $1`,
		[since],
	);
	return rows[0]?.count ?? 0;
}

/**
 * Upserts a batch of rows into a portable table. Mirrors the semantics of
 * importFullDatabase — existing rows lose to the imported version, nothing
 * absent from the import is touched — but takes rows a page at a time so a
 * streaming import never has to hold the whole file.
 *
 * Columns absent from a row are written as NULL only when the row genuinely
 * omits them; a section that deliberately skips a heavy column (album cover
 * art, say) passes it in `skipColumns` so the existing value survives.
 */
async function upsertTableRowsUnlocked(
	db: Database,
	table: PortableTable,
	rows: PortableTableRow[],
	options?: PortableTableUpsertOptions,
): Promise<number> {
	const skip = new Set(options?.skipColumns ?? []);
	const columns = table.columns.filter((column) => !skip.has(column));
	const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");

	// Columns that only ever move forward (a read cursor), merged by taking the
	// larger side rather than whichever file happened to be imported last.
	const maxColumns = new Set(
		(options?.maxColumns ?? []).filter((column) => columns.includes(column)),
	);
	const preserveColumns = new Set(
		(options?.preserveExistingOnNullOrEmptyColumns ?? []).filter((column) =>
			columns.includes(column),
		),
	);

	const insertOnlyColumns = new Set(
		(options?.insertOnlyColumns ?? []).filter((column) => columns.includes(column)),
	);

	const updates = columns
		.filter((column) => column !== table.primaryKey && !insertOnlyColumns.has(column))
		.map((column) => {
			if (maxColumns.has(column)) {
				return `${column} = MAX(COALESCE(excluded.${column}, 0), COALESCE(${table.name}.${column}, 0))`;
			}
			if (preserveColumns.has(column)) {
				return `${column} = CASE WHEN excluded.${column} IS NULL OR excluded.${column} = '' THEN ${table.name}.${column} ELSE excluded.${column} END`;
			}
			return `${column} = excluded.${column}`;
		})
		.join(", ");

	/**
	 * Last-writer-wins guard. Without it an import is a blind overwrite, so
	 * restoring a backup taken on a device that had been sitting closed would
	 * drag live rows backwards — unread counts, last-activity times and
	 * conversation previews all regressing to whatever the stale side held.
	 * Rows the target doesn't have still insert normally; only genuine
	 * conflicts consult the timestamp.
	 */
	const guard =
		options?.newerThanColumn && columns.includes(options.newerThanColumn)
			? ` WHERE COALESCE(excluded.${options.newerThanColumn}, 0) >= COALESCE(${table.name}.${options.newerThanColumn}, 0)`
			: "";

	// An UPDATE keyed on the primary key, so a row the target does not have is
	// left alone rather than inserted from columns that cannot satisfy the
	// table's NOT NULL constraints.
	const updateColumns = columns.filter(
		(column) => column !== table.primaryKey && !insertOnlyColumns.has(column),
	);
	const updateOnlySql = `
		UPDATE ${table.name} SET ${updateColumns
			.map((column, index) => `${column} = $${index + 2}`)
			.join(", ")}
		WHERE ${table.primaryKey} = $1
	`;

	const sql = `
		INSERT INTO ${table.name} (${columns.join(", ")})
		VALUES (${placeholders})
		ON CONFLICT(${table.primaryKey}) DO ${updates ? `UPDATE SET ${updates}${guard}` : "NOTHING"}
	`;

	let written = 0;
	for (const row of rows) {
		if (!row || typeof row !== "object" || row[table.primaryKey] == null) {
			continue;
		}
		if (options?.updateOnly) {
			if (updateColumns.length === 0) {
				continue;
			}
			await db.execute(updateOnlySql, [
				row[table.primaryKey],
				...updateColumns.map((column) => row[column] ?? null),
			]);
		} else {
			await db.execute(sql, columns.map((column) => row[column] ?? null));
		}
		written += 1;
	}
	return written;
}

export async function upsertTableRows(
	name: string,
	rows: PortableTableRow[],
	options?: PortableTableUpsertOptions,
): Promise<number> {
	const table = requirePortableTable(name);
	if (rows.length === 0) {
		return 0;
	}

	let written = 0;
	const db = await getDb();
	await executeWithLockRetry(db, `import-${table.name}`, async () => {
		written = await upsertTableRowsUnlocked(db, table, rows, options);
	});
	return written;
}

/**
 * Keyset-paged variant used by unattended sync. Unlike OFFSET paging it
 * cannot skip a surviving row when another row is inserted or deleted while
 * a long reconciliation scan is running.
 */
export async function selectTablePageAfter(
	name: string,
	afterPrimaryKey: string | null,
	limit: number,
	options?: { omitColumns?: string[] },
): Promise<Record<string, unknown>[]> {
	const table = requirePortableTable(name);
	const omit = new Set(options?.omitColumns ?? []);
	const columns = table.columns.filter((column) => !omit.has(column));
	const where = afterPrimaryKey == null ? "" : `WHERE ${table.primaryKey} > $1`;
	const params = afterPrimaryKey == null ? [] : [afterPrimaryKey];
	const db = await getDb();
	return db.select<Record<string, unknown>[]>(
		`SELECT ${columns.join(", ")} FROM ${table.name} ${where}
		 ORDER BY ${table.primaryKey} LIMIT ${Math.max(1, Math.trunc(limit))}`,
		params,
	);
}

async function selectPortableTableRowUnlocked(
	db: Database,
	table: PortableTable,
	primaryKeyValue: unknown,
	omitColumns?: string[],
): Promise<PortableTableRow | null> {
	const omit = new Set(omitColumns ?? []);
	const columns = table.columns.filter((column) => !omit.has(column));
	if (columns.length === 0) {
		throw new Error(`Cannot compare ${table.name} without any portable columns`);
	}
	const rows = await db.select<PortableTableRow[]>(
		`SELECT ${columns.join(", ")} FROM ${table.name}
		 WHERE ${table.primaryKey} = $1 LIMIT 1`,
		[primaryKeyValue],
	);
	return rows[0] ?? null;
}

async function deletePortableTableRowUnlocked(
	db: Database,
	table: PortableTable,
	primaryKeyValue: unknown,
): Promise<void> {
	await db.execute(
		`DELETE FROM ${table.name} WHERE ${table.primaryKey} = $1`,
		[primaryKeyValue],
	);
}

/**
 * Atomically compares and applies one portable row relative to this module's
 * serialized write queue. Predicates are synchronous and must be pure because
 * the whole compare/write unit can be repeated after a transient SQLite lock.
 *
 * The incoming predicate runs first, making a replay that is already present
 * an idempotent no-op. A failed expected predicate means the row changed since
 * the caller observed it, so the requested mutation is deliberately skipped.
 */
export async function compareAndApplyPortableTableRow(
	name: string,
	primaryKeyValue: unknown,
	mutation: PortableTableRowMutation,
	options: PortableTableCompareAndApplyOptions,
): Promise<PortableTableCompareAndApplyResult> {
	const table = requirePortableTable(name);
	if (primaryKeyValue == null) {
		throw new Error(`Cannot compare ${table.name} without a primary key`);
	}
	if (
		mutation.kind === "upsert" &&
		(
			mutation.row[table.primaryKey] == null ||
			String(mutation.row[table.primaryKey]) !== String(primaryKeyValue)
		)
	) {
		throw new Error(`The ${table.name} upsert row does not match its primary key`);
	}

	const db = await getDb();
	let result: PortableTableCompareAndApplyResult | null = null;
	await executeWithLockRetry(db, `compare-and-apply-${table.name}`, async () => {
		result = null;
		const currentRow = await selectPortableTableRowUnlocked(
			db,
			table,
			primaryKeyValue,
			options.omitColumns,
		);
		if (options.matchesIncoming(currentRow)) {
			result = "already-current";
			return;
		}
		if (!options.matchesExpected(currentRow)) {
			result = "changed";
			return;
		}

		if (mutation.kind === "upsert") {
			await upsertTableRowsUnlocked(db, table, [mutation.row], mutation.options);
		} else {
			await deletePortableTableRowUnlocked(db, table, primaryKeyValue);
		}
		result = "applied";
	});
	if (result == null) {
		throw new Error(`The ${table.name} compare-and-apply operation did not complete`);
	}
	return result;
}

/** Deletes one row through the same table allowlist used by backup import. */
export async function deletePortableTableRow(name: string, primaryKeyValue: unknown): Promise<void> {
	const table = requirePortableTable(name);
	if (primaryKeyValue == null) {
		return;
	}
	const db = await getDb();
	await executeWithLockRetry(db, `delete-${table.name}-row`, async () => {
		await deletePortableTableRowUnlocked(db, table, primaryKeyValue);
	});
}

/** Empties the named portable tables — the "replace everything" import path. */
/**
 * Blank cached media columns while keeping the rows. The albums table carries
 * both album metadata and its cached cover image, so freeing the cover must
 * not delete the album it belongs to.
 */
export async function blankPortableTableColumns(
	name: string,
	columns: readonly string[],
): Promise<void> {
	const table = requirePortableTable(name);
	const known = columns.filter((column) => table.columns.includes(column));
	if (known.length === 0) return;
	const assignments = known.map((column) => `${column} = NULL`).join(", ");
	const db = await getDb();
	await executeWithLockRetry(db, "blank-portable-columns", async () => {
		await db.execute(`UPDATE ${table.name} SET ${assignments}`);
	});
}

export async function clearPortableTables(names: string[]): Promise<void> {
	const tables = names.map(requirePortableTable);
	if (tables.length === 0) {
		return;
	}
	const db = await getDb();
	await executeWithLockRetry(db, "clear-portable-tables", async () => {
		for (const table of tables) {
			await db.execute(`DELETE FROM ${table.name}`);
		}
	});
}

export type DatabaseUsage = {
	/** What the file takes up on disk. */
	fileBytes: number;
	/** The part of it holding data. */
	usedBytes: number;
	/**
	 * Space inside the file that deleted rows left behind. Sqlite keeps it for
	 * its own later writes instead of returning it to the disk, so a file that
	 * once held gigabytes of media stays that size long after the media is
	 * gone — see compactDatabase.
	 */
	freeBytes: number;
};

/**
 * How much room the chat database takes, and how much of that is still in
 * use. Read via pragma rather than a filesystem stat because $APPDATA has no
 * read scope in our fs capability.
 */
export async function getDatabaseUsage(): Promise<DatabaseUsage> {
	const db = await getDb();
	const rows = await db.select<{ file: number | null; free: number | null }[]>(
		"SELECT page_count * page_size AS file, freelist_count * page_size AS free"
			+ " FROM pragma_page_count(), pragma_page_size(), pragma_freelist_count()",
	);
	const fileBytes = rows[0]?.file ?? 0;
	const freeBytes = Math.min(rows[0]?.free ?? 0, fileBytes);
	return { fileBytes, usedBytes: fileBytes - freeBytes, freeBytes };
}

/**
 * Rewrites the database without its free pages, handing that space back to
 * the disk. Nothing stored is lost: sqlite rebuilds the file from the live
 * rows and swaps it in atomically, so an interrupted run leaves the original
 * in place.
 */
export async function compactDatabase(): Promise<DatabaseUsage> {
	const db = await getDb();
	await executeWithLockRetry(db, "compact-database", async () => {
		await db.execute("VACUUM");
	});
	return getDatabaseUsage();
}

/**
 * Dumps every portable table in this profile's db as raw rows, plus the
 * exporting user's id so a later import can refuse to load another
 * account's data.
 */
export async function exportFullDatabase(ownerUserId: number): Promise<FullDbExport> {
	const db = await getDb();
	const tables = {} as FullDbExport["tables"];

	for (const table of FULL_EXPORT_TABLES) {
		const rows = await db.select<Record<string, unknown>[]>(`SELECT * FROM ${table.name}`);
		tables[table.name] = rows;
	}

	return {
		version: 1,
		exportedAt: Date.now(),
		ownerUserId,
		tables,
	};
}

export type ImportFullDatabaseResult =
	| { ok: true; rowsImported: number }
	| { ok: false; error: "wrong_owner" | "invalid_format" };

/**
 * Merge-imports a previously exported database: every row is upserted
 * (existing local rows are overwritten by the imported version on conflict,
 * nothing not present in the import is touched or removed). Only column
 * names from our own known schema are ever interpolated into SQL — unknown
 * keys on an imported row are ignored rather than trusted, since the import
 * file is arbitrary user-supplied JSON.
 */
export async function importFullDatabase(
	data: FullDbExport,
	currentUserId: number,
): Promise<ImportFullDatabaseResult> {
	if (!data || data.version !== 1 || typeof data.ownerUserId !== "number" || !data.tables) {
		return { ok: false, error: "invalid_format" };
	}
	if (data.ownerUserId !== currentUserId) {
		return { ok: false, error: "wrong_owner" };
	}

	const db = await getDb();
	let rowsImported = 0;

	await executeWithLockRetry(db, "import-full-database", async () => {
		for (const table of FULL_EXPORT_TABLES) {
			const rows = data.tables[table.name];
			if (!Array.isArray(rows)) {
				continue;
			}

			const placeholders = table.columns.map((_, i) => `$${i + 1}`).join(", ");
			const updates = table.columns
				.filter((c) => c !== table.primaryKey)
				.map((c) => `${c} = excluded.${c}`)
				.join(", ");
			const sql = `
				INSERT INTO ${table.name} (${table.columns.join(", ")})
				VALUES (${placeholders})
				ON CONFLICT(${table.primaryKey}) DO UPDATE SET ${updates}
			`;

			for (const row of rows) {
				if (!row || typeof row !== "object" || (row as Record<string, unknown>)[table.primaryKey] == null) {
					continue;
				}
				const values = table.columns.map((c) => (row as Record<string, unknown>)[c] ?? null);
				await db.execute(sql, values);
				rowsImported += 1;
			}
		}
	});

	return { ok: true, rowsImported };
}

// ---------------------------------------------------------------------------
// Settings (generic per-profile key/value store — JSON-encoded values)
// ---------------------------------------------------------------------------

export async function getSetting<T>(key: string): Promise<T | null> {
	const db = await getDb();
	const rows = await db.select<{ value: string }[]>(
		"SELECT value FROM settings WHERE key = $1",
		[key],
	);
	if (!rows[0]) {
		return null;
	}
	try {
		return JSON.parse(rows[0].value) as T;
	} catch (error) {
		appLog.error("[chat-db] failed to parse setting", { key, error });
		return null;
	}
}

export async function setSetting(key: string, value: unknown): Promise<void> {
	const db = await getDb();

	await executeWithLockRetry(db, "set-setting", async () => {
		await db.execute(
			`
			INSERT INTO settings (key, value) VALUES ($1, $2)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value
			`,
			[key, JSON.stringify(value)],
		);
	});
}

// ---------------------------------------------------------------------------
// Saved phrases
// ---------------------------------------------------------------------------

export async function getAllSavedPhrases(): Promise<string[]> {
	const db = await getDb();
	const rows = await db.select<{ phrase: string }[]>(
		"SELECT phrase FROM saved_phrases ORDER BY created_at ASC",
	);
	return rows.map((row) => row.phrase);
}

/** Replace-all: mirrors the old localStorage-backed saveSavedPhrases semantics. */
export async function setSavedPhrases(phrases: string[]): Promise<string[]> {
	const db = await getDb();
	const now = Date.now();

	await executeWithLockRetry(db, "set-saved-phrases", async () => {
		await db.execute("DELETE FROM saved_phrases");
		// The list is read back by `created_at`, so that is where its order
		// lives: each phrase gets a time one step after the one before it.
		// With one time for all of them the order was left to chance, and
		// cloud sync, which carries the time, had no order to pass on.
		for (const [index, phrase] of phrases.entries()) {
			await db.execute(
				"INSERT INTO saved_phrases (phrase, created_at) VALUES ($1, $2) ON CONFLICT(phrase) DO NOTHING",
				[phrase, now + index],
			);
		}
	});

	return getAllSavedPhrases();
}

// ---------------------------------------------------------------------------
// Generic per-profile settings consumed only inside a single component
// (no synchronous hot-path access needed) just reuse getSetting/setSetting
// directly with a dedicated key — see PreferencesContext's sibling, the
// chat-page "hide pinned" toggle, browse filters, recent gifs, and seen
// timestamps below.
// ---------------------------------------------------------------------------

export async function getRecentGifs<T>(): Promise<T[]> {
	const stored = await getSetting<T[]>("recentGifs");
	return Array.isArray(stored) ? stored : [];
}

export async function setRecentGifs<T>(gifs: T[]): Promise<T[]> {
	await setSetting("recentGifs", gifs);
	return gifs;
}

// ---------------------------------------------------------------------------
// Saved locations
// ---------------------------------------------------------------------------

export interface StoredSavedLocation {
	id: string;
	name: string;
	geohash: string;
	lat: number;
	lon: number;
}

type SavedLocationRow = StoredSavedLocation & { created_at: number };

export async function getAllSavedLocations(): Promise<StoredSavedLocation[]> {
	const db = await getDb();
	const rows = await db.select<SavedLocationRow[]>(
		"SELECT id, name, geohash, lat, lon FROM saved_locations ORDER BY created_at ASC",
	);
	return rows.map(({ id, name, geohash, lat, lon }) => ({ id, name, geohash, lat, lon }));
}

export async function insertSavedLocation(
	input: StoredSavedLocation,
): Promise<StoredSavedLocation[]> {
	const db = await getDb();

	await executeWithLockRetry(db, "insert-saved-location", async () => {
		await db.execute(
			`
			INSERT INTO saved_locations (id, name, geohash, lat, lon, created_at)
			VALUES ($1, $2, $3, $4, $5, $6)
			`,
			[input.id, input.name, input.geohash, input.lat, input.lon, Date.now()],
		);
	});

	return getAllSavedLocations();
}

export async function deleteSavedLocationRow(id: string): Promise<StoredSavedLocation[]> {
	const db = await getDb();

	await executeWithLockRetry(db, "delete-saved-location", async () => {
		await db.execute("DELETE FROM saved_locations WHERE id = $1", [id]);
	});

	return getAllSavedLocations();
}

// ---------------------------------------------------------------------------
// Copying settings from another account on this device
// ---------------------------------------------------------------------------

export interface AccountSettingsSnapshot {
	/** Raw JSON-encoded values, copied as stored. */
	settings: { key: string; value: string }[];
	phrases: string[];
	locations: StoredSavedLocation[];
}

function accountDbFilename(profileId: number): string {
	return `chat-${profileId}.sqlite3`;
}

/** True when this account already has its own database file on this device. */
export async function accountDbExists(profileId: number): Promise<boolean> {
	try {
		return await exists(accountDbFilename(profileId), { baseDir: BaseDirectory.AppData });
	} catch (error) {
		appLog.warn("[chat-db] account db existence check failed", { profileId, error });
		return false;
	}
}

/**
 * Profile ids of the account databases found in the app's data folder. Empty
 * when the folder can't be listed; callers also check the accounts they
 * already know about, so a platform that refuses the listing loses nothing.
 */
export async function listAccountDbProfileIds(): Promise<number[]> {
	try {
		const entries = await readDir(await appDataDir());
		const ids = new Set<number>();
		for (const entry of entries) {
			if (!entry.isFile) continue;
			const profileId = profileIdFromAccountDbFilename(entry.name);
			if (profileId != null) ids.add(profileId);
		}
		return [...ids];
	} catch (error) {
		appLog.warn("[chat-db] could not list account databases", error);
		return [];
	}
}

/**
 * Reads the copyable settings, saved phrases and saved locations from
 * another account's database without making it the active one. It opens a
 * separate connection and closes only that one.
 */
export async function readAccountSettingsSnapshot(
	sourceProfileId: number,
): Promise<AccountSettingsSnapshot> {
	return withAccountDb(sourceProfileId, async (source) => {
		const settingRows = await source.select<{ key: string; value: string }[]>(
			"SELECT key, value FROM settings",
		);
		const phraseRows = await source.select<{ phrase: string }[]>(
			"SELECT phrase FROM saved_phrases ORDER BY created_at ASC",
		);
		const locationRows = await source.select<SavedLocationRow[]>(
			"SELECT id, name, geohash, lat, lon, created_at FROM saved_locations ORDER BY created_at ASC",
		);
		return {
			settings: settingRows.filter((row) => isCopyableAccountSetting(row.key)),
			phrases: phraseRows.map((row) => row.phrase),
			locations: locationRows.map(({ id, name, geohash, lat, lon }) => ({
				id,
				name,
				geohash,
				lat,
				lon,
			})),
		};
	});
}

/**
 * Opens another account's database on a connection of its own, runs `read`
 * on it and closes only that connection.
 */
async function withAccountDb<T>(
	sourceProfileId: number,
	read: (source: Database) => Promise<T>,
): Promise<T> {
	// Compared as text: reading the active account through a second
	// connection would end with closing the connection the app is using.
	if (String(sourceProfileId) === String(activeChatDbProfileId)) {
		throw new Error("Choose an account other than the one you're signed in with.");
	}
	if (!(await accountDbExists(sourceProfileId))) {
		throw new Error("That account has no data on this device.");
	}

	const source = await Database.load(`sqlite:${accountDbFilename(sourceProfileId)}`);
	try {
		await source.execute(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`).catch(() => {});
		return await read(source);
	} finally {
		// Pass the path: close() with no argument closes every sql pool,
		// including the active account's (see setActiveChatDbUser).
		await source.close(source.path).catch((error) => {
			appLog.warn("[chat-db] failed to close the source account db", error);
		});
	}
}

/** History tables copied as they are when moving to a new account. */
const MOVED_HISTORY_TABLES = [
	"block_events",
	"stats_block_log",
	"stats_location_log",
	"stats_coverage_log",
	"stats_profile_edit_log",
	"stats_profile_open_log",
	"stats_view_distance_log",
] as const;

export type MovedHistoryTable = (typeof MOVED_HISTORY_TABLES)[number];

export interface AccountHistorySnapshot {
	/** Full message rows, for the Stats copy. */
	messageRows: PortableTableRow[];
	messages: PastContactMessage[];
	loggedBlocks: PastContactLoggedBlock[];
	displayNames: Map<string, string>;
	historyRows: { table: MovedHistoryTable; rows: PortableTableRow[] }[];
}

function messageBodyText(bodyJson: string | null): string {
	if (!bodyJson) return "";
	try {
		const body = JSON.parse(bodyJson) as unknown;
		return body && typeof body === "object" && typeof (body as { text?: unknown }).text === "string"
			? (body as { text: string }).text
			: "";
	} catch {
		return "";
	}
}

/** Reads what the per-person history and the moved history tables need. */
export async function readAccountHistorySnapshot(
	sourceProfileId: number,
): Promise<AccountHistorySnapshot> {
	return withAccountDb(sourceProfileId, async (source) => {
		const messageRows = await source.select<
			(PortableTableRow & {
				conversation_id: string;
				sender_id: number | string;
				type: string;
				timestamp: number;
				body_json: string | null;
			})[]
		>("SELECT * FROM messages");
		const loggedRows = await source.select<
			{ profile_id: string | number; event_type: string; timestamp: number; reason_label: string | null }[]
		>("SELECT profile_id, event_type, timestamp, reason_label FROM stats_block_log");
		const nameRows = await source.select<{ profile_id: string | number | null; name: string | null }[]>(
			`SELECT other_profile_id AS profile_id, name FROM conversations
			 UNION ALL SELECT profile_id, display_name AS name FROM block_events`,
		);

		const historyRows: AccountHistorySnapshot["historyRows"] = [];
		for (const table of MOVED_HISTORY_TABLES) {
			historyRows.push({
				table,
				rows: await source.select<PortableTableRow[]>(`SELECT * FROM ${table}`),
			});
		}

		const displayNames = new Map<string, string>();
		for (const row of nameRows) {
			const name = row.name?.trim();
			if (row.profile_id != null && name) displayNames.set(String(row.profile_id), name);
		}

		return {
			messageRows,
			messages: messageRows.map((row) => ({
				conversationId: row.conversation_id,
				senderId: String(row.sender_id),
				type: row.type,
				timestamp: Number(row.timestamp) || 0,
				text: messageBodyText(row.body_json),
			})),
			loggedBlocks: loggedRows.map((row) => ({
				profileId: String(row.profile_id),
				blocked: row.event_type === "block",
				timestamp: Number(row.timestamp) || 0,
				reason: row.reason_label,
			})),
			displayNames,
			historyRows,
		};
	});
}

/**
 * Stores the per-person history from one old account, replacing what an
 * earlier move from that same account wrote.
 */
export async function replacePastContacts(
	sourceProfileId: string,
	contacts: readonly PastContact[],
): Promise<void> {
	const db = await getDb();
	const now = Date.now();
	const columns = requirePortableTable("past_contacts").columns;
	const rows = contacts.map((contact) => [
		contact.profileId,
		contact.sourceProfileId,
		contact.displayName,
		contact.theirMessages,
		contact.myMessages,
		contact.firstMessageAt,
		contact.lastMessageAt,
		contact.lastText,
		contact.blockedByMeAt,
		contact.blockReason,
		contact.blockedMeAt,
		contact.messages.length > 0 ? JSON.stringify(contact.messages) : null,
		now,
	]);
	const updates = columns
		.filter((column) => column !== "profile_id")
		.map((column) => `${column} = excluded.${column}`)
		.join(", ");
	await executeWithLockRetry(db, "replace-past-contacts", async () => {
		await db.execute("DELETE FROM past_contacts WHERE source_profile_id = $1", [sourceProfileId]);
		await insertRowsInBatches(
			db,
			"past_contacts",
			columns,
			rows,
			`ON CONFLICT(profile_id) DO UPDATE SET ${updates}`,
		);
	});
}

type PastContactRow = {
	profile_id: string;
	source_profile_id: string;
	display_name: string | null;
	their_messages: number;
	my_messages: number;
	first_message_at: number | null;
	last_message_at: number | null;
	last_text: string | null;
	blocked_by_me_at: number | null;
	block_reason: string | null;
	blocked_me_at: number | null;
	messages_json: string | null;
};

/** Reads stored old messages, dropping anything that isn't one. */
function parsePastMessages(json: string | null): PastMessage[] {
	if (!json) return [];
	try {
		const parsed = JSON.parse(json) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(item): item is PastMessage =>
				Boolean(item) &&
				typeof item === "object" &&
				typeof (item as PastMessage).at === "number" &&
				typeof (item as PastMessage).mine === "boolean" &&
				typeof (item as PastMessage).text === "string",
		);
	} catch {
		return [];
	}
}

export async function getAllPastContacts(): Promise<PastContact[]> {
	const db = await getDb();
	const rows = await db.select<PastContactRow[]>(
		`SELECT profile_id, source_profile_id, display_name, their_messages, my_messages,
			first_message_at, last_message_at, last_text, blocked_by_me_at, block_reason, blocked_me_at,
			messages_json
		 FROM past_contacts`,
	);
	return rows.map((row) => ({
		profileId: row.profile_id,
		sourceProfileId: row.source_profile_id,
		displayName: row.display_name,
		theirMessages: Number(row.their_messages) || 0,
		myMessages: Number(row.my_messages) || 0,
		firstMessageAt: row.first_message_at,
		lastMessageAt: row.last_message_at,
		lastText: row.last_text,
		blockedByMeAt: row.blocked_by_me_at,
		blockReason: row.block_reason,
		blockedMeAt: row.blocked_me_at,
		messages: parsePastMessages(row.messages_json),
	}));
}

/**
 * Adds history rows from another account, leaving any row this account
 * already has alone. Only known columns are written.
 */
export async function insertMovedHistoryRows(
	name: MovedHistoryTable,
	rows: readonly PortableTableRow[],
): Promise<void> {
	if (rows.length === 0) return;
	const table = requirePortableTable(name);
	const db = await getDb();
	const values = rows
		.filter((row) => row[table.primaryKey] != null)
		.map((row) => table.columns.map((column) => row[column] ?? null));
	await executeWithLockRetry(db, `move-${table.name}`, async () => {
		await insertRowsInBatches(
			db,
			table.name,
			table.columns,
			values,
			`ON CONFLICT(${table.primaryKey}) DO NOTHING`,
		);
	});
}

/** True once a move from this account has already been done into the active one. */
export async function hasMovedFromAccount(sourceProfileId: string): Promise<boolean> {
	const db = await getDb();
	const rows = await db.select<{ found: number }[]>(
		"SELECT 1 AS found FROM past_contacts WHERE source_profile_id = $1 LIMIT 1",
		[sourceProfileId],
	);
	return rows.length > 0;
}

/**
 * Stores an old account's messages for Stats, already re-homed by
 * `rehomeMessageRow`, replacing an earlier copy from that account.
 */
export async function replacePastMessages(
	sourceProfileId: string,
	rows: readonly PortableTableRow[],
): Promise<void> {
	const table = requirePortableTable("past_messages");
	const db = await getDb();
	const values = rows.map((row) =>
		table.columns.map((column) =>
			column === "source_profile_id" ? sourceProfileId : (row[column] ?? null),
		),
	);
	await executeWithLockRetry(db, "replace-past-messages", async () => {
		await db.execute("DELETE FROM past_messages WHERE source_profile_id = $1", [sourceProfileId]);
		await insertRowsInBatches(
			db,
			table.name,
			table.columns,
			values,
			"ON CONFLICT(message_id) DO NOTHING",
		);
	});
}

/** Stores an old account's viewer rows for Stats, one JSON row per viewer. */
export async function replacePastViews(
	sourceProfileId: string,
	rows: readonly { profileId: string }[],
): Promise<void> {
	const table = requirePortableTable("past_views");
	const db = await getDb();
	const now = Date.now();
	const values = rows
		.filter((row) => typeof row?.profileId === "string" && row.profileId.length > 0)
		.map((row) => [row.profileId, sourceProfileId, JSON.stringify(row), now]);
	await executeWithLockRetry(db, "replace-past-views", async () => {
		await db.execute("DELETE FROM past_views WHERE source_profile_id = $1", [sourceProfileId]);
		await insertRowsInBatches(
			db,
			table.name,
			table.columns,
			values,
			"ON CONFLICT(profile_id) DO UPDATE SET row_json = excluded.row_json, updated_at = excluded.updated_at",
		);
	});
}

/** Points copied block history at the conversation ids this account uses. */
export async function rehomeBlockEventConversations(
	updates: readonly { id: string; conversationId: string }[],
): Promise<void> {
	if (updates.length === 0) return;
	const db = await getDb();
	await executeWithLockRetry(db, "rehome-block-events", async () => {
		for (const update of updates) {
			await db.execute("UPDATE block_events SET conversation_id = $1 WHERE id = $2", [
				update.conversationId,
				update.id,
			]);
		}
	});
}

/**
 * Many rows per statement: one call per row costs a round trip to the
 * native side each, which is tens of seconds for ten thousand rows. Kept
 * well under SQLite's bound-parameter limit. `table` and `columns` must come
 * from the portable-table registry, never from input.
 */
async function insertRowsInBatches(
	db: Database,
	table: string,
	columns: readonly string[],
	rows: readonly unknown[][],
	conflictClause: string,
): Promise<void> {
	const rowsPerStatement = Math.max(1, Math.floor(900 / columns.length));
	for (let start = 0; start < rows.length; start += rowsPerStatement) {
		const batch = rows.slice(start, start + rowsPerStatement);
		const values: unknown[] = [];
		const tuples = batch.map((row) => {
			const placeholders = row.map((value) => {
				values.push(value);
				return `$${values.length}`;
			});
			return `(${placeholders.join(", ")})`;
		});
		await db.execute(
			`INSERT INTO ${table} (${columns.join(", ")}) VALUES ${tuples.join(", ")} ${conflictClause}`,
			values,
		);
	}
}

/**
 * Writes a snapshot into the active account. Settings replace this account's
 * own values; phrases and locations are added to what it already has.
 */
export async function applyAccountSettingsSnapshot(
	snapshot: AccountSettingsSnapshot,
): Promise<{ settings: number; phrases: number; locations: number }> {
	const db = await getDb();
	const settings = snapshot.settings.filter((row) => isCopyableAccountSetting(row.key));
	const now = Date.now();

	await executeWithLockRetry(db, "copy-account-settings", async () => {
		for (const row of settings) {
			await db.execute(
				`
				INSERT INTO settings (key, value) VALUES ($1, $2)
				ON CONFLICT(key) DO UPDATE SET value = excluded.value
				`,
				[row.key, row.value],
			);
		}
		for (const [index, phrase] of snapshot.phrases.entries()) {
			await db.execute(
				"INSERT INTO saved_phrases (phrase, created_at) VALUES ($1, $2) ON CONFLICT(phrase) DO NOTHING",
				[phrase, now + index],
			);
		}
		for (const [index, location] of snapshot.locations.entries()) {
			await db.execute(
				`
				INSERT INTO saved_locations (id, name, geohash, lat, lon, created_at)
				VALUES ($1, $2, $3, $4, $5, $6)
				ON CONFLICT(id) DO NOTHING
				`,
				[location.id, location.name, location.geohash, location.lat, location.lon, now + index],
			);
		}
	});

	return {
		settings: settings.length,
		phrases: snapshot.phrases.length,
		locations: snapshot.locations.length,
	};
}

// ---------------------------------------------------------------------------
// One-time migration of legacy global localStorage settings into the
// profile that's active the moment this code first ships — every other
// profile is meant to start with defaults, so this must run exactly once
// across the whole app's lifetime (not once per profile db), guarded by a
// flag outside any per-profile file.
// ---------------------------------------------------------------------------

const LEGACY_SETTINGS_MIGRATED_FLAG = "fg-settings-migrated-to-db";

function readLegacyJson<T>(key: string): T | null {
	const raw = window.localStorage.getItem(key);
	if (!raw) {
		return null;
	}
	try {
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

export async function migrateLegacySettingsIfNeeded(userId: number): Promise<void> {
	if (window.localStorage.getItem(LEGACY_SETTINGS_MIGRATED_FLAG) === "true") {
		return;
	}

	try {
		// Theme/UI preferences (app_preferences) intentionally stay in
		// localStorage — they apply to the whole app, not per profile. The
		// location fields inside that same blob are the exception: they move
		// into this profile's settings so whichever account is active right
		// now (typically the one the user had open before this migration)
		// keeps its current location instead of losing it.
		const legacyAppPreferences = readLegacyJson<{
			geohash?: string | null;
			locationName?: string | null;
			useAutoLocation?: boolean;
		}>("app_preferences");
		if (legacyAppPreferences && (legacyAppPreferences.geohash != null || legacyAppPreferences.useAutoLocation)) {
			await setSetting("locationPreferences", {
				geohash: legacyAppPreferences.geohash ?? null,
				locationName: legacyAppPreferences.locationName ?? null,
				useAutoLocation: legacyAppPreferences.useAutoLocation === true,
			});
		}

		const legacyPhrases = readLegacyJson<unknown>("fg-saved-phrases");
		if (Array.isArray(legacyPhrases)) {
			const phrases = legacyPhrases.filter((p): p is string => typeof p === "string");
			if (phrases.length > 0) {
				await setSavedPhrases(phrases);
			}
		}

		const legacyLocations = readLegacyJson<unknown>("fg-saved-locations");
		if (Array.isArray(legacyLocations)) {
			for (const entry of legacyLocations) {
				if (
					entry &&
					typeof entry === "object" &&
					typeof (entry as Record<string, unknown>).id === "string" &&
					typeof (entry as Record<string, unknown>).name === "string" &&
					typeof (entry as Record<string, unknown>).geohash === "string" &&
					typeof (entry as Record<string, unknown>).lat === "number" &&
					typeof (entry as Record<string, unknown>).lon === "number"
				) {
					await insertSavedLocation(entry as StoredSavedLocation);
				}
			}
		}

		const legacyAutomation = {
			blockOnChat: window.localStorage.getItem("fg-block-chat") === "true",
			blockGrid: window.localStorage.getItem("fg-block-grid") === "true",
			forbiddenWords: window.localStorage.getItem("fg-forbidden-words") ?? "",
			minAge: window.localStorage.getItem("fg-block-min-age") ?? "18",
			maxAge: window.localStorage.getItem("fg-block-max-age") ?? "99",
			refreshEnabled: window.localStorage.getItem("fg-auto-refresh-enabled") === "true",
			refreshInterval: window.localStorage.getItem("fg-auto-refresh-interval") ?? "5",
		};
		const hadLegacyAutomation = [
			"fg-block-chat",
			"fg-block-grid",
			"fg-forbidden-words",
			"fg-block-min-age",
			"fg-block-max-age",
			"fg-auto-refresh-enabled",
			"fg-auto-refresh-interval",
		].some((key) => window.localStorage.getItem(key) != null);
		if (hadLegacyAutomation) {
			await setSetting("automation", legacyAutomation);
		}

		const legacyRecentGifs = readLegacyJson<unknown>("fg-recent-gifs");
		if (Array.isArray(legacyRecentGifs) && legacyRecentGifs.length > 0) {
			await setSetting("recentGifs", legacyRecentGifs);
		}

		const legacyHidePinned = window.localStorage.getItem("chat_hide_pinned");
		if (legacyHidePinned != null) {
			await setSetting("chatHidePinned", legacyHidePinned === "true");
		}

		const legacyAutoDownload = window.localStorage.getItem("fg-auto-download-media");
		if (legacyAutoDownload != null) {
			await setSetting("autoDownloadMedia", legacyAutoDownload === "true");
		}

		const legacyPrivacyKeys = [
			"fg-hide-read-receipts",
			"fg-show-read-receipt-toggle",
			"fg-read-receipts-exceptions",
			"fg-record-profile-views",
		];
		const hadLegacyPrivacy = legacyPrivacyKeys.some((key) => window.localStorage.getItem(key) != null);
		if (hadLegacyPrivacy) {
			await setSetting("privacy", {
				hideReadReceiptsGlobal: window.localStorage.getItem("fg-hide-read-receipts") === "true",
				showReadReceiptToggle: window.localStorage.getItem("fg-show-read-receipt-toggle") !== "false",
				recordProfileViews: window.localStorage.getItem("fg-record-profile-views") !== "false",
				readReceiptsExceptions: readLegacyJson<Record<string, boolean>>("fg-read-receipts-exceptions") ?? {},
			});
		}

		const legacyBrowseFilters = readLegacyJson<Record<string, unknown>>("open-grind:browse-filters");
		if (legacyBrowseFilters) {
			await setSetting("browseFilters", legacyBrowseFilters);
		}

		const legacySeenKeys: Record<string, string> = {
			interest: "fg-interest-last-seen",
			interestViews: "fg-interest-views-last-seen",
			interestTaps: "fg-interest-taps-last-seen",
			inbox: "fg-inbox-last-seen",
			rightNow: "fg-rightnow-last-seen",
		};
		const hadLegacySeen = Object.values(legacySeenKeys).some((key) => window.localStorage.getItem(key) != null);
		if (hadLegacySeen) {
			const seenTimestamps: Record<string, number> = {};
			for (const [field, key] of Object.entries(legacySeenKeys)) {
				const raw = window.localStorage.getItem(key);
				const value = raw ? Number(raw) : 0;
				seenTimestamps[field] = Number.isFinite(value) ? value : 0;
			}
			await setSetting("seenTimestamps", seenTimestamps);
		}

		appLog.info("[chat-db] migrated legacy localStorage settings into profile db", { userId });
	} catch (error) {
		appLog.error("[chat-db] legacy settings migration failed", error);
	} finally {
		window.localStorage.setItem(LEGACY_SETTINGS_MIGRATED_FLAG, "true");
	}
}

/**
 * What people wrote to this account, and the names they had: what the keyword
 * advice measures a keyword against. Text only, newest 20,000 messages, and
 * it includes the old account's moved messages and viewers, which is most of
 * what a young account has to go on.
 *
 * `viewerNames` are the old account's saved viewers, by profile id, so the
 * caller can add the current account's without counting anyone twice.
 */
export async function getKeywordAdviceTexts(
	ownProfileId: number | null,
): Promise<{ people: string[][]; names: string[]; viewerNames: Record<string, string> }> {
	const db = await getDb();
	const own = new Set<number>([0]);
	if (ownProfileId != null && Number.isFinite(ownProfileId)) own.add(ownProfileId);
	const sources = await db
		.select<{ source_profile_id: string }[]>("SELECT DISTINCT source_profile_id FROM past_contacts")
		.catch(() => []);
	for (const row of sources) {
		const id = Number(row.source_profile_id);
		if (Number.isFinite(id)) own.add(id);
	}

	const bySender = new Map<number, { at: number; text: string }[]>();
	for (const table of ["messages", "past_messages"]) {
		const rows = await db
			.select<{ sender_id: number; timestamp: number; body_json: string | null }[]>(
				`SELECT sender_id, timestamp, body_json FROM ${table}
				 WHERE type = 'Text' AND body_json IS NOT NULL
				 ORDER BY timestamp DESC LIMIT 20000`,
			)
			.catch(() => []);
		for (const row of rows) {
			if (own.has(Number(row.sender_id))) continue;
			let text = "";
			try {
				const body = JSON.parse(row.body_json ?? "{}") as { text?: unknown };
				text = typeof body.text === "string" ? body.text.trim() : "";
			} catch {
				// One unreadable body is one message less to measure against.
			}
			if (!text) continue;
			const texts = bySender.get(Number(row.sender_id)) ?? [];
			texts.push({ at: row.timestamp, text });
			bySender.set(Number(row.sender_id), texts);
		}
	}

	const nameRows = [
		...(await db
			.select<{ name: string | null }[]>("SELECT name FROM conversations WHERE name IS NOT NULL")
			.catch(() => [])),
		...(await db
			.select<{ name: string | null }[]>(
				"SELECT display_name AS name FROM past_contacts WHERE display_name IS NOT NULL",
			)
			.catch(() => [])),
	];

	const viewerNames: Record<string, string> = {};
	const viewerRows = await db
		.select<{ profile_id: string; row_json: string }[]>("SELECT profile_id, row_json FROM past_views")
		.catch(() => []);
	for (const row of viewerRows) {
		try {
			const name = (JSON.parse(row.row_json) as { displayName?: unknown }).displayName;
			if (typeof name === "string" && name.trim()) viewerNames[row.profile_id] = name.trim();
		} catch {
			// One unreadable row is one name less to measure against.
		}
	}

	return {
		people: [...bySender.values()].map((texts) =>
			texts.sort((a, b) => a.at - b.at).map((message) => message.text),
		),
		names: nameRows.map((row) => (row.name ?? "").trim()).filter(Boolean),
		viewerNames,
	};
}
