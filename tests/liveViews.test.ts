import { describe, expect, test } from "bun:test";
import type { InterestItem } from "../src/pages/app/interest/interestUtils";
import { LIVE_VIEW_MATCH_MS, overlayLiveViews } from "../src/pages/app/interest/liveViews";

const now = Date.UTC(2026, 9, 15, 10, 0, 0);
const row = (profileId: string, timestamp: number, viewCount = 1): InterestItem => ({
	profileId,
	displayName: `Name ${profileId}`,
	imageHash: `hash-${profileId}`,
	timestamp,
	tapType: null,
	viewCount,
	canOpenProfile: true,
});

describe("live views on the Interest list", () => {
	const list = [row("1", now - 60 * 60_000), row("2", now - 2 * 60 * 60_000, 3)];

	test("a viewer the list does not have yet goes on top at once", () => {
		const { views, settled } = overlayLiveViews(list, [{ profileId: "9", imageHash: "h9", timestamp: now }]);
		expect(views[0]).toMatchObject({ profileId: "9", imageHash: "h9", timestamp: now, viewCount: 1 });
		expect(views).toHaveLength(3);
		expect(settled).toEqual([]);
	});

	test("a returning viewer moves up with one more view and keeps their name", () => {
		const { views } = overlayLiveViews(list, [{ profileId: "2", imageHash: null, timestamp: now }]);
		expect(views[0]).toMatchObject({ profileId: "2", displayName: "Name 2", imageHash: "hash-2", viewCount: 4 });
		expect(views.filter((item) => item.profileId === "2")).toHaveLength(1);
	});

	test("once the list shows the view, even at a slightly different time, it is settled and not shown twice", () => {
		const caughtUp = [row("9", now - 40_000), ...list];
		const { views, settled } = overlayLiveViews(caughtUp, [{ profileId: "9", imageHash: null, timestamp: now }]);
		expect(settled).toEqual(["9"]);
		expect(views).toBe(caughtUp);
		expect(LIVE_VIEW_MATCH_MS).toBeGreaterThan(100_000);
	});
});
