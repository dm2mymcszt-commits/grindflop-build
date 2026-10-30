import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// English and French are the two languages the app ships. These tests keep
// them in step: a text the code asks for and English lacks shows as its raw
// key, and one French lacks falls back to English in the middle of a French
// screen.
const root = join(import.meta.dir, "..");

function load(language: string): Record<string, unknown> {
	return JSON.parse(readFileSync(join(root, "public", "locales", language, "translation.json"), "utf8"));
}

function flatten(node: Record<string, unknown>, prefix = ""): Map<string, string> {
	const out = new Map<string, string>();
	for (const [key, value] of Object.entries(node)) {
		if (value && typeof value === "object") {
			for (const [inner, text] of flatten(value as Record<string, unknown>, `${prefix}${key}.`)) {
				out.set(inner, text);
			}
		} else {
			out.set(prefix + key, String(value));
		}
	}
	return out;
}

function sourcesUnder(dir: string): { path: string; text: string }[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return sourcesUnder(path);
		return /\.tsx?$/.test(entry.name) ? [{ path, text: readFileSync(path, "utf8") }] : [];
	});
}

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

const en = flatten(load("en"));
const fr = flatten(load("fr"));
const namespaces = new Set(Object.keys(load("en")));

/** A key the code names is there as itself or, for a counted text, as its plural forms. */
function known(texts: Map<string, string>, key: string): boolean {
	return texts.has(key) || texts.has(`${key}_other`);
}

function placeholders(text: string): string[] {
	return [...text.matchAll(/\{\{\s*([^},\s]+)[^}]*\}\}/g)].map((match) => match[1]).sort();
}

function tags(text: string): string[] {
	return [...text.matchAll(/<\/?([a-zA-Z0-9]+)\s*\/?>/g)].map((match) => match[0]).sort();
}

describe("locale files", () => {
	test("the code only asks for texts English has", () => {
		const missing = new Set<string>();
		// t("a.b"), i18n.t("a.b"), tRef.current("a.b"), translate("a.b"), <Trans i18nKey="a.b" />, and
		// tables that carry their keys as titleKey: "a.b".
		const patterns = [
			/\b(?:t|translate|tRef\.current)\(\s*(["'`])([A-Za-z0-9_]+(?:\.[A-Za-z0-9_-]+)+)\1/g,
			/\bi18nKey=(["'])([A-Za-z0-9_]+(?:\.[A-Za-z0-9_-]+)+)\1/g,
			/\b[A-Za-z]*Key:\s*(["'])([A-Za-z0-9_]+(?:\.[A-Za-z0-9_-]+)+)\1/g,
		];
		for (const { text } of sourcesUnder(join(root, "src"))) {
			for (const pattern of patterns) {
				for (const match of text.matchAll(pattern)) {
					const key = match[2];
					if (!namespaces.has(key.split(".")[0])) continue;
					if (!known(en, key)) missing.add(key);
				}
			}
		}
		expect([...missing].sort()).toEqual([]);
	});

	test("French has every English text", () => {
		expect([...en.keys()].filter((key) => !fr.has(key))).toEqual([]);
	});

	test("French has nothing English lacks, apart from its extra plural form", () => {
		const extra = [...fr.keys()].filter((key) => !en.has(key));
		// French counts 1 000 000 differently from 2: "_many" sits beside "_other".
		const unexplained = extra.filter(
			(key) => !(key.endsWith("_many") && en.has(key.replace(/_many$/, "_other"))),
		);
		expect(unexplained).toEqual([]);
	});

	test("a counted English text also has the form for one", () => {
		// With only "_other", or only the bare key, "1 chats" is what gets shown.
		// Told apart from a key that merely ends that way ("blocked_by_other")
		// by the number it prints.
		const lonely = [...en].filter(
			([key, text]) =>
				key.endsWith("_other") && text.includes("{{count}}") && !en.has(key.replace(/_other$/, "_one")),
		).map(([key]) => key);
		expect(lonely).toEqual([]);
	});

	test("French keeps the values and the markup of each English text", () => {
		const different: string[] = [];
		for (const [key, english] of en) {
			const french = fr.get(key);
			if (french === undefined) continue;
			if (placeholders(english).join() !== placeholders(french).join()) different.push(`${key}: values`);
			if (tags(english).join() !== tags(french).join()) different.push(`${key}: markup`);
		}
		expect(different).toEqual([]);
	});

	test("no text is empty", () => {
		const empty = (texts: Map<string, string>) =>
			[...texts].filter(([, text]) => text.trim() === "" && text !== " ").map(([key]) => key);
		expect(empty(en)).toEqual([]);
		expect(empty(fr)).toEqual([]);
	});

	test("French plural forms come in full sets", () => {
		const bases = new Set(
			[...fr.keys()].filter((key) => PLURAL_SUFFIX.test(key) && en.has(key)).map((key) => key.replace(PLURAL_SUFFIX, "")),
		);
		const incomplete = [...bases].filter(
			(base) => fr.has(`${base}_one`) && fr.has(`${base}_other`) && !fr.has(`${base}_many`),
		);
		expect(incomplete).toEqual([]);
	});
});
