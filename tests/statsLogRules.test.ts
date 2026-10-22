import { describe, expect, test } from "bun:test";
import {
	classifyBlockReason,
	describePhotoChange,
	isSameStatsPlace,
	resolveBlockReason,
	selectLoggableViewDistances,
	statsHourStart,
} from "../src/utils/statsLogRules";
import { encodeGeohash } from "../src/utils/geohash";

describe("classifyBlockReason", () => {
	// Every sentence below is one an auto-blocker produces today. If one of
	// them changes, its block must not silently fall into "other".
	const cases: [string, string, string | null][] = [
		["No Age Set", "no_age", null],
		["Age limit (19)", "age", "19"],
		["Age Limit (61)", "age", "61"],
		["Scanner: Age limit (19)", "age", "19"],
		["Distance limit", "distance", null],
		["Distance Limit (42km)", "distance", "42km"],
		["Has active 'Right Now' status", "right_now", null],
		["Forbidden 'Looking For' tag", "looking_for", null],
		["Has an X / Twitter account", "social_link", null],
		["Scanner: Has an X / Twitter account", "social_link", null],
		["Name keyword: cash", "name_keyword", "cash"],
		['Name keyword: "cash"', "name_keyword", "cash"],
		["Name Keyword: cash", "name_keyword", "cash"],
		["Bio keyword: party", "bio_keyword", "party"],
		['Bio keyword: "party"', "bio_keyword", "party"],
		["Message keyword: sup", "message_keyword", "sup"],
		['Message keyword: "sup"', "message_keyword", "sup"],
		["Keyword match", "keyword", null],
		['First message: "hey"', "first_message", "hey"],
		["Scanner: First message was media (Bot evasion)", "first_media", null],
		["First message was media (Bot evasion)", "first_media", null],
		["Left on seen for 12min", "left_on_seen", "12"],
		["Faceless profile: No media sent 5min after first message", "faceless", null],
		["Explicit photo", "explicit_media", null],
		["Explicit video", "explicit_media", null],
		["Explicit profile photo", "explicit_media", null],
		["Explicit album", "explicit_media", null],
		["Explicit profile photo: bare buttocks, 77% sure", "explicit_media", "bare buttocks, 77% sure"],
	];

	for (const [label, kind, detail] of cases) {
		test(`reads "${label}"`, () => {
			expect(classifyBlockReason(label)).toEqual({ kind: kind as never, detail });
		});
	}

	test("keeps anything unrecognised as other", () => {
		expect(classifyBlockReason("Something new")).toEqual({ kind: "other", detail: null });
		expect(classifyBlockReason(null)).toEqual({ kind: "other", detail: null });
	});

	test("an explicit kind wins over the label", () => {
		expect(
			resolveBlockReason({ kind: "rule", label: "Age limit (19)", detail: "new_chat" }),
		).toEqual({ kind: "rule", detail: "new_chat" });
	});
});

describe("isSameStatsPlace", () => {
	const paris = encodeGeohash(48.8566, 2.3522);

	test("GPS jitter of a few metres is the same place", () => {
		expect(isSameStatsPlace(paris, encodeGeohash(48.8567, 2.3524))).toBe(true);
	});

	test("the same place across a geohash cell boundary is still the same place", () => {
		// ~200 m apart, on either side of a 6-character cell edge.
		const west = encodeGeohash(48.85, 2.3510);
		const east = encodeGeohash(48.85, 2.3537);
		expect(west.slice(0, 6)).not.toBe(east.slice(0, 6));
		expect(isSameStatsPlace(west, east)).toBe(true);
	});

	test("a move of a couple of kilometres is a new place", () => {
		expect(isSameStatsPlace(paris, encodeGeohash(48.8738, 2.2950))).toBe(false);
	});

	test("an unreadable geohash never counts as the same place", () => {
		expect(isSameStatsPlace(paris, "not-a-geohash")).toBe(false);
	});
});

describe("statsHourStart", () => {
	test("rounds down to the start of the hour", () => {
		const hour = Date.UTC(2026, 8, 17, 14, 0, 0);
		expect(statsHourStart(hour)).toBe(hour);
		expect(statsHourStart(hour + 59 * 60 * 1000 + 999)).toBe(hour);
		expect(statsHourStart(hour + 60 * 60 * 1000)).toBe(hour + 60 * 60 * 1000);
	});
});

describe("selectLoggableViewDistances", () => {
	const now = Date.UTC(2026, 8, 17, 14, 0, 0);
	const hourAgo = now - 60 * 60 * 1000;

	test("keeps a recent view with a distance, keyed by the view", () => {
		expect(
			selectLoggableViewDistances(
				[{ profileId: "42", timestamp: hourAgo, distanceMeters: 1200 }],
				now,
				"preview:",
			),
		).toEqual([
			{ id: `42:${hourAgo}`, profileId: "42", viewTimestamp: hourAgo, distanceMeters: 1200 },
		]);
	});

	test("reads a view time given in seconds", () => {
		const [view] = selectLoggableViewDistances(
			[{ profileId: "42", timestamp: hourAgo / 1000, distanceMeters: 5 }],
			now,
			"preview:",
		);
		expect(view?.viewTimestamp).toBe(hourAgo);
	});

	test("a distance of zero is a real distance", () => {
		expect(
			selectLoggableViewDistances(
				[{ profileId: "42", timestamp: hourAgo, distanceMeters: 0 }],
				now,
				"preview:",
			),
		).toHaveLength(1);
	});

	test("skips what cannot be trusted", () => {
		expect(
			selectLoggableViewDistances(
				[
					{ profileId: "preview:abc", timestamp: hourAgo, distanceMeters: 100 },
					{ profileId: "1", timestamp: hourAgo, distanceMeters: null },
					{ profileId: "2", timestamp: null, distanceMeters: 100 },
					{ profileId: "3", timestamp: hourAgo, distanceMeters: 100, hasExactTimestamp: false },
					{ profileId: "4", timestamp: now - 25 * 60 * 60 * 1000, distanceMeters: 100 },
					{ profileId: "5", timestamp: hourAgo, distanceMeters: -1 },
				],
				now,
				"preview:",
			),
		).toEqual([]);
	});

	test("the same view listed twice is kept once", () => {
		expect(
			selectLoggableViewDistances(
				[
					{ profileId: "42", timestamp: hourAgo, distanceMeters: 1200 },
					{ profileId: "42", timestamp: hourAgo, distanceMeters: 1200 },
				],
				now,
				"preview:",
			),
		).toHaveLength(1);
	});
});

describe("describePhotoChange", () => {
	test("a new first photo is a main photo change", () => {
		expect(describePhotoChange(["a", "b"], ["b", "a"])).toEqual(["mainPhoto"]);
	});

	test("adding a photo at the end keeps the main photo", () => {
		expect(describePhotoChange(["a"], ["a", "b"])).toEqual(["photoAdded"]);
	});

	test("replacing the main photo is both a main photo change and an add/remove", () => {
		expect(describePhotoChange(["a", "b"], ["c", "b"])).toEqual([
			"mainPhoto",
			"photoAdded",
			"photoRemoved",
		]);
	});

	test("reordering only the other photos", () => {
		expect(describePhotoChange(["a", "b", "c"], ["a", "c", "b"])).toEqual(["photoOrder"]);
	});

	test("nothing changed", () => {
		expect(describePhotoChange(["a", "b"], ["a", "b"])).toEqual([]);
	});
});
