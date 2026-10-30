import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { localizeBlockReason } from "../src/utils/blockReasonText";
import { setTranslator, translate, type TranslateOptions } from "../src/utils/translate";

const root = join(import.meta.dir, "..");

function textAt(translations: unknown, key: string): unknown {
	return key.split(".").reduce<unknown>(
		(node, part) => (node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined),
		translations,
	);
}

/** The app's translator in miniature: the text from a locale file, with its values filled in. */
function translatorFor(language: string) {
	const translations = JSON.parse(
		readFileSync(join(root, "public", "locales", language, "translation.json"), "utf8"),
	);
	return (key: string, options?: TranslateOptions) => {
		const text = textAt(translations, key);
		if (typeof text !== "string") throw new Error(`no ${language} text for ${key}`);
		return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, name: string) =>
			options && name in options ? String(options[name]) : whole,
		);
	};
}

// Other test files read the English written at the call sites.
afterEach(() => setTranslator(null));

// Every sentence the blockers save, as they write it.
const SAVED_REASONS = [
	"No Age Set",
	"Age limit (25)",
	"Distance limit",
	"Distance Limit (3km)",
	"Has active 'Right Now' status",
	"Forbidden 'Looking For' tag",
	"Has an X / Twitter account",
	"Name keyword: \"masc4masc\"",
	"Bio keyword: telegram",
	"Message keyword: snap",
	"Keyword match",
	"First message: \"hot\"",
	"First message was media (Bot evasion)",
	"Left on seen for 45min",
	"Faceless profile: No face in the photos they sent",
	"Faceless profile: No media sent 5min after first message",
	"Faceless profile: No face in profile photos",
	"Explicit photo",
	"Explicit video",
	"Explicit profile photo",
	"Explicit album",
	"Explicit photo: bare buttocks, 77% sure",
	"Explicit profile photo: genitals, 91% sure",
	"They blocked you",
	"Grindr had dropped your block. Blocked again.",
	"A photo they sent could not be checked. It stays covered and they were not blocked.",
	"A photo they sent took too long to check. It stays covered and they were not blocked.",
	"Could not tell whether what they sent shows a face, so they were not blocked.",
	"Could not tell whether their profile photos show a face, so they were not blocked.",
];

describe("translate", () => {
	test("uses the English written at the call site until the app provides a translator", () => {
		expect(translate("any.key", { defaultValue: "Hello {{name}}", name: "Sam" })).toBe("Hello Sam");
		expect(translate("any.key")).toBe("any.key");
	});

	test("picks the form for one or for several from the count", () => {
		const options = { defaultValue_one: "{{count}} message", defaultValue_other: "{{count}} messages" };
		expect(translate("any.key", { ...options, count: 1 })).toBe("1 message");
		expect(translate("any.key", { ...options, count: 4 })).toBe("4 messages");
		expect(translate("any.key", { ...options, count: 0 })).toBe("0 messages");
	});

	test("hands over to the app's translator once it is set", () => {
		setTranslator((key) => `[${key}]`);
		expect(translate("any.key", { defaultValue: "Hello" })).toBe("[any.key]");
	});
});

describe("localizeBlockReason", () => {
	test("in English, a saved reason reads as it was saved", () => {
		setTranslator(translatorFor("en"));
		for (const reason of SAVED_REASONS) {
			// The scanners do not agree on capitals ("Distance Limit", "Distance limit").
			expect(localizeBlockReason(reason).toLowerCase()).toBe(reason.toLowerCase());
		}
	});

	test("in French, no saved reason is left in English", () => {
		setTranslator(translatorFor("fr"));
		for (const reason of SAVED_REASONS) {
			expect(localizeBlockReason(reason)).not.toBe(reason);
		}
		expect(localizeBlockReason("Age limit (25)")).toBe("Limite d'âge (25)");
		expect(localizeBlockReason("Left on seen for 45min")).toBe("Laissé en vu pendant 45 min");
		expect(localizeBlockReason("Explicit photo: bare buttocks, 77% sure")).toBe(
			"Photo explicite : fesses nues, sûr à 77 %",
		);
	});

	test("the scanner's prefix is dropped, as the screens that read the log do", () => {
		setTranslator(translatorFor("fr"));
		expect(localizeBlockReason("Scanner: First message was media (Bot evasion)")).toBe(
			localizeBlockReason("First message was media (Bot evasion)"),
		);
	});

	test("a sentence it does not know comes back untouched", () => {
		setTranslator(translatorFor("fr"));
		expect(localizeBlockReason("My own rule name")).toBe("My own rule name");
		expect(localizeBlockReason("")).toBe("");
	});
});
