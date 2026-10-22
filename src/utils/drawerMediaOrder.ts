/**
 * The order of the media drawer: what has been sent most often comes first.
 *
 * Grindr keeps no count of how often a drawer item was sent, so the app keeps
 * its own, by the item's id. Nothing here touches storage; see
 * services/drawerMediaUsage.ts for where the counts live.
 */

/** How often each drawer item has been sent, by its id. */
export type DrawerSendCounts = Record<string, number>;

/** Reads stored counts, keeping only what is a count: a positive whole number under a numeric id. */
export function parseSendCounts(value: unknown): DrawerSendCounts {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return {};
	}
	const counts: DrawerSendCounts = {};
	for (const [id, count] of Object.entries(value)) {
		if (/^\d+$/.test(id) && typeof count === "number" && Number.isInteger(count) && count > 0) {
			counts[id] = count;
		}
	}
	return counts;
}

/** The counts after one more send of each of these items. */
export function countSends(counts: DrawerSendCounts, mediaIds: readonly number[]): DrawerSendCounts {
	const next = { ...counts };
	for (const id of mediaIds) {
		const key = String(id);
		next[key] = (next[key] ?? 0) + 1;
	}
	return next;
}

/**
 * The counts without the one for an item that was deleted from the drawer.
 * Returns the object it was given when there was nothing to forget, so a
 * caller can tell there is nothing to save.
 */
export function withoutCount(counts: DrawerSendCounts, mediaId: number): DrawerSendCounts {
	const key = String(mediaId);
	if (!(key in counts)) {
		return counts;
	}
	const next = { ...counts };
	delete next[key];
	return next;
}

/** How long an item counts as newly added to the drawer. */
export const NEW_IN_DRAWER_MS = 24 * 60 * 60 * 1000;

/** A time from Grindr in milliseconds, whether it came in seconds or in milliseconds. */
function toMillis(time: number | null | undefined): number | null {
	if (typeof time !== "number" || !Number.isFinite(time) || time <= 0) {
		return null;
	}
	return time < 1e12 ? time * 1000 : time;
}

/**
 * The items in the order the drawer shows them: what was added in the last
 * day first, newest at the top, then the rest with the most-sent first.
 *
 * Without the first rule a photo that was just added, sent zero times, would
 * sit below everything ever sent even once, and be hard to find right when
 * it is wanted. Items that tie stay in the order they came in.
 */
export function mostSentFirst<T extends { id: number; createdTs?: number | null }>(
	items: readonly T[],
	counts: DrawerSendCounts,
	now: number = Date.now(),
): T[] {
	return items
		.map((item, position) => {
			const added = toMillis(item.createdTs);
			return {
				item,
				position,
				added: added ?? 0,
				isNew: added !== null && added <= now && now - added < NEW_IN_DRAWER_MS,
				sent: counts[String(item.id)] ?? 0,
			};
		})
		.sort((a, b) => {
			if (a.isNew !== b.isNew) return a.isNew ? -1 : 1;
			if (a.isNew) return b.added - a.added || a.position - b.position;
			return b.sent - a.sent || a.position - b.position;
		})
		.map((entry) => entry.item);
}
