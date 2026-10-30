/**
 * albumStore.ts — eager fetch-and-store of received albums into chatDb.
 *
 * As soon as an Album/ExpiringAlbum/ExpiringAlbumV2 message is seen, the
 * full album + every content item's bytes are downloaded and stored, so the
 * content survives the share expiring or its view-once limit being
 * exhausted server-side. Per-share viewability (remainingViews/isViewable)
 * is read from the sharing chat message's body by the caller — the album
 * API response itself doesn't carry that field, and a given album can be
 * re-shared multiple times with different expiry.
 */

import * as chatDb from "./chatDb";
import { fetchAndEncode, HEAVY_DOWNLOAD_CONCURRENCY, toDataUri } from "./mediaStore";
import { BoundedStringCache, cacheBudget } from "../utils/boundedCache";
import { mapWithConcurrency } from "../utils/concurrency";
import {
	getAlbumContentReplyTarget,
	getMessageAlbumCoverUrl,
	getMessageAlbumId,
} from "../pages/app/chat/chatUtils";
import { ApiFunctionError } from "./apiHelpers";
import type { UiMessage } from "../types/chat-page";
import type { AlbumContentItem } from "../types/chat-page";
import type { AlbumDetailsResponse } from "../types/chat-service";
import type { StoredAlbumMediaSummary } from "../types/chat-db";
import { appLog } from "../utils/logger";
import { isAutoDownloadMediaEnabled } from "../utils/mediaSettings";
import { limitChatDbBlobRead } from "../utils/chatDbBlobLimiter";
import { isPictureUrl, sniffMediaMime } from "../utils/mediaMime";
import { checkAlbumItem, isOwnAlbumOwner, refreshAlbumChecks } from "./albumContentCheck";
import { isExplicitFilterEnabled, verdictOf, type MediaSender } from "./contentCheck";

/**
 * Mirrors newly-downloaded album content into the device's Downloads
 * folder, if the user has opted in. Dynamically imported to avoid a
 * circular dependency — saveMedia.ts imports toDataUri from mediaStore.ts,
 * which this module also depends on.
 */
async function maybeAutoDownloadToDevice(
	base64: string,
	mimeType: string | null,
	contentType: string | null,
	conversationId: string | null,
): Promise<void> {
	if (!isAutoDownloadMediaEnabled()) {
		return;
	}
	const isVideo = (contentType ?? mimeType ?? "").toLowerCase().startsWith("video/");
	try {
		const { saveMediaBytesToDeviceSilent } = await import("./saveMedia");
		await saveMediaBytesToDeviceSilent(base64, mimeType ?? contentType, isVideo ? "video" : "image", conversationId);
	} catch (error) {
		appLog.warn("[album-store] auto-download to device failed", error);
	}
}

// Once a background refresh attempt confirms the server doesn't have this
// album/share anymore (404 once truly gone, 403 once the share is stopped —
// observed in practice as the actual response for a revoked share), stop
// re-requesting it for that *same* share message on every subsequent
// message pass this session — just keep serving whatever's cached. If the
// album gets shared again later, that arrives as a new chat message (new
// messageId, same albumId) — attemptedMessageIds below lets that one
// through for a fresh retry instead of being stuck skipped forever.
const knownGoneAlbumIds = new Set<number>();
const attemptedMessageIds = new Set<string>();
const GONE_STATUS_CODES = new Set([403, 404]);

// De-dupes concurrent refresh attempts for the same album — multiple
// message-arrival passes can land for the same share back to back, and
// without this each one fires its own request before the first one's
// catch block has a chance to populate knownGoneAlbumIds above.
const captureInFlight = new Map<number, Promise<AlbumCaptureResult>>();

