/**
 * mediaStore.ts — eager fetch-and-store of chat media bytes into chatDb.
 *
 * Once a message's image/video/audio URL is resolved (even momentarily,
 * since CloudFront signed URLs expire on a timer), the bytes are downloaded
 * via @tauri-apps/plugin-http (bypasses webview CORS — same pattern already
 * proven in saveMedia.ts against these exact CDN hosts) and stored as base64
 * in chat.sqlite3, so the content survives URL expiry / view-once forever.
 * The tap-to-reveal/blur UI is unaffected — only where the bytes come from
 * changes.
 */

import { fetch } from "@tauri-apps/plugin-http";
import * as chatDb from "./chatDb";
import {
	getMediaCaptureTarget,
	getReplyImageHashTarget,
} from "../pages/app/chat/chatUtils";
import type { MediaCaptureTarget } from "../pages/app/chat/chatUtils";
import type { MediaKind } from "../types/chat-db";
import type { UiMessage } from "../types/chat-page";
import { appLog } from "../utils/logger";
import { isAutoDownloadMediaEnabled } from "../utils/mediaSettings";
import { limitChatDbBlobRead } from "../utils/chatDbBlobLimiter";
import { BoundedStringCache, cacheBudget, isConstrainedDevice } from "../utils/boundedCache";
import { mapWithConcurrency } from "../utils/concurrency";
import {
	checkMediaBytes,
	isExplicitFilterEnabled,
	verdictOf,
	type MediaSender,
} from "./contentCheck";

/**
 * How many large downloads run at once. Each sits in memory several times over
 * while it is base64-encoded and stored, so a phone takes them one at a time.
 */
export const HEAVY_DOWNLOAD_CONCURRENCY = isConstrainedDevice() ? 1 : 3;

/** Files declared larger than this are not downloaded into memory at all. */
const MAX_DOWNLOAD_BYTES = cacheBudget(64, 256);

// De-dupe concurrent fetches for the same key (e.g. multiple hydration passes
// racing for the same image).
const inFlight = new Map<string, Promise<void>>();

// Synchronous in-memory cache so render code (which can't await a DB read)
// can prefer the locally-stored copy once it's available. Populated as
// fetchAndStoreMedia resolves (whether by downloading or finding a DB hit).
const memoryCache = new BoundedStringCache<string>("Chat media", cacheBudget(48, 192));
// Media keys already looked up in chatDb and not found, so a render that keeps
// asking does not keep reading.
const emptyMediaKeyLookups = new Set<string>();

// When what is on screen needs more than the budget, loading one entry evicts
// another that is also on screen, and that one's next render would load it
// straight back — forever. Not reloading the same key within this window
// breaks the loop; the item shows again once it has passed.
const REHYDRATE_COOLDOWN_MS = 30_000;
const lastHydratedAt = new Map<string, number>();

function hydratedRecently(key: string): boolean {
	const at = lastHydratedAt.get(key);
	return at !== undefined && Date.now() - at < REHYDRATE_COOLDOWN_MS;
}
const cacheListeners = new Set<() => void>();

function setCachedMediaUri(mediaKey: string, uri: string): void {
	memoryCache.set(mediaKey, uri);
	for (const listener of cacheListeners) {
		listener();
	}
}

/** Synchronous read of the in-memory media cache. */
export function getCachedMediaUri(mediaKey: string | null | undefined): string | null {
	if (!mediaKey) {
		return null;
	}
	return memoryCache.get(mediaKey) ?? null;
}

/** Subscribe to in-memory cache updates; returns an unsubscribe function. */
export function subscribeToMediaCache(listener: () => void): () => void {
	cacheListeners.add(listener);
	return () => {
		cacheListeners.delete(listener);
	};
}

function bytesToBase64(data: ArrayBuffer, mimeType: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const blob = new Blob([data], { type: mimeType || "application/octet-stream" });
		const reader = new FileReader();
		reader.onload = () => {
			const dataUrl = reader.result as string;
			const commaIndex = dataUrl.indexOf(",");
			resolve(commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl);
		};
		reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
		reader.readAsDataURL(blob);
	});
}

