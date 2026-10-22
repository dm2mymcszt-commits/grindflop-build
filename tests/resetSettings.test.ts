import { describe, expect, test } from "bun:test";
import {
	RESETTABLE_LOCAL_STORAGE_KEYS,
	preferencesAfterReset,
	resetAppearanceAndBehaviour,
} from "../src/utils/resetSettings";

/** Just enough of the browser's storage for the reset to work on. */
function fakeStorage(initial: Record<string, string>): Storage & { dump(): Record<string, string> } {
	const data = new Map(Object.entries(initial));
	return {
		get length() {
			return data.size;
		},
		clear: () => data.clear(),
		getItem: (key: string) => data.get(key) ?? null,
		key: (index: number) => Array.from(data.keys())[index] ?? null,
		removeItem: (key: string) => void data.delete(key),
		setItem: (key: string, value: string) => void data.set(key, value),
		dump: () => Object.fromEntries(data),
	};
}

describe("the list of what a reset touches", () => {
	// Every one of these decides who gets blocked, what others can see of the
	// user, or is data. A reset must never reach them.
	const mustNeverBeReset = [
		"fg-forbidden-words",
		"fg-first-message-words",
		"fg-auto-block-whitelist",
		"fg-block-chat",
		"fg-block-grid",
		"fg-block-min-age",
		"fg-block-max-age",
		"fg-block-max-distance",
		"fg-block-interest-views",
		"fg-autoblock-counter-block",
		"fg-ban-on-select",
		"fg-explicit-filter",
		"fg-explicit-block",
		"fg-explicit-block-profile",
		"fg-inbox-scanner-enabled",
		"fg-view-scanner",
		"fg-ghost-mode",
		"fg-ghost-exceptions",
		"fg-location-finder-enabled",
		"fg-device-id",
		"fg-user-id",
		"fg-saved-account-profiles",
		"fg-onboarding-complete",
		"fg:google-drive-auto-sync-paused",
	];

	test("leaves blocking, privacy, sync and identity alone", () => {
		for (const key of mustNeverBeReset) {
			expect(RESETTABLE_LOCAL_STORAGE_KEYS).not.toContain(key);
		}
	});

	// The families those keys come from. The two "confirm before blocking"
	// switches are not among them: they only decide whether the app asks.
	test("holds nothing from the families that decide blocking, privacy or identity", () => {
		for (const key of RESETTABLE_LOCAL_STORAGE_KEYS) {
			expect(key).not.toMatch(
				/^fg-(block|autoblock|auto-block|ban-|explicit|forbidden|first-message|ghost|view-scanner|inbox-scanner|image-scanner|location-finder)|sync|device|user-id/,
			);
		}
	});

	test("lists each key once", () => {
		expect(new Set(RESETTABLE_LOCAL_STORAGE_KEYS).size).toBe(RESETTABLE_LOCAL_STORAGE_KEYS.length);
	});
});

describe("preferencesAfterReset", () => {
	test("drops the look and keeps what is known of a running Right Now session", () => {
		const stored = JSON.stringify({
			colorScheme: "light",
			accentColor: "#ff0000",
			mobileGridColumns: "2",
			developerMode: true,
			revealEffectEnabled: true,
			activeRightNowId: 77,
			activeRightNowExpiresAt: 1_800_000_000_000,
			rightNowRemaining: 2,
		});
		expect(JSON.parse(preferencesAfterReset(stored)!)).toEqual({
			activeRightNowId: 77,
			activeRightNowExpiresAt: 1_800_000_000_000,
			rightNowRemaining: 2,
		});
	});

	test("nothing worth keeping means no entry at all, as on a fresh install", () => {
		expect(preferencesAfterReset(JSON.stringify({ colorScheme: "dark" }))).toBeNull();
		expect(preferencesAfterReset(JSON.stringify({ activeRightNowId: null }))).toBeNull();
		expect(preferencesAfterReset(null)).toBeNull();
		expect(preferencesAfterReset("")).toBeNull();
	});

	test("an entry that cannot be read is dropped, not passed on", () => {
		expect(preferencesAfterReset("{not json")).toBeNull();
		expect(preferencesAfterReset("[1,2]")).toBeNull();
		expect(preferencesAfterReset('"text"')).toBeNull();
	});
});

describe("resetAppearanceAndBehaviour", () => {
	test("removes what is on the list and nothing else", () => {
		const storage = fakeStorage({
			app_preferences: JSON.stringify({ colorScheme: "light", rightNowRemaining: 3 }),
			profile_skip_block_confirm: "true",
			chat_skip_link_open_confirm: "true",
			notif_taps_enabled: "false",
			"fg-show-interest": "false",
			"fg-keep-screen-on": "true",
			"fg-emoji-style": "twemoji",
			// Not on the list:
			"fg-forbidden-words": '["x"]',
			"fg-block-min-age": "25",
			"fg-explicit-filter": "true",
			"fg-ghost-mode": "true",
			"fg-location-finder-enabled": "false",
			"fg-user-id": "920000003",
		});

		resetAppearanceAndBehaviour(storage);

		expect(storage.dump()).toEqual({
			app_preferences: JSON.stringify({ rightNowRemaining: 3 }),
			"fg-forbidden-words": '["x"]',
			"fg-block-min-age": "25",
			"fg-explicit-filter": "true",
			"fg-ghost-mode": "true",
			"fg-location-finder-enabled": "false",
			"fg-user-id": "920000003",
		});
	});

	test("with nothing stored it changes nothing", () => {
		const storage = fakeStorage({ "fg-forbidden-words": "[]" });
		resetAppearanceAndBehaviour(storage);
		expect(storage.dump()).toEqual({ "fg-forbidden-words": "[]" });
	});
});
