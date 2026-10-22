/**
 * Persists the last server-visible state of a conversation before an
 * automatic block removes it from the inbox and message APIs.
 *
 * Background auto-blockers must use this instead of calling blockProfile
 * directly. A foreground chat usually already exists in chatDb, but a chat
 * discovered while another screen is open may only exist in the live inbox.
 * Blocking first permanently loses the only copy of its metadata/history.
 */

import type { UiMessage } from "../types/chat-page";
import type { AlbumDetailsResponse } from "../types/chat-service";
import type { ConversationEntry, Message, MessagesResponse } from "../types/messages";
import { mergeConversationForPreserve } from "../utils/conversationMerge";
import { appLog } from "../utils/logger";
import { markSelfBlockAction } from "../utils/selfBlockActions";
import { ApiFunctionError } from "./apiHelpers";
import { captureConversationAlbumsForArchival } from "./albumStore";
import { getChatContactIndexForProfiles } from "./chatContactIndex";
import * as chatDb from "./chatDb";
import { captureMessageMediaForArchival } from "./mediaStore";
import {
	announceSelfBlock,
	applySelfBlockAction,
	markConversationDeleteHandled,
} from "./conversationArchive";
import {
	logAutoBlock,
	type StatsAutoBlockContext,
	type StatsBlockReason,
} from "./statsLog";

type PreserveAndAutoBlockOptions = {
	conversation: ConversationEntry;
	profileId: string;
	displayName?: string | null;
	/**
	 * The signed-in user's own profile id, used only to tell their outgoing
	 * attachments from received ones so the pre-block capture doesn't mirror
	 * the user's own photos into the device's Downloads folder.
	 */
	userId?: number | null;
	messageSnapshot?: MessagesResponse;
	/**
	 * Messages the caller already holds that the snapshot may not carry yet —
	 * in practice the realtime message that triggered the block, which the
	 * message API can still be a beat behind on. Persisted and album-scanned
	 * alongside the snapshot; deduped by messageId, so passing one that is
	 * also in the snapshot is harmless.
	 */
	additionalMessages?: Message[];
	fetchMessages: () => Promise<MessagesResponse>;
	getAlbum: (albumId: number) => Promise<AlbumDetailsResponse>;
	blockProfile: () => Promise<unknown>;
	/**
	 * Whether this caller will actually get another chance if the block is
	 * deferred because the conversation could not be fully preserved. True
	 * (the default) for the scanners and inbox filters that re-evaluate every
	 * pass — and even they only defer MAX_PRESERVE_ATTEMPTS times. Must be
	 * false for automation rules: those mark a sender seen *before* running
	 * their actions, so a deferral there means the rule never fires again and
	 * the profile is silently never blocked — strictly worse than blocking
	 * with a partial capture.
	 */
	mayDeferOnIncompleteCapture?: boolean;
	/**
	 * Where the block came from and why, for the Stats block log. Null when
	 * this repeats a block already on record (restoreDroppedBlock): there is no
	 * new block to log, and a second row would pass itself off as the reason.
	 */
	stats?: StatsAutoBlockContext | null;
};

// The shared inbox service and BackgroundInboxScanner can notice the same
// match during one polling cycle. Reuse the first operation so they cannot
// race two block requests or insert duplicate system messages.
const inFlightBlocks = new Map<string, Promise<void>>();

/**
 * Whether a block of this conversation is already under way. The capture
 * step downloads the conversation's photos, which can turn up a reason of
 * its own (an explicit one); whoever notices that asks here first instead of
 * starting a second block for a different reason.
 */
export function isAutoBlockInFlight(conversationId: string): boolean {
	return inFlightBlocks.has(conversationId);
}

/**
 * Thrown when content shared in the conversation could not be secured
 * locally *and* the server hasn't declared it gone — i.e. a retry could
 * still succeed. Every caller treats a rejection as "leave this
 * conversation in the inbox and try again on the next pass", which is
 * exactly what we want: blocking now would destroy the only remaining
 * copy of that content.
 */
export class ContentCaptureIncompleteError extends Error {
	readonly albumIds: number[];
	readonly messageIds: string[];
	/** Albums with not a single byte stored locally — the ones a block actually loses. */
	readonly albumsWithoutAnyLocalCopy: number[];

