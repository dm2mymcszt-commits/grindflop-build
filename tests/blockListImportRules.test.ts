import { describe, expect, test } from "bun:test";
import {
	BLOCK_LIST_FORMAT,
	BlockListParseError,
	IMPORT_PACES,
	INSTANT_ROUND_MS,
	MAX_CONSECUTIVE_FAILURES,
	MAX_RATE_LIMIT_STRIKES,
	RATE_LIMIT_BASE_MS,
	RATE_LIMIT_MAX_MS,
	RETRY_DELAY_MS,
	blocksUntilBreak,
	buildBlockListFile,
	classifyBlockFailure,
	dailyWindow,
	estimateImportMs,
	nextToSend,
	parseBlockListFile,
	planBlockImport,
	randomInRange,
	settleInstantRound,
} from "../src/utils/blockListImportRules";

const DAY = 24 * 60 * 60 * 1000;

function parseCode(text: string): string | null {
	try {
		parseBlockListFile(text);
		return null;
	} catch (error) {
		return error instanceof BlockListParseError ? error.code : "other";
	}
}

describe("block list file", () => {
	test("an export reads back as the same ids", () => {
		const file = buildBlockListFile(["123", "456", "123", "junk"], new Date("2026-09-19T10:00:00Z"));
		expect(file).toEqual({
			format: BLOCK_LIST_FORMAT,
			version: 1,
			exportedAt: "2026-09-19T10:00:00.000Z",
			count: 2,
			profileIds: ["123", "456"],
		});
		expect(parseBlockListFile(JSON.stringify(file)).profileIds).toEqual(["123", "456"]);
	});

	test("reads a bare list, numbers included, and Grindr's own blocks response", () => {
		expect(parseBlockListFile("[123, \"456\", {\"profileId\": 789}]").profileIds).toEqual(["123", "456", "789"]);
		expect(
			parseBlockListFile(JSON.stringify({ blocking: [{ profileId: 11 }, { profileId: "22" }] })).profileIds,
		).toEqual(["11", "22"]);
	});

	test("reads plain text of ids in any separator, and a byte order mark", () => {
		const parsed = parseBlockListFile("\uFEFF123\n456, 789;123\r\n");
		expect(parsed.profileIds).toEqual(["123", "456", "789"]);
		expect(parsed.duplicates).toBe(1);
	});

	test("rejects plain text holding anything but ids, so no column is read as ids", () => {
		expect(parseCode("profileId,age\n123,34")).toBe("not_ids");
		expect(parseCode("123 456 12.5")).toBe("not_ids");
		expect(parseCode("123 -456")).toBe("not_ids");
		expect(parseCode("0123")).toBe("not_ids");
	});

	test("drops bad entries from a JSON list but keeps the rest", () => {
		const parsed = parseBlockListFile(JSON.stringify({ format: BLOCK_LIST_FORMAT, version: 1, profileIds: ["1", "x", -5, 2] }));
		expect(parsed.profileIds).toEqual(["1", "2"]);
		expect(parsed.invalid).toBe(2);
	});

	test("refuses other files", () => {
		expect(parseCode("   ")).toBe("empty");
		expect(parseCode("[]")).toBe("empty");
		expect(parseCode("[\"a\", \"b\"]")).toBe("not_ids");
		expect(parseCode("{\"format\": \"free-grind-backup\", \"profileIds\": [1]}")).toBe("wrong_format");
		expect(parseCode("{\"conversations\": []}")).toBe("wrong_format");
		expect(parseCode("{broken")).toBe("wrong_format");
		expect(parseCode(JSON.stringify({ format: BLOCK_LIST_FORMAT, version: 2, profileIds: ["1"] }))).toBe(
			"newer_version",
		);
	});
});

describe("planBlockImport", () => {
	test("leaves out the account itself and anyone already blocked, keeping file order", () => {
		expect(planBlockImport(["5", "1", "9", "3", "1"], ["9", "7"], 3)).toEqual({
			toBlock: ["5", "1"],
			alreadyBlocked: 1,
			skippedSelf: true,
		});
	});
});

