import { describe, expect, test } from "bun:test";
import { mergeBrowseCardImages } from "../src/pages/app/gridpage/cardImages";
import type { BrowseCard } from "../src/types/grid";

const card = (profileId: string, primaryImageUrl?: string | null): BrowseCard => ({
	profileId,
	displayName: `Profile ${profileId}`,
	primaryImageUrl,
});

describe("mergeBrowseCardImages", () => {
	// The bug this guards: the grid endpoint now and then leaves the photo out of
	// a card that is otherwise complete, and a refresh replaced the whole list, so
	// the tile flashed to the no-photo placeholder until the next refresh.
	test("a card that lost its photo on a refresh keeps the one it had", () => {
		const merged = mergeBrowseCardImages(
			[card("1", "https://cdn/a.jpg"), card("2", "https://cdn/b.jpg")],
			[card("1"), card("2", null)],
		);
		expect(merged.map((c) => c.primaryImageUrl)).toEqual(["https://cdn/a.jpg", "https://cdn/b.jpg"]);
	});

	test("a photo the server did send always wins over the old one", () => {
		const merged = mergeBrowseCardImages(
			[card("1", "https://cdn/old.jpg")],
			[card("1", "https://cdn/new.jpg")],
		);
		expect(merged[0].primaryImageUrl).toBe("https://cdn/new.jpg");
	});

	test("a profile never seen with a photo stays without one", () => {
		const merged = mergeBrowseCardImages([card("1", "https://cdn/a.jpg"), card("2")], [card("2"), card("3")]);
		expect(merged.map((c) => c.primaryImageUrl ?? null)).toEqual([null, null]);
	});

	test("only the photo is carried over, everything else is the fresh card", () => {
		const fresh: BrowseCard = { ...card("1"), displayName: "Renamed", distanceMeters: 120 };
		const [merged] = mergeBrowseCardImages([{ ...card("1", "https://cdn/a.jpg"), distanceMeters: 900 }], [fresh]);
		expect(merged).toEqual({ ...fresh, primaryImageUrl: "https://cdn/a.jpg" });
	});

	test("with nothing to carry over, the fresh list is returned as it is", () => {
		const next = [card("1"), card("2", "https://cdn/b.jpg")];
		expect(mergeBrowseCardImages([], next)).toBe(next);
		expect(mergeBrowseCardImages([card("9")], next)).toBe(next);
	});
});