	constructor(albumIds: number[], messageIds: string[], albumsWithoutAnyLocalCopy: number[] = []) {
		const parts = [
			albumIds.length > 0 ? `album(s) ${albumIds.join(", ")}` : null,
			messageIds.length > 0 ? `message(s) ${messageIds.join(", ")}` : null,
		].filter(Boolean);
		super(`Content capture incomplete for ${parts.join(" and ")} — deferring block`);
		this.name = "ContentCaptureIncompleteError";
		this.albumIds = albumIds;
		this.messageIds = messageIds;
		this.albumsWithoutAnyLocalCopy = albumsWithoutAnyLocalCopy;
	}
}

// A conversation whose history never becomes fully preservable (a permanently
// odd album item, a CDN that keeps failing, a chatDb write that keeps losing a
// lock race to a running sync) must not wedge the auto-blocker forever. After
// this many deferrals we block anyway, keeping whatever was captured — the
// teaser cover and any bytes that did come down.
//
// This counts the *whole* preserve step, not just the content capture. A
// failure in the earlier steps (fetching the thread, writing it to chatDb)
// used to defer with no cap at all, which is how a profile that plainly
// matched a forbidden keyword could sit in the inbox indefinitely: every pass
// re-matched it, re-tried the preserve, threw in the same place, and left it
// exactly where it was, with nothing logged to say so.
const MAX_PRESERVE_ATTEMPTS = 3;
const preserveAttempts = new Map<string, number>();

/**
 * Downloads and stores everything in this conversation that the block is
 * about to revoke access to — album shares (metadata, teaser cover, content
 * bytes) and every image/video/audio attachment — before the block request
 * goes out.
 *
 * Scans the union of the live messages and everything already in chatDb for
 * the conversation: content can easily have arrived during an earlier scan
 * (and been persisted then) while sitting outside the page of messages the
 * snapshot returns now, and this is the last moment it can ever be fetched.
 */
async function captureContentBeforeBlock(
	conversationId: string,
	messages: Message[],
	userId: number | null,
	getAlbum: (albumId: number) => Promise<AlbumDetailsResponse>,
): Promise<void> {
	const byMessageId = new Map<string, UiMessage>();
	for (const message of await chatDb.getMessages(conversationId).catch(() => [])) {
		byMessageId.set(message.messageId, message);
	}
	// Live messages last — their bodies carry the freshest signed media/cover
	// URLs, which is what the capture actually downloads from.
	for (const message of messages) {
		byMessageId.set(message.messageId, message);
	}
	const allMessages = [...byMessageId.values()];

	const [albumResults, mediaResults] = await Promise.all([
		captureConversationAlbumsForArchival(allMessages, conversationId, getAlbum),
		captureMessageMediaForArchival(allMessages, conversationId, userId),
	]);

	// "unavailable" means the server already refuses to serve it (403/404, or
	// a signed URL that has demonstrably expired) — no later retry can do
	// better, so it must not hold the block back.
	const retryableAlbums = albumResults.filter((r) => !r.complete && !r.unavailable);
	const retryableMedia = mediaResults.filter((r) => !r.captured && !r.unavailable);
	if (retryableAlbums.length === 0 && retryableMedia.length === 0) {
		return;
	}

	throw new ContentCaptureIncompleteError(
		retryableAlbums.map((r) => r.albumId),
		retryableMedia.map((r) => r.messageId),
		retryableAlbums.filter((r) => !r.hasLocalContent).map((r) => r.albumId),
	);
}

