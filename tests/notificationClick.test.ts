import { describe, expect, test } from "bun:test";
import { clickedNotification, TAPS_NOTIFICATION_GROUP } from "../src/utils/notificationClick";

describe("clickedNotification", () => {
	test("a message notification opens its conversation", () => {
		expect(clickedNotification("900000002_920000003")).toEqual({
			event: "opened",
			action: "chat:900000002_920000003",
			conversationId: "900000002_920000003",
		});
	});

	test("a tap notification opens the taps", () => {
		expect(clickedNotification(TAPS_NOTIFICATION_GROUP)).toEqual({
			event: "opened",
			action: "taps",
			conversationId: null,
		});
	});

	test("spaces around the group are not part of it", () => {
		expect(clickedNotification("  42_43 ")?.conversationId).toBe("42_43");
		expect(clickedNotification(" taps ")?.action).toBe("taps");
	});

	// An auto-block alert, for one, is posted without a group. Clicking it
	// brings the window forward and opens nothing.
	test("a notification without a group opens nothing", () => {
		expect(clickedNotification("")).toBeNull();
		expect(clickedNotification("   ")).toBeNull();
		expect(clickedNotification(null)).toBeNull();
		expect(clickedNotification(undefined)).toBeNull();
		expect(clickedNotification(42)).toBeNull();
		expect(clickedNotification({ group: "taps" })).toBeNull();
	});
});
