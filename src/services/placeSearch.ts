/**
 * placeSearch.ts — place suggestions while the user types.
 *
 * Photon (komoot's OSM geocoder) matches on the start of a name, so "Amster"
 * finds Amsterdam. Nominatim, which did this before, only matches whole
 * words: the same query returned an industrial estate in Ottawa and four
 * shops in Ukraine. Nominatim stays as the fallback for when Photon is down
 * or finds nothing.
 *
 * A leaf module on purpose (zod only), so tests can import it.
 */

import z from "zod";

export type PlaceKind =
	| "country"
	| "region"
	| "city"
	| "village"
	| "district"
	| "street"
	| "address"
	| "island"
	| "place";

export type PlaceResult = {
	lat: number;
	lon: number;
	/** The place itself: "Amsterdam". */
	title: string;
	/** Where it is, so two places with one name can be told apart: "Hollande-Septentrionale, Pays-Bas". */
	context: string;
	kind: PlaceKind;
	/** The name the location is saved under once picked: "Amsterdam, Pays-Bas". */
	label: string;
	city: string | null;
};

const MAX_RESULTS = 7;
/** Photon lists a city once as a place and once as its boundary, and a station once per platform. */
const SAME_PLACE_KM = 5;
/** The languages the public Photon server can answer in; any other gets each place's local name. */
const PHOTON_LANGUAGES = ["en", "fr", "de"];

const optionalText = z.string().nullish();

const photonPropertiesSchema = z.object({
	osm_key: optionalText,
	osm_value: optionalText,
	type: optionalText,
	name: optionalText,
	street: optionalText,
	housenumber: optionalText,
	district: optionalText,
	city: optionalText,
	county: optionalText,
	state: optionalText,
	country: optionalText,
});

export type PhotonProperties = z.infer<typeof photonPropertiesSchema>;

const photonResponseSchema = z.object({
	features: z.array(
		z.object({
			geometry: z.object({ coordinates: z.tuple([z.number(), z.number()]) }),
			properties: photonPropertiesSchema,
		}),
	),
});

const nominatimResultSchema = z.object({
	display_name: z.string(),
	lat: z.string(),
	lon: z.string(),
	name: optionalText,
	addresstype: optionalText,
	address: z
		.object({
			road: optionalText,
			house_number: optionalText,
			neighbourhood: optionalText,
			suburb: optionalText,
			borough: optionalText,
			city_district: optionalText,
			city: optionalText,
			town: optionalText,
			village: optionalText,
			municipality: optionalText,
			county: optionalText,
			state: optionalText,
			country: optionalText,
		})
		.nullish(),
});

type NominatimResult = z.infer<typeof nominatimResultSchema>;

type PlaceParts = {
	title: string;
	kind: PlaceKind;
	street: string | null;
	district: string | null;
	city: string | null;
	county: string | null;
	state: string | null;
	country: string | null;
};

function sameText(a: string, b: string): boolean {
	return a.localeCompare(b, undefined, { sensitivity: "base" }) === 0;
}

function assemble(lat: number, lon: number, parts: PlaceParts): PlaceResult {
	const { title, kind } = parts;
	// From the nearest to the widest. Past three, the middle levels go first:
	// the street and the country say more than the county between them.
	let around: { level: string; text: string }[] = [];
	for (const level of ["street", "district", "city", "county", "state", "country"] as const) {
		const text = parts[level];
		if (!text || sameText(text, title) || around.some((part) => sameText(part.text, text))) continue;
		around.push({ level, text });
	}
	for (const level of ["county", "state", "district", "street"]) {
		if (around.length <= 3) break;
		around = around.filter((part) => part.level !== level);
	}

	const isCity = kind === "city" || kind === "village";
	const within = !isCity && parts.city && !sameText(parts.city, title) ? parts.city : parts.country;
	return {
		lat,
		lon,
		title,
		context: around.map((part) => part.text).join(", "),
		kind,
		label: within && !sameText(within, title) ? `${title}, ${within}` : title,
		city: isCity ? title : parts.city,
	};
}

function photonKind(properties: PhotonProperties): PlaceKind {
	const value = properties.osm_value ?? "";
	if (properties.osm_key === "place") {
		if (value === "island" || value === "islet" || value === "archipelago") return "island";
		if (value === "village" || value === "hamlet" || value === "isolated_dwelling") return "village";
	}
	switch (properties.type) {
		case "country":
			return "country";
		case "state":
		case "county":
			return "region";
		case "city":
			return "city";
		case "district":
		case "locality":
			return "district";
		case "street":
			return "street";
		case "house":
			return properties.name ? "place" : "address";
		default:
			return "place";
	}
}