export function preserveAndAutoBlockConversation(
	options: PreserveAndAutoBlockOptions,
): Promise<void> {
	const conversationId = options.conversation.data.conversationId;
	const existing = inFlightBlocks.get(conversationId);
	if (existing) {
		return existing;
	}

	const operation = (async () => {
		const mayDefer = options.mayDeferOnIncompleteCapture ?? true;
		const attempt = (preserveAttempts.get(conversationId) ?? 0) + 1;

		try {
			// Persist the inbox metadata before the extra message request. If
			// that request fails, the block is deliberately not attempted and
			// the next scan can retry while the server conversation is still
			// available. Merged with the stored row, because an entry built
			// from a realtime message carries no photo and often no name, and
			// after the block neither can be fetched again.
			const stored = await chatDb.getConversation(conversationId).catch(() => null);
			const conversation = mergeConversationForPreserve(
				options.conversation,
				stored?.entry,
				options.displayName,
			);
			await chatDb.upsertConversation(conversation, options.profileId);

			const snapshot = options.messageSnapshot ?? (await options.fetchMessages());
			// The realtime message that triggered the block can still be missing
			// from the snapshot — the block path runs before the bridge's own
			// persistence, so it has to be folded in here or it is lost outright.
			const liveMessages = [...snapshot.messages, ...(options.additionalMessages ?? [])];
			if (liveMessages.length > 0) {
				await chatDb.upsertMessages(conversationId, liveMessages);
			}
			if (snapshot.lastReadTimestamp !== undefined) {
				await chatDb.setLastReadTimestamp(
					conversationId,
					snapshot.lastReadTimestamp ?? null,
				);
			}
			await chatDb.markConversationMessagesSynced(
				conversationId,
				conversation.data.lastActivityTimestamp ?? null,
			);

			// Album and attachment bytes live behind signed URLs the block
			// revokes along with the conversation, and nothing else in the
			// background path fetches them — an open ChatPage is what normally
			// triggers the capture. Await it here, before the block, or the
			// archived thread keeps bubbles whose content is gone for good.
			await captureContentBeforeBlock(
				conversationId,
				liveMessages,
				options.userId ?? null,
				options.getAlbum,
			);
		} catch (error) {
			// A caller that gets another pass takes one — but only a bounded
			// number of them. Past that the match has been sitting unenforced
			// for several cycles and blocking with a partial capture is the
			// lesser loss; the profile matched the user's rules either way.
			if (mayDefer && attempt < MAX_PRESERVE_ATTEMPTS) {
				preserveAttempts.set(conversationId, attempt);
				appLog.warn(
					`[auto-block] could not fully preserve ${conversationId} (attempt ${attempt}/${MAX_PRESERVE_ATTEMPTS}) — deferring the block to the next pass`,
					error,
				);
				throw error;
			}
			appLog.warn(
				`[auto-block] preserving ${conversationId} still failing${mayDefer ? ` after ${attempt} attempts` : " and this caller cannot retry"} — blocking anyway, keeping whatever was captured`,
				error,
			);
		}
		preserveAttempts.delete(conversationId);

		// Mark before the request leaves, matching the manual-block mutation's
		// ordering. The websocket delete echo can otherwise win the race and be
		// misattributed as "they blocked you".
		markSelfBlockAction(conversationId, "block");
		markConversationDeleteHandled(conversationId);
		await options.blockProfile();
		if (options.stats !== null) {
			logAutoBlock(options.profileId, options.stats);
		}
		try {
			await applySelfBlockAction(options.profileId, "block");
		} finally {
			// After the archive step, not before: the blocked-list cache changing
			// re-runs reconcileBlockStateWithBlockedList, which would otherwise
			// race applySelfBlockAction for the same block_state transition.
			announceSelfBlock(options.profileId);
		}
	})();

	inFlightBlocks.set(conversationId, operation);
	const clearInFlight = () => {
		if (inFlightBlocks.get(conversationId) === operation) {
			inFlightBlocks.delete(conversationId);
		}
	};
	void operation.then(clearInFlight, clearInFlight);
	return operation;
}

/**
 * Grindr's conversation ids for a one-to-one chat are the two profile ids
 * joined by ":" in ascending numeric order. Deriving it lets a block that
 * starts from a profile id alone (an automation rule fired by a tap or a
 * view, where no conversation was ever in our inbox) still address the real
 * server conversation instead of inventing a `direct:<profileId>` stand-in.
 */
function buildDirectConversationId(
	userId: number | string,
	profileId: number | string,
): string | null {
	const a = Number(userId);
	const b = Number(profileId);
	if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) {
		return null;
	}
	return a < b ? `${a}:${b}` : `${b}:${a}`;
}

