/**
 * albumContentCheck.ts — the explicit-photo filter, for shared albums.
 *
 * An album is somebody sending photos like any other, just several at once
 * and behind a tap. Each item is checked by the same detector and remembered
 * the same way (content_checks, under "album:<albumId>:<contentId>"), tied to
 * the message that shared the album so an explicit item can block its sender
 * through the usual guard.
 *
 * Same rule as everywhere else: an item is only shown once a check says
 * clear. An item with no check — never downloaded, a video too large to
 * open, a detector error — counts as not cleared, and an album with any such
 * item keeps its cover hidden.
 *
 * This module knows nothing about how albums are downloaded; albumStore calls
 * in with the bytes it has.
 */

import type { StoredContentCheck } from "../types/chat-db";
import type { AlbumContentItem } from "../types/chat-page";
import { HIDDEN_MEDIA_MIME, HIDDEN_MEDIA_PLACEHOLDER } from "../utils/hiddenMediaPlaceholder";
import {
	albumCoverFor,
	albumFaceVerdict,
	coverForVerdict,
	faceVerdict,
	type ContentCover,
	type ContentVerdict,
	type SentMediaFace,
} from "../utils/explicitContentRules";
import { limitChatDbBlobRead } from "../utils/chatDbBlobLimiter";
import { appLog } from "../utils/logger";
import { sniffMediaMime } from "../utils/mediaMime";
import * as chatDb from "./chatDb";
import {
	checkMediaBytes,
	getCachedCheckForMediaKey,
	isExplicitFilterEnabled,
	isExplicitGalleryHidingEnabled,
	loadContentCheck,
	notifyContentChecksChanged,
	scoresOf,
	verdictOf,
	type MediaSender,
} from "./contentCheck";

/** Longest stored preview, in base64 characters, read back to check an item after the fact. */
const PREVIEW_MAX_CHARS = 2 * 1024 * 1024;

/** `compositeId` is album_media's own key, "<albumId>:<contentId>". */
function keyForComposite(compositeId: string): string {
	return `album:${compositeId}`;
}

export function albumItemKey(albumId: number, contentId: number): string {
	return keyForComposite(`${albumId}:${contentId}`);
}

/** Whether an album belongs to the signed-in account. Unknown owners count as someone else's. */
export function isOwnAlbumOwner(ownerProfileId: string | null | undefined): boolean {
	const self = chatDb.getActiveChatDbUser();
	return ownerProfileId != null && self != null && String(ownerProfileId) === String(self);
}

// What covers each album as a whole, once worked out. Absent means not
// looked at yet, which the getters below treat as covered.
const albumCovers = new Map<number, ContentCover | null>();
const ownAlbums = new Set<number>();

/** What covers this album's cover picture right now, or null to show it. */
export function getAlbumCover(albumId: number): ContentCover | null {
	if (ownAlbums.has(albumId) || !isExplicitGalleryHidingEnabled()) return null;
	return albumCovers.has(albumId) ? (albumCovers.get(albumId) ?? null) : "unchecked";
}

/** What covers one item of an album right now, or null to show it. */
export function getAlbumItemCover(albumId: number, contentId: number): ContentCover | null {
	if (ownAlbums.has(albumId) || !isExplicitGalleryHidingEnabled()) return null;
	return coverForVerdict(verdictOf(getCachedCheckForMediaKey(albumItemKey(albumId, contentId))));
}

/**
 * A received album with every item the filter has not cleared swapped for
 * the hidden tile, in place, and a count of them. Nothing is left out: an
 * album of five with all five hidden still has five items, which is what it
 * should say. Shown as it is with the filter off, for the account's own
 * album, or once the user asked to see it anyway (`showAll`).
 */
export function coverAlbumContent(
	albumId: number,
	content: readonly AlbumContentItem[],
	showAll: boolean,
): { content: AlbumContentItem[]; hiddenCount: number } {
	if (showAll || !isExplicitGalleryHidingEnabled()) return { content: [...content], hiddenCount: 0 };
	let hiddenCount = 0;
	const covered = content.map((item) => {
		if (getAlbumItemCover(albumId, item.contentId) == null) return item;
		hiddenCount += 1;
		return {
			...item,
			// A picture now, whatever it was: nothing may try to play it.
			contentType: HIDDEN_MEDIA_MIME,
			url: HIDDEN_MEDIA_PLACEHOLDER,
			thumbUrl: HIDDEN_MEDIA_PLACEHOLDER,
			coverUrl: HIDDEN_MEDIA_PLACEHOLDER,
			hidden: true,
		};
	});
	return { content: covered, hiddenCount };
}

