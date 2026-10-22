import type { ConversationEntry, Message } from "./messages";

export type ArchivedReason = "not_found" | "ws_delete";

// Explicit, durable record of who blocked whom for this conversation — the
// source of truth for archiving/system-message decisions instead of
// inferring direction from toggling `archived` on an ambiguous
// chat.v1.conversation.delete event (see conversationArchive.ts).
export type BlockState = "blocked_by_me" | "blocked_by_other";

export type StoredConversation = {
	conversationId: string;
	otherProfileId: string | null;
	entry: ConversationEntry;
	archived: boolean;
	archivedReason: ArchivedReason | null;
	archivedAt: number | null;
	// Manual, local-only "hide from inbox" flag — unlike `archived`, a hidden
	// conversation still round-trips through /v4/inbox normally; this only
	// gates the client-side filteredConversations view.
	hidden: boolean;
	blockState: BlockState | null;
	lastSeenInInboxAt: number | null;
	// The conversation's lastActivityTimestamp as of the last time its messages
	// were successfully fetched — not just when the conversation row itself
	// was upserted. Lets inboxSync tell "metadata is current" apart from
	// "messages are current", so an interrupted first sync resumes by
	// re-fetching only conversations whose messages never actually landed,
	// instead of restarting the whole message fetch from scratch.
	messagesSyncedActivityTimestamp: number | null;
	createdAt: number;
	updatedAt: number;
};

/**
 * What the on-device detector found in one received photo or video. Scores
 * run from 0 to 1; the verdict is read from them (utils/explicitContentRules).
 */
export type StoredContentCheck = {
	mediaKey: string;
	messageId: string | null;
	conversationId: string | null;
	kind: "image" | "video";
	explicitLabel: string | null;
	explicitScore: number;
	coverOnlyScore: number;
	faceScore: number;
	/** Share of the photo the strongest face takes up; null on checks made before it was kept. */
	faceShare: number | null;
	model: string;
	checkedAt: number;
};

export type StoredMessage = Message & {
	localHistory: boolean;
};

// A durable, standalone record of a block/unblock initiated by the *other*
// side — kept separate from the messages table (rather than derived from
// SystemBlocked/SystemUnblocked messages on read) so the profile's name and
// avatar are captured at the moment it happens and survive even if the
// conversation itself later becomes unresolvable (e.g. the other profile is
// deleted/banned, or the conversation ages out of the live inbox entirely).
export type BlockEventType = "blocked" | "unblocked";

export type StoredBlockEvent = {
	id: string;
	profileId: string | null;
	conversationId: string;
	eventType: BlockEventType;
	timestamp: number;
	displayName: string | null;
	avatarMediaHash: string | null;
	createdAt: number;
};

export type MediaKind = "image" | "video" | "audio";
export type MediaFetchStatus = "pending" | "ok" | "failed";

export type MediaFileUpsertInput = {
	mediaKey: string;
	conversationId: string | null;
	messageId: string | null;
	kind: MediaKind;
	mimeType: string | null;
	dataBase64: string;
	viewOnce: boolean;
	sizeBytes: number | null;
	fetchStatus: MediaFetchStatus;
};

export type StoredMediaFile = {
	mediaKey: string;
	conversationId: string | null;
	messageId: string | null;
	kind: MediaKind;
	mimeType: string | null;
	dataBase64: string;
	viewOnce: boolean;
	sizeBytes: number | null;
	fetchStatus: MediaFetchStatus;
	fetchedAt: number;
};

export type AlbumUpsertInput = {
	albumId: string;
	ownerProfileId: string | null;
	albumName: string | null;
	conversationId: string | null;
	sharedViaMessageId: string | null;
};

export type StoredAlbum = {
	albumId: string;
	ownerProfileId: string | null;
	albumName: string | null;
	conversationId: string | null;
	sharedViaMessageId: string | null;
	previewCoverBase64: string | null;
	previewCoverMimeType: string | null;
	createdAt: number;
	updatedAt: number;
};

export type AlbumMediaUpsertInput = {
	contentId: string;
	albumId: string;
	contentType: string | null;
	dataBase64: string | null;
	thumbDataBase64: string | null;
	remainingViews: number | null;
	isViewable: boolean | null;
};

export type StoredAlbumMedia = {
	contentId: string;
	albumId: string;
	contentType: string | null;
	dataBase64: string | null;
	thumbDataBase64: string | null;
	remainingViews: number | null;
	isViewable: boolean | null;
	fetchedAt: number | null;
};

/** An album item without its bytes: whether they are saved, and its metadata. */
export type StoredAlbumMediaSummary = {
	contentId: string;
	albumId: string;
	contentType: string | null;
	hasData: boolean;
	remainingViews: number | null;
	isViewable: boolean | null;
};

export type StoredAvatar = {
	mediaHash: string;
	dataBase64: string;
	mimeType: string | null;
	fetchedAt: number;
};

export type DownloadedMediaPlatform = "ios" | "android" | "desktop";

/**
 * One entry per file this app has saved to the device (Photos album asset
 * id on iOS, MediaStore content URI on Android, relative path on desktop) —
 * the manifest used to report total storage used and to delete precisely
 * what we saved, nothing else. Device-local bookkeeping only — never part
 * of the portable chat-data export/import.
 */
export type DownloadedMediaEntry = {
	identifier: string;
	platform: DownloadedMediaPlatform;
	albumId: string | null;
	byteSize: number;
	mimeType: string | null;
	kind: "image" | "video" | null;
	savedAt: number;
};

export type FullDbExport = {
	version: 1;
	exportedAt: number;
	ownerUserId: number;
	tables: {
		conversations: Record<string, unknown>[];
		conversation_meta: Record<string, unknown>[];
		messages: Record<string, unknown>[];
		media_files: Record<string, unknown>[];
		albums: Record<string, unknown>[];
		album_media: Record<string, unknown>[];
		avatars: Record<string, unknown>[];
		settings: Record<string, unknown>[];
		saved_phrases: Record<string, unknown>[];
		saved_locations: Record<string, unknown>[];
		// Absent from files written by older builds; the importer skips any
		// table key it doesn't find, so those still import cleanly.
		block_events: Record<string, unknown>[];
		// Stats logs — also absent from older files, skipped the same way.
		stats_block_log: Record<string, unknown>[];
		stats_location_log: Record<string, unknown>[];
		stats_coverage_log: Record<string, unknown>[];
		stats_profile_edit_log: Record<string, unknown>[];
		stats_profile_open_log: Record<string, unknown>[];
		stats_view_distance_log: Record<string, unknown>[];
		past_contacts: Record<string, unknown>[];
		past_messages: Record<string, unknown>[];
		past_views: Record<string, unknown>[];
	};
};