type PreserveAndAutoBlockProfileOptions = {
	profileId: string;
	userId?: number | null;
	displayName?: string | null;
	listMessages: (conversationId: string) => Promise<MessagesResponse>;
	getAlbum: (albumId: number) => Promise<AlbumDetailsResponse>;
	blockProfile: () => Promise<unknown>;
	mayDeferOnIncompleteCapture?: boolean;
	/**
	 * Whether a profile that turns out to have no conversation at all may still
	 * leave a local `direct:<profileId>` archived shell behind. Off unless
	 * asked for — see ApplySelfBlockActionOptions.
	 */
	materializeMissingConversation?: boolean;
	stats?: StatsAutoBlockContext;
};

/**
 * Blocks a profile we only know by id — the automation-rule triggers that
 * fire on a tap or a view, where there may be no conversation in the inbox
 * (or in chatDb) at all.
 *
 * Resolves the real server conversation first (stored row → local contact
 * index → derived id, confirmed by actually fetching its messages) and hands
 * off to preserveAndAutoBlockConversation so the history, albums and media
 * are captured exactly as they are for every other auto-block path. Only
 * when the server confirms there is no conversation does it block outright —
 * at that point there is genuinely nothing to lose.
 */
export async function preserveAndAutoBlockProfile(
	options: PreserveAndAutoBlockProfileOptions,
): Promise<void> {
	const profileId = String(options.profileId);
	const resolved = await resolveConversationForProfile(profileId, options);

	if (!resolved) {
		// No conversation exists for this profile, so there is no history,
		// album or attachment that blocking could destroy.
		await options.blockProfile();
		logAutoBlock(profileId, options.stats);
		try {
			await applySelfBlockAction(profileId, "block", {
				materializeMissingConversation: options.materializeMissingConversation,
			});
		} finally {
			announceSelfBlock(profileId);
		}
		return;
	}

	await preserveAndAutoBlockConversation({
		conversation: resolved.conversation,
		profileId,
		displayName: options.displayName,
		userId: options.userId,
		messageSnapshot: resolved.snapshot,
		fetchMessages: () => options.listMessages(resolved.conversation.data.conversationId),
		getAlbum: options.getAlbum,
		blockProfile: options.blockProfile,
		mayDeferOnIncompleteCapture: options.mayDeferOnIncompleteCapture,
		stats: options.stats,
	});
}

/**
 * Whether a failed message fetch actually proves there is no conversation to
 * preserve. Only the server's own "this isn't there / you can't have it"
 * answers count: everything else (5xx, 429, a dropped connection) is a
 * transport failure that tells us nothing about the conversation.
 */
function isConversationAbsentError(error: unknown): boolean {
	if (!(error instanceof ApiFunctionError)) {
		return false;
	}
	return error.status === 403 || error.status === 404 || error.status === 410;
}

