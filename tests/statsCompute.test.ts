import { describe, expect, test } from "bun:test";
import {
	addLocalDays,
	attributeViewsToPlaces,
	blockedYouIn,
	bucketize,
	buildBuckets,
	collapseBlockLog,
	coverageByDay,
	findAutoBlockMistakes,
	flattenViews,
	HOUR_MS,
	listDayKeys,
	localDayKey,
	longestDayStreak,
	median,
	normalizeOpener,
	percentChange,
	rankFastestResponders,
	resolvePeriod,
	startOfLocalDay,
	summarizeChats,
	summarizeReplies,
	type BlockLogRow,
	type ConversationSummary,
} from "../src/pages/app/stats/statsCompute";

const NOW = new Date(2026, 8, 17, 15, 30).getTime();
const at = (day: number, hour = 12, minute = 0) =>
	new Date(2026, 8, day, hour, minute).getTime();

describe("periods and days", () => {
	test("7 days is today and the six days before, from local midnight", () => {
		const period = resolvePeriod("7d", NOW);
		expect(period.start).toBe(new Date(2026, 8, 11).getTime());
		expect(period.previous).toEqual({
			start: new Date(2026, 8, 4).getTime(),
			end: period.start as number,
		});
		expect(listDayKeys(period.start as number, NOW)).toHaveLength(7);
	});

	test("all time has no start and nothing to compare with", () => {
		const period = resolvePeriod("all", NOW);
		expect(period.start).toBeNull();
		expect(period.previous).toBeNull();
	});

	test("buckets are days up to a month, then weeks starting Monday", () => {
		expect(buildBuckets(at(1), at(30))).toHaveLength(30);
		const weeks = buildBuckets(at(1, 0), addLocalDays(at(1, 0), 60));
		expect(weeks[0].unit).toBe("week");
		// 1 Sep 2026 is a Tuesday, so its week began on Monday 31 Aug.
		expect(weeks[0].key).toBe("2026-08-31");
		expect(weeks.flatMap((bucket) => bucket.days)).toHaveLength(61);
	});
});

describe("numbers", () => {
	test("median of odd, even and empty lists", () => {
		expect(median([5, 1, 3])).toBe(3);
		expect(median([4, 1, 3, 2])).toBe(2.5);
		expect(median([])).toBeNull();
	});

	test("a change needs something before it", () => {
		expect(percentChange(12, 10)).toBe(20);
		expect(percentChange(5, 0)).toBeNull();
		expect(percentChange(5, null)).toBeNull();
	});

	test("bucketize puts each value in the highest range it reaches", () => {
		expect(
			bucketize(
				[1, 2, 3, 9, 10, 40],
				[
					{ label: "1", min: 1 },
					{ label: "2-3", min: 2 },
					{ label: "4-9", min: 4 },
					{ label: "10+", min: 10 },
				],
			).map((bucket) => bucket.count),
		).toEqual([1, 2, 1, 2]);
	});
});

describe("viewers", () => {
	test("flattens view history, one event per distinct time, seconds read as milliseconds", () => {
		const events = flattenViews([
			{
				profileId: "1",
				displayName: "A",
				imageHash: null,
				timestamp: at(15),
				viewCount: 3,
				viewTimestamps: [at(15), at(14), at(14)],
			},
			{
				profileId: "2",
				displayName: "B",
				imageHash: null,
				timestamp: at(16) / 1000,
				viewCount: 1,
			},
			{
				profileId: "preview:x",
				displayName: "",
				imageHash: null,
				timestamp: at(16),
				viewCount: 1,
			},
		]);
		expect(events.map((event) => [event.profileId, event.timestamp])).toEqual([
			["1", at(14)],
			["1", at(15)],
			["2", at(16)],
		]);
	});

	test("a streak counts consecutive days and is ongoing when it reaches yesterday", () => {
		const streak = longestDayStreak(
			["2026-09-10", "2026-09-11", "2026-09-14", "2026-09-15", "2026-09-16"],
			NOW,
		);
		expect(streak).toEqual({ length: 3, endDay: "2026-09-16", ongoing: true });
	});
});

describe("coverage", () => {
	test("classifies days by recorded hours, before tracking started, and today's hours so far", () => {
		const hours = [
			...Array.from({ length: 22 }, (_, hour) => at(15, hour)),
			...Array.from({ length: 5 }, (_, hour) => at(16, hour)),
			...Array.from({ length: 14 }, (_, hour) => at(17, hour)),
		];
		const days = coverageByDay(
			hours,
			["2026-09-13", "2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17"],
			at(14, 9),
			NOW,
		);
		expect(days.map((day) => day.state)).toEqual([
			"before",
			"none",
			"full",
			"partial",
			"full",
		]);
		expect(days[4].possibleHours).toBe(16);
	});
});