// Synchronous in-memory record of which albums are fully captured locally,
// so render code (which can't await a DB read) can show a cached album as
// open-able regardless of what the live message body currently says about
// its viewability/expiry. Populated as captures resolve (this session) and
// via an explicit hydration check the first time a given album is rendered.
const capturedAlbumIds = new Set<number>();
const albumCacheListeners = new Set<() => void>();
const albumCheckInFlight = new Map<number, Promise<void>>();
// Albums already checked against chatDb this session.
const checkedAlbumIds = new Set<number>();
// The message bubble's cover image also comes straight from the live body
// (coverUrl/previewUrl) — once a share is stopped/exhausted/expired the
// server can drop that field entirely, which would otherwise make the
// cover disappear even though we have the actual image cached. Same
// in-memory pattern as mediaStore.ts's per-key cache.
const albumCoverCache = new BoundedStringCache<number>("Album covers", cacheBudget(8, 32));

// Per-content-item thumbnail cache, keyed the same way as album_media's PK
// (`${albumId}:${contentId}`) — backs reply-quote thumbnails and "tapped
// photo" reaction bubbles for a *specific* item inside an album, as opposed
// to albumCoverCache above which only ever tracks item 0. Populated both by
// a full album capture (refreshAlbumCacheState) and, when that never
// happened, by captureAlbumContentThumbFromMessage below.
const albumContentThumbCache = new BoundedStringCache<string>("Album thumbnails", cacheBudget(16, 64));
// De-dupes concurrent captureAlbumContentThumbFromMessage calls for the same
// item. Holds the in-flight promise (rather than just the key) so an awaiting
// caller — e.g. the pre-block capture in autoBlockConversation — can join a
// capture another scanner already started instead of re-downloading it.
const contentThumbCaptureInFlight = new Map<string, Promise<void>>();

function albumContentKey(albumId: number, contentId: number): string {
	return `${albumId}:${contentId}`;
}

/** Synchronous read of a single album content item's cached thumbnail, or null if not cached (yet). */
export function getCachedAlbumContentThumbUri(albumId: number, contentId: number): string | null {
	return albumContentThumbCache.get(albumContentKey(albumId, contentId)) ?? null;
}

/** Longest preview, in base64 characters, loaded into memory for an album item. */
const CACHED_THUMB_MAX_CHARS = 512 * 1024;

/**
 * A saved preview as something an <img> can show, or null when the bytes are
 * a video. Previews are stored under the album item's type, so a video's JPEG
 * preview is labelled video/mp4, and without a separate preview the video
 * itself was kept as one.
 */
