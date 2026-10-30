import { describe, expect, test } from "bun:test";
import { shouldRefreshChatAfterGoogleDriveApply } from "../src/pages/app/chat/googleDriveRefresh";

describe("Google Drive chat refresh profile gate", () => {
	test("accepts only the ready active profile", () => {
		expect(shouldRefreshChatAfterGoogleDriveApply({ profileId: 42 }, 42, true)).toBe(true);
		expect(shouldRefreshChatAfterGoogleDriveApply({ profileId: 41 }, 42, true)).toBe(false);
		expect(shouldRefreshChatAfterGoogleDriveApply({ profileId: 42 }, 42, false)).toBe(false);
		expect(shouldRefreshChatAfterGoogleDriveApply({ profileId: 42 }, null, true)).toBe(false);
		expect(shouldRefreshChatAfterGoogleDriveApply(undefined, 42, true)).toBe(false);
	});
});
