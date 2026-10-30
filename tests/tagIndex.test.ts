import { describe, expect, test } from "bun:test";
import { buildTagIndex, toTagKeys } from "../src/utils/tags";

// A catalog as the server sends it for a French session: keys stay the same in
// every language, texts do not.
const FRENCH = [
	{ key: "twink", text: "Minet" },
	{ key: "dad-bod", text: "Papa poule" },
	{ key: "muscle", text: "Musclé" },
	{ key: "bear", text: "Ours" },
];

describe("buildTagIndex", () => {
	const index = buildTagIndex(FRENCH);

	test("a key stays a key and shows its text", () => {
		expect(index.keyFor("twink")).toBe("twink");
		expect(index.labelFor("twink")).toBe("Minet");
	});

	// The bug this guards: tags were stored as the text shown, lower-cased in the
	// grid filter, and sent like that. The server matches on keys, so a filter
	// picked in French matched nobody.
	test("a value saved the old way, as text, resolves to its key", () => {
		expect(index.keyFor("minet")).toBe("twink");
		expect(index.keyFor("Papa poule")).toBe("dad-bod");
		expect(index.keyFor("  MUSCLÉ ")).toBe("muscle");
		expect(index.labelFor("papa poule")).toBe("Papa poule");
	});

	test("a key is matched whatever its case", () => {
		expect(index.keyFor("Dad-Bod")).toBe("dad-bod");
	});

	test("a free-typed tag the catalog does not know is left alone", () => {
		expect(index.keyFor("leather daddy")).toBe("leather daddy");
		expect(index.labelFor("leather daddy")).toBe("leather daddy");
	});

	test("a text that spells another tag's key never takes that key's place", () => {
		const tricky = buildTagIndex([
			{ key: "bear", text: "Ours" },
			{ key: "cub", text: "Bear" },
		]);
		expect(tricky.keyFor("bear")).toBe("bear");
		expect(tricky.labelFor("bear")).toBe("Ours");
	});

	test("with no catalog yet, values pass through unchanged", () => {
		const empty = buildTagIndex([]);
		expect(empty.keyFor("twink")).toBe("twink");
		expect(empty.labelFor("Minet")).toBe("Minet");
	});
});

describe("toTagKeys", () => {
	const index = buildTagIndex(FRENCH);

	test("old and new forms of one tag are sent once, in order", () => {
		expect(toTagKeys(index, ["minet", "bear", "twink", "Ours"])).toEqual(["twink", "bear"]);
	});

	test("blanks are dropped and unknown tags kept", () => {
		expect(toTagKeys(index, ["", "  ", "leather daddy", "muscle"])).toEqual([
			"leather daddy",
			"muscle",
		]);
	});
});