export function toDataUri(mimeType: string | null, base64: string): string {
	return `data:${mimeType || "application/octet-stream"};base64,${base64}`;
}

/**
 * Checks whether a CloudFront signed URL has expired by reading the
 * `Expires` query parameter (Unix epoch seconds). No network request needed.
 * Returns false if the URL cannot be parsed or has no Expires param.
 */
export function isSignedUrlExpired(url: string): boolean {
	try {
		const expires = new URL(url).searchParams.get("Expires");
		if (!expires) return false;
		return Date.now() > Number(expires) * 1000;
	} catch {
		return false;
	}
}

export type FetchedMedia = {
	base64: string;
	mimeType: string | null;
	sizeBytes: number;
};

/** Downloads `url` and base64-encodes it. Returns null on any failure (logs, never throws). */
export async function fetchAndEncode(url: string): Promise<FetchedMedia | null> {
	try {
		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(`Failed to download media (${response.status})`);
		}
		const declaredBytes = Number(response.headers.get("content-length"));
		if (Number.isFinite(declaredBytes) && declaredBytes > MAX_DOWNLOAD_BYTES) {
			// Reading it would hold the whole file in memory several times over
			// while it is encoded and stored, which on a phone is enough to get
			// the app killed.
			try {
				await response.body?.cancel();
			} catch {
				// Nothing more to stop.
			}
			appLog.warn(
				`[media-store] skipped a ${Math.round(declaredBytes / 1048576)} MB file over the ${Math.round(MAX_DOWNLOAD_BYTES / 1048576)} MB limit`,
			);
			return null;
		}
		const arrayBuffer = await response.arrayBuffer();
		const mimeType =
			response.headers.get("content-type")?.split(";")[0]?.trim() || null;
		const base64 = await bytesToBase64(arrayBuffer, mimeType || "application/octet-stream");
		return { base64, mimeType, sizeBytes: arrayBuffer.byteLength };
	} catch (error) {
		appLog.warn(`[media-store] failed to fetch/encode ${url}`, error);
		return null;
	}
}

export type FetchAndStoreMediaParams = {
	mediaKey: string;
	kind: MediaKind;
	url: string;
	conversationId: string | null;
	messageId: string | null;
	viewOnce: boolean;
	// Whether the signed-in user sent this message themselves — auto-download
	// to the device's Downloads folder only ever mirrors media *received*
	// from someone else, never the user's own outgoing photos/videos.
	isOwnMessage: boolean;
	// Set for captures of secondary preview content (reply-quote thumbnails,
	// reaction bubbles) rather than the actual media a message is about —
	// never worth mirroring to the device's Downloads folder even when
	// received. Defaults to false.
	skipAutoDownload?: boolean;
	// Whether the stored copy is also held in memory, ready to show. The
	// pre-block archival capture passes false: it saves media from chats
	// nobody is looking at, and holding all of that is what ran iOS out of
	// memory. Defaults to true.
	cacheInMemory?: boolean;
	// Who sent the message and when, for callers that have the message in
	// hand. The explicit-photo filter needs both before it may block anyone,
	// and a message that just arrived is not in chatDb yet to be looked up.
	sender?: MediaSender | null;
};

/**
 * Whether this is the actual media somebody sent, as opposed to this
 * account's own or a thumbnail quoted alongside a message. Received photos
 * and videos are what the explicit-photo filter checks and what
 * auto-download mirrors.
 */
function isReceivedPrimaryMedia(params: FetchAndStoreMediaParams): boolean {
	return !params.isOwnMessage && !params.skipAutoDownload;
}

