/**
 * Where the app keeps how often each drawer item was sent. One entry in the
 * account's own settings, on this device: Grindr has no such count, and it is
 * not something to carry to another device, where the drawer may be used
 * differently.
 */

import { appLog } from "../utils/logger";
import {
	countSends,
	mostSentFirst,
	parseSendCounts,
	withoutCount,
	type DrawerSendCounts,
} from "../utils/drawerMediaOrder";
import { isDrawerMostSentFirst } from "../utils/mediaDefaults";
import { getSetting, setSetting } from "./chatDb";

const SETTING_KEY = "drawerMediaUsage";

/** Never fails: without counts the drawer simply keeps the order it came in. */
export async function loadDrawerSendCounts(): Promise<DrawerSendCounts> {
	try {
		return parseSendCounts(await getSetting<unknown>(SETTING_KEY));
	} catch (error) {
		appLog.warn("[drawer] could not read the send counts", error);
		return {};
	}
}

/** Counts one more send of each of these items. Never fails. */
export async function recordDrawerSends(mediaIds: readonly number[]): Promise<void> {
	if (mediaIds.length === 0) return;
	try {
		await setSetting(SETTING_KEY, countSends(await loadDrawerSendCounts(), mediaIds));
	} catch (error) {
		appLog.warn("[drawer] could not record the send counts", error);
	}
}

/** Forgets the count of an item that was deleted from the drawer. Never fails. */
export async function forgetDrawerSends(mediaId: number): Promise<void> {
	try {
		const counts = await loadDrawerSendCounts();
		const next = withoutCount(counts, mediaId);
		if (next !== counts) {
			await setSetting(SETTING_KEY, next);
		}
	} catch (error) {
		appLog.warn("[drawer] could not forget a send count", error);
	}
}

/**
 * The drawer's items in the order to show them: reordered when the setting
 * is on, and exactly as Grindr sent them when it is off. Never fails.
 */
export async function orderDrawerMedia<T extends { id: number; createdTs?: number | null }>(
	media: T[],
): Promise<T[]> {
	if (!isDrawerMostSentFirst()) {
		return media;
	}
	return mostSentFirst(media, await loadDrawerSendCounts());
}