export type AlbumItemBytes = { base64: string; mimeType: string | null };

/**
 * Checks one album item from bytes the caller holds. A still picture of the
 * item is preferred (its preview, or the item itself when it is a photo); a
 * video with no picture is read frame by frame. Returns null when nothing
 * could be established.
 */
export async function checkAlbumItem(input: {
	albumId: number;
	contentId: number;
	contentType: string | null;
	main: AlbumItemBytes | null;
	preview: AlbumItemBytes | null;
	messageId: string | null;
	conversationId: string | null;
	sender?: MediaSender | null;
}): Promise<StoredContentCheck | null> {
	const isVideo = (bytes: AlbumItemBytes | null) =>
		/^video\//i.test((bytes ? sniffMediaMime(bytes.base64) : null) ?? bytes?.mimeType ?? input.contentType ?? "");
	const picture = [input.preview, input.main].find((bytes) => bytes != null && !isVideo(bytes)) ?? null;
	const source = picture ?? input.main ?? input.preview;
	if (!source) return null;

	return checkMediaBytes({
		mediaKey: albumItemKey(input.albumId, input.contentId),
		messageId: input.messageId,
		conversationId: input.conversationId,
		kind: picture ? "image" : "video",
		base64: source.base64,
		mimeType: source.mimeType,
		sender: input.sender,
	});
}

const refreshInFlight = new Map<number, Promise<void>>();

/**
 * Works out what covers an album from the checks on its items, and checks,
 * from the previews already stored, any item that has none yet (an album
 * saved before the filter was switched on). Safe to call often.
 */
export function refreshAlbumChecks(albumId: number): Promise<void> {
	const running = refreshInFlight.get(albumId);
	if (running) return running;

	const run = (async () => {
		try {
			const album = await limitChatDbBlobRead(() => chatDb.getAlbum(String(albumId)));
			if (isOwnAlbumOwner(album?.ownerProfileId)) {
				ownAlbums.add(albumId);
				notifyContentChecksChanged();
				return;
			}
			ownAlbums.delete(albumId);

			const summaries = await chatDb.getAlbumMediaSummaries(String(albumId));
			const verdicts: (ContentVerdict | null)[] = [];
			for (const summary of summaries) {
				const key = keyForComposite(summary.contentId);
				let check = await loadContentCheck(key);
				if (!check && isExplicitFilterEnabled()) {
					const preview = await limitChatDbBlobRead(() =>
						chatDb.getAlbumMediaThumb(summary.contentId, PREVIEW_MAX_CHARS),
					);
					const mimeType = preview ? (sniffMediaMime(preview.thumbBase64) ?? preview.contentType) : null;
					// Only a stored picture: a video kept without one is too heavy
					// to pull back out of the database just to look at.
					if (preview && !/^(video|audio)\//i.test(mimeType ?? "")) {
						check = await checkMediaBytes({
							mediaKey: key,
							messageId: album?.sharedViaMessageId ?? null,
							conversationId: album?.conversationId ?? null,
							kind: "image",
							base64: preview.thumbBase64,
							mimeType,
						});
					}
				}
				verdicts.push(verdictOf(check));
			}
			albumCovers.set(albumId, albumCoverFor(verdicts));
			notifyContentChecksChanged();
		} catch (error) {
			appLog.warn(`[album-check] could not work out album ${albumId}`, error);
		} finally {
			refreshInFlight.delete(albumId);
		}
	})();
	refreshInFlight.set(albumId, run);
	return run;
}

async function checksForAlbum(albumId: number): Promise<(StoredContentCheck | null)[]> {
	const summaries = await chatDb.getAlbumMediaSummaries(String(albumId));
	return Promise.all(summaries.map((summary) => loadContentCheck(keyForComposite(summary.contentId))));
}

/**
 * The check with the strongest explicit finding among an album's items, or
 * null when not one of them has been checked.
 */
export async function worstAlbumCheck(albumId: number): Promise<StoredContentCheck | null> {
	const checks: (StoredContentCheck | null)[] = await checksForAlbum(albumId).catch(() => []);
	let worst: StoredContentCheck | null = null;
	for (const check of checks) {
		if (check && (worst == null || check.explicitScore > worst.explicitScore)) worst = check;
	}
	return worst;
}

/** What an album somebody shared says about their face, for the faceless rules. */
export async function albumFaceFor(albumId: number): Promise<SentMediaFace> {
	const checks = await checksForAlbum(albumId).catch(() => null);
	if (!checks) return "unknown";
	return albumFaceVerdict(checks.map((check) => (check ? faceVerdict(scoresOf(check)) : null)));
}
