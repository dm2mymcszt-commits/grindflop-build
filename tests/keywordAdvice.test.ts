import { describe, expect, test } from "bun:test";
import {
	adviseKeyword,
	isEverydayWord,
	keywordAdviceId,
	prepareKeywordAdviceCorpus,
	quickKeywordAdvice,
} from "../src/utils/keywordAdvice";
import type { KeywordEntry } from "../src/utils/keywordList";

const anywhere = (text: string): KeywordEntry => ({ text, mode: "anywhere" });
const whole = (text: string): KeywordEntry => ({ text, mode: "whole" });

/** People who each wrote one message, the listed ones first. */
function corpusOf(messages: string[], names: string[] = [], size = 200) {
	const people = Array.from({ length: size }, (_, index) => [messages[index] ?? `bonjour numéro ${index}`]);
	return prepareKeywordAdviceCorpus({ people, names });
}

describe("everyday words", () => {
	test("function words and greetings count, in either language and any case", () => {
		for (const word of ["qui", "Qui", " QUI ? ", "tu", "hey", "what", "now"]) {
			expect(isEverydayWord(word)).toBe(true);
		}
	});

	test("slang, names and phrases do not", () => {
		for (const word of ["bz", "dl", "telegram", "horny", "tu cherches", "47", "🍆"]) {
			expect(isEverydayWord(word)).toBe(false);
		}
	});
});

describe("advice while typing", () => {
	test("warns about an everyday word matched anywhere", () => {
		expect(quickKeywordAdvice("qui", "anywhere")).toMatchObject({ kind: "everyday_word", suggest: "whole" });
	});

	test("says nothing once it is a whole message, or for an ordinary keyword", () => {
		expect(quickKeywordAdvice("qui", "whole")).toBeNull();
		expect(quickKeywordAdvice("telegram", "anywhere")).toBeNull();
	});
});

describe("advice on a saved keyword", () => {
	test("an everyday word matched anywhere is flagged even with no history", () => {
		expect(adviseKeyword(anywhere("qui"), "forbidden", null)).toMatchObject({
			kind: "everyday_word",
			suggest: "whole",
			people: 0,
		});
	});

	test("and comes with how many people it reaches, and one of their messages", () => {
		const corpus = corpusOf(["tu cherches qui ?", "c'est qui", "salut"]);
		expect(adviseKeyword(anywhere("qui"), "forbidden", corpus)).toMatchObject({
			kind: "everyday_word",
			people: 2,
			total: 200,
			example: "tu cherches qui ?",
		});
	});

	test("the same word as a whole message gets no advice", () => {
		const corpus = corpusOf(["tu cherches qui ?"]);
		expect(adviseKeyword(whole("qui"), "forbidden", corpus)).toBeNull();
	});

	test("an ordinary keyword reaching a few people is left alone", () => {
		const corpus = corpusOf(["add me on telegram", "telegram ?"]);
		expect(adviseKeyword(anywhere("telegram"), "forbidden", corpus)).toBeNull();
	});

	test("a keyword reaching a large share of the people seen is pointed out", () => {
		const corpus = corpusOf(Array.from({ length: 12 }, () => "dispo ce soir"));
		expect(adviseKeyword(anywhere("dispo"), "forbidden", corpus)).toMatchObject({
			kind: "matches_many",
			suggest: "whole",
			people: 12,
		});
	});

	test("a whole-only word that people used inside sentences is offered a wider match", () => {
		const corpus = corpusOf(["Masculine", "looking for masculine guys"], [], 400);
		expect(adviseKeyword(whole("masculine"), "forbidden", corpus)).toMatchObject({
			kind: "would_catch_more",
			suggest: "anywhere",
			// The message that is the word alone was already caught.
			people: 1,
			example: "looking for masculine guys",
		});
	});

	test("but not when widening it would reach many people, nor for a phrase", () => {
		const many = corpusOf(Array.from({ length: 10 }, () => "je suis actif ce soir"));
		expect(adviseKeyword(whole("actif"), "forbidden", many)).toBeNull();
		const phrase = corpusOf(["tu cherches quoi ici"]);
		expect(adviseKeyword(whole("tu cherches"), "forbidden", phrase)).toBeNull();
	});

	test("a thin history gives no advice that rests on shares", () => {
		const thin = prepareKeywordAdviceCorpus({ people: [["dispo"], ["dispo"], ["looking for masculine guys"]], names: [] });
		expect(adviseKeyword(anywhere("dispo"), "forbidden", thin)).toBeNull();
		expect(adviseKeyword(whole("masculine"), "forbidden", thin)).toBeNull();
	});

	test("an opener rule is measured on first messages only, and never on names", () => {
		const people = Array.from({ length: 200 }, (_, index) => (index === 0 ? ["salut", "tu cherches qui"] : ["bonjour"]));
		const corpus = prepareKeywordAdviceCorpus({ people, names: ["qui"] });
		expect(adviseKeyword(anywhere("qui"), "openers", corpus)).toMatchObject({ people: 0, total: 200 });
		expect(adviseKeyword(anywhere("qui"), "forbidden", corpus)).toMatchObject({ people: 2, total: 201 });
	});
});

test("an answer of \"it's intended\" is remembered per list, kind and keyword", () => {
	const advice = adviseKeyword(anywhere("Qui"), "forbidden", null)!;
	expect(keywordAdviceId("forbidden", anywhere("Qui"), advice)).toBe("forbidden:everyday_word:qui");
	expect(keywordAdviceId("openers", anywhere(" qui ?"), advice)).toBe("openers:everyday_word:qui");
});
