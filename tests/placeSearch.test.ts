import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	dedupePlaces,
	placeFromPhoton,
	type PhotonProperties,
	type PlaceKind,
	type PlaceResult,
} from "../src/services/placeSearch";

const root = join(import.meta.dir, "..");

function place(properties: PhotonProperties, lat: number, lon: number): PlaceResult {
	const result = placeFromPhoton(properties, lat, lon);
	if (!result) throw new Error("no place");
	return result;
}

// What Photon answered for "Amster" and friends on 2026-10-13, in French.
const amsterdam = { osm_key: "place", osm_value: "city", type: "city", name: "Amsterdam", state: "Hollande-Septentrionale", country: "Pays-Bas" };
const amsterdamBoundary = { ...amsterdam, osm_key: "boundary", osm_value: "administrative" };
const amsterdamNewYork = { osm_key: "place", osm_value: "city", type: "city", name: "Amsterdam", state: "New York", country: "États-Unis d'Amérique" };

describe("place suggestions", () => {
	test("a city says what it is and where", () => {
		expect(place(amsterdam, 52.373, 4.892)).toEqual({
			lat: 52.373,
			lon: 4.892,
			title: "Amsterdam",
			context: "Hollande-Septentrionale, Pays-Bas",
			kind: "city",
			label: "Amsterdam, Pays-Bas",
			city: "Amsterdam",
		});
	});

	test("two cities with one name read differently", () => {
		const dutch = place(amsterdam, 52.373, 4.892);
		const american = place(amsterdamNewYork, 42.939, -74.188);
		expect(american.context).toBe("New York, États-Unis d'Amérique");
		expect(american.label).not.toBe(dutch.label);
	});

	test("a neighbourhood is named with its city", () => {
		const marais = place(
			{ osm_key: "place", osm_value: "suburb", type: "district", name: "Le Marais", city: "Paris", state: "Île-de-France", country: "France" },
			48.86,
			2.361,
		);
		expect(marais.kind).toBe("district");
		expect(marais.context).toBe("Paris, Île-de-France, France");
		expect(marais.label).toBe("Le Marais, Paris");
		expect(marais.city).toBe("Paris");
	});

	test("a street drops what repeats and keeps city and country", () => {
		const avenue = place(
			{ osm_key: "highway", osm_value: "primary", type: "street", name: "Amsterdam Avenue", district: "Manhattan", city: "New York", state: "New York", country: "États-Unis d'Amérique" },
			40.796,
			-73.969,
		);
		expect(avenue.kind).toBe("street");
		expect(avenue.context).toBe("Manhattan, New York, États-Unis d'Amérique");
	});

	test("an address without a name is titled by its street and number", () => {
		const rivoli = place(
			{ osm_key: "place", osm_value: "house", type: "house", street: "Rue de Rivoli", housenumber: "12", district: "Le Marais", city: "Paris", state: "Île-de-France", country: "France" },
			48.856,
			2.36,
		);
		expect(rivoli.kind).toBe("address");
		expect(rivoli.title).toBe("Rue de Rivoli 12");
		expect(rivoli.context).toBe("Le Marais, Paris, France");
		expect(rivoli.label).toBe("Rue de Rivoli 12, Paris");
	});

	test("a venue keeps its street and city when something has to go", () => {
		const club = place(
			{ osm_key: "amenity", osm_value: "nightclub", type: "house", name: "Berghain", street: "Am Wriezener Bahnhof", district: "Friedrichshain", city: "Berlin", country: "Allemagne" },
			52.511,
			13.443,
		);
		expect(club.kind).toBe("place");
		expect(club.context).toBe("Am Wriezener Bahnhof, Berlin, Allemagne");
	});

	test("islands, villages, regions and countries are told apart", () => {
		expect(place({ osm_key: "place", osm_value: "island", type: "other", name: "Ibiza", country: "Espagne" }, 38.97, 1.42).kind).toBe("island");
		expect(place({ osm_key: "place", osm_value: "hamlet", type: "district", name: "Amsterdam", city: "Holland", country: "États-Unis d'Amérique" }, 40.6, -75.1).kind).toBe("village");
		expect(place({ osm_key: "place", osm_value: "state", type: "state", name: "New York", country: "États-Unis d'Amérique" }, 43.1, -75.8).kind).toBe("region");
		const paraguay = place({ osm_key: "place", osm_value: "country", type: "country", name: "Paraguay", country: "Paraguay" }, -23.3, -58.1);
		expect(paraguay.kind).toBe("country");
		expect(paraguay.context).toBe("");
		expect(paraguay.label).toBe("Paraguay");
	});

	test("a feature with nothing to call it by is left out", () => {
		expect(placeFromPhoton({ osm_key: "building", osm_value: "yes", type: "house" }, 1, 2)).toBeNull();
	});

	test("a city listed as a place and as its boundary shows once, the far namesake stays", () => {
		const list = dedupePlaces([
			place(amsterdam, 52.373, 4.892),
			place(amsterdamBoundary, 52.375, 4.898),
			place(amsterdamNewYork, 42.939, -74.188),
		]);
		expect(list.map((entry) => entry.context)).toEqual([
			"Hollande-Septentrionale, Pays-Bas",
			"New York, États-Unis d'Amérique",
		]);
	});

	test("every kind has its word in English and French", () => {
		const kinds: Record<PlaceKind, true> = {
			country: true,
			region: true,
			city: true,
			village: true,
			district: true,
			street: true,
			address: true,
			island: true,
			place: true,
		};
		for (const language of ["en", "fr"]) {
			const translations = JSON.parse(
				readFileSync(join(root, "public", "locales", language, "translation.json"), "utf8"),
			);
			expect(Object.keys(translations.browse_location.place_kind).sort()).toEqual(Object.keys(kinds).sort());
		}
	});
});