async function downloadAndStore(params: FetchAndStoreMediaParams): Promise<void> {
	const { mediaKey, kind, url, conversationId, messageId, viewOnce } = params;
	const fetched = await fetchAndEncode(url);

	if (!fetched) {
		await chatDb
			.upsertMediaFile({
				mediaKey,
				conversationId,
				messageId,
				kind,
				mimeType: null,
				dataBase64: "",
				viewOnce,
				sizeBytes: null,
				fetchStatus: "failed",
			})
			.catch(() => {});
		return;
	}

	await chatDb.upsertMediaFile({
		mediaKey,
		conversationId,
		messageId,
		kind,
		mimeType: fetched.mimeType,
		dataBase64: fetched.base64,
		viewOnce,
		sizeBytes: fetched.sizeBytes,
		fetchStatus: "ok",
	});
	if (params.cacheInMemory !== false) {
		setCachedMediaUri(mediaKey, toDataUri(fetched.mimeType, fetched.base64));
	}
	emptyMediaKeyLookups.delete(mediaKey);
	// This message now has bytes on disk, so a message-id-keyed lookup that
	// previously came back empty would succeed — let it be retried.
	if (messageId) {
		emptyMessageMediaLookups.delete(messageId);
	}

	if (!isReceivedPrimaryMedia(params) || kind === "audio") {
		return;
	}

	// Checked here, with the bytes already in hand, so every path that
	// downloads a received photo — a live message, an opened thread, the
	// scanner, the capture before a block — ends with a verdict on it.
	// Awaited: a caller that waits for the download is waiting for the
	// verdict too.
	if (isExplicitFilterEnabled()) {
		const check = await checkMediaBytes({
			mediaKey,
			messageId,
			conversationId,
			kind,
			base64: fetched.base64,
			mimeType: fetched.mimeType,
			sender: params.sender,
		});
		// Only a photo that was checked and found clear is copied out to the
		// device's gallery; an explicit or unchecked one stays inside the app.
		if (verdictOf(check) !== "clear") {
			return;
		}
	}

	void maybeAutoDownloadToDevice(fetched.base64, fetched.mimeType, kind, conversationId);
}

/**
 * Mirrors newly-cached media into the device's Downloads folder, if the user
 * has opted in. Dynamically imported to avoid a circular dependency —
 * saveMedia.ts itself imports toDataUri from this module.
 */
async function maybeAutoDownloadToDevice(
	base64: string,
	mimeType: string | null,
	kind: "image" | "video",
	conversationId: string | null,
): Promise<void> {
	if (!isAutoDownloadMediaEnabled()) {
		return;
	}
	try {
		const { saveMediaBytesToDeviceSilent } = await import("./saveMedia");
		await saveMediaBytesToDeviceSilent(base64, mimeType, kind, conversationId);
	} catch (error) {
		appLog.warn("[media-store] auto-download to device failed", error);
	}
}

/**
 * Fetch and store media bytes for `mediaKey` if not already cached. Safe to
 * call repeatedly/concurrently (fire-and-forget) — de-duped in-flight,
 * skipped once already stored, retried on a previous failure. Never throws.
 */
export async function fetchAndStoreMedia(
	params: FetchAndStoreMediaParams,
): Promise<void> {
	const { mediaKey, url } = params;
	if (!mediaKey || !url) {
		return;
	}

	const existing = inFlight.get(mediaKey);
	if (existing) {
		return existing;
	}

	const run = (async () => {
		try {
			let storedStatus: string | null;
			if (params.cacheInMemory === false) {
				// Only whether it is stored: reading the bytes back to find out
				// pulled every captured video across the bridge a second time.
				storedStatus = await chatDb.getMediaFetchStatus(mediaKey).catch(() => null);
				if (storedStatus === "ok") {
					return;
				}
			} else {
				const cached = await limitChatDbBlobRead(() => chatDb.getMediaFile(mediaKey));
				if (cached?.fetchStatus === "ok") {
					setCachedMediaUri(mediaKey, toDataUri(cached.mimeType, cached.dataBase64));
					// Stored before the filter was switched on, or the same photo
					// arriving again in a new message: it still needs a verdict
					// tied to this message.
					if (
						isExplicitFilterEnabled() &&
						isReceivedPrimaryMedia(params) &&
						params.kind !== "audio"
					) {
						await checkMediaBytes({
							mediaKey,
							messageId: params.messageId,
							conversationId: params.conversationId,
							kind: params.kind,
							base64: cached.dataBase64,
							mimeType: cached.mimeType,
							sender: params.sender,
						});
					}
					return;
				}
				storedStatus = cached?.fetchStatus ?? null;
			}
			// Signed URLs that already expired are guaranteed to 403 — skip the
			// network round-trip (and the log spam it'd produce) instead of
			// re-hitting CloudFront every time this message is re-processed
			// (poll, realtime merge, hydration pass) until a fresh URL arrives.
			if (isSignedUrlExpired(url)) {
				if (storedStatus !== "failed") {
					await chatDb
						.upsertMediaFile({
							mediaKey,
							conversationId: params.conversationId,
							messageId: params.messageId,
							kind: params.kind,
							mimeType: null,
							dataBase64: "",
							viewOnce: params.viewOnce,
							sizeBytes: null,
							fetchStatus: "failed",
						})
						.catch(() => {});
				}
				return;
			}
			await downloadAndStore(params);
		} finally {
			inFlight.delete(mediaKey);
		}
	})();

	inFlight.set(mediaKey, run);
	return run;
}

