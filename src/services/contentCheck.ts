/**
 * contentCheck.ts — runs received photos and videos past the on-device
 * detector and remembers what it found.
 *
 * The filter this backs is fail-closed: a received photo is only shown once a
 * check says "clear". So the one thing this module must never do is turn a
 * failure into a pass. A photo that could not be decoded, a video no frame
 * could be read from, a detector that is not there: all of those leave *no*
 * record, and no record means the photo stays covered.
 *
 * What it found is kept as scores in chatDb (content_checks) and in memory,
 * reachable by media key and by message id — the message id is the one that
 * stays valid after a message's link expires and its media key can no longer
 * be worked out.
 *
 * Deciding who gets blocked is not done here. An explicit result for a
 * received message is handed to whoever registered with
 * setExplicitVerdictHandler (services/explicitMediaGuard.ts).
 */

import { invoke } from "@tauri-apps/api/core";
import * as chatDb from "./chatDb";
import { isTauriRuntime } from "./tauriWebSocket";
import type { MediaKind, StoredContentCheck } from "../types/chat-db";
import { cacheBudget } from "../utils/boundedCache";
import { limitChatDbBlobRead } from "../utils/chatDbBlobLimiter";
import {
	combineContentScores,
	coverForVerdict,
	scoreDetections,
	verdictFromScores,
	type ContentCover,
	type ContentDetection,
	type ContentScores,
	type ContentVerdict,
} from "../utils/explicitContentRules";
import { appLog } from "../utils/logger";

// ---------------------------------------------------------------------------
// Settings — per device, like the other auto-block switches.
// ---------------------------------------------------------------------------

const FILTER_STORAGE_KEY = "fg-explicit-filter";
const BLOCK_STORAGE_KEY = "fg-explicit-block";
const PROFILE_BLOCK_STORAGE_KEY = "fg-explicit-block-profile";
const FILTER_SINCE_STORAGE_KEY = "fg-explicit-filter-since";
const HIDE_GALLERIES_STORAGE_KEY = "fg-explicit-hide-galleries";
const HIDE_PROFILE_PHOTOS_STORAGE_KEY = "fg-explicit-hide-profile-photos";
export const EXPLICIT_FILTER_UPDATED_EVENT = "fg-explicit-filter-updated";

/** Received photos and videos stay covered until checked. Off outside the app, where there is no detector. */
export function isExplicitFilterEnabled(): boolean {
	return (
		typeof window !== "undefined" &&
		window.localStorage.getItem(FILTER_STORAGE_KEY) === "true" &&
		isTauriRuntime()
	);
}

/** Whether an explicit photo also blocks its sender. On unless switched off. */
export function isExplicitBlockEnabled(): boolean {
	return isExplicitFilterEnabled() && window.localStorage.getItem(BLOCK_STORAGE_KEY) !== "false";
}

/**
 * Whether an explicit photo on somebody's profile blocks them when they
 * message. A switch of its own, on unless switched off.
 */
export function isExplicitProfileBlockEnabled(): boolean {
	return isExplicitFilterEnabled() && window.localStorage.getItem(PROFILE_BLOCK_STORAGE_KEY) !== "false";
}

/**
 * Whether what is not cleared is also hidden inside shared albums and in a
 * chat's media list. Only what is drawn: checking and blocking go on either
 * way. A switch of its own, on unless switched off.
 */
export function isExplicitGalleryHidingEnabled(): boolean {
	return isExplicitFilterEnabled() && window.localStorage.getItem(HIDE_GALLERIES_STORAGE_KEY) !== "false";
}

/**
 * Whether a profile photo the detector called explicit is drawn as the
 * hidden tile. Only what is drawn: blocking over it goes on either way. A
 * switch of its own, on unless switched off.
 */
export function isExplicitProfilePhotoHidingEnabled(): boolean {
	return (
		isExplicitFilterEnabled() && window.localStorage.getItem(HIDE_PROFILE_PHOTOS_STORAGE_KEY) !== "false"
	);
}

/**
 * When the filter was last switched on. Only photos received after this can
 * block anyone: opening an old chat must not block someone over history.
 */
export function getExplicitFilterSince(): number | null {
	if (typeof window === "undefined") return null;
	const since = Number(window.localStorage.getItem(FILTER_SINCE_STORAGE_KEY));
	return Number.isFinite(since) && since > 0 ? since : null;
}

