import { describe, expect, test } from "bun:test";
import {
	heatmapRequestBody,
	mergeHeat,
	parseHeatmapResponse,
	placeLabel,
	squareCovers,
	squareForView,
} from "../src/services/exploreHeatmap";

// Trimmed from what Grindr answered on 2026-10-14 for the centre of Paris.
const parisAnswer = {
	locations: [
		{
			id: 44,
			type: "City",
			name: "Paris",
			nameDecoration: "🇫🇷",
			containedInId: 0,
			displayCoordinates: { lat: 48.8566, lng: 2.3522 },
			exploreCascadeCoordinates: { lat: 48.8566, lng: 2.3522 },
		},
		{
			id: 45,
			type: "Neighbourhood",
			name: "Le Marais",
			nameDecoration: "🇫🇷",
			containedInId: 44,
			displayCoordinates: { lat: 48.8607, lng: 2.3574 },
			exploreCascadeCoordinates: { lat: 48.8607, lng: 2.3574 },
		},
	],
	heatmaps: [
		{ heatmapId: 1400, coordinates: { lat: 48.857252829564345, lng: 2.3573109660960743 }, intensity: 4 },
		{ heatmapId: 1400, coordinates: { lat: 48.862553720279884, lng: 2.3563109034053995 }, intensity: 5 },
	],
};

describe("explore heatmap", () => {
	test("reads the flags and the heat", () => {
		const { places, heat } = parseHeatmapResponse(parisAnswer);
		expect(places).toEqual([
			{ id: 44, kind: "city", name: "Paris", cityId: null, lat: 48.8566, lon: 2.3522, exploreLat: 48.8566, exploreLon: 2.3522 },
			{ id: 45, kind: "neighbourhood", name: "Le Marais", cityId: 44, lat: 48.8607, lon: 2.3574, exploreLat: 48.8607, exploreLon: 2.3574 },
		]);
		expect(heat).toEqual([
			{ lat: 48.857252829564345, lon: 2.3573109660960743, intensity: 4 },
			{ lat: 48.862553720279884, lon: 2.3563109034053995, intensity: 5 },
		]);
	});

	test("the all-locations answer has flags and no heat", () => {
		expect(parseHeatmapResponse({ locations: parisAnswer.locations }).heat).toEqual([]);
	});

	test("an entry it cannot read is skipped, not the whole answer", () => {
		const { places } = parseHeatmapResponse({ locations: [{ id: "x" }, parisAnswer.locations[0]] });
		expect(places.map((place) => place.name)).toEqual(["Paris"]);
		expect(parseHeatmapResponse(null)).toEqual({ places: [], heat: [] });
	});

	test("the request carries the three fields the official app sends", () => {
		expect(heatmapRequestBody({ lat: 48.8566, lon: 2.3522, side: 0.1 })).toEqual({
			coordinates: { lat: 48.8566, lng: 2.3522 },
			searchSquareSide: 0.1,
			includeHeatmaps: true,
		});
	});

	test("the square follows the view, a little wider, and is not asked for a whole region", () => {
		const view = { north: 48.9, south: 48.82, east: 2.42, west: 2.28 };
		const square = squareForView(view);
		expect(square?.lat).toBeCloseTo(48.86);
		expect(square?.lon).toBeCloseTo(2.35);
		expect(square?.side).toBeCloseTo(0.21);
		expect(square && squareCovers(square, view)).toBe(true);
		expect(squareForView({ north: 51, south: 47, east: 4, west: 0 })).toBeNull();
	});

	test("a view that moved out of the square needs a new one", () => {
		const square = { lat: 48.86, lon: 2.35, side: 0.2 };
		expect(squareCovers(square, { north: 48.9, south: 48.85, east: 2.4, west: 2.3 })).toBe(true);
		expect(squareCovers(square, { north: 49.1, south: 49.0, east: 2.4, west: 2.3 })).toBe(false);
	});

	test("a neighbourhood is named with its city", () => {
		const { places } = parseHeatmapResponse(parisAnswer);
		expect(placeLabel(places[1], places)).toBe("Le Marais, Paris");
		expect(placeLabel(places[0], places)).toBe("Paris");
	});

	test("heat fetched twice for overlapping squares is kept once", () => {
		const point = { lat: 1, lon: 2, intensity: 3 };
		expect(mergeHeat([point], [point, { lat: 1, lon: 3, intensity: 1 }])).toHaveLength(2);
	});
});