/**
 * Returns a ready-to-use data: URI for previously-stored media, or null if
 * not cached (yet, or the last fetch failed).
 */
export async function getLocalMediaUri(
	mediaKey: string | null | undefined,
): Promise<string | null> {
	if (!mediaKey) {
		return null;
	}
	const stored = await limitChatDbBlobRead(() => chatDb.getMediaFile(mediaKey));
	if (!stored || stored.fetchStatus !== "ok") {
		return null;
	}
	return toDataUri(stored.mimeType, stored.dataBase64);
}

/**
 * The primary media_key (see chatUtils.ts's getMediaKeyForMessage) is
 * derived from whatever the live message body currently offers — a hash,
 * a URL, a mediaId. Once the server stops including that field (expired
 * signed URL no longer refreshed, conversation archived, etc.) the same
 * message can no longer reproduce that key, even though chatDb may still
 * have the bytes filed under it. message_id is stable forever, so this is
 * a parallel, URL-independent cache namespace keyed by it instead — used
 * as a fallback wherever the primary lookup can't even be attempted.
 */
export function getMessageFallbackMediaKey(messageId: string): string {
	return `msg:${messageId}`;
}

// Message ids whose message-id-keyed lookup came back with nothing usable.
// Render code calls hydrateMediaByMessageId on every pass for a bubble whose
// body has lost its URL, and without this each of those passes would re-read
// a blob table. Cleared for a message the moment anything is stored for it,
// so a later capture is still picked up.
const emptyMessageMediaLookups = new Set<string>();

/**
 * Populates the in-memory cache (under the message-id fallback key) from
 * whatever's already stored for this message, regardless of whether the
 * live message currently carries a usable URL. Safe to call repeatedly,
 * including from render.
 */
export async function hydrateMediaByMessageId(messageId: string): Promise<void> {
	const key = getMessageFallbackMediaKey(messageId);
	if (
		memoryCache.has(key) ||
		inFlight.has(key) ||
		emptyMessageMediaLookups.has(messageId) ||
		hydratedRecently(key)
	) {
		return;
	}

	const run = (async () => {
		try {
			const stored = await limitChatDbBlobRead(() =>
				chatDb.getMediaFileByMessageId(messageId),
			);
			if (stored?.fetchStatus === "ok") {
				lastHydratedAt.set(key, Date.now());
				setCachedMediaUri(key, toDataUri(stored.mimeType, stored.dataBase64));
			} else {
				emptyMessageMediaLookups.add(messageId);
			}
		} finally {
			inFlight.delete(key);
		}
	})();

	inFlight.set(key, run);
	return run;
}

/**
 * Loads stored media into memory by its media key. For a message whose live
 * link has expired and whose copy is not in memory — never loaded, or evicted
 * to keep memory in check — this is how the saved copy comes back.
 */