describe("block log", () => {
	const row = (overrides: Partial<BlockLogRow>): BlockLogRow => ({
		id: String(Math.random()),
		event_type: "block",
		profile_id: "42",
		timestamp: at(15),
		method: "auto",
		source: "view_scan",
		reason_kind: "age",
		reason_detail: "19",
		reason_label: "Age limit (19)",
		rule_id: null,
		rule_name: null,
		device_id: "pc",
		...overrides,
	});

	test("the same block logged by two devices counts once", () => {
		const kept = collapseBlockLog([
			row({ device_id: "pc" }),
			row({ device_id: "iphone", timestamp: at(15) + 20_000 }),
			row({ device_id: "iphone", profile_id: "7" }),
		]);
		expect(kept).toHaveLength(2);
	});

	test("a later block of the same person is a new event", () => {
		expect(
			collapseBlockLog([
				row({ device_id: "pc" }),
				row({ device_id: "iphone", timestamp: at(15) + 2 * HOUR_MS }),
			]),
		).toHaveLength(2);
	});

	test("an auto-block undone by hand is a mistake; one blocked again first is not", () => {
		const mistakes = findAutoBlockMistakes([
			row({ profile_id: "1", timestamp: at(10) }),
			row({
				profile_id: "1",
				event_type: "unblock",
				method: "manual",
				timestamp: at(11),
			}),
			row({ profile_id: "2", timestamp: at(10) }),
			row({ profile_id: "2", method: "manual", timestamp: at(11) }),
			row({
				profile_id: "2",
				event_type: "unblock",
				method: "manual",
				timestamp: at(12),
			}),
		]);
		expect(mistakes.map((entry) => entry.profile_id)).toEqual(["1"]);
	});

	test("someone who blocked you twice counts once, at their newest block", () => {
		const blocked = (profileId: string | null, conversationId: string, timestamp: number) => ({
			profileId,
			conversationId,
			timestamp,
		});
		const people = blockedYouIn(
			[
				blocked("1", "1:9", at(14, 19, 36)),
				blocked("1", "1:9", at(14, 19, 37)),
				blocked(null, "2:9", at(12)),
				blocked(null, "2:9", at(13)),
				blocked("3", "3:9", at(1)),
			],
			{ start: at(10), end: NOW },
		);
		expect(people).toEqual([
			blocked("1", "1:9", at(14, 19, 37)),
			blocked(null, "2:9", at(13)),
		]);
	});
});

describe("chats", () => {
	const ME = 100;
	const chat = (
		overrides: Partial<ConversationSummary>,
	): ConversationSummary => ({
		conversationId: String(Math.random()),
		otherProfileId: "7",
		name: null,
		blockState: null,
		favorite: false,
		firstSender: 7,
		firstTs: at(10),
		firstType: "Text",
		firstText: "Hey!",
		lastSender: 7,
		lastTs: at(10),
		total: 1,
		mine: 0,
		firstInTs: at(10),
		firstOutTs: null,
		firstInTextTs: at(10),
		firstAlbumInTs: null,
		...overrides,
	});

	test("openers are grouped regardless of case and end punctuation", () => {
		expect(normalizeOpener("  Hey!! ")).toBe("hey");
		const summary = summarizeChats(
			[
				chat({ firstText: "Hey!" }),
				chat({ firstText: "hey" }),
				chat({ firstText: "sup" }),
			],
			ME,
			NOW,
		);
		expect(summary.openers[0]).toEqual({ label: "hey", count: 2 });
	});

	test("counts who started, answers, real conversations and media-first openers", () => {
		const summary = summarizeChats(
			[
				chat({ total: 3, mine: 1, lastSender: ME }),
				chat({ firstType: "Image", firstText: null, firstInTextTs: null }),
				chat({
					firstSender: ME,
					total: 2,
					mine: 1,
					firstInTs: at(10, 13),
					firstOutTs: at(10),
				}),
				chat({
					firstSender: ME,
					total: 1,
					mine: 1,
					firstInTs: null,
					lastSender: ME,
					blockState: "blocked_by_me",
				}),
			],
			ME,
			NOW,
		);
		expect(summary.theyStarted).toBe(2);
		expect(summary.youStarted).toBe(2);
		expect(summary.youAnsweredTheirs).toBe(1);
		expect(summary.theyAnsweredYours).toBe(1);
		expect(summary.real).toBe(2);
		expect(summary.photoFirst).toBe(1);
		expect(summary.medianTimeToTheirReply).toBe(HOUR_MS);
		// The blocked chat is left out of unanswered.
		expect(summary.unansweredYours).toBe(1);
	});

	test("reply times ignore pauses over 12 hours and rank people with enough replies", () => {
		const gaps = [
			{ conversationId: "a", mine: false, gapMs: 30_000, timestamp: at(10) },
			{ conversationId: "a", mine: false, gapMs: 60_000, timestamp: at(10) },
			{ conversationId: "b", mine: false, gapMs: 10_000, timestamp: at(10) },
			{ conversationId: "a", mine: true, gapMs: 120_000, timestamp: at(10) },
			{
				conversationId: "a",
				mine: true,
				gapMs: 13 * HOUR_MS,
				timestamp: at(10),
			},
		];
		const summary = summarizeReplies(gaps);
		expect(summary.mineCount).toBe(1);
		expect(summary.theirsMedian).toBe(30_000);
		expect(rankFastestResponders(gaps, 2)).toEqual([
			{ conversationId: "a", median: 45_000, count: 2 },
		]);
	});
});

describe("places", () => {
	test("credits views to the place active at the time and counts hours per place", () => {
		const home = {
			timestamp: at(15, 0),
			geohash: "u09tvw0f6szy",
			name: "Home",
			lat: 48.85,
			lon: 2.35,
		};
		const trip = {
			timestamp: at(16, 0),
			geohash: "u0bmvd1q5c2e",
			name: "Lyon",
			lat: 45.76,
			lon: 4.83,
		};
		const { places, unplacedViews } = attributeViewsToPlaces(
			[at(14, 12), at(15, 10), at(15, 20), at(16, 5)],
			[trip, home],
			{ start: at(14, 0), end: at(16, 12) },
		);
		const byName = Object.fromEntries(
			places.map((place) => [place.name, place]),
		);
		expect(unplacedViews).toBe(1);
		expect(byName.Home.views).toBe(2);
		expect(byName.Home.hours).toBe(24);
		expect(byName.Lyon.views).toBe(1);
		expect(byName.Lyon.hours).toBe(12);
	});
});

test("local day keys follow the device's calendar", () => {
	expect(localDayKey(startOfLocalDay(NOW))).toBe("2026-09-17");
});