describe("pacing", () => {
	test("gaps stay inside each pace's range", () => {
		for (const settings of Object.values(IMPORT_PACES)) {
			expect(randomInRange(settings.gapMs, () => 0)).toBe(settings.gapMs[0]);
			expect(randomInRange(settings.gapMs, () => 0.999999)).toBe(settings.gapMs[1]);
		}
	});

	test("breaks come after the set count, give or take a fifth", () => {
		expect(blocksUntilBreak("balanced", () => 0)).toBe(80);
		expect(blocksUntilBreak("balanced", () => 0.5)).toBe(100);
		expect(blocksUntilBreak("balanced", () => 0.999999)).toBe(120);
	});

	test("estimates include breaks and whole days waited for the daily limit", () => {
		// Balanced: 7.5 s a block, a 3.5 min break every 100.
		expect(estimateImportMs(100, "balanced")).toBe(100 * 7_500 + 210_000);
		// Careful stops at 1,000 a day, so 10,000 takes nine waits plus one day's work.
		const oneDayOfWork = 1_000 * 15_000 + 20 * 450_000;
		expect(estimateImportMs(10_000, "careful")).toBe(9 * DAY + oneDayOfWork);
		expect(estimateImportMs(1_000, "careful")).toBe(oneDayOfWork);
		expect(estimateImportMs(0, "fast")).toBe(0);
		// Every pace, slowest first, takes longer than the next.
		expect(estimateImportMs(10_000, "careful")).toBeGreaterThan(estimateImportMs(10_000, "balanced"));
		expect(estimateImportMs(10_000, "balanced")).toBeGreaterThan(estimateImportMs(10_000, "fast"));
		expect(estimateImportMs(10_000, "fast")).toBeGreaterThan(estimateImportMs(10_000, "instant"));
	});

	test("Instant has no gaps, breaks or daily limit, and sends ten at a time", () => {
		expect(IMPORT_PACES.instant).toMatchObject({ gapMs: [0, 0], breakEvery: null, dailyLimit: null, concurrency: 10 });
		expect(blocksUntilBreak("instant", () => 0.5)).toBe(0);
		expect(estimateImportMs(10_000, "instant")).toBe(1_000 * INSTANT_ROUND_MS);
		expect(estimateImportMs(5, "instant")).toBe(INSTANT_ROUND_MS);
		// The paced modes send one at a time.
		for (const pace of ["careful", "balanced", "fast"] as const) expect(IMPORT_PACES[pace].concurrency).toBe(1);
	});
});

describe("nextToSend", () => {
	const queue = ["1", "2", "3", "4", "5"];

	test("takes profiles kept for a retry first, then the queue from the cursor", () => {
		expect(nextToSend(["9", "8"], queue, 1, 5, 4)).toEqual({ ids: ["9", "8", "2", "3"], fromRetry: 2, fromQueue: 2 });
		expect(nextToSend(["9", "8", "7"], queue, 0, 5, 1)).toEqual({ ids: ["9"], fromRetry: 1, fromQueue: 0 });
		expect(nextToSend([], queue, 3, 5, 10)).toEqual({ ids: ["4", "5"], fromRetry: 0, fromQueue: 2 });
	});

	test("never reads past the job's total, and is empty when everything was sent", () => {
		expect(nextToSend([], queue, 2, 3, 10)).toEqual({ ids: ["3"], fromRetry: 0, fromQueue: 1 });
		expect(nextToSend([], queue, 5, 5, 10)).toEqual({ ids: [], fromRetry: 0, fromQueue: 0 });
		expect(nextToSend(["9"], queue, 5, 5, 10)).toEqual({ ids: ["9"], fromRetry: 1, fromQueue: 0 });
	});
});

describe("settleInstantRound", () => {
	const round = (...results: ("ok" | number | null)[]) =>
		results.map((result, index) => ({ profileId: String(index + 1), result }));

	test("counts blocks and gives up on profiles Grindr won't block or never answered for", () => {
		expect(settleInstantRound(round("ok", 404, "ok", 500, null), 3)).toEqual({
			blocked: ["1", "3"],
			failed: 3,
			retry: [],
			stop: null,
			consecutiveFailures: 0,
		});
	});

	test("stops at the first sign of too many requests, keeping the refused ones", () => {
		expect(settleInstantRound(round("ok", 429, "ok", 429), 0)).toEqual({
			blocked: ["1", "3"],
			failed: 0,
			retry: ["2", "4"],
			stop: "too_fast",
			consecutiveFailures: 0,
		});
	});

	test("a refused account stops it, ahead of anything else", () => {
		expect(settleInstantRound(round(429, 403, 404), 0)).toMatchObject({
			retry: ["1", "2"],
			failed: 1,
			stop: "forbidden",
		});
	});

	test("stops when whole rounds keep failing", () => {
		expect(settleInstantRound(round(null, null, null), MAX_CONSECUTIVE_FAILURES - 3)).toMatchObject({
			failed: 3,
			stop: "failing",
			consecutiveFailures: MAX_CONSECUTIVE_FAILURES,
		});
		expect(settleInstantRound(round(null, null), 0).stop).toBeNull();
	});
});

