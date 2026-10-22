/**
 * What stored chat history shows about a conversation before a given point.
 *
 * The inbox scanner's "first message" rules read Grindr's copy of a chat, and
 * deleting a conversation restarts Grindr's copy while GrindFlop keeps its own.
 * Without looking back at that local history, whatever someone sends after a
 * delete looks like an opener — which is how people were auto-blocked in the
 * middle of a conversation.
 */

type HistoryMessage = {
	senderId?: number | string | null;
	body?: unknown;
};

export type EarlierHistory = {
	/** This account sent something. */
	hasOutgoing: boolean;
	/** The other person sent something, media included. */
	hasIncoming: boolean;
	/** The other person sent text. */
	hasIncomingText: boolean;
};

export const NO_EARLIER_HISTORY: EarlierHistory = {
	hasOutgoing: false,
	hasIncoming: false,
	hasIncomingText: false,
};

function textOf(body: unknown): string {
	if (typeof body === "string") return body;
	if (body && typeof body === "object") {
		const text = (body as { text?: unknown }).text;
		if (typeof text === "string") return text;
	}
	return "";
}

export function summarizeEarlierHistory(
	messages: readonly HistoryMessage[],
	userId: number | string | null | undefined,
): EarlierHistory {
	const summary = { ...NO_EARLIER_HISTORY };
	for (const message of messages) {
		const sender = Number(message.senderId);
		// System notes ("You blocked this person" and the like) are stored with
		// sender 0 and are not part of the conversation.
		if (!sender) continue;
		if (userId != null && sender === Number(userId)) {
			summary.hasOutgoing = true;
			continue;
		}
		summary.hasIncoming = true;
		if (textOf(message.body).trim() !== "") {
			summary.hasIncomingText = true;
		}
	}
	return summary;
}

/** The earliest timestamp among messages, or null if none carries one. */
export function earliestTimestamp(
	messages: readonly { timestamp?: number | null }[],
): number | null {
	let earliest: number | null = null;
	for (const message of messages) {
		const timestamp = Number(message.timestamp);
		if (!Number.isFinite(timestamp) || timestamp <= 0) continue;
		if (earliest == null || timestamp < earliest) earliest = timestamp;
	}
	return earliest;
}
