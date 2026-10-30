/**
 * exploreHeatmap.ts — Grindr's Explore heatmap: the gay neighbourhoods it
 * marks with a rainbow flag, and where its users gather around them.
 *
 * Two endpoints, read from the official Android app (26.20.0) since nobody
 * had documented them:
 *   GET  /v1/explore_heatmaps/all_locations → every flagged city and neighbourhood
 *   POST /v1/explore_heatmaps {coordinates, searchSquareSide, includeHeatmaps}
 *        → the flags and heat points inside a square around `coordinates`,
 *          `searchSquareSide` degrees wide. The official app sends the visible
 *          map's centre and max(lat span, lng span).
 * The activity is historical, not live, and only exists for a few dozen cities.
 *
 * A leaf module on purpose (zod only), so tests can import it.
 */

import z from "zod";

export type HeatmapPlace = {
	id: number;
	kind: "city" | "neighbourhood";
	name: string;
	/** The id of the city a neighbourhood belongs to; null for a city. */
	cityId: number | null;
	/** Where the flag sits. */
	lat: number;
	lon: number;
	/** Where Grindr's own Explore search is pointed when the flag is picked. */
	exploreLat: number;
	exploreLon: number;
};

export type HeatPoint = {
	lat: number;
	lon: number;
	/** 1 (quiet) to 5 (busiest) in every answer seen so far. */
	intensity: number;
};

export type HeatmapSquare = {
	lat: number;
	lon: number;
	/** Width and height of the square, in degrees. */
	side: number;
};

/** Below this zoom a city's flag shows; from it on, its neighbourhoods' flags do. */
export const NEIGHBOURHOOD_ZOOM = 10.5;
/** Heat is only asked for and drawn from this zoom on, as in the official app. */
export const HEAT_MIN_ZOOM = 10;
/** A wider square than this would cover a region rather than a city. */
export const MAX_SQUARE_SIDE = 1;

const coordinatesSchema = z.object({ lat: z.number(), lng: z.number() });

const locationSchema = z.object({
	id: z.number(),
	type: z.string().nullish(),
	name: z.string(),
	containedInId: z.number().nullish(),
	displayCoordinates: coordinatesSchema,
	exploreCascadeCoordinates: coordinatesSchema.nullish(),
});

const heatSchema = z.object({
	coordinates: coordinatesSchema,
	intensity: z.number(),
});

const responseSchema = z.object({
	locations: z.array(z.unknown()).nullish(),
	heatmaps: z.array(z.unknown()).nullish(),
});

/** Skips the entries it cannot read instead of failing the whole answer. */
function readEach<T>(entries: unknown[] | null | undefined, schema: z.ZodType<T>): T[] {
	return (entries ?? []).flatMap((entry) => {
		const parsed = schema.safeParse(entry);
		return parsed.success ? [parsed.data] : [];
	});
}

export function parseHeatmapResponse(payload: unknown): { places: HeatmapPlace[]; heat: HeatPoint[] } {
	const parsed = responseSchema.safeParse(payload);
	if (!parsed.success) return { places: [], heat: [] };
	const places = readEach(parsed.data.locations, locationSchema).map((location): HeatmapPlace => {
		const cityId = location.containedInId ? location.containedInId : null;
		const explore = location.exploreCascadeCoordinates ?? location.displayCoordinates;
		return {
			id: location.id,
			kind: location.type?.toLowerCase() === "city" || cityId === null ? "city" : "neighbourhood",
			name: location.name,
			cityId,
			lat: location.displayCoordinates.lat,
			lon: location.displayCoordinates.lng,
			exploreLat: explore.lat,
			exploreLon: explore.lng,
		};
	});
	const heat = readEach(parsed.data.heatmaps, heatSchema).map((point) => ({
		lat: point.coordinates.lat,
		lon: point.coordinates.lng,
		intensity: point.intensity,
	}));
	return { places, heat };
}

export function heatmapRequestBody(square: HeatmapSquare) {
	return {
		coordinates: { lat: square.lat, lng: square.lon },
		searchSquareSide: square.side,
		includeHeatmaps: true,
	};
}

/**
 * The square to ask for when the map shows these bounds, or null when it
 * shows too much to be worth asking. It is half again as wide as the view,
 * so a little panning stays inside what was already fetched.
 */
export function squareForView(view: { north: number; south: number; east: number; west: number }): HeatmapSquare | null {
	const side = Math.max(view.north - view.south, view.east - view.west);
	if (!(side > 0) || side > MAX_SQUARE_SIDE) return null;
	return { lat: (view.north + view.south) / 2, lon: (view.east + view.west) / 2, side: side * 1.5 };
}

export function squareCovers(square: HeatmapSquare, view: { north: number; south: number; east: number; west: number }): boolean {
	const half = square.side / 2;
	return (
		view.north <= square.lat + half &&
		view.south >= square.lat - half &&
		view.east <= square.lon + half &&
		view.west >= square.lon - half
	);
}

/** What a picked flag is called once it becomes the explore location: "Le Marais, Paris". */
export function placeLabel(place: HeatmapPlace, places: HeatmapPlace[]): string {
	const city = place.cityId === null ? null : places.find((other) => other.id === place.cityId);
	return city && city.name !== place.name ? `${place.name}, ${city.name}` : place.name;
}

/** Heat points from several answers, without the ones two overlapping squares both returned. */
export function mergeHeat(known: HeatPoint[], incoming: HeatPoint[]): HeatPoint[] {
	const seen = new Set(known.map((point) => `${point.lat},${point.lon}`));
	const merged = [...known];
	for (const point of incoming) {
		const key = `${point.lat},${point.lon}`;
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(point);
	}
	return merged;
}