async function resolveConversationForProfile(
	profileId: string,
	options: PreserveAndAutoBlockProfileOptions,
): Promise<{ conversation: ConversationEntry; snapshot: MessagesResponse } | null> {
	// `observed` marks an id we have actually seen belong to a conversation —
	// a stored row, or the local contact index. A *derived* id is only a guess
	// at what the server would call this pair, and the server answers for any
	// valid pair whether or not the two have ever spoken (see below).
	const candidates: { conversationId: string; observed: boolean }[] = [];
	const addCandidate = (id: string | null | undefined, observed: boolean) => {
		if (
			id
			&& !id.startsWith("direct:")
			&& !candidates.some((candidate) => candidate.conversationId === id)
		) {
			candidates.push({ conversationId: id, observed });
		}
	};

	const stored = await chatDb.findConversationByProfileId(profileId).catch(() => null);
	addCandidate(stored?.conversationId, true);

	if (candidates.length === 0) {
		const [indexed] = await getChatContactIndexForProfiles([profileId]).catch(() => []);
		addCandidate(indexed?.conversationId, true);
	}

	if (options.userId != null) {
		addCandidate(buildDirectConversationId(options.userId, profileId), false);
	}

	for (const { conversationId, observed } of candidates) {
		// The fetch is the confirmation: a conversation id we derived (or
		// remembered from an index that can outlive the conversation) is only
		// worth preserving under if the server still answers for it.
		let snapshot: MessagesResponse;
		try {
			snapshot = await options.listMessages(conversationId);
		} catch (error) {
			if (isConversationAbsentError(error)) {
				continue;
			}
			// A 5xx, a rate limit or a dropped connection says nothing about
			// whether this conversation exists. Reading it as "nothing here"
			// would block the profile and destroy exactly the history this
			// path exists to capture, so a caller that gets another pass takes
			// one instead. One-shot triggers can't (see
			// mayDeferOnIncompleteCapture) — for them, blocking with whatever
			// is already local still beats never blocking at all.
			if (options.mayDeferOnIncompleteCapture !== false) {
				throw error;
			}
			appLog.warn(
				`[auto-block] could not confirm conversation ${conversationId} for ${profileId}, and this caller cannot retry — continuing`,
				error,
			);
			continue;
		}

		// A 200 with an empty thread is NOT confirmation for an id we derived
		// ourselves: the server answers for any valid pair of profile ids,
		// including two people who have never exchanged a word. Accepting it
		// is what turned "block someone who viewed your profile" into a
		// fabricated archived chat — a conversation row, named after them,
		// carrying nothing but a "You blocked this person" marker. There is
		// also nothing to preserve in an empty thread, so falling through to
		// the plain block loses no history.
		if (!observed && snapshot.messages.length === 0) {
			appLog.debug(
				`[auto-block] derived conversation ${conversationId} for ${profileId} came back empty — treating as no conversation`,
			);
			continue;
		}

		return {
			conversation:
				stored?.conversationId === conversationId
					? stored.entry
					: buildMinimalConversationEntry(
							conversationId,
							profileId,
							options.displayName,
							snapshot,
						),
			snapshot,
		};
	}

	return null;
}

function buildMinimalConversationEntry(
	conversationId: string,
	profileId: string,
	displayName: string | null | undefined,
	snapshot: MessagesResponse,
): ConversationEntry {
	const lastMessage = snapshot.messages[snapshot.messages.length - 1];
	return {
		type: "Conversation",
		data: {
			conversationId,
			name: displayName?.trim() ?? "",
			participants: [{ profileId: Number(profileId) }],
			lastActivityTimestamp: lastMessage?.timestamp ?? Date.now(),
			unreadCount: 0,
			muted: false,
			pinned: false,
			favorite: false,
			preview: lastMessage
				? {
						conversationId: { value: conversationId },
						messageId: lastMessage.messageId,
						senderId: lastMessage.senderId,
						type: lastMessage.type,
						chat1Type: lastMessage.chat1Type,
						text:
							typeof (lastMessage.body as Record<string, unknown> | null)?.text === "string"
								? ((lastMessage.body as Record<string, unknown>).text as string)
								: null,
					}
				: null,
		},
	};
}

/**
 * Wraps an api-functions object so its `blockProfile` preserves the
 * conversation first. Automation rules take the whole object as their
 * runner, and every background trigger that can block through one — a new
 * chat, an incoming message, a tap, a view — must go through the preserving
 * path, not the raw endpoint. The rule that fired arrives as `reason`.
 */
export function withPreservingBlock<
	T extends {
		listMessages: (params: { conversationId: string }) => Promise<MessagesResponse>;
		getAlbum: (albumId: number) => Promise<AlbumDetailsResponse>;
		blockProfile: (profileId: string) => Promise<unknown>;
	},
>(api: T, userId: number | null): T {
	return {
		...api,
		blockProfile: (profileId: string, reason?: StatsBlockReason) =>
			preserveAndAutoBlockProfile({
				stats: { source: "automation", reason },
				profileId,
				userId,
				listMessages: (conversationId) => api.listMessages({ conversationId }),
				getAlbum: (albumId) => api.getAlbum(albumId),
				blockProfile: () => api.blockProfile(profileId),
				// One-shot triggers can't retry — see mayDeferOnIncompleteCapture.
				mayDeferOnIncompleteCapture: false,
				// A rule that fires on a tap or a view blocks someone there may
				// be no chat with at all, exactly like the Interest sweep — so it
				// must not leave an archived chat behind for one that never
				// existed either. A real conversation still resolves above and is
				// preserved and archived as before; only the empty shell is gone.
				materializeMissingConversation: false,
			}),
	};
}
