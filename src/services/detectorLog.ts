/**
 * detectorLog.ts — a short, readable record of what the photo detector's
 * rules did and, above all, of when they could not decide.
 *
 * The rules built on the detector never block on a guess: a photo that would
 * not download or a face it is unsure about means "leave them alone". That
 * is the right thing to do and an invisible one, so it is written down here
 * and shown in Settings. Otherwise "it did nothing" and "it is broken" look
 * the same from the outside.
 *
 * Kept on this device only, newest first, and short.
 */

const STORAGE_KEY = "fg-detector-log";
export const DETECTOR_LOG_UPDATED_EVENT = "fg-detector-log-updated";
const MAX_ENTRIES = 80;

export type DetectorLogOutcome = "blocked" | "saved" | "left_alone";

export type DetectorLogEntry = {
	at: number;
	profileId: string;
	name: string;
	outcome: DetectorLogOutcome;
	/** A sentence a person can read: what was decided and why. */
	detail: string;
};

export function getDetectorLog(): DetectorLogEntry[] {
	if (typeof window === "undefined") return [];
	try {
		const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "[]");
		return Array.isArray(parsed) ? (parsed as DetectorLogEntry[]) : [];
	} catch {
		return [];
	}
}

/**
 * Adds an entry, unless the same thing was already written about the same
 * person: the scanner comes back to every chat on each pass, and the list is
 * for what happened, not for how often it was looked at.
 */
export function logDetectorDecision(entry: Omit<DetectorLogEntry, "at">): void {
	if (typeof window === "undefined") return;
	const log = getDetectorLog();
	if (
		log.some(
			(existing) =>
				existing.profileId === entry.profileId &&
				existing.outcome === entry.outcome &&
				existing.detail === entry.detail,
		)
	) {
		return;
	}
	const next = [{ ...entry, at: Date.now() }, ...log].slice(0, MAX_ENTRIES);
	try {
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
		window.dispatchEvent(new Event(DETECTOR_LOG_UPDATED_EVENT));
	} catch {
		// A full or unavailable store loses the note, never the decision.
	}
}

export function clearDetectorLog(): void {
	if (typeof window === "undefined") return;
	window.localStorage.removeItem(STORAGE_KEY);
	window.dispatchEvent(new Event(DETECTOR_LOG_UPDATED_EVENT));
}
