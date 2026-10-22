/**
 * The rules behind the saved copies of profiles (services/profileCopyStore),
 * kept free of storage so they can be tested on their own.
 *
 * A copy is what GET /v7/profiles/:id last returned for someone while their
 * profile could still be read. Once it can't — a block in either direction, a
 * deleted account — the copy is the only way to show who they were.
 */

import type { ProfileDetail } from "../types/grid";

/** Copies of profiles that can still be read, newest kept. */
export const RECENT_COPY_CAP = 3000;
/** Copies of profiles that can no longer be read, newest kept. */
export const KEPT_COPY_CAP = 10000;
/** One profile is not written again within this window. */
export const COPY_REWRITE_INTERVAL_MS = 10 * 60 * 1000;
/** Minimum gap between two trims of the store. */
export const COPY_CLEANUP_INTERVAL_MS = 30 * 60 * 1000;

/**
 * The profile with everything empty left out. Most of a profile's fields are
 * null or an empty list, and their names alone are over half of what would be
 * written; reading it back through the schema restores every default.
 */
export function compactProfileForStorage(profile: ProfileDetail): Record<string, unknown> {
	const compact: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(profile)) {
		if (value === null || value === undefined) continue;
		if (Array.isArray(value) && value.length === 0) continue;
		compact[key] = value;
	}
	return compact;
}

/**
 * A saved copy as it should be shown. What was true only at the moment it was
 * saved — online, how far away, a Right Now post, travelling — is taken out:
 * shown next to someone's name it would read as true now.
 */
export function prepareProfileCopyForDisplay(profile: ProfileDetail): ProfileDetail {
	return {
		...profile,
		onlineUntil: null,
		seen: null,
		distance: null,
		isNew: false,
		rightNow: null,
		rightNowText: null,
		rightNowPosted: null,
		rightNowDistance: null,
		rightNowThumbnailUrl: null,
		rightNowFullImageUrl: null,
		rightNowShareLocation: null,
		rightNowMedias: [],
		isTeleporting: false,
		isRoaming: false,
		isVisiting: false,
		arrivalDays: null,
		travelPlans: [],
		unreadCount: 0,
		lastThrobTimestamp: null,
	};
}

/** Whether a profile written at `lastWrittenAt` is due to be written again. */
export function isCopyRewriteDue(lastWrittenAt: number | undefined, now: number): boolean {
	return lastWrittenAt === undefined || now - lastWrittenAt >= COPY_REWRITE_INTERVAL_MS;
}

/** How many of the oldest copies in a tier have to go to respect its cap. */
export function countCopiesOverCap(count: number, cap: number): number {
	return Math.max(0, count - cap);
}
