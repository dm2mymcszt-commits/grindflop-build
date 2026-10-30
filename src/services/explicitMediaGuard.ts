/**
 * explicitMediaGuard.ts — blocks whoever sent an explicit photo.
 *
 * contentCheck.ts establishes what a photo shows; this decides what happens
 * to its sender. There are two ways in:
 *
 * - A message arriving live. ChatRealtimeBridge waits for the verdict before
 *   it notifies or counts the message as unread, and blocks through its own
 *   path. It claims the message here first, so the handler below leaves it
 *   alone.
 * - Everything else — a thread being opened, the inbox scanner catching up on
 *   what arrived while the app was closed. Those only download the photo;
 *   the verdict reaches the handler below, which blocks.
 *
 * The rule from every earlier auto-block misfire applies: a block needs real
 * evidence about this person. Here that is a verdict on a photo they sent,
 * a sender and a time that are actually known, and a chat that is not
 * already archived. Anything missing means no block; the photo simply stays
 * covered.
 */

import type { AlbumDetailsResponse } from "../types/chat-service";
import type { Message, MessagesResponse } from "../types/messages";
import type { StoredContentCheck } from "../types/chat-db";
import { notifyAutoBlock } from "../utils/autoblock";
import {
	decideExplicitBlock,
	isConversationParticipant,
	describeExplicitScores,
	EXPLICIT_ALBUM_REASON,
	explicitBlockReason,
	explicitNotice,
	type ExplicitBlockDecision,
} from "../utils/explicitContentRules";
import { appLog } from "../utils/logger";
import { checkAndAutoWhitelistActiveChat, isProfileAutoblockWhitelisted } from "../utils/privacy";
import { getMediaCaptureTarget, getMessageAlbumId } from "../pages/app/chat/chatUtils";
import { worstAlbumCheck } from "./albumContentCheck";
import { captureAlbumsForMessagesNow } from "./albumStore";
import { isAutoBlockInFlight, preserveAndAutoBlockProfile } from "./autoBlockConversation";
import * as chatDb from "./chatDb";
import {
	getCachedCheckForMessage,
	getExplicitFilterSince,
	isExplicitBlockEnabled,
	isExplicitFilterEnabled,
	scoresOf,
	setExplicitVerdictHandler,
	verdictOf,
	type ExplicitVerdictEvent,
} from "./contentCheck";
import { logDetectorDecision } from "./detectorLog";
import { fetchAndStoreMedia } from "./mediaStore";
import type { StatsBlockReason } from "./statsLog";

/** The reason for a block over this check: an album item says so, the rest go by photo or video. */
export function explicitReasonFor(check: StoredContentCheck): string {
	return check.mediaKey.startsWith("album:") ? EXPLICIT_ALBUM_REASON : explicitBlockReason(check.kind);
}

/** What the Stats log records for an explicit-photo block. */
export function explicitStatsReason(check: StoredContentCheck, label?: string): StatsBlockReason {
	return {
		kind: "explicit_media",
		label: label ?? explicitReasonFor(check),
		detail: describeExplicitScores(scoresOf(check)),
	};
}

// ---------------------------------------------------------------------------
// Live messages
// ---------------------------------------------------------------------------

/**
 * How long a live message waits for its photo to be downloaded and checked
 * before it is let through covered. The check carries on, and a late explicit
 * verdict still blocks through the handler below.
 */
const LIVE_CHECK_TIMEOUT_MS = 25_000;

const liveClaims = new Set<string>();

/** Lets the handler take over a message the live path has finished with. */
export function releaseLiveMessage(messageId: string): void {
	liveClaims.delete(messageId);
}

/**
 * Downloads and checks the photo or video in a message that just arrived.
 * Returns the check, or null when the message has no photo, the filter is
 * off, or nothing could be established in time.
 *
 * A message this returns a check for stays claimed: the caller decides what
 * to do about it and calls releaseLiveMessage when it is done.
 */
export async function checkLiveMessageMedia(
	message: Message,
	getAlbum: (albumId: number) => Promise<AlbumDetailsResponse>,
): Promise<StoredContentCheck | null> {
	if (!isExplicitFilterEnabled()) return null;
	const target = getMediaCaptureTarget(message);
	// An album is several photos behind one message: all of them are
	// downloaded and checked, and the worst one speaks for the message.
	const albumId =
		message.type === "Album" || message.type === "ExpiringAlbum" || message.type === "ExpiringAlbumV2"
			? getMessageAlbumId(message)
			: null;
	if (albumId == null && (!target || target.kind === "audio")) return null;

	liveClaims.add(message.messageId);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const download: Promise<unknown> =
		albumId != null
			? captureAlbumsForMessagesNow([message], message.conversationId, getAlbum)
			: fetchAndStoreMedia({
					mediaKey: target!.mediaKey,
					kind: target!.kind,
					url: target!.url,
					conversationId: message.conversationId,
					messageId: message.messageId,
					viewOnce: target!.viewOnce,
					isOwnMessage: false,
					sender: { senderId: message.senderId, timestamp: message.timestamp },
				});
	const finished = await Promise.race([
		download.then(() => true),
		new Promise<false>((resolve) => {
			timer = setTimeout(() => resolve(false), LIVE_CHECK_TIMEOUT_MS);
		}),
	]);
	if (timer) clearTimeout(timer);

	const check = !finished
		? null
		: albumId != null
			? await worstAlbumCheck(albumId)
			: getCachedCheckForMessage(message.messageId);
	if (!check) {
		// Nothing to act on yet. Released, so a verdict that lands later is
		// handled below instead of being dropped.
		liveClaims.delete(message.messageId);
		logDetectorDecision({
			profileId: String(message.senderId),
			name: "",
			outcome: "left_alone",
			detail: finished
				? "A photo they sent could not be checked. It stays covered and they were not blocked."
				: "A photo they sent took too long to check. It stays covered and they were not blocked.",
		});
	}
	return check;
}

