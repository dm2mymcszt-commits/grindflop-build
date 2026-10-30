import { describe, expect, test } from "bun:test";
import {
	countSends,
	NEW_IN_DRAWER_MS,
	mostSentFirst,
	parseSendCounts,
	withoutCount,
} from "../src/utils/drawerMediaOrder";

const item = (id: number) => ({ id });

describe("mostSentFirst", () => {
	test("puts what was sent most at the top", () => {
		const items = [item(1), item(2), item(3)];
		expect(mostSentFirst(items, { "2": 5, "3": 1 }).map((i) => i.id)).toEqual([2, 3, 1]);
	});

	test("keeps the order they came in for items sent equally often", () => {
		const items = [item(10), item(20), item(30), item(40)];
		expect(mostSentFirst(items, { "30": 2, "10": 2 }).map((i) => i.id)).toEqual([10, 30, 20, 40]);
	});

	test("with no counts the order is untouched", () => {
		const items = [item(3), item(1), item(2)];
		expect(mostSentFirst(items, {}).map((i) => i.id)).toEqual([3, 1, 2]);
	});

	test("leaves the list it was given alone", () => {
		const items = [item(1), item(2)];
		mostSentFirst(items, { "2": 9 });
		expect(items.map((i) => i.id)).toEqual([1, 2]);
	});
});

describe("mostSentFirst, with newly added items", () => {
	const now = 1_800_000_000_000;
	const added = (id: number, msAgo: number) => ({ id, createdTs: now - msAgo });
	const HOUR = 60 * 60 * 1000;

	// A photo that was just added has never been sent. Ordered by sends alone
	// it would sit at the very bottom, right when it is wanted.
	test("keeps what was added in the last day above everything else, newest first", () => {
		const items = [added(1, 40 * 24 * HOUR), added(2, 2 * HOUR), added(3, 30 * 24 * HOUR), added(4, 1 * HOUR)];
		expect(mostSentFirst(items, { "1": 9, "3": 4 }, now).map((i) => i.id)).toEqual([4, 2, 1, 3]);
	});

	test("an item stops being new after a day", () => {
		const items = [added(1, NEW_IN_DRAWER_MS + 1), added(2, 50 * 24 * HOUR)];
		expect(mostSentFirst(items, { "2": 3 }, now).map((i) => i.id)).toEqual([2, 1]);
		expect(mostSentFirst([added(1, NEW_IN_DRAWER_MS - 1), added(2, 50 * 24 * HOUR)], { "2": 3 }, now).map((i) => i.id)).toEqual([1, 2]);
	});

	test("reads a time given in seconds as well as one in milliseconds", () => {
		const inSeconds = { id: 1, createdTs: Math.floor((now - HOUR) / 1000) };
		const old = { id: 2, createdTs: now - 90 * 24 * HOUR };
		expect(mostSentFirst([old, inSeconds], { "2": 5 }, now).map((i) => i.id)).toEqual([1, 2]);
	});

	test("an item with no usable time, or one from the future, is not treated as new", () => {
		const items = [{ id: 1, createdTs: 0 }, { id: 2, createdTs: now + HOUR }, { id: 3 }, { id: 4, createdTs: now - HOUR }];
		expect(mostSentFirst(items, {}, now).map((i) => i.id)).toEqual([4, 1, 2, 3]);
	});
});

describe("countSends", () => {
	test("adds one for each item sent", () => {
		expect(countSends({ "1": 2 }, [1, 7])).toEqual({ "1": 3, "7": 1 });
	});

	test("counts an item sent twice in one go twice", () => {
		expect(countSends({}, [4, 4])).toEqual({ "4": 2 });
	});

	test("leaves the counts it was given alone", () => {
		const before = { "1": 2 };
		countSends(before, [1]);
		expect(before).toEqual({ "1": 2 });
	});
});

describe("withoutCount", () => {
	test("forgets the count of an item deleted from the drawer", () => {
		expect(withoutCount({ "1": 2, "2": 1 }, 2)).toEqual({ "1": 2 });
	});

	test("hands back the very same counts when there was nothing to forget", () => {
		const counts = { "1": 2 };
		expect(withoutCount(counts, 9)).toBe(counts);
	});

	test("leaves the counts it was given alone", () => {
		const counts = { "1": 2, "2": 1 };
		withoutCount(counts, 1);
		expect(counts).toEqual({ "1": 2, "2": 1 });
	});
});

describe("parseSendCounts", () => {
	test("reads what was stored", () => {
		expect(parseSendCounts({ "12": 3, "7": 1 })).toEqual({ "12": 3, "7": 1 });
	});

	test("keeps only what is a count under an id", () => {
		expect(
			parseSendCounts({ "12": 3, abc: 2, "5": 0, "6": -1, "7": 1.5, "8": "2", "9": null }),
		).toEqual({ "12": 3 });
	});

	test("anything else is no counts at all", () => {
		expect(parseSendCounts(null)).toEqual({});
		expect(parseSendCounts(undefined)).toEqual({});
		expect(parseSendCounts([1, 2])).toEqual({});
		expect(parseSendCounts("12")).toEqual({});
	});
});
