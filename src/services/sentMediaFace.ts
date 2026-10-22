/**
 * sentMediaFace.ts — what something somebody sent says about their face.
 *
 * Backs the faceless rules' "only a photo that shows their face saves them".
 * A photo or video gets the detector's verdict, and so does a shared album,
 * from its items. Anything that cannot be judged — an album not fully
 * checked, a photo that would not download, a detector error — is "unknown",
 * and "unknown" counts in their favour: nobody is blocked for something this
 * could not look at.
 */

import type { Message } from "../types/messages";
import { getMediaCaptureTarget, getMessageAlbumId } from "../pages/app/chat/chatUtils";
import { albumFaceFor } from "./albumContentCheck";
import { faceVerdict, type SentMediaFace } from "../utils/explicitContentRules";
import * as chatDb from "./chatDb";
import { checkMediaBytes, getCachedCheckForMessage, scoresOf } from "./contentCheck";
import { fetchAndStoreMedia } from "./mediaStore";
import { limitChatDbBlobRead } from "../utils/chatDbBlobLimiter";

/** Whether a message is a photo, video or album at all, going by its type. */
function mediaKindOf(message: Message): "photo_or_video" | "album" | null {
	const type = message.type?.toLowerCase() ?? "";
	const chat1Type = message.chat1Type?.toLowerCase() ?? "";
	if (type.includes("album")) return "album";
	if (
		type === "image" ||
		type === "expiringimage" ||
		type === "video" ||
		type === "nonexpiringvideo" ||
		type === "privatevideo" ||
		chat1Type === "image" ||
		chat1Type === "expiring_image" ||
		chat1Type === "video" ||
		chat1Type === "private_video" ||
		chat1Type === "expiring_video"
	) {
		return "photo_or_video";
	}
	return null;
}

/**
 * The face verdict for one received message, or null when the message is not
 * media. Downloads and checks the photo if that has not happened yet.
 */
export async function sentMediaFaceFor(message: Message, conversationId: string): Promise<SentMediaFace | null> {
	const kind = mediaKindOf(message);
	if (kind == null) return null;
	if (kind === "album") {
		// Its items, as far as they were downloaded and checked. An album
		// that was not, or not fully, cannot be judged.
		const albumId = getMessageAlbumId(message);
		return albumId == null ? "unknown" : albumFaceFor(albumId);
	}

	try {
		let check = getCachedCheckForMessage(message.messageId);
		if (!check) {
			check =
				(await chatDb.getContentChecksForMessages([message.messageId]).catch(() => []))[0] ?? null;
		}

		const target = getMediaCaptureTarget(message);
		if (!check && target && target.kind !== "audio") {
			// Stores the photo; with the explicit filter on it is checked on the way.
			await fetchAndStoreMedia({
				mediaKey: target.mediaKey,
				kind: target.kind,
				url: target.url,
				conversationId,
				messageId: message.messageId,
				viewOnce: target.viewOnce,
				isOwnMessage: false,
				cacheInMemory: false,
				sender: { senderId: message.senderId, timestamp: message.timestamp },
			});
			check = getCachedCheckForMessage(message.messageId);
		}

		if (!check) {
			const stored = await limitChatDbBlobRead(() =>
				target ? chatDb.getMediaFile(target.mediaKey) : chatDb.getMediaFileByMessageId(message.messageId),
			);
			if (stored?.fetchStatus === "ok" && stored.dataBase64 && stored.kind !== "audio") {
				check = await checkMediaBytes({
					mediaKey: stored.mediaKey,
					messageId: message.messageId,
					conversationId,
					kind: stored.kind,
					base64: stored.dataBase64,
					mimeType: stored.mimeType,
					sender: { senderId: message.senderId, timestamp: message.timestamp },
				});
			}
		}

		return check ? faceVerdict(scoresOf(check)) : "unknown";
	} catch {
		return "unknown";
	}
}
