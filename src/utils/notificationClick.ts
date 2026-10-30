/**
 * What a clicked desktop notification asks the app to open.
 *
 * The Rust side reports the click with the group the notification was posted
 * under, and nothing else: a conversation id for a message, or "taps".
 */

/** The group every tap notification is posted under. */
export const TAPS_NOTIFICATION_GROUP = "taps";

export type ClickedNotification =
	| { event: "opened"; action: "taps"; conversationId: null }
	| { event: "opened"; action: string; conversationId: string };

/**
 * Reads the payload of a click. Returns null for anything that does not name
 * something to open, so a click on any other notification only brings the
 * window forward.
 */
export function clickedNotification(group: unknown): ClickedNotification | null {
	if (typeof group !== "string") {
		return null;
	}
	const name = group.trim();
	if (!name) {
		return null;
	}
	if (name === TAPS_NOTIFICATION_GROUP) {
		return { event: "opened", action: "taps", conversationId: null };
	}
	return { event: "opened", action: `chat:${name}`, conversationId: name };
}