export function setExplicitFilterEnabled(enabled: boolean): void {
	if (typeof window === "undefined") return;
	const wasEnabled = window.localStorage.getItem(FILTER_STORAGE_KEY) === "true";
	window.localStorage.setItem(FILTER_STORAGE_KEY, String(enabled));
	if (enabled && !wasEnabled) {
		window.localStorage.setItem(FILTER_SINCE_STORAGE_KEY, String(Date.now()));
	}
	window.dispatchEvent(new Event(EXPLICIT_FILTER_UPDATED_EVENT));
}

export function setExplicitProfileBlockEnabled(enabled: boolean): void {
	if (typeof window === "undefined") return;
	window.localStorage.setItem(PROFILE_BLOCK_STORAGE_KEY, String(enabled));
	window.dispatchEvent(new Event(EXPLICIT_FILTER_UPDATED_EVENT));
}

export function setExplicitGalleryHidingEnabled(enabled: boolean): void {
	if (typeof window === "undefined") return;
	window.localStorage.setItem(HIDE_GALLERIES_STORAGE_KEY, String(enabled));
	window.dispatchEvent(new Event(EXPLICIT_FILTER_UPDATED_EVENT));
}

export function setExplicitProfilePhotoHidingEnabled(enabled: boolean): void {
	if (typeof window === "undefined") return;
	window.localStorage.setItem(HIDE_PROFILE_PHOTOS_STORAGE_KEY, String(enabled));
	window.dispatchEvent(new Event(EXPLICIT_FILTER_UPDATED_EVENT));
}

export function setExplicitBlockEnabled(enabled: boolean): void {
	if (typeof window === "undefined") return;
	window.localStorage.setItem(BLOCK_STORAGE_KEY, String(enabled));
	window.dispatchEvent(new Event(EXPLICIT_FILTER_UPDATED_EVENT));
}

// ---------------------------------------------------------------------------
// What has been checked
// ---------------------------------------------------------------------------

const MODEL = "nudenet-320n";
const MAX_REMEMBERED = 4000;

const byMediaKey = new Map<string, StoredContentCheck>();
const byMessageId = new Map<string, StoredContentCheck>();
const listeners = new Set<() => void>();

function trim(map: Map<string, StoredContentCheck>): void {
	if (map.size <= MAX_REMEMBERED) return;
	let excess = map.size - Math.floor(MAX_REMEMBERED * 0.75);
	for (const key of map.keys()) {
		if (excess-- <= 0) break;
		map.delete(key);
	}
}

function remember(check: StoredContentCheck, messageId?: string | null): void {
	byMediaKey.set(check.mediaKey, check);
	if (check.messageId) byMessageId.set(check.messageId, check);
	// The same photo sent again is a new message with the same media key.
	if (messageId) byMessageId.set(messageId, check);
	trim(byMediaKey);
	trim(byMessageId);
	for (const listener of listeners) listener();
}

/** Records a check made outside this module (a profile photo), so it is not made twice. */
export async function saveContentCheck(check: StoredContentCheck): Promise<void> {
	remember(check);
	await chatDb.upsertContentCheck(check).catch((error) => {
		appLog.warn("[content-check] could not save a check", error);
	});
}

export function scoresOf(check: StoredContentCheck): ContentScores {
	return {
		explicitLabel: check.explicitLabel,
		explicitScore: check.explicitScore,
		coverOnlyScore: check.coverOnlyScore,
		faceScore: check.faceScore,
		faceShare: check.faceShare,
	};
}

export function verdictOf(check: StoredContentCheck | null | undefined): ContentVerdict | null {
	return check ? verdictFromScores(scoresOf(check)) : null;
}

export function getCachedCheckForMessage(messageId: string | null | undefined): StoredContentCheck | null {
	return messageId ? (byMessageId.get(messageId) ?? null) : null;
}

export function getCachedCheckForMediaKey(mediaKey: string | null | undefined): StoredContentCheck | null {
	return mediaKey ? (byMediaKey.get(mediaKey) ?? null) : null;
}

/** What covers this received message's photo right now, or null to show it. */
export function getContentCoverForMessage(messageId: string): ContentCover | null {
	return coverForVerdict(verdictOf(byMessageId.get(messageId)));
}

