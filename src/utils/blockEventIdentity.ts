import type { BlockEventType } from "../types/chat-db";

/**
 * How close two sightings of a block (or unblock) have to be to count as the
 * same event.
 *
 * Every device that is online sees the same chat.v1.conversation.delete and
 * records it on its own, stamped with its own clock, and Google Drive sync
 * then carries both rows everywhere: the PC and the iPhone logged one block
 * a second apart on 2026-09-14. Grindr sends no time or id both devices would
 * share, so the time is all there is to match them on. A real second block
 * means they unblocked and blocked again; inside this window that is rare,
 * and it would be counted once.
 */
export const SAME_BLOCK_EVENT_WINDOW_MS = 10 * 60_000;

/**
 * The row id for an event first seen at `timestamp`. It is rounded down to the
 * window, so two devices that notice the same block seconds apart write the
 * same row and sync keeps one. The row itself keeps the exact time.
 */
export function blockEventId(
	conversationId: string,
	eventType: BlockEventType,
	timestamp: number,
): string {
	const slot =
		Math.floor(timestamp / SAME_BLOCK_EVENT_WINDOW_MS) * SAME_BLOCK_EVENT_WINDOW_MS;
	return `${conversationId}:${eventType}:${slot}`;
}

export type StoredBlockEventTime = {
	id: string;
	event_type: string;
	timestamp: number;
};

/**
 * An event already stored for this conversation that a new sighting is really
 * another sighting of: the same kind, within the window, and nothing of the
 * other kind between them. This catches what the rounded id cannot, such as the
 * other device's row arriving by sync first, or the two falling either side of
 * a rounding boundary.
 */
export function findSameBlockEvent<T extends StoredBlockEventTime>(
	stored: readonly T[],
	eventType: BlockEventType,
	timestamp: number,
): T | null {
	let closest: T | null = null;
	for (const row of stored) {
		if (row.event_type !== eventType) continue;
		const gap = Math.abs(row.timestamp - timestamp);
		if (gap > SAME_BLOCK_EVENT_WINDOW_MS) continue;
		const from = Math.min(row.timestamp, timestamp);
		const to = Math.max(row.timestamp, timestamp);
		const separated = stored.some(
			(other) =>
				other.event_type !== eventType &&
				other.timestamp > from &&
				other.timestamp < to,
		);
		if (separated) continue;
		if (!closest || gap < Math.abs(closest.timestamp - timestamp)) closest = row;
	}
	return closest;
}
