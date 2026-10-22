import { describe, expect, test } from "bun:test";
import { foldForSearch, searchSettings } from "../src/utils/settingsSearch";

const entries = [
	{ id: "appearance", label: "Appearance", section: "Settings", description: "Change color scheme and accent color." },
	{ id: "scheme", label: "Color Scheme", section: "Appearance" },
	{ id: "screen", label: "Keep Screen On", section: "Behavior", description: "Stop the screen from dimming." },
	{ id: "block", label: "Confirm Before Blocking", section: "Behavior", description: "Ask before blocking a profile." },
	{ id: "blocked", label: "Blocked Accounts", section: "Settings", description: "See who you blocked." },
	{ id: "ecran", label: "Garder l'écran allumé", section: "Comportement", description: "Empêche l'écran de s'éteindre." },
];

const ids = (query: string) => searchSettings(entries, query).map((entry) => entry.id);

describe("foldForSearch", () => {
	test("drops case and accents", () => {
		expect(foldForSearch("Écran Allumé")).toBe("ecran allume");
		expect(foldForSearch("PARAMÈTRES")).toBe("parametres");
	});
});

describe("searchSettings", () => {
	test("nothing typed finds nothing", () => {
		expect(ids("")).toEqual([]);
		expect(ids("   ")).toEqual([]);
	});

	test("finds a setting by part of its name, whatever the case", () => {
		expect(ids("scheme")).toEqual(["scheme", "appearance"]);
		expect(ids("KEEP")).toEqual(["screen"]);
	});

	test("finds an accented name typed without its accents, and the other way round", () => {
		expect(ids("ecran")).toEqual(["ecran"]);
		expect(ids("écran")).toEqual(["ecran"]);
		expect(ids("Scrèen")).toEqual(["screen"]);
	});

	test("every word typed has to be there, in any order", () => {
		expect(ids("before confirm")).toEqual(["block"]);
		expect(ids("confirm screen")).toEqual([]);
	});

	test("a word may come from the page the setting is on", () => {
		expect(ids("behavior screen")).toEqual(["screen"]);
	});

	test("the name of a page brings up the page, then what is on it", () => {
		expect(ids("appearance")).toEqual(["appearance", "scheme"]);
		expect(ids("behavior")).toEqual(["screen", "block"]);
	});

	test("names come before pages, and descriptions last", () => {
		// "block" is in two names, and in no page name; "profile" only in a description.
		expect(ids("block")).toEqual(["block", "blocked"]);
		expect(ids("profile")).toEqual(["block"]);
		// "color" is in one name and in another entry's description.
		expect(ids("color")).toEqual(["scheme", "appearance"]);
	});

	test("within a group the order given is kept", () => {
		expect(ids("s")).toEqual(["scheme", "screen", "blocked", "appearance", "block", "ecran"]);
	});

	test("leaves the list it was given alone", () => {
		const before = entries.map((entry) => entry.id);
		searchSettings(entries, "block");
		expect(entries.map((entry) => entry.id)).toEqual(before);
	});
});
