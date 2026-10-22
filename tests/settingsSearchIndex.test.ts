import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The list of searchable settings needs the app around it, so it is read as
// text here: these tests are about what it points at, not about running it.
const root = join(import.meta.dir, "..");
const indexSource = readFileSync(join(root, "src", "data", "settingsSearchIndex.ts"), "utf8");

function sourcesUnder(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return sourcesUnder(path);
		// Line endings differ from one checkout to the next.
		return entry.name.endsWith(".tsx") ? [readFileSync(path, "utf8").replace(/\r\n/g, "\n")] : [];
	});
}

function textAt(translations: unknown, key: string): unknown {
	return key.split(".").reduce<unknown>(
		(node, part) => (node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined),
		translations,
	);
}

describe("settings search index", () => {
	const keys = [...new Set([...indexSource.matchAll(/\bt\("([^"]+)"/g)].map((match) => match[1]))];

	test("reads its texts from entries, never from text written in the list", () => {
		expect(keys.length).toBeGreaterThan(100);
		expect(indexSource).not.toContain("defaultValue");
	});

	// A result has to read like the row it opens, in the language the app is
	// in: a text missing from a file would show as its raw key.
	for (const language of ["en", "fr"]) {
		test(`every text it shows exists in ${language}`, () => {
			const translations = JSON.parse(
				readFileSync(join(root, "public", "locales", language, "translation.json"), "utf8"),
			);
			const missing = keys.filter((key) => {
				const text = textAt(translations, key);
				return typeof text !== "string" || text.trim() === "";
			});
			expect(missing).toEqual([]);
		});
	}

	test("every row it can jump to carries that id on a page", () => {
		const anchors = [
			...new Set(
				[...indexSource.matchAll(/"((?:cust|behavior|notif|privacy|automation|data|settings)-[a-z0-9-]+)"/g)]
					.map((match) => match[1])
					// Names of results only: several of them open the same folded section.
					.filter((id) => !id.startsWith("automation-item-")),
			),
		];
		expect(anchors.length).toBeGreaterThan(50);

		const pages = [
			...sourcesUnder(join(root, "src", "pages")),
			...sourcesUnder(join(root, "src", "components")),
		].join("\n");
		// Written as an attribute, or handed to the Settings screen's row helper
		// as its last argument.
		const missing = anchors.filter(
			(anchor) => !pages.includes(`id="${anchor}"`) && !pages.includes(`"${anchor}",\n`),
		);
		expect(missing).toEqual([]);
	});

	test("no result shares its name with another", () => {
		const names = [...indexSource.matchAll(/"((?:nav|cust|behavior|notif|privacy|data|settings)-[a-z0-9-]+|automation-item-[a-z0-9-]+)"/g)]
			.map((match) => match[1]);
		// An anchor may be written twice (a row and the fallback of another);
		// the names given as a result's own id may not.
		const itemNames = names.filter((name) => name.startsWith("automation-item-") || name.startsWith("nav-"));
		expect(new Set(itemNames).size).toBe(itemNames.length);
	});
});
