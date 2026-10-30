/**
 * liveViews.ts — viewers Grindr announced live, shown before its views list
 * catches up. A leaf module on purpose (type imports only), so tests can
 * import it: interestUtils reaches the locale loader, which only Vite has.
 */

import type { InterestItem } from "./interestUtils";

/** A view Grindr announced over the websocket, before its views list shows it. */
export type LiveView = {
	profileId: string;
	imageHash: string | null;
	timestamp: number;
};

/**
 * Grindr's views list gives the same view a time 8 to 100 seconds away from
 * the one its live event carried (measured 2026-10-15 over 678 views), so a
 * listed view this close to a live one is taken to be that view.
 */
export const LIVE_VIEW_MATCH_MS = 3 * 60_000;

/**
 * Puts views that were just announced live on top of the list, since Grindr's
 * views list only shows them minutes later. A live view the list already
 * covers is reported as settled, and is not shown twice. Nothing here is
 * written to the viewer store: a live time never equals the list's time for
 * the same view, and storing both would count every view twice.
 */
export function overlayLiveViews(
	views: InterestItem[],
	liveViews: readonly LiveView[],
): { views: InterestItem[]; settled: string[] } {
	const settled: string[] = [];
	let result = views;
	for (const live of liveViews) {
		const existing = result.find((item) => item.profileId === live.profileId);
		if (
			existing &&
			existing.timestamp != null &&
			existing.hasExactTimestamp !== false &&
			existing.timestamp >= live.timestamp - LIVE_VIEW_MATCH_MS
		) {
			settled.push(live.profileId);
			continue;
		}
		const shown: InterestItem = {
			profileId: live.profileId,
			displayName: existing?.displayName ?? null,
			imageHash: existing?.imageHash ?? live.imageHash,
			timestamp: live.timestamp,
			hasExactTimestamp: true,
			tapType: null,
			viewCount: (existing?.viewCount ?? 0) + 1,
			canOpenProfile: true,
			isFromCache: false,
			isMutual: existing?.isMutual,
			onlineUntil: existing?.onlineUntil,
			distanceMeters: existing?.distanceMeters,
		};
		result = [shown, ...result.filter((item) => item.profileId !== live.profileId)];
	}
	return {
		views: result === views ? views : [...result].sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0)),
		settled,
	};
}
