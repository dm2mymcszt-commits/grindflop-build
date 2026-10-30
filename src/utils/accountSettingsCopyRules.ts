/**
 * Rules for copying one account's settings into another account on the same
 * device — for moving to a new Grindr account without setting the app up
 * again.
 *
 * Only settings that say how the user likes the app to behave are copied.
 * Keys that record the old account's own history stay behind:
 * `automation_seen_senders` and `seenTimestamps` are about who messaged or
 * was seen by that account, `blockListSnapshot` is its block list (moved
 * with the block list import instead), and the one-time sync and repair
 * markers must run again against the new account's data. An allowlist keeps
 * any key added later behind until someone decides it belongs to the user
 * rather than the account.
 */
export const COPYABLE_ACCOUNT_SETTING_KEYS: ReadonlySet<string> = new Set([
	"automation",
	"automation_rules",
	// Copied with the rules so the defaults aren't seeded again on top of them.
	"automation_age_defaults_seeded_v2",
	"automation_keywords_defaults_seeded",
	"autoDownloadMedia",
	"browseFilters",
	"chatHidePinned",
	"chatInboxFilters",
	"locationPreferences",
	"privacy",
	"recentGifs",
	"stats",
]);

export function isCopyableAccountSetting(key: string): boolean {
	return COPYABLE_ACCOUNT_SETTING_KEYS.has(key);
}

const ACCOUNT_DB_FILENAME = /^chat-(\d{1,20})\.sqlite3$/;

/** The profile id of a per-account chat database file, or null for any other file. */
export function profileIdFromAccountDbFilename(filename: string): number | null {
	const match = ACCOUNT_DB_FILENAME.exec(filename);
	if (!match) {
		return null;
	}
	const profileId = Number(match[1]);
	return Number.isSafeInteger(profileId) && profileId > 0 ? profileId : null;
}