/** One Photon feature as a suggestion, or null when it has nothing to show as a name. */
export function placeFromPhoton(properties: PhotonProperties, lat: number, lon: number): PlaceResult | null {
	const street = properties.street
		? properties.housenumber
			? `${properties.street} ${properties.housenumber}`
			: properties.street
		: null;
	const title = properties.name ?? street ?? properties.city ?? properties.country;
	if (!title) return null;
	return assemble(lat, lon, {
		title,
		kind: photonKind(properties),
		street,
		district: properties.district ?? null,
		city: properties.city ?? null,
		county: properties.county ?? null,
		state: properties.state ?? null,
		country: properties.country ?? null,
	});
}

function nominatimKind(result: NominatimResult): PlaceKind {
	switch (result.addresstype) {
		case "country":
			return "country";
		case "state":
		case "region":
		case "province":
		case "county":
			return "region";
		case "city":
		case "town":
		case "municipality":
			return "city";
		case "village":
		case "hamlet":
			return "village";
		case "suburb":
		case "neighbourhood":
		case "quarter":
		case "borough":
		case "city_district":
			return "district";
		case "road":
			return "street";
		case "island":
			return "island";
		case "building":
		case "house_number":
			return result.name ? "place" : "address";
		default:
			return "place";
	}
}

function placeFromNominatim(result: NominatimResult): PlaceResult | null {
	const lat = Number(result.lat);
	const lon = Number(result.lon);
	if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
	const address = result.address ?? {};
	const street = address.road
		? address.house_number
			? `${address.road} ${address.house_number}`
			: address.road
		: null;
	const title = result.name || street || result.display_name.split(",")[0].trim();
	if (!title) return null;
	return assemble(lat, lon, {
		title,
		kind: nominatimKind(result),
		street,
		district: address.neighbourhood ?? address.suburb ?? address.borough ?? address.city_district ?? null,
		city: address.city ?? address.town ?? address.village ?? address.municipality ?? null,
		county: address.county ?? null,
		state: address.state ?? null,
		country: address.country ?? null,
	});
}

function distanceKm(a: PlaceResult, b: PlaceResult): number {
	const toRad = (degrees: number) => (degrees * Math.PI) / 180;
	const dLat = toRad(b.lat - a.lat);
	const dLon = toRad(b.lon - a.lon);
	const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
	return 6371 * 2 * Math.asin(Math.sqrt(h));
}

/** Keeps the first of several suggestions that carry one name for one spot, in the order given. */
export function dedupePlaces(places: PlaceResult[]): PlaceResult[] {
	const kept: PlaceResult[] = [];
	for (const place of places) {
		const repeated = kept.some(
			(other) => sameText(other.title, place.title) && distanceKm(other, place) < SAME_PLACE_KM,
		);
		if (!repeated) kept.push(place);
	}
	return kept;
}

function isAbort(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

function baseLanguage(language: string | undefined): string | null {
	return language ? language.toLowerCase().split("-")[0] : null;
}

async function searchPhoton(query: string, language: string | null, signal?: AbortSignal): Promise<PlaceResult[]> {
	const params = new URLSearchParams({ q: query, limit: "10" });
	if (language && PHOTON_LANGUAGES.includes(language)) params.set("lang", language);
	const response = await fetch(`https://photon.komoot.io/api/?${params.toString()}`, { signal });
	if (!response.ok) throw new Error(`photon answered ${response.status}`);
	const { features } = photonResponseSchema.parse(await response.json());
	return features
		.map(({ geometry, properties }) => placeFromPhoton(properties, geometry.coordinates[1], geometry.coordinates[0]))
		.filter((place): place is PlaceResult => place !== null);
}

async function searchNominatim(query: string, language: string | null, signal?: AbortSignal): Promise<PlaceResult[]> {
	const params = new URLSearchParams({ format: "json", addressdetails: "1", limit: "8", q: query });
	if (language) params.set("accept-language", language);
	const response = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`, { signal });
	if (!response.ok) throw new Error(`nominatim answered ${response.status}`);
	return z
		.array(nominatimResultSchema)
		.parse(await response.json())
		.map(placeFromNominatim)
		.filter((place): place is PlaceResult => place !== null);
}

/**
 * Suggestions for what has been typed so far, best match first. Throws only
 * when neither service could be reached (or the request was aborted); an
 * empty list means both answered and found nothing.
 */
export async function searchPlaces(
	query: string,
	options: { language?: string; signal?: AbortSignal } = {},
): Promise<PlaceResult[]> {
	const language = baseLanguage(options.language);
	let photonFailed = false;
	try {
		const places = dedupePlaces(await searchPhoton(query, language, options.signal));
		if (places.length > 0) return places.slice(0, MAX_RESULTS);
	} catch (error) {
		if (isAbort(error)) throw error;
		photonFailed = true;
	}
	try {
		return dedupePlaces(await searchNominatim(query, language, options.signal)).slice(0, MAX_RESULTS);
	} catch (error) {
		if (isAbort(error) || photonFailed) throw error;
		return [];
	}
}