export async function hydrateMediaByKey(mediaKey: string): Promise<void> {
	if (
		!mediaKey ||
		memoryCache.has(mediaKey) ||
		inFlight.has(mediaKey) ||
		emptyMediaKeyLookups.has(mediaKey) ||
		hydratedRecently(mediaKey)
	) {
		return;
	}

	const run = (async () => {
		try {
			const stored = await limitChatDbBlobRead(() => chatDb.getMediaFile(mediaKey));
			if (stored?.fetchStatus === "ok") {
				lastHydratedAt.set(mediaKey, Date.now());
				setCachedMediaUri(mediaKey, toDataUri(stored.mimeType, stored.dataBase64));
			} else {
				emptyMediaKeyLookups.add(mediaKey);
			}
		} catch {
			emptyMediaKeyLookups.add(mediaKey);
		} finally {
			inFlight.delete(mediaKey);
		}
	})();

	inFlight.set(mediaKey, run);
	return run;
}

/** What a pre-block media capture attempt managed to secure locally. */
export type MediaCaptureResult = {
	messageId: string;
	mediaKey: string;
	kind: MediaKind;
	/** Bytes for this message are in chatDb with fetchStatus "ok". */
	captured: boolean;
	/**
	 * The URL this message offers is a signed URL that has already expired, so
	 * it is guaranteed to 403 — no later retry can do better than what's
	 * cached, and it must not hold a block back.
	 */
	unavailable: boolean;
};

/**
 * Downloads and stores every image/video/audio attachment in `messages`,
 * awaited, and reports per-message whether the bytes actually landed.
 *
 * The fire-and-forget captureMediaForMessages in ChatPage exists to keep the
 * open thread's cache warm; this is its counterpart for the auto-block path,
 * where the block permanently revokes the signed URLs these messages carry
 * and there is no second chance. Resolves (never rejects).
 *
 * Reply-quote and ProfilePhotoReply thumbnails are captured alongside, on a
 * best-effort basis — those resolve from content-addressed CDN hashes that
 * outlive the conversation, so they're worth grabbing but aren't reported as
 * something a block could destroy.
 */
export async function captureMessageMediaForArchival(
	messages: UiMessage[],
	conversationId: string,
	userId: number | null,
): Promise<MediaCaptureResult[]> {
	const targets: { message: UiMessage; target: MediaCaptureTarget }[] = [];
	const sideCaptures: Promise<void>[] = [];

	for (const message of messages) {
		const target = getMediaCaptureTarget(message);
		if (target) {
			targets.push({ message, target });
		}
		// An attachment whose body has already lost its URL has nothing left to
		// download. What is stored for it stays in chatDb, and is only loaded
		// into memory if somebody opens the thread.

		const replyTarget = getReplyImageHashTarget(message);
		if (replyTarget) {
			sideCaptures.push(
				fetchAndStoreMedia({
					mediaKey: replyTarget.mediaKey,
					kind: "image",
					url: replyTarget.url,
					conversationId,
					messageId: message.messageId,
					viewOnce: false,
					isOwnMessage: false,
					skipAutoDownload: true,
					cacheInMemory: false,
				}),
			);
		}
	}

	const [results] = await Promise.all([
		mapWithConcurrency(targets, HEAVY_DOWNLOAD_CONCURRENCY, async ({ message, target }): Promise<MediaCaptureResult> => {
			// fetchAndStoreMedia never throws and de-dupes in flight by
			// mediaKey, so a racing scanner joins this download rather than
			// issuing a second one.
			await fetchAndStoreMedia({
				mediaKey: target.mediaKey,
				kind: target.kind,
				url: target.url,
				conversationId,
				messageId: message.messageId,
				viewOnce: target.viewOnce,
				isOwnMessage: userId != null && Number(message.senderId) === Number(userId),
				cacheInMemory: false,
			});

			// It records failures as a row with fetchStatus "failed" rather
			// than signalling them, so success has to be read back off the row.
			const status = await chatDb.getMediaFetchStatus(target.mediaKey).catch(() => null);

			return {
				messageId: message.messageId,
				mediaKey: target.mediaKey,
				kind: target.kind,
				captured: status === "ok",
				unavailable: isSignedUrlExpired(target.url),
			};
		}),
		Promise.all(sideCaptures),
	]);

	return results;
}