describe("dailyWindow", () => {
	const start = 1_000_000;

	test("opens with the first block and counts inside it", () => {
		expect(dailyWindow({ windowStartedAt: null, countInWindow: 0 }, 10, start)).toEqual({
			windowStartedAt: start,
			countInWindow: 0,
			waitUntil: null,
		});
		expect(dailyWindow({ windowStartedAt: start, countInWindow: 9 }, 10, start + 5)).toEqual({
			windowStartedAt: start,
			countInWindow: 9,
			waitUntil: null,
		});
	});

	test("holds everything until 24 hours after the window opened once the limit is reached", () => {
		expect(dailyWindow({ windowStartedAt: start, countInWindow: 10 }, 10, start + 1_000).waitUntil).toBe(start + DAY);
	});

	test("a new window opens when the old one has passed, even after a long pause", () => {
		expect(dailyWindow({ windowStartedAt: start, countInWindow: 10 }, 10, start + 3 * DAY)).toEqual({
			windowStartedAt: start + 3 * DAY,
			countInWindow: 0,
			waitUntil: null,
		});
	});

	test("no limit never waits", () => {
		expect(dailyWindow({ windowStartedAt: start, countInWindow: 99_999 }, null, start + 1).waitUntil).toBeNull();
	});
});

describe("classifyBlockFailure", () => {
	const counters = { attempts: 1, rateLimitStrikes: 0, consecutiveFailures: 1 };

	test("backs off harder each time Grindr rate-limits, up to an hour, then stops", () => {
		expect(classifyBlockFailure(429, { ...counters, rateLimitStrikes: 1 })).toEqual({
			kind: "retry",
			delayMs: RATE_LIMIT_BASE_MS,
			rateLimited: true,
		});
		expect(classifyBlockFailure(429, { ...counters, rateLimitStrikes: 2 })).toEqual({
			kind: "retry",
			delayMs: RATE_LIMIT_BASE_MS * 2,
			rateLimited: true,
		});
		expect(classifyBlockFailure(429, { ...counters, rateLimitStrikes: 5 })).toEqual({
			kind: "retry",
			delayMs: RATE_LIMIT_MAX_MS,
			rateLimited: true,
		});
		expect(classifyBlockFailure(429, { ...counters, rateLimitStrikes: MAX_RATE_LIMIT_STRIKES })).toEqual({
			kind: "stop",
			reason: "rate_limited",
		});
	});

	test("stops at once when the account is refused", () => {
		expect(classifyBlockFailure(401, counters)).toEqual({ kind: "stop", reason: "forbidden" });
		expect(classifyBlockFailure(403, counters)).toEqual({ kind: "stop", reason: "forbidden" });
	});

	test("skips a profile Grindr won't block, and retries a server or network failure a few times", () => {
		expect(classifyBlockFailure(404, counters)).toEqual({ kind: "skip" });
		expect(classifyBlockFailure(500, counters)).toEqual({ kind: "retry", delayMs: RETRY_DELAY_MS, rateLimited: false });
		expect(classifyBlockFailure(null, { ...counters, attempts: 2 })).toEqual({
			kind: "retry",
			delayMs: RETRY_DELAY_MS,
			rateLimited: false,
		});
		expect(classifyBlockFailure(null, { ...counters, attempts: 3 })).toEqual({ kind: "skip" });
	});

	test("stops when failures keep coming, whatever they are", () => {
		const failing = { ...counters, consecutiveFailures: MAX_CONSECUTIVE_FAILURES };
		expect(classifyBlockFailure(404, failing)).toEqual({ kind: "stop", reason: "failing" });
		expect(classifyBlockFailure(null, failing)).toEqual({ kind: "stop", reason: "failing" });
	});
});
