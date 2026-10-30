import { describe, expect, test } from "bun:test";
import {
	isCopyableAccountSetting,
	profileIdFromAccountDbFilename,
} from "../src/utils/accountSettingsCopyRules";

describe("isCopyableAccountSetting", () => {
	test("copies the settings a user sets up by hand", () => {
		for (const key of [
			"automation",
			"automation_rules",
			"browseFilters",
			"chatInboxFilters",
			"locationPreferences",
			"privacy",
			"stats",
		]) {
			expect(isCopyableAccountSetting(key)).toBe(true);
		}
	});

	test("copies the seed markers with the rules so defaults aren't added on top", () => {
		expect(isCopyableAccountSetting("automation_age_defaults_seeded_v2")).toBe(true);
		expect(isCopyableAccountSetting("automation_keywords_defaults_seeded")).toBe(true);
	});

	test("leaves the old account's own history and one-time markers behind", () => {
		for (const key of [
			"automation_seen_senders",
			"seenTimestamps",
			"blockListSnapshot",
			"inboxSyncCompletedV1",
			"synthetic-block-placeholder-purge-v2",
			"someFutureSetting",
		]) {
			expect(isCopyableAccountSetting(key)).toBe(false);
		}
	});
});

describe("profileIdFromAccountDbFilename", () => {
	test("reads the profile id from an account's database file", () => {
		expect(profileIdFromAccountDbFilename("chat-900000002.sqlite3")).toBe(900000002);
	});

	test("ignores the other databases and their side files", () => {
		for (const name of [
			"chat.sqlite3",
			"chat-contact-index-900000002.sqlite3",
			"google-drive-sync-900000002.sqlite3",
			"chat-900000002.sqlite3-wal",
			"chat-900000002.sqlite3-shm",
			"chat-abc.sqlite3",
			"chat-0.sqlite3",
		]) {
			expect(profileIdFromAccountDbFilename(name)).toBeNull();
		}
	});
});
