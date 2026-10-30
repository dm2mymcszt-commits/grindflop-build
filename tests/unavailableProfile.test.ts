import { describe, expect, test } from "bun:test";
import {
	isUsableProfileName,
	pickKnownProfile,
	resolveUnavailableProfile,
} from "../src/utils/unavailableProfile";

describe("resolveUnavailableProfile", () => {
	test("a profile Grindr still shows is not unavailable", () => {
		expect(
			resolveUnavailableProfile({ access: "accessible", blockedByMe: true }),
		).toBeNull();
		expect(
			resolveUnavailableProfile({
				access: "accessible",
				blockedByMe: null,
				knownBlockState: "blocked_by_other",
			}),
		).toBeNull();
	});

	test("a profile that is gone is deleted whatever the block signals say", () => {
		expect(
			resolveUnavailableProfile({ access: "not_found", blockedByMe: true }),
		).toBe("deleted");
		expect(
			resolveUnavailableProfile({
				access: "not_found",
				blockedByMe: null,
				knownBlockState: "blocked_by_other",
				selfActedRecently: true,
			}),
		).toBe("deleted");
	});

	test("the block list holding them means this account blocked them", () => {
		expect(
			resolveUnavailableProfile({ access: "blocked", blockedByMe: true }),
		).toBe("you_blocked");
	});

	// They blocked first and this account blocked back: the saved state still
	// says "blocked by other", but "You blocked this person" is true, and it is
	// the block Unblock can do something about.
	test("this account's own block is shown even when they blocked first", () => {
		expect(
			resolveUnavailableProfile({
				access: "blocked",
				blockedByMe: true,
				knownBlockState: "blocked_by_other",
			}),
		).toBe("you_blocked");
	});

	test("a stub with a block list that does not hold them is their block", () => {
		expect(
			resolveUnavailableProfile({ access: "blocked", blockedByMe: false }),
		).toBe("blocked_you");
		expect(
			resolveUnavailableProfile({
				access: "blocked",
				blockedByMe: false,
				knownBlockState: "blocked_by_other",
			}),
		).toBe("blocked_you");
	});

	// The bug this guards: straight after an unblock the stub is still served
	// for a moment, and the block list — correctly — no longer holds them.
	// Read plainly that is "they blocked you", seconds after unblocking them.
	test("this account's own recent block or unblock attributes nothing to them", () => {
		expect(
			resolveUnavailableProfile({
				access: "blocked",
				blockedByMe: false,
				selfActedRecently: true,
			}),
		).toBe("blocked_unknown");
		expect(
			resolveUnavailableProfile({
				access: "blocked",
				blockedByMe: null,
				knownBlockState: "blocked_by_other",
				selfActedRecently: true,
			}),
		).toBe("blocked_unknown");
	});

	test("a recent action does not hide a block the list still holds", () => {
		expect(
			resolveUnavailableProfile({
				access: "blocked",
				blockedByMe: true,
				selfActedRecently: true,
			}),
		).toBe("you_blocked");
	});

	test("a list that contradicts the saved state is not believed either way", () => {
		expect(
			resolveUnavailableProfile({
				access: "blocked",
				blockedByMe: false,
				knownBlockState: "blocked_by_me",
			}),
		).toBe("blocked_unknown");
	});

	test("without the block list, the chat's saved state answers", () => {
		expect(
			resolveUnavailableProfile({
				access: "blocked",
				blockedByMe: null,
				knownBlockState: "blocked_by_me",
			}),
		).toBe("you_blocked");
		expect(
			resolveUnavailableProfile({
				access: "blocked",
				blockedByMe: null,
				knownBlockState: "blocked_by_other",
			}),
		).toBe("blocked_you");
	});

	test("with neither, nothing is said about whose block it is", () => {
		expect(
			resolveUnavailableProfile({ access: "blocked", blockedByMe: null }),
		).toBe("blocked_unknown");
		expect(
			resolveUnavailableProfile({
				access: "blocked",
				blockedByMe: null,
				knownBlockState: null,
			}),
		).toBe("blocked_unknown");
	});
});

describe("isUsableProfileName", () => {
	test("the stub's own placeholders are not names", () => {
		expect(isUsableProfileName("4")).toBe(false);
		expect(isUsableProfileName("3")).toBe(false);
		expect(isUsableProfileName(" 4 ")).toBe(false);
	});

	test("empty and missing names are not names", () => {
		expect(isUsableProfileName("")).toBe(false);
		expect(isUsableProfileName("   ")).toBe(false);
		expect(isUsableProfileName(null)).toBe(false);
		expect(isUsableProfileName(undefined)).toBe(false);
	});

	test("anything else is, including other numbers", () => {
		expect(isUsableProfileName("Tom")).toBe(true);
		expect(isUsableProfileName("44")).toBe(true);
		expect(isUsableProfileName("5")).toBe(true);
	});
});

describe("pickKnownProfile", () => {
	test("nothing known gives nothing", () => {
		expect(pickKnownProfile([])).toEqual({ name: null, imageHash: null, imageUrl: null });
		expect(pickKnownProfile([null, undefined, {}])).toEqual({
			name: null,
			imageHash: null,
			imageUrl: null,
		});
	});

	test("the first source wins", () => {
		expect(
			pickKnownProfile([
				{ name: "Tom", imageHash: "aaa" },
				{ name: "Thomas", imageHash: "bbb" },
			]),
		).toEqual({ name: "Tom", imageHash: "aaa", imageUrl: null });
	});

	// The chat can remember a name while only the viewers list kept a photo.
	test("name and picture are filled from different sources", () => {
		expect(
			pickKnownProfile([
				{ name: "Tom", imageHash: null },
				{ name: null, imageHash: "bbb" },
			]),
		).toEqual({ name: "Tom", imageHash: "bbb", imageUrl: null });
	});

	// A chat whose name was saved from the stub must not win over a real name
	// further down.
	test("a saved stub name is skipped for the next real one", () => {
		expect(
			pickKnownProfile([
				{ name: "4", imageHash: "aaa" },
				{ name: " Tom ", imageHash: "bbb" },
			]),
		).toEqual({ name: "Tom", imageHash: "aaa", imageUrl: null });
	});

	test("a ready-made picture address is kept when there is no hash", () => {
		expect(
			pickKnownProfile([{ name: "Tom", imageUrl: "https://example.test/a.jpg" }]),
		).toEqual({ name: "Tom", imageHash: null, imageUrl: "https://example.test/a.jpg" });
	});

	test("the first picture wins, whichever kind it is", () => {
		expect(
			pickKnownProfile([
				{ imageUrl: "https://example.test/a.jpg" },
				{ imageHash: "bbb" },
			]),
		).toEqual({ name: null, imageHash: null, imageUrl: "https://example.test/a.jpg" });
	});
});