/**
 * The live path's half of the decision: whether this check blocks the person
 * who sent the message. The whitelist answer is the caller's, which has
 * already worked it out for its other rules.
 */
export function decideLiveExplicitBlock(
	message: Message,
	check: StoredContentCheck | null,
	userId: number | null,
	whitelisted: boolean,
	blockingEnabled: boolean = isExplicitBlockEnabled(),
): ExplicitBlockDecision {
	return decideExplicitBlock({
		blockingEnabled,
		verdict: verdictOf(check),
		senderId: message.senderId,
		userId,
		messageTimestamp: message.timestamp,
		filterEnabledAt: getExplicitFilterSince(),
		whitelisted,
		conversationArchived: false,
	});
}

// ---------------------------------------------------------------------------
// Everything else
// ---------------------------------------------------------------------------

export type ExplicitMediaGuardApi = {
	listMessages: (params: { conversationId: string }) => Promise<MessagesResponse>;
	getAlbum: (albumId: number) => Promise<AlbumDetailsResponse>;
	blockProfile: (profileId: string) => Promise<unknown>;
};

// Each message is acted on once, whatever keeps re-reporting its verdict
// (every render of a thread asks again).
const handledMessages = new Set<string>();

async function handleExplicitVerdict(
	event: ExplicitVerdictEvent,
	api: ExplicitMediaGuardApi,
	userId: number,
): Promise<void> {
	const { check, messageId, conversationId } = event;
	if (liveClaims.has(messageId) || handledMessages.has(messageId)) return;
	if (!isExplicitBlockEnabled()) return;
	// The capture before a block downloads the chat's photos, which is how an
	// explicit one can surface in a chat that is already being blocked.
	if (isAutoBlockInFlight(conversationId)) return;

	let stored: Awaited<ReturnType<typeof chatDb.getConversation>>;
	let sender = event.sender;
	try {
		stored = await chatDb.getConversation(conversationId);
		sender ??= await chatDb.getMessageSenderAndTime(messageId);
	} catch (error) {
		// Not knowing is not a reason to block; the next report tries again.
		appLog.warn(`[explicit-guard] could not read ${conversationId}; leaving it`, error);
		return;
	}

	const profileId = sender ? String(sender.senderId) : null;
	const displayName = stored?.entry.data.name?.trim() || "";
	const whitelisted =
		profileId != null &&
		(isProfileAutoblockWhitelisted(profileId) ||
			(await checkAndAutoWhitelistActiveChat(profileId, conversationId, displayName || undefined, undefined, userId)));

	const decision = decideExplicitBlock({
		blockingEnabled: true,
		verdict: verdictOf(check),
		senderId: sender?.senderId,
		userId,
		messageTimestamp: sender?.timestamp,
		filterEnabledAt: getExplicitFilterSince(),
		whitelisted,
		conversationArchived: stored != null && (stored.archived || stored.blockState != null),
		// A photo that came with a chat merged into this one was sent from
		// another profile; it says nothing about the person this chat is with.
		senderInConversation:
			profileId != null ? isConversationParticipant(conversationId, profileId) : null,
	});
	if (!decision.block || profileId == null) {
		if (!decision.block && decision.why !== "unknown_sender") {
			// Settled for this message. An unknown sender may become known once
			// the message is stored, so that one is asked again.
			handledMessages.add(messageId);
		}
		appLog.debug(
			`[explicit-guard] not blocking for message ${messageId}: ${decision.block ? "no sender" : decision.why}`,
		);
		return;
	}

	handledMessages.add(messageId);
	const reason = explicitReasonFor(check);
	appLog.info(
		`[explicit-guard] blocking ${profileId} for an explicit ${check.kind} (${describeExplicitScores(scoresOf(check)) ?? "no detail"})`,
	);
	try {
		await preserveAndAutoBlockProfile({
			profileId,
			userId,
			displayName,
			listMessages: (id) => api.listMessages({ conversationId: id }),
			getAlbum: (albumId) => api.getAlbum(albumId),
			blockProfile: () => api.blockProfile(profileId),
			// Nothing reports this verdict again on a schedule, so a deferred
			// block might never be retried.
			mayDeferOnIncompleteCapture: false,
			stats: { source: "inbox_scan", reason: explicitStatsReason(check) },
		});
		const notice = explicitNotice(reason, scoresOf(check));
		void notifyAutoBlock(displayName || profileId, notice);
		logDetectorDecision({ profileId, name: displayName, outcome: "blocked", detail: notice });
		window.dispatchEvent(new Event("fg-refresh-inbox"));
	} catch (error) {
		// Let a later report of the same verdict try again.
		handledMessages.delete(messageId);
		appLog.warn(`[explicit-guard] blocking ${profileId} failed`, error);
	}
}

/**
 * Starts acting on explicit verdicts with this account's API. Returns a
 * function that stops it (sign-out, account switch).
 */
export function startExplicitMediaGuard(api: ExplicitMediaGuardApi, userId: number): () => void {
	const handler = (event: ExplicitVerdictEvent) => {
		void handleExplicitVerdict(event, api, userId);
	};
	setExplicitVerdictHandler(handler);
	return () => {
		setExplicitVerdictHandler(null);
		handledMessages.clear();
		liveClaims.clear();
	};
}