/** The check for a media key: from memory, else from the database (and then remembered). */
export async function loadContentCheck(mediaKey: string): Promise<StoredContentCheck | null> {
	const cached = byMediaKey.get(mediaKey);
	if (cached) return cached;
	const stored = await chatDb.getContentCheck(mediaKey).catch(() => null);
	if (stored) remember(stored);
	return stored;
}

/** For state worked out from checks elsewhere (an album's cover): re-renders whoever is listening. */
export function notifyContentChecksChanged(): void {
	for (const listener of listeners) listener();
}

/** Subscribe to checks landing; returns an unsubscribe function. */
export function subscribeToContentChecks(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

// ---------------------------------------------------------------------------
// The detector
// ---------------------------------------------------------------------------

type DetectionResult = {
	detections: ContentDetection[];
	imageWidth: number;
	imageHeight: number;
	elapsedMs: number;
};

// One at a time: a check holds a decoded photo in memory, and nothing here is
// urgent enough to hold several.
let queueTail: Promise<unknown> = Promise.resolve();

function enqueue<T>(run: () => Promise<T>): Promise<T> {
	const result = queueTail.then(run, run);
	queueTail = result.catch(() => {});
	return result;
}

async function detectImage(base64: string, tiled = false): Promise<ContentScores> {
	const result = await invoke<DetectionResult>("detect_image_content", { imageBase64: base64, tiled });
	return scoreDetections(result.detections);
}

/**
 * Runs the detector on one still image. Rejects when it cannot be read.
 * `tiled` also looks at the photo piece by piece: slower, and what finds a
 * face in a full-length photo.
 */
export function checkImageBytes(base64: string, options?: { tiled?: boolean }): Promise<ContentScores> {
	return enqueue(() => detectImage(base64, options?.tiled === true));
}

const FRAME_MAX_SIDE = 640;
/**
 * A video larger than this is not opened to read frames from: on a phone the
 * extra copies are enough to get the app killed. It is left unchecked, which
 * keeps it covered.
 */
const MAX_VIDEO_CHECK_BYTES = cacheBudget(24, 128);
const VIDEO_LOAD_TIMEOUT_MS = 10_000;
const VIDEO_SEEK_TIMEOUT_MS = 5_000;
/** Where in a video to look, as fractions of its length. */
const FRAME_POSITIONS = [0.05, 0.3, 0.55, 0.8];

function once(target: EventTarget, event: string, timeoutMs: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error(`timed out waiting for ${event}`));
		}, timeoutMs);
		const onEvent = () => {
			cleanup();
			resolve();
		};
		const onError = () => {
			cleanup();
			reject(new Error("the video could not be read"));
		};
		const cleanup = () => {
			clearTimeout(timer);
			target.removeEventListener(event, onEvent);
			target.removeEventListener("error", onError);
		};
		target.addEventListener(event, onEvent);
		target.addEventListener("error", onError);
	});
}

/**
 * A frame the webview never actually painted comes out as one flat colour.
 * The detector would find nothing in it, and "nothing found" must not be
 * mistaken for "nothing there".
 */
function isFlatFrame(context: CanvasRenderingContext2D, width: number, height: number): boolean {
	const { data } = context.getImageData(0, 0, width, height);
	let min = 255;
	let max = 0;
	const step = Math.max(4, Math.floor(data.length / 4 / 2000) * 4);
	for (let index = 0; index < data.length; index += step) {
		const light = (data[index] + data[index + 1] + data[index + 2]) / 3;
		if (light < min) min = light;
		if (light > max) max = light;
	}
	return max - min < 12;
}

