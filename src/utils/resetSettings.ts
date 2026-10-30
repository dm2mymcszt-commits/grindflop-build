/**
 * Puts the look and the everyday behaviour of the app back to how a fresh
 * install has them, on this device.
 *
 * What it touches is a list, on purpose. This app keeps a great many
 * settings and most of them decide who gets blocked. None of those are here:
 * a reset that brought back default blocking rules, or wiped the ones the
 * user built, would do real harm. Privacy is not here either, since "back to
 * default" there means read receipts and profile views being sent again.
 * Neither is anything that is data and not a setting (filters and locations
 * kept with the account, saved accounts, sync, history).
 */

import {
	SKIP_BLOCK_CONFIRM_KEY,
	SKIP_DELETE_CONVERSATION_CONFIRM_KEY,
	SKIP_LINK_OPEN_CONFIRM_KEY,
	SKIP_UNBLOCK_CONFIRM_KEY,
} from "./blockConfirm";
import { KEEP_SCREEN_ON_KEY } from "./keepScreenOn";
import { LOCATION_SEARCH_AUTOFOCUS_KEY } from "./locationSearchSettings";
import {
	DEFAULT_ALBUM_EXPIRATION_KEY,
	DEFAULT_EXPIRING_PHOTOS_KEY,
	DRAWER_MOST_SENT_FIRST_KEY,
} from "./mediaDefaults";
import {
	CHAT_NOTIFICATIONS_ENABLED_KEY,
	FOREGROUND_NOTIFICATIONS_ENABLED_KEY,
	TAP_NOTIFICATIONS_ENABLED_KEY,
} from "./notificationSettings";

/** Where the theme, layout and display preferences are kept. */
const PREFERENCES_KEY = "app_preferences";

/**
 * Kept in the preferences entry without being preferences: what the app
 * knows about a Right Now session that is running. A reset must not make it
 * forget one.
 */
const PREFERENCES_FIELDS_TO_KEEP = [
	"activeRightNowId",
	"activeRightNowExpiresAt",
	"rightNowRemaining",
] as const;

/**
 * Switches kept on this device, each removed so that its own default takes
 * over. The keys without a constant belong to pages that do not export one.
 */
export const RESETTABLE_LOCAL_STORAGE_KEYS: readonly string[] = [
	// Confirmations
	SKIP_BLOCK_CONFIRM_KEY,
	SKIP_UNBLOCK_CONFIRM_KEY,
	SKIP_DELETE_CONVERSATION_CONFIRM_KEY,
	SKIP_LINK_OPEN_CONFIRM_KEY,
	// Notifications
	CHAT_NOTIFICATIONS_ENABLED_KEY,
	TAP_NOTIFICATIONS_ENABLED_KEY,
	FOREGROUND_NOTIFICATIONS_ENABLED_KEY,
	// Which tabs show, and how they open
	"fg-show-right-now",
	"fg-show-interest",
	"fg-interest-default-tab",
	"fg-interest-views-sort",
	"fg-interest-views-window",
	"fg-interest-views-count-mode",
	"fg-stats-period",
	// Display
	"fg-hide-grid-images",
	"fg-emoji-style",
	KEEP_SCREEN_ON_KEY,
	LOCATION_SEARCH_AUTOFOCUS_KEY,
	// How sent media starts out
	DEFAULT_EXPIRING_PHOTOS_KEY,
	DEFAULT_ALBUM_EXPIRATION_KEY,
	DRAWER_MOST_SENT_FIRST_KEY,
];

/** The preferences entry reduced to the fields a reset has to keep. */
export function preferencesAfterReset(stored: string | null): string | null {
	if (!stored) {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(stored);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return null;
	}

	const kept: Record<string, unknown> = {};
	for (const field of PREFERENCES_FIELDS_TO_KEEP) {
		const value = (parsed as Record<string, unknown>)[field];
		if (value !== undefined && value !== null) {
			kept[field] = value;
		}
	}
	return Object.keys(kept).length > 0 ? JSON.stringify(kept) : null;
}

/**
 * Resets the settings listed above. The app has to be reloaded afterwards:
 * the pages hold the old values in memory.
 */
export function resetAppearanceAndBehaviour(storage: Storage = window.localStorage): void {
	const preferences = preferencesAfterReset(storage.getItem(PREFERENCES_KEY));
	if (preferences === null) {
		storage.removeItem(PREFERENCES_KEY);
	} else {
		storage.setItem(PREFERENCES_KEY, preferences);
	}
	for (const key of RESETTABLE_LOCAL_STORAGE_KEYS) {
		storage.removeItem(key);
	}
}
