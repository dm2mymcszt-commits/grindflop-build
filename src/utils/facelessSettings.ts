/**
 * The switches behind the two faceless rules. Per device, like the other
 * auto-block switches.
 *
 * - No profile picture at all: blocked a set time after their first message
 *   unless what they send saves them.
 * - Has pictures, but none shows a face: the same outcome with a longer,
 *   separate wait, because this is where a detector is most likely wrong.
 *
 * Two of the options only apply to chats that began after they were switched
 * on (the "since" stamps). Switching a stricter rule on must not go back
 * through the inbox and block people who were fine under the old one.
 */

const NO_PHOTO_KEY = "fg-block-faceless-no-media";
const NO_PHOTO_DELAY_KEY = "fg-block-faceless-delay";
const NEED_FACE_KEY = "fg-block-faceless-need-face";
const NEED_FACE_SINCE_KEY = "fg-block-faceless-need-face-since";
const NO_FACE_PHOTO_KEY = "fg-block-faceless-photos";
const NO_FACE_PHOTO_DELAY_KEY = "fg-block-faceless-photos-delay";
const NO_FACE_PHOTO_SINCE_KEY = "fg-block-faceless-photos-since";

export const DEFAULT_NO_FACE_PHOTO_DELAY_MINUTES = 30;
/** A week. Longer than that is not a wait, it is the rule being off. */
export const MAX_NO_FACE_PHOTO_DELAY_MINUTES = 7 * 24 * 60;

function read(key: string): string | null {
	return typeof window === "undefined" ? null : window.localStorage.getItem(key);
}

function readSince(key: string): number | null {
	const since = Number(read(key));
	return Number.isFinite(since) && since > 0 ? since : null;
}

/**
 * Stamps the moment an option goes from off to on; leaves the stamp alone
 * otherwise. An option found on with no stamp (switched on by a build from
 * before there was one) is stamped now, never treated as always having been on.
 */
function writeSwitch(key: string, sinceKey: string, enabled: boolean): void {
	const wasEnabled = read(key) === "true";
	window.localStorage.setItem(key, String(enabled));
	if (enabled && (!wasEnabled || readSince(sinceKey) == null)) {
		window.localStorage.setItem(sinceKey, String(Date.now()));
	}
}

export function isNoPhotoRuleEnabled(): boolean {
	return read(NO_PHOTO_KEY) === "true";
}

export function getNoPhotoDelayMinutes(): number {
	const minutes = parseInt(read(NO_PHOTO_DELAY_KEY) || "5", 10);
	return Number.isFinite(minutes) && minutes > 0 ? minutes : 5;
}

/** Whether only media that shows a face saves someone, instead of any media. */
export function isNeedFaceEnabled(): boolean {
	return read(NEED_FACE_KEY) === "true" && readSince(NEED_FACE_SINCE_KEY) != null;
}

export function getNeedFaceSince(): number | null {
	return readSince(NEED_FACE_SINCE_KEY);
}

/**
 * On only once it has been switched on by a build that records when. An
 * earlier build had this as a plain checkbox with other thresholds; left on
 * from then, it counts as off until it is saved on again.
 */
export function isNoFacePhotoRuleEnabled(): boolean {
	return read(NO_FACE_PHOTO_KEY) === "true" && readSince(NO_FACE_PHOTO_SINCE_KEY) != null;
}

export function getNoFacePhotoSince(): number | null {
	return readSince(NO_FACE_PHOTO_SINCE_KEY);
}

export function clampNoFacePhotoDelayMinutes(minutes: number): number {
	if (!Number.isFinite(minutes)) return DEFAULT_NO_FACE_PHOTO_DELAY_MINUTES;
	return Math.min(MAX_NO_FACE_PHOTO_DELAY_MINUTES, Math.max(1, Math.round(minutes)));
}

export function getNoFacePhotoDelayMinutes(): number {
	const stored = read(NO_FACE_PHOTO_DELAY_KEY);
	return stored == null ? DEFAULT_NO_FACE_PHOTO_DELAY_MINUTES : clampNoFacePhotoDelayMinutes(Number(stored));
}

export function saveFacelessSettings(settings: {
	noPhotoRule: boolean;
	noPhotoDelayMinutes: string;
	needFace: boolean;
	noFacePhotoRule: boolean;
	noFacePhotoDelayMinutes: number;
}): void {
	if (typeof window === "undefined") return;
	window.localStorage.setItem(NO_PHOTO_KEY, String(settings.noPhotoRule));
	window.localStorage.setItem(NO_PHOTO_DELAY_KEY, settings.noPhotoDelayMinutes);
	writeSwitch(NEED_FACE_KEY, NEED_FACE_SINCE_KEY, settings.needFace);
	writeSwitch(NO_FACE_PHOTO_KEY, NO_FACE_PHOTO_SINCE_KEY, settings.noFacePhotoRule);
	window.localStorage.setItem(
		NO_FACE_PHOTO_DELAY_KEY,
		String(clampNoFacePhotoDelayMinutes(settings.noFacePhotoDelayMinutes)),
	);
}
