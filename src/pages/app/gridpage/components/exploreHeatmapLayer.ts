/**
 * exploreHeatmapLayer.ts — draws Grindr's Explore heatmap on a MapLibre map:
 * a rainbow flag on each gay neighbourhood Grindr knows (the city's flag
 * when zoomed out, its neighbourhoods' flags when zoomed in), and purple
 * heat where its users gather once the map is close enough to a city.
 *
 * Heat is fetched like the official app does it: for the square around
 * what the map shows, and again only once the view leaves every square
 * already fetched. See services/exploreHeatmap.ts for the endpoints.
 */

import {
	HEAT_MIN_ZOOM,
	NEIGHBOURHOOD_ZOOM,
	mergeHeat,
	squareCovers,
	squareForView,
	type HeatPoint,
	type HeatmapPlace,
	type HeatmapSquare,
} from "../../../../services/exploreHeatmap";
import { appLog } from "../../../../utils/logger";

export type ExploreHeatmapSource = {
	loadPlaces(): Promise<HeatmapPlace[]>;
	loadSquare(square: HeatmapSquare): Promise<{ places: HeatmapPlace[]; heat: HeatPoint[] }>;
	onPickPlace(place: HeatmapPlace, places: HeatmapPlace[]): void;
};

export type ExploreHeatmapLayer = {
	detach(): void;
	/** True right after a flag was tapped, so the map does not also treat the tap as a pick of that spot. */
	ownsClick(): boolean;
};

const SOURCE_ID = "fg-explore-heat";
const LAYER_ID = "fg-explore-heat";
const FETCH_DELAY_MS = 400;
/** Below this zoom the whole world shows and the flags would only pile up. */
const FLAGS_MIN_ZOOM = 3;

// The flagged places are the same for everyone and change rarely: one
// request per app session is enough.
let placesCache: Promise<HeatmapPlace[]> | null = null;

function loadPlacesOnce(source: ExploreHeatmapSource): Promise<HeatmapPlace[]> {
	if (!placesCache) {
		placesCache = source.loadPlaces().catch((error) => {
			placesCache = null;
			throw error;
		});
	}
	return placesCache;
}

function flagElement(place: HeatmapPlace): HTMLButtonElement {
	const element = document.createElement("button");
	element.type = "button";
	element.title = place.name;
	element.setAttribute("aria-label", place.name);
	// No `position` here: MapLibre's marker class makes it absolute, which
	// also anchors the name below. An inline `position:relative` overrode
	// that and laid the flags out one after another, so the more flags were
	// showing, the further each drifted from its place.
	element.style.cssText =
		"width:34px;height:34px;padding:0;border:none;border-radius:9999px;background:#111;" +
		"display:flex;align-items:center;justify-content:center;font-size:18px;line-height:1;cursor:pointer;" +
		"box-shadow:0 2px 6px rgba(0,0,0,.45);";
	const flag = document.createElement("span");
	flag.textContent = "🏳️‍🌈";
	const name = document.createElement("span");
	name.textContent = place.name;
	name.style.cssText =
		"position:absolute;top:37px;left:50%;transform:translateX(-50%);white-space:nowrap;padding:2px 8px;" +
		"border-radius:9999px;background:#111;color:#fff;font:600 12px/1.4 system-ui,sans-serif;" +
		"box-shadow:0 2px 6px rgba(0,0,0,.35);";
	element.append(flag, name);
	return element;
}

function heatCollection(heat: HeatPoint[]) {
	return {
		type: "FeatureCollection" as const,
		features: heat.map((point) => ({
			type: "Feature" as const,
			properties: { intensity: point.intensity },
			geometry: { type: "Point" as const, coordinates: [point.lon, point.lat] },
		})),
	};
}