/** A few still frames from a video, as base64 JPEGs. Rejects when none could be read. */
async function extractVideoFrames(base64: string, mimeType: string | null): Promise<string[]> {
	const blob = await (await fetch(`data:${mimeType || "video/mp4"};base64,${base64}`)).blob();
	const objectUrl = URL.createObjectURL(blob);
	const video = document.createElement("video");
	video.muted = true;
	video.playsInline = true;
	video.preload = "auto";
	try {
		video.src = objectUrl;
		await once(video, "loadeddata", VIDEO_LOAD_TIMEOUT_MS);
		// iOS decodes nothing until playback has started once.
		await video.play().then(() => video.pause()).catch(() => {});

		const width = video.videoWidth;
		const height = video.videoHeight;
		if (!width || !height) throw new Error("the video has no picture");
		const scale = Math.min(1, FRAME_MAX_SIDE / Math.max(width, height));
		const canvas = document.createElement("canvas");
		canvas.width = Math.max(1, Math.round(width * scale));
		canvas.height = Math.max(1, Math.round(height * scale));
		const context = canvas.getContext("2d", { willReadFrequently: true });
		if (!context) throw new Error("no canvas to draw frames on");

		const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null;
		const times = duration
			? FRAME_POSITIONS.map((position) => position * duration)
			: [0.1, 1, 2.5, 5];

		const frames: string[] = [];
		for (const time of times) {
			try {
				video.currentTime = time;
				await once(video, "seeked", VIDEO_SEEK_TIMEOUT_MS);
				context.drawImage(video, 0, 0, canvas.width, canvas.height);
				if (isFlatFrame(context, canvas.width, canvas.height)) continue;
				const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
				frames.push(dataUrl.slice(dataUrl.indexOf(",") + 1));
			} catch {
				// A frame that would not seek is skipped; the others still count.
			}
		}
		if (frames.length === 0) throw new Error("no frame of the video could be read");
		return frames;
	} finally {
		video.removeAttribute("src");
		video.load();
		URL.revokeObjectURL(objectUrl);
	}
}

// ---------------------------------------------------------------------------
// Checking received media
// ---------------------------------------------------------------------------

/** Who sent the message a photo came in, when the caller already knows. */
export type MediaSender = { senderId: string | number; timestamp: number };

export type ExplicitVerdictEvent = {
	check: StoredContentCheck;
	messageId: string;
	conversationId: string;
	sender: MediaSender | null;
};

let explicitVerdictHandler: ((event: ExplicitVerdictEvent) => void) | null = null;

export function setExplicitVerdictHandler(
	handler: ((event: ExplicitVerdictEvent) => void) | null,
): void {
	explicitVerdictHandler = handler;
}

function announceIfExplicit(
	check: StoredContentCheck,
	messageId: string | null,
	conversationId: string | null,
	sender: MediaSender | null,
): void {
	if (!messageId || !conversationId || verdictOf(check) !== "explicit") return;
	try {
		explicitVerdictHandler?.({ check, messageId, conversationId, sender });
	} catch (error) {
		appLog.warn("[content-check] explicit verdict handler failed", error);
	}
}

export type CheckMediaInput = {
	mediaKey: string;
	messageId: string | null;
	conversationId: string | null;
	kind: MediaKind;
	base64: string;
	mimeType: string | null;
	sender?: MediaSender | null;
};

const inFlight = new Map<string, Promise<StoredContentCheck | null>>();
// A photo the detector could not read is not retried on every render.
const RETRY_AFTER_FAILURE_MS = 60_000;
const failedAt = new Map<string, number>();

/**
 * Checks a received photo or video whose bytes the caller holds. Returns what
 * was found, or null when nothing could be established — which leaves the
 * photo covered. Never throws.
 */
export async function checkMediaBytes(input: CheckMediaInput): Promise<StoredContentCheck | null> {
	const { mediaKey, messageId, conversationId, kind } = input;
	const sender = input.sender ?? null;
	if (!mediaKey || !input.base64 || (kind !== "image" && kind !== "video")) return null;

	const known = byMediaKey.get(mediaKey);
	if (known) {
		if (messageId && !byMessageId.has(messageId)) remember(known, messageId);
		announceIfExplicit(known, messageId, conversationId, sender);
		return known;
	}

	const running = inFlight.get(mediaKey);
	if (running) {
		const check = await running;
		if (check) {
			if (messageId && !byMessageId.has(messageId)) remember(check, messageId);
			announceIfExplicit(check, messageId, conversationId, sender);
		}
		return check;
	}

	const failed = failedAt.get(mediaKey);
	if (failed !== undefined && Date.now() - failed < RETRY_AFTER_FAILURE_MS) return null;

	const run = (async (): Promise<StoredContentCheck | null> => {
		try {
			const stored = await chatDb.getContentCheck(mediaKey).catch(() => null);
			if (stored) {
				remember(stored, messageId);
				return stored;
			}

			const scores = await enqueue(async () => {
				if (kind === "image") return detectImage(input.base64);
				if (input.base64.length * 0.75 > MAX_VIDEO_CHECK_BYTES) {
					throw new Error("the video is too large to check on this device");
				}
				const frames = await extractVideoFrames(input.base64, input.mimeType);
				const perFrame: ContentScores[] = [];
				for (const frame of frames) perFrame.push(await detectImage(frame));
				return combineContentScores(perFrame);
			});

			const check: StoredContentCheck = {
				mediaKey,
				messageId,
				conversationId,
				kind,
				explicitLabel: scores.explicitLabel,
				explicitScore: scores.explicitScore,
				coverOnlyScore: scores.coverOnlyScore,
				faceScore: scores.faceScore,
				faceShare: scores.faceShare,
				model: MODEL,
				checkedAt: Date.now(),
			};
			await chatDb.upsertContentCheck(check).catch((error) => {
				// Still good for this session; it is simply checked again next time.
				appLog.warn("[content-check] could not save a check", error);
			});
			failedAt.delete(mediaKey);
			remember(check, messageId);
			return check;
		} catch (error) {
			failedAt.set(mediaKey, Date.now());
			appLog.warn(`[content-check] could not check ${kind} ${mediaKey}`, error);
			return null;
		} finally {
			inFlight.delete(mediaKey);
		}
	})();

	inFlight.set(mediaKey, run);
	const check = await run;
	if (check) announceIfExplicit(check, messageId, conversationId, sender);
	return check;
}