function previewDataUri(contentType: string | null, base64: string): string | null {
	const mimeType = sniffMediaMime(base64) ?? contentType;
	if (/^(video|audio)\//i.test(mimeType ?? "")) return null;
	return toDataUri(mimeType, base64);
}

// Items whose only saved preview is the video itself, and items whose preview
// link turned out to be a video too: nothing to look up again.
const noPictureThumbKeys = new Set<string>();
const noPicturePreviewUrlKeys = new Set<string>();

/**
 * Rebuilds this album's in-memory state from chatDb: whether it is fully
 * captured, its fallback cover, and small previews of its items.
 *
 * Reads the items' bytes only where a preview is small. It used to load every
 * file of the album in full just to find these out — for an album of videos,
 * gigabytes at a time, on every chat render and before every block.
 *
 * The album's own (clear) content thumbnail is only a *fallback* cover —
 * captureAlbumPreviewFromMessage's blurred chat-bubble teaser is the
 * preferred source and must never be overwritten by this clear one.
 */
async function refreshAlbumCacheState(albumId: number): Promise<StoredAlbumMediaSummary[]> {
	const summaries = await chatDb.getAlbumMediaSummaries(String(albumId));
	if (summaries.length === 0) {
		return summaries;
	}

	const thumbs = await limitChatDbBlobRead(() =>
		chatDb.getAlbumMediaThumbs(String(albumId), CACHED_THUMB_MAX_CHARS),
	);
	if (!albumCoverCache.has(albumId)) {
		// The first item's preview, or the first real picture when that is a video.
		const first = thumbs.find((thumb) => thumb.contentId === summaries[0].contentId);
		const cover = [first, ...thumbs]
			.map((thumb) => (thumb ? previewDataUri(thumb.contentType, thumb.thumbBase64) : null))
			.find((uri): uri is string => uri !== null);
		if (cover) {
			albumCoverCache.set(albumId, cover);
		}
	}
	for (const thumb of thumbs) {
		const uri = previewDataUri(thumb.contentType, thumb.thumbBase64);
		if (uri) albumContentThumbCache.set(thumb.contentId, uri);
		else noPictureThumbKeys.add(thumb.contentId);
	}

	if (summaries.every((item) => item.hasData)) {
		capturedAlbumIds.add(albumId);
	}

	// Always notify, even if nothing visibly changed — an extra render is cheap,
	// whereas a missed notification leaves a bubble showing stale state.
	for (const listener of albumCacheListeners) {
		listener();
	}
	// What the explicit-photo filter makes of this album follows the same
	// stored state, including items saved before the filter was switched on.
	if (isExplicitFilterEnabled()) {
		void refreshAlbumChecks(albumId);
	}
	return summaries;
}

/** Synchronous read: is this album fully captured locally right now? */
export function isAlbumCachedLocally(albumId: number): boolean {
	return capturedAlbumIds.has(albumId);
}

/**
 * Synchronous read: did a live API refresh for this album return 403/404
 * this session, meaning the share is revoked/gone server-side?
 * Used to immediately show a "no longer shared" badge in chat without
 * waiting for the next thread-messages poll to update isViewable.
 */
export function isAlbumKnownRevoked(albumId: number): boolean {
	return knownGoneAlbumIds.has(albumId);
}

/** Synchronous read of the cached cover image, or null if not cached (yet). */
export function getCachedAlbumCoverUri(albumId: number): string | null {
	return albumCoverCache.get(albumId) ?? null;
}

/** Subscribe to in-memory album-cache updates; returns an unsubscribe function. */
export function subscribeToAlbumCache(listener: () => void): () => void {
	albumCacheListeners.add(listener);
	return () => {
		albumCacheListeners.delete(listener);
	};
}

/**
 * Clears every local trace of an album — chatDb rows plus every in-memory
 * cache keyed by albumId — used when the user explicitly deletes a received
 * album from the shared-albums page. Safe to call regardless of whether the
 * share is still live server-side; the caller is responsible for revoking
 * that separately (removeAlbumShare) before/alongside calling this.
 */
export async function deleteLocalAlbum(albumId: number): Promise<void> {
	await chatDb.deleteAlbum(String(albumId)).catch((error) => {
		appLog.warn(`[album-store] failed to delete local album ${albumId}`, error);
	});
	capturedAlbumIds.delete(albumId);
	albumCoverCache.delete(albumId);
	knownGoneAlbumIds.delete(albumId);
	for (const listener of albumCacheListeners) {
		listener();
	}
}

/**
 * Checks chatDb for a previously-captured album once per session (e.g. on
 * first render after an app restart, when the in-memory set above starts
 * empty, or simply re-opening an already-loaded thread before the next
 * capture pass has re-run). Safe to call repeatedly/concurrently — only
 * de-duped while a check is actually in flight, not "once ever", so a check
 * that ran too early (before a capture elsewhere finished) doesn't
 * permanently block re-checking later.
 */
export function ensureAlbumCacheChecked(albumId: number): void {
	// Once a session is enough: a capture that stores more refreshes the state
	// itself, and this is called on every render of every album bubble.
	if (capturedAlbumIds.has(albumId) || albumCheckInFlight.has(albumId) || checkedAlbumIds.has(albumId)) {
		return;
	}
	const run = (async () => {
		try {
			// The blurred chat-bubble preview (preferred cover source) first.
			const album = await limitChatDbBlobRead(() => chatDb.getAlbum(String(albumId)));
			if (album?.previewCoverBase64 && !albumCoverCache.has(albumId)) {
				albumCoverCache.set(
					albumId,
					toDataUri(album.previewCoverMimeType, album.previewCoverBase64),
				);
				for (const listener of albumCacheListeners) {
					listener();
				}
			}

			await refreshAlbumCacheState(albumId);
		} catch (error) {
			appLog.warn(`[album-store] failed to check local cache for album ${albumId}`, error);
		} finally {
			checkedAlbumIds.add(albumId);
			albumCheckInFlight.delete(albumId);
		}
	})();
	albumCheckInFlight.set(albumId, run);
}

/**
 * Captures the chat bubble's blurred teaser preview from the sharing
 * message's own body (coverUrl/previewUrl) — distinct from, and preferred
 * over, the album's actual (clear) content thumbnails. Runs independently
 * of the full album refresh, since this source doesn't need the album API
 * at all and may still be capturable even when that's gated/gone.
 */
async function captureAlbumPreviewFromMessage(
	message: UiMessage,
	albumId: number,
): Promise<boolean> {
	const coverUrl = getMessageAlbumCoverUrl(message);
	if (!coverUrl) {
		return false;
	}
	try {
		const fetched = await fetchAndEncode(coverUrl);
		if (!fetched) {
			return false;
		}
		await chatDb.upsertAlbumPreviewCover(String(albumId), fetched.base64, fetched.mimeType);
		albumCoverCache.set(albumId, toDataUri(fetched.mimeType, fetched.base64));
		for (const listener of albumCacheListeners) {
			listener();
		}
		return true;
	} catch (error) {
		appLog.warn(`[album-store] failed to capture preview cover for album ${albumId}`, error);
		return false;
	}
}

/**
 * Seeds a single album content item's thumbnail from a reply/reaction
 * message's own `previewUrl` — for AlbumContentReply/AlbumContentReaction
 * messages, which reference one specific item inside an album that may
 * never have been captured as a whole (e.g. the sharing message isn't in
 * the loaded history). Without this, that thumbnail is only ever resolved
 * from the live signed preview URL, which the item can outlive.
 *
 * If the item was already captured via a full album share (album_media
 * already has bytes for it), this reuses those instead of re-downloading.
 * Fire-and-forget; safe to call repeatedly for the same item.
 */
export function captureAlbumContentThumbFromMessage(
	albumId: number,
	contentId: number,
	contentType: string | null,
	previewUrl: string | null,
): void {
	void ensureAlbumContentThumbCaptured(albumId, contentId, contentType, previewUrl);
}

/**
 * Awaitable form of captureAlbumContentThumbFromMessage, for callers that
 * must not proceed until the thumbnail is durably stored — the pre-block
 * capture, which loses server access the moment the block lands. Resolves
 * (never rejects) once the item is cached, already cached, or unrecoverable.
 */
export function ensureAlbumContentThumbCaptured(
	albumId: number,
	contentId: number,
	contentType: string | null,
	previewUrl: string | null,
): Promise<void> {
	const key = albumContentKey(albumId, contentId);
	if (albumContentThumbCache.has(key) || noPicturePreviewUrlKeys.has(key) || (noPictureThumbKeys.has(key) && !previewUrl)) {
		return Promise.resolve();
	}
	const inFlight = contentThumbCaptureInFlight.get(key);
	if (inFlight) {
		return inFlight;
	}
	const run = (async () => {
		try {
			const existing = await limitChatDbBlobRead(() =>
				chatDb.getAlbumMediaThumb(key, CACHED_THUMB_MAX_CHARS),
			);
			const existingUri = existing ? previewDataUri(existing.contentType ?? contentType, existing.thumbBase64) : null;
			if (existingUri) {
				albumContentThumbCache.set(key, existingUri);
				for (const listener of albumCacheListeners) listener();
				return;
			}

			if (!previewUrl) {
				if (existing) noPictureThumbKeys.add(key);
				return;
			}
			const fetched = await fetchAndEncode(previewUrl);
			if (!fetched) {
				return;
			}
			await chatDb.setAlbumMediaThumb({
				contentId: key,
				albumId: String(albumId),
				contentType: contentType ?? fetched.mimeType,
				thumbBase64: fetched.base64,
			});
			const fetchedUri = previewDataUri(fetched.mimeType, fetched.base64);
			if (fetchedUri) {
				albumContentThumbCache.set(key, fetchedUri);
				for (const listener of albumCacheListeners) listener();
			} else {
				noPicturePreviewUrlKeys.add(key);
			}
		} catch (error) {
			appLog.warn(`[album-store] failed to capture content thumb ${key}`, error);
		} finally {
			contentThumbCaptureInFlight.delete(key);
		}
	})();
	contentThumbCaptureInFlight.set(key, run);
	return run;
}

export type CaptureAlbumParams = {
	albumId: number;
	albumName: string | null;
	content: AlbumContentItem[];
	ownerProfileId: string | null;
	conversationId: string | null;
	sharedViaMessageId: string | null;
	remainingViews: number | null;
	isViewable: boolean | null;
	/**
	 * Who sent the sharing message and when, for callers that hold it. An
	 * explicit item can only block its sender when both are known, and a
	 * message that just arrived is not in chatDb yet to be looked up.
	 */
	sender?: MediaSender | null;
};

async function captureAlbumContent(
	albumId: number,
	item: AlbumContentItem,
	existing: StoredAlbumMediaSummary | undefined,
	remainingViews: number | null,
	isViewable: boolean | null,
	conversationId: string | null,
	ownerProfileId: string | null,
	sharedViaMessageId: string | null,
	sender: MediaSender | null,
): Promise<void> {
	const compositeId = `${albumId}:${item.contentId}`;
	try {
		if (existing?.hasData) {
			// Bytes already captured — refresh the view state without sending
			// the whole file back to the database.
			await chatDb.updateAlbumMediaViewability(compositeId, remainingViews, isViewable);
			return;
		}

		const mainUrl = item.url || item.coverUrl;
		const thumbUrl = item.thumbUrl ?? null;

		// One after the other: each is held in memory as base64 until stored.
		const main = mainUrl ? await fetchAndEncode(mainUrl) : null;
		const thumb = thumbUrl && thumbUrl !== mainUrl ? await fetchAndEncode(thumbUrl) : null;

		await chatDb.upsertAlbumMedia({
			contentId: compositeId,
			albumId: String(albumId),
			contentType: item.contentType ?? main?.mimeType ?? null,
			dataBase64: main?.base64 ?? null,
			thumbDataBase64: thumb?.base64 ?? main?.base64 ?? null,
			remainingViews,
			isViewable,
		});

		// Checked here, with the bytes in hand, like any other received photo.
		// Awaited, so a caller waiting for the album is waiting for the verdict
		// on its items too. Only an item found clear is copied out to the
		// device's gallery.
		if (isExplicitFilterEnabled() && !isOwnAlbumOwner(ownerProfileId)) {
			const check = await checkAlbumItem({
				albumId,
				contentId: item.contentId,
				contentType: item.contentType ?? null,
				main: main ? { base64: main.base64, mimeType: main.mimeType } : null,
				preview: thumb ? { base64: thumb.base64, mimeType: thumb.mimeType } : null,
				messageId: sharedViaMessageId,
				conversationId,
				sender,
			});
			if (verdictOf(check) !== "clear") {
				return;
			}
		}

		if (main?.base64) {
			void maybeAutoDownloadToDevice(main.base64, main.mimeType, item.contentType, conversationId);
		}
	} catch (error) {
		appLog.warn(`[album-store] failed to capture album content ${compositeId}`, error);
	}
}

/**
 * Eagerly downloads and stores every content item's bytes for an album.
 * Resolves with the album_media rows as they stand afterwards, so callers
 * that need to know whether the capture actually completed (the pre-block
 * capture) can check without a second read.
 */
export async function captureAlbum(
	params: CaptureAlbumParams,
): Promise<StoredAlbumMediaSummary[]> {
	const {
		albumId,
		albumName,
		content,
		ownerProfileId,
		conversationId,
		sharedViaMessageId,
		remainingViews,
		isViewable,
	} = params;
	const sender = params.sender ?? null;

	await chatDb.upsertAlbum({
		albumId: String(albumId),
		ownerProfileId,
		albumName,
		conversationId,
		sharedViaMessageId,
	});

	const existing = await chatDb.getAlbumMediaSummaries(String(albumId));
	const existingById = new Map(existing.map((m) => [m.contentId, m] as const));

	await mapWithConcurrency(content, HEAVY_DOWNLOAD_CONCURRENCY, (item) =>
		captureAlbumContent(
			albumId,
			item,
			existingById.get(`${albumId}:${item.contentId}`),
			remainingViews,
			isViewable,
			conversationId,
			ownerProfileId,
			sharedViaMessageId,
			sender,
		),
	);

	return refreshAlbumCacheState(albumId);
}

export type AlbumMessageInfo = {
	albumId: number;
	remainingViews: number | null;
	isViewable: boolean | null;
};

function getAlbumMessageInfo(message: UiMessage): AlbumMessageInfo | null {
	const isAlbumMessage =
		message.type === "Album" ||
		message.type === "ExpiringAlbum" ||
		message.type === "ExpiringAlbumV2";
	if (!isAlbumMessage) {
		if (typeof message.type === "string" && message.type.toLowerCase().includes("album")) {
			appLog.debug(
				`[album-store] message ${message.messageId} has an album-ish type "${message.type}" not in the recognized set — skipping`,
			);
		}
		return null;
	}

	const albumId = getMessageAlbumId(message);
	if (albumId == null) {
		appLog.debug(
			`[album-store] message ${message.messageId} is type "${message.type}" but has no extractable albumId — body=${JSON.stringify(message.body)}`,
		);
		return null;
	}

	const body = message.body as Record<string, unknown> | null | undefined;
	const isViewable = typeof body?.isViewable === "boolean" ? body.isViewable : null;
	const remainingViews =
		typeof body?.remainingViews === "number" ? body.remainingViews : null;

	return { albumId, remainingViews, isViewable };
}

/**
 * What a capture attempt managed to secure locally. Callers that merely want
 * the cache warmed can ignore this; the pre-block capture uses it to decide
 * whether it is safe to give up server access to the album.
 */
export type AlbumCaptureResult = {
	albumId: number;
	/**
	 * Every content item the server actually exposed a URL for now has its
	 * bytes in album_media. Items the server reports as still `processing`
	 * (no URL of any kind) can't be fetched by anyone and don't count against
	 * this.
	 */
	complete: boolean;
	/**
	 * The server says the album/share is gone (403/404). Nothing further is
	 * retrievable, so retrying later cannot do better than what's cached.
	 */
	unavailable: boolean;
	/** Anything at all is stored locally — media rows and/or the teaser cover. */
	hasLocalContent: boolean;
};

function summarizeCachedAlbum(
	albumId: number,
	media: StoredAlbumMediaSummary[],
	previewCaptured: boolean,
	unavailable: boolean,
): AlbumCaptureResult {
	return {
		albumId,
		complete: media.length > 0 && media.every((m) => m.hasData),
		unavailable,
		hasLocalContent: media.length > 0 || previewCaptured,
	};
}

async function captureAlbumFromMessageIfNeeded(
	info: AlbumMessageInfo,
	message: UiMessage,
	conversationId: string,
	getAlbum: (albumId: number) => Promise<AlbumDetailsResponse>,
): Promise<AlbumCaptureResult> {
	if (knownGoneAlbumIds.has(info.albumId) && attemptedMessageIds.has(message.messageId)) {
		// Already confirmed gone for this exact share message — don't keep
		// re-requesting it on every reload/poll, just keep serving whatever's
		// cached. A *new* share message for the same album (different
		// messageId — i.e. shared with us again later) still falls through
		// below for a fresh retry.
		const cached = await refreshAlbumCacheState(info.albumId).catch(() => []);
		return summarizeCachedAlbum(
			info.albumId,
			cached,
			albumCoverCache.has(info.albumId),
			true,
		);
	}

	const existingRun = captureInFlight.get(info.albumId);
	if (existingRun) {
		// Another scanner (or an open ChatPage) is already downloading this
		// exact album — join that run rather than issuing a second set of
		// requests for the same bytes.
		return existingRun;
	}

	const run = (async (): Promise<AlbumCaptureResult> => {
		attemptedMessageIds.add(message.messageId);

		// The blurred teaser preview comes straight from this message's own
		// body, not the album API — capture it independently of (and before)
		// the full album refresh below, so it's available even if that
		// refresh fails (share gated/gone) and always reflects this latest
		// share's preview rather than a stale one from an older share.
		const previewCaptured = await captureAlbumPreviewFromMessage(message, info.albumId);

		try {
			// Always refresh from the live API first, even if we already have a
			// fully-captured copy — the owner can add more content to an album
			// after it was first shared, and we want to pick that up rather than
			// keep re-using a stale snapshot forever. captureAlbum reuses
			// already-downloaded bytes per content item and only fetches
			// genuinely new ones, so this doesn't re-download anything we
			// already have.
			const details = await getAlbum(info.albumId);
			knownGoneAlbumIds.delete(info.albumId);
			const stored = await captureAlbum({
				albumId: details.albumId,
				albumName: details.albumName,
				content: details.content,
				ownerProfileId: String(message.senderId),
				conversationId,
				sharedViaMessageId: message.messageId,
				remainingViews: info.remainingViews,
				isViewable: info.isViewable,
				sender: { senderId: message.senderId, timestamp: message.timestamp },
			});

			// Per-item downloads inside captureAlbum swallow their own errors so
			// one bad item can't abort the rest — so completeness has to be read
			// back off the stored rows rather than inferred from "didn't throw".
			const storedById = new Map(stored.map((m) => [m.contentId, m] as const));
			const missing = details.content.filter((item) => {
				if (!item.url && !item.coverUrl) {
					return false; // Nothing to fetch — server hasn't published it.
				}
				return !storedById.get(`${info.albumId}:${item.contentId}`)?.hasData;
			});
			if (missing.length > 0) {
				appLog.warn(
					`[album-store] album ${info.albumId} captured incompletely — ${missing.length}/${details.content.length} item(s) missing bytes`,
				);
			}
			return {
				albumId: info.albumId,
				complete: missing.length === 0,
				unavailable: false,
				hasLocalContent: stored.length > 0 || previewCaptured,
			};
		} catch (error) {
			const gone =
				error instanceof ApiFunctionError && GONE_STATUS_CODES.has(error.status);
			if (gone) {
				knownGoneAlbumIds.add(info.albumId);
			}
			// Live refresh failed (offline, share stopped/gone, conversation
			// archived/blocked) — fine as long as we already have a cached copy;
			// only worth logging if we don't have anything at all.
			const existing = await refreshAlbumCacheState(info.albumId).catch(() => []);
			if (existing.length === 0) {
				appLog.warn(
					`[album-store] failed to capture album from message ${message.messageId}`,
					error,
				);
			}
			return summarizeCachedAlbum(info.albumId, existing, previewCaptured, gone);
		} finally {
			captureInFlight.delete(info.albumId);
		}
	})();

	captureInFlight.set(info.albumId, run);
	return run;
}

/**
 * Scans messages for Album/ExpiringAlbum/ExpiringAlbumV2 shares and eagerly
 * captures each one (fire-and-forget). Safe to call repeatedly for the same
 * messages — reuses already-downloaded bytes instead of re-fetching them.
 */
export function captureAlbumsForMessages(
	messages: UiMessage[],
	conversationId: string,
	getAlbum: (albumId: number) => Promise<AlbumDetailsResponse>,
): void {
	void captureAlbumsForMessagesNow(messages, conversationId, getAlbum);
}

/**
 * Awaitable form of captureAlbumsForMessages, for callers that must not
 * proceed until every referenced album is durably stored — specifically the
 * pre-block capture, which permanently loses server access to these albums
 * the moment the block request lands.
 *
 * Resolves (never rejects) with one result per distinct album referenced in
 * the batch; the caller decides what to do about incomplete ones.
 */
export async function captureAlbumsForMessagesNow(
	messages: UiMessage[],
	conversationId: string,
	getAlbum: (albumId: number) => Promise<AlbumDetailsResponse>,
): Promise<AlbumCaptureResult[]> {
	const entries: { info: AlbumMessageInfo; message: UiMessage }[] = [];
	for (const message of messages) {
		const info = getAlbumMessageInfo(message);
		if (info) {
			entries.push({ info, message });
		}
	}

	// Hydrate from chatDb immediately (fast, local-only) for every distinct
	// album referenced in this batch, so every message bubble sharing the
	// same album id shows consistent, already-cached state right away —
	// independent of (and well ahead of) the slower live-refresh capture
	// below, which still runs to pick up newly-added content/confirm gone.
	for (const albumId of new Set(entries.map((e) => e.info.albumId))) {
		ensureAlbumCacheChecked(albumId);
	}

	return mapWithConcurrency(entries, HEAVY_DOWNLOAD_CONCURRENCY, ({ info, message }) =>
		captureAlbumFromMessageIfNeeded(info, message, conversationId, getAlbum),
	);
}

/**
 * Everything album-shaped in a conversation, captured and awaited — album
 * shares (metadata + teaser cover + every accessible content item) plus the
 * per-item thumbnails referenced by AlbumContentReply/AlbumContentReaction
 * messages, which point at items whose own share message may not be in the
 * batch at all.
 *
 * Used by the pre-block capture in autoBlockConversation: once the block
 * request lands the server stops serving all of this, so it has to be on
 * disk first. Resolves (never rejects) with one result per album share.
 */
export async function captureConversationAlbumsForArchival(
	messages: UiMessage[],
	conversationId: string,
	getAlbum: (albumId: number) => Promise<AlbumDetailsResponse>,
): Promise<AlbumCaptureResult[]> {
	const [results] = await Promise.all([
		captureAlbumsForMessagesNow(messages, conversationId, getAlbum),
		Promise.all(
			messages.map((message) => {
				const target = getAlbumContentReplyTarget(message);
				if (!target) {
					return Promise.resolve();
				}
				return ensureAlbumContentThumbCaptured(
					target.albumId,
					target.contentId,
					target.contentType,
					target.previewUrl,
				);
			}),
		),
	]);
	return results;
}

export type LocalAlbumContent = {
	albumId: number;
	albumName: string | null;
	content: AlbumContentItem[];
};

/** Reads a previously-captured album back out as ready-to-render content items, or null if not cached. */
export async function getLocalAlbum(albumId: number): Promise<LocalAlbumContent | null> {
	const media = await chatDb.getAlbumMedia(String(albumId));
	if (media.length === 0) {
		return null;
	}

	const album = await chatDb.getAlbum(String(albumId));
	const content: AlbumContentItem[] = media.map((m) => {
		const separatorIndex = m.contentId.indexOf(":");
		const realContentId = Number(
			separatorIndex >= 0 ? m.contentId.slice(separatorIndex + 1) : m.contentId,
		);
		const mimeType = (m.dataBase64 ? sniffMediaMime(m.dataBase64) : null) ?? m.contentType;
		const url = m.dataBase64 ? toDataUri(mimeType, m.dataBase64) : null;
		// A video keeps no picture unless a real preview was saved alongside it.
		const preview = m.thumbDataBase64 ? previewDataUri(m.contentType, m.thumbDataBase64) : null;
		const thumbUrl = preview ?? (isPictureUrl(url) ? url : null);

		return {
			contentId: realContentId,
			contentType: m.contentType ?? mimeType,
			thumbUrl,
			url,
			coverUrl: thumbUrl ?? url,
			processing: false,
		};
	});

	return {
		albumId,
		albumName: album?.albumName ?? null,
		content,
	};
}