export function attachExploreHeatmap(map: any, maplibregl: any, source: ExploreHeatmapSource): ExploreHeatmapLayer {
	let detached = false;
	let places: HeatmapPlace[] = [];
	let heat: HeatPoint[] = [];
	const fetchedSquares: HeatmapSquare[] = [];
	const markers = new Map<number, { place: HeatmapPlace; marker: any; element: HTMLElement }>();
	let fetchTimer: ReturnType<typeof setTimeout> | null = null;
	let fetching = false;
	let fetchAgain = false;
	let lastFlagTapAt = 0;

	const showFlagsForZoom = () => {
		const zoom = map.getZoom();
		for (const { place, element } of markers.values()) {
			const visible =
				place.kind === "city" ? zoom >= FLAGS_MIN_ZOOM && zoom < NEIGHBOURHOOD_ZOOM : zoom >= NEIGHBOURHOOD_ZOOM;
			element.style.display = visible ? "flex" : "none";
		}
	};

	const addPlaces = (incoming: HeatmapPlace[]) => {
		for (const place of incoming) {
			if (markers.has(place.id)) continue;
			places = [...places.filter((known) => known.id !== place.id), place];
			const element = flagElement(place);
			element.addEventListener("click", (event) => {
				event.stopPropagation();
				lastFlagTapAt = Date.now();
				source.onPickPlace(place, places);
			});
			const marker = new maplibregl.Marker({ element, anchor: "center" }).setLngLat([place.lon, place.lat]).addTo(map);
			markers.set(place.id, { place, marker, element });
		}
		showFlagsForZoom();
	};

	// Custom layers do not survive a style change (the light/dark switch),
	// so this runs again on every style.load.
	const ensureHeatLayer = () => {
		if (detached) return;
		try {
			const existing = map.getSource(SOURCE_ID);
			if (existing) {
				existing.setData(heatCollection(heat));
				return;
			}
			map.addSource(SOURCE_ID, { type: "geojson", data: heatCollection(heat) });
			const firstLabelLayer = (map.getStyle()?.layers ?? []).find((layer: any) => layer.type === "symbol")?.id;
			map.addLayer(
				{
					id: LAYER_ID,
					type: "heatmap",
					source: SOURCE_ID,
					minzoom: HEAT_MIN_ZOOM - 1,
					paint: {
						"heatmap-weight": ["interpolate", ["linear"], ["get", "intensity"], 0, 0, 5, 1],
						"heatmap-intensity": ["interpolate", ["linear"], ["zoom"], HEAT_MIN_ZOOM, 1, 15, 1.5],
						// Grindr's points sit a few hundred metres apart. Doubling per zoom
						// level keeps each about 900 m wide on the ground, so neighbours
						// melt into one cloud as in the official app instead of dots.
						"heatmap-radius": ["interpolate", ["exponential", 2], ["zoom"], 10, 9, 13, 72, 16, 576],
						"heatmap-color": [
							"interpolate",
							["linear"],
							["heatmap-density"],
							0, "rgba(147, 51, 234, 0)",
							0.15, "rgba(147, 51, 234, 0.25)",
							0.4, "rgba(168, 85, 247, 0.5)",
							0.7, "rgba(217, 70, 239, 0.7)",
							1, "rgba(244, 184, 228, 0.85)",
						],
						"heatmap-opacity": ["interpolate", ["linear"], ["zoom"], HEAT_MIN_ZOOM - 0.5, 0, HEAT_MIN_ZOOM + 0.5, 0.8],
					},
				},
				firstLabelLayer,
			);
		} catch {
			// The style is still loading; style.load / load call this again.
		}
	};

	const fetchVisibleHeat = async () => {
		if (detached) return;
		if (fetching) {
			fetchAgain = true;
			return;
		}
		if (map.getZoom() < HEAT_MIN_ZOOM) return;
		const bounds = map.getBounds();
		const view = { north: bounds.getNorth(), south: bounds.getSouth(), east: bounds.getEast(), west: bounds.getWest() };
		if (fetchedSquares.some((square) => squareCovers(square, view))) return;
		const square = squareForView(view);
		if (!square) return;

		fetching = true;
		try {
			const answer = await source.loadSquare(square);
			if (detached) return;
			fetchedSquares.push(square);
			heat = mergeHeat(heat, answer.heat);
			addPlaces(answer.places);
			ensureHeatLayer();
		} catch (error) {
			// Not remembered as fetched, so the next move asks again.
			appLog.warn("[heatmap] could not load the heat for this area", error);
		} finally {
			fetching = false;
			if (fetchAgain && !detached) {
				fetchAgain = false;
				scheduleFetch();
			}
		}
	};

	const scheduleFetch = () => {
		if (fetchTimer) clearTimeout(fetchTimer);
		fetchTimer = setTimeout(() => {
			fetchTimer = null;
			void fetchVisibleHeat();
		}, FETCH_DELAY_MS);
	};

	map.on("style.load", ensureHeatLayer);
	map.on("load", ensureHeatLayer);
	map.on("zoom", showFlagsForZoom);
	map.on("moveend", scheduleFetch);
	ensureHeatLayer();
	scheduleFetch();

	loadPlacesOnce(source)
		.then((loaded) => {
			if (!detached) addPlaces(loaded);
		})
		.catch((error) => appLog.warn("[heatmap] could not load the flagged places", error));

	return {
		detach() {
			detached = true;
			if (fetchTimer) clearTimeout(fetchTimer);
			for (const { marker } of markers.values()) marker.remove();
			markers.clear();
			try {
				map.off("style.load", ensureHeatLayer);
				map.off("load", ensureHeatLayer);
				map.off("zoom", showFlagsForZoom);
				map.off("moveend", scheduleFetch);
				if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
				if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
			} catch {
				// The map itself is already gone (the picker was unmounted).
			}
		},
		ownsClick() {
			return Date.now() - lastFlagTapAt < 400;
		},
	};
}