export type MessageCheckRequest = {
	messageId: string;
	conversationId: string;
	/** The message's own media key when its body still gives one; null once the link is gone. */
	mediaKey: string | null;
	sender: MediaSender | null;
};

// Message ids already looked up this session, so a thread that re-renders
// does not keep asking for the same thing.
const requestedMessages = new Map<string, number>();

/**
 * Makes sure the received messages on screen have a check: first whatever is
 * already recorded, then, for the rest, the copy of the media this device has
 * stored. A message with nothing stored yet is left for the download that
 * stores it, which checks it as it lands.
 */
export async function requestChecksForMessages(requests: readonly MessageCheckRequest[]): Promise<void> {
	if (!isExplicitFilterEnabled()) return;
	const now = Date.now();
	const pending = requests.filter((request) => {
		if (byMessageId.has(request.messageId)) return false;
		const asked = requestedMessages.get(request.messageId);
		return asked === undefined || now - asked >= RETRY_AFTER_FAILURE_MS;
	});
	if (pending.length === 0) return;
	for (const request of pending) requestedMessages.set(request.messageId, now);

	const recorded = await chatDb
		.getContentChecksForMessages(pending.map((request) => request.messageId))
		.catch(() => []);
	for (const check of recorded) {
		remember(check);
		const request = pending.find((candidate) => candidate.messageId === check.messageId);
		if (request) announceIfExplicit(check, request.messageId, request.conversationId, request.sender);
	}

	for (const request of pending) {
		if (byMessageId.has(request.messageId)) continue;
		try {
			// By the message's own key when it has one: the message-id lookup can
			// return a reply thumbnail filed under the same message, and a check
			// of the wrong picture must not uncover this one.
			const stored = await limitChatDbBlobRead(() =>
				request.mediaKey
					? chatDb.getMediaFile(request.mediaKey)
					: chatDb.getMediaFileByMessageId(request.messageId),
			);
			if (!stored || stored.fetchStatus !== "ok" || !stored.dataBase64) continue;
			await checkMediaBytes({
				mediaKey: stored.mediaKey,
				messageId: request.messageId,
				conversationId: request.conversationId,
				kind: stored.kind,
				base64: stored.dataBase64,
				mimeType: stored.mimeType,
				sender: request.sender,
			});
		} catch (error) {
			appLog.warn(`[content-check] could not check message ${request.messageId}`, error);
		}
	}
}

/** Runs the detector on a generated picture, to show in Settings that it works on this device. */
export async function testDetector(): Promise<{ ok: true; elapsedMs: number } | { ok: false; error: string }> {
	try {
		const canvas = document.createElement("canvas");
		canvas.width = 96;
		canvas.height = 96;
		const context = canvas.getContext("2d");
		if (!context) throw new Error("no canvas");
		const gradient = context.createLinearGradient(0, 0, 96, 96);
		gradient.addColorStop(0, "#335577");
		gradient.addColorStop(1, "#ddbb99");
		context.fillStyle = gradient;
		context.fillRect(0, 0, 96, 96);
		const dataUrl = canvas.toDataURL("image/png");
		const started = performance.now();
		await checkImageBytes(dataUrl.slice(dataUrl.indexOf(",") + 1));
		return { ok: true, elapsedMs: Math.round(performance.now() - started) };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}
