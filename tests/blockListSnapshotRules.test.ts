import { describe, expect, test } from "bun:test";
import {
	applyBlockChanges,
	blockedFromStatsLog,
	mergeFullBlockList,
	readSavedBlockList,
} from "../src/utils/blockListSnapshotRules";

describe("applyBlockChanges", () => {
	test("applies blocks and unblocks in the order they happened", () => {
		const result = applyBlockChanges(
			["1", "2"],
			[
				{ profileId: "3", blocked: false, at: 20 },
				{ profileId: "3", blocked: true, at: 10 },
				{ profileId: "1", blocked: false, at: 5 },
			],
		);
		expect(result.sort()).toEqual(["2"]);
	});
});

describe("mergeFullBlockList", () => {
	test("keeps changes made after the request went out", () => {
		const result = mergeFullBlockList(["1", "2"], 100, [
			{ profileId: "9", blocked: true, at: 150 },
			{ profileId: "2", blocked: false, at: 120 },
		]);
		expect(result.sort()).toEqual(["1", "9"]);
	});

	test("trusts Grindr over changes it already had when asked", () => {
		const result = mergeFullBlockList(["1"], 100, [{ profileId: "5", blocked: true, at: 50 }]);
		expect(result).toEqual(["1"]);
	});
});

describe("blockedFromStatsLog", () => {
	test("keeps only people whose latest entry is a block", () => {
		const result = blockedFromStatsLog([
			{ profile_id: "1", event_type: "block", timestamp: 1 },
			{ profile_id: "2", event_type: "block", timestamp: 1 },
			{ profile_id: "2", event_type: "unblock", timestamp: 2 },
			{ profile_id: "3", event_type: "unblock", timestamp: 1 },
			{ profile_id: "3", event_type: "block", timestamp: 3 },
			{ profile_id: null, event_type: "block", timestamp: 4 },
			{ profile_id: "not-an-id", event_type: "block", timestamp: 4 },
		]);
		expect(result.sort()).toEqual(["1", "3"]);
	});

	test("doesn't depend on row order", () => {
		const result = blockedFromStatsLog([
			{ profile_id: "2", event_type: "unblock", timestamp: 2 },
			{ profile_id: "2", event_type: "block", timestamp: 1 },
		]);
		expect(result).toEqual([]);
	});
});

describe("readSavedBlockList", () => {
	test("rejects anything that isn't a saved list", () => {
		expect(readSavedBlockList(null)).toBeNull();
		expect(readSavedBlockList({ version: 2, profileIds: [] })).toBeNull();
		expect(readSavedBlockList({ version: 1 })).toBeNull();
	});

	test("drops junk ids and duplicates", () => {
		expect(
			readSavedBlockList({ version: 1, savedAt: 5, fullListAt: 4, profileIds: ["1", 1, "x", 2] }),
		).toEqual({ version: 1, savedAt: 5, fullListAt: 4, profileIds: ["1", "2"] });
	});
});
