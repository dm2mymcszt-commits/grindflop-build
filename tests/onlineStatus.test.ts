import { describe, expect, test } from "bun:test";
import { getOnlineStatusMeta, ONLINE_WINDOW_MS } from "../src/utils/onlineStatus";

const MINUTE = 60_000;
const NOW = 1_800_000_000_000;

/** As Grindr sends it: online until ten minutes after the last activity. */
const activeAgo = (minutes: number) => {
	const lastOnline = NOW - minutes * MINUTE;
	return [lastOnline, lastOnline + ONLINE_WINDOW_MS] as const;
};

describe("online status", () => {
	test("someone who did something within the last minute is active now", () => {
		expect(getOnlineStatusMeta(...activeAgo(0), NOW)).toMatchObject({
			isOnline: true,
			labelKey: "browse_page.status_online_now",
		});
		expect(getOnlineStatusMeta(NOW - 59_000, NOW + 9 * MINUTE, NOW).labelKey).toBe("browse_page.status_online_now");
	});

	test("someone still counted online but quiet says for how long", () => {
		expect(getOnlineStatusMeta(...activeAgo(4), NOW)).toMatchObject({
			isOnline: true,
			labelKey: "browse_page.status_online_idle",
			count: 4,
		});
		expect(getOnlineStatusMeta(...activeAgo(9), NOW).count).toBe(9);
	});

	test("without the last activity, it is worked back from the end of the window", () => {
		expect(getOnlineStatusMeta(null, NOW + 6 * MINUTE, NOW)).toMatchObject({
			labelKey: "browse_page.status_online_idle",
			count: 4,
		});
		expect(getOnlineStatusMeta(0, NOW + ONLINE_WINDOW_MS, NOW).labelKey).toBe("browse_page.status_online_now");
	});

	test("times that make no sense never show a large number", () => {
		// A last activity later than now, or far older than the window allows.
		expect(getOnlineStatusMeta(NOW + 5 * MINUTE, NOW + 9 * MINUTE, NOW).labelKey).toBe("browse_page.status_online_now");
		expect(getOnlineStatusMeta(NOW - 300 * MINUTE, NOW + 2 * MINUTE, NOW).labelKey).toBe("browse_page.status_online_now");
	});

	test("once the window has passed, it is the time since they were last active", () => {
		expect(getOnlineStatusMeta(...activeAgo(15), NOW)).toMatchObject({
			isOnline: false,
			labelKey: "browse_page.status_minutes_ago",
			count: 15,
		});
		expect(getOnlineStatusMeta(NOW - 3 * 60 * MINUTE, null, NOW)).toMatchObject({
			labelKey: "browse_page.status_hours_ago",
			count: 3,
		});
		expect(getOnlineStatusMeta(NOW - 50 * 60 * MINUTE, null, NOW)).toMatchObject({
			labelKey: "browse_page.status_days_ago",
			count: 2,
		});
	});

	test("nothing known, or the server's zero, is offline", () => {
		expect(getOnlineStatusMeta(null, null, NOW).labelKey).toBe("browse_page.status_offline");
		expect(getOnlineStatusMeta(0, 0, NOW).labelKey).toBe("browse_page.status_offline");
	});
});
