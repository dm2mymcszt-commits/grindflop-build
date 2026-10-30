import { describe, expect, test } from "bun:test";
import {
	addKeywords,
	findKeyword,
	keywordsFromInput,
	keywordsFromPastedList,
	parseKeywordList,
	pruneReviewList,
	readKeywordFile,
	serializeKeywordList,
	upgradeLegacyKeywordList,
	upgradeLegacyOpenerList,
} from "../src/utils/keywordList";

const whole = (text: string) => ({ text, mode: "whole" as const });
const anywhere = (text: string) => ({ text, mode: "anywhere" as const });

describe("parseKeywordList", () => {
	test("bare entries match anywhere, quoted entries match the whole message", () => {
		expect(parseKeywordList('telegram, "tu cherches"')).toEqual([anywhere("telegram"), whole("tu cherches")]);
	});

	test("a quoted entry can hold commas and doubled quotes", () => {
		expect(parseKeywordList('"salut, ça va", "say ""hi"""')).toEqual([
			whole("salut, ça va"),
			whole('say "hi"'),
		]);
	});

	test("empty entries and extra whitespace are dropped", () => {
		expect(parseKeywordList(" , hot ,,  hey   sexy , ")).toEqual([anywhere("hot"), anywhere("hey sexy")]);
		expect(parseKeywordList("")).toEqual([]);
		expect(parseKeywordList(null)).toEqual([]);
	});

	test("a quote that is never closed is read as a plain entry", () => {
		expect(parseKeywordList('"oops, hot')).toEqual([anywhere('"oops'), anywhere("hot")]);
	});

	test("text after a closing quote makes it a plain entry", () => {
		expect(parseKeywordList('"5\'10" tall, hot')).toEqual([anywhere('"5\'10" tall'), anywhere("hot")]);
	});
});

describe("serializing", () => {
	test("round-trips through parseKeywordList", () => {
		const entries = [anywhere("telegram"), whole("tu cherches"), whole("salut, ça va"), whole('say "hi"')];
		expect(parseKeywordList(serializeKeywordList(entries))).toEqual(entries);
	});

	test("writes bare words and quoted phrases", () => {
		expect(serializeKeywordList([anywhere("hot"), whole("tu cherches")])).toBe('hot, "tu cherches"');
	});

	test("an opener list from before openers had modes becomes whole-message entries", () => {
		const upgrade = upgradeLegacyOpenerList("hot, looking for");
		expect(upgrade.entries).toEqual([whole("hot"), whole("looking for")]);
		expect(upgrade.value).toBe('"hot", "looking for"');
	});
});

describe("duplicates", () => {
	test("the same keyword is found whatever its case, spacing, punctuation or mode", () => {
		const list = [whole("Tu cherches"), anywhere("telegram")];
		expect(findKeyword(list, "tu  cherches ?")).toEqual(whole("Tu cherches"));
		expect(findKeyword(list, "TELEGRAM")).toEqual(anywhere("telegram"));
		expect(findKeyword(list, "tu cherches quoi")).toBeNull();
	});

	test("adding reports what was already there and does not add it twice", () => {
		const result = addKeywords([anywhere("hot")], [anywhere("Hot"), whole("new phrase")]);
		expect(result.added).toEqual([whole("new phrase")]);
		expect(result.duplicates).toEqual([anywhere("hot")]);
		expect(result.entries).toEqual([anywhere("hot"), whole("new phrase")]);
	});

	test("repeating an entry within one paste is not reported as already there", () => {
		const result = addKeywords([], [anywhere("a"), anywhere("A")]);
		expect(result.added).toEqual([anywhere("a")]);
		expect(result.duplicates).toEqual([]);
	});
});

describe("typed and pasted keywords", () => {
	test("a whole-message entry keeps its commas", () => {
		expect(keywordsFromInput("salut, ça va", "whole")).toEqual([whole("salut, ça va")]);
	});

	test("commas separate anywhere entries", () => {
		expect(keywordsFromInput("cash, bot", "anywhere")).toEqual([anywhere("cash"), anywhere("bot")]);
	});

	test("wrapping quotes are not part of the keyword", () => {
		expect(keywordsFromInput('"hot"', "whole")).toEqual([whole("hot")]);
	});

	test("a pasted list keeps quoted entries whole and gives the rest the chosen mode", () => {
		expect(keywordsFromPastedList('cash\nbot, "tu cherches"', "whole")).toEqual([
			whole("cash"),
			whole("bot"),
			whole("tu cherches"),
		]);
		expect(keywordsFromPastedList('cash, "tu cherches"', "anywhere")).toEqual([
			anywhere("cash"),
			whole("tu cherches"),
		]);
	});
});

describe("upgrading a list saved before whole-message entries", () => {
	test("phrases become whole-message entries and single words keep matching anywhere", () => {
		const upgrade = upgradeLegacyKeywordList("telegram, tu cherches, C qui ?, hot");
		expect(upgrade.entries).toEqual([
			anywhere("telegram"),
			whole("tu cherches"),
			whole("C qui ?"),
			anywhere("hot"),
		]);
		expect(upgrade.value).toBe('telegram, "tu cherches", "C qui ?", hot');
		expect(upgrade.switchedToWhole).toEqual(["tu cherches", "c qui"]);
	});

	test("duplicates are dropped", () => {
		expect(upgradeLegacyKeywordList("hot, Hot, hot").entries).toEqual([anywhere("hot")]);
	});

	test("an old export is upgraded on import, a new one is read as written", () => {
		expect(readKeywordFile("telegram\ntu cherches").entries).toEqual([anywhere("telegram"), whole("tu cherches")]);
		expect(readKeywordFile('telegram, "tu cherches", hey sexy').entries).toEqual([
			anywhere("telegram"),
			whole("tu cherches"),
			anywhere("hey sexy"),
		]);
	});

	test("only whole-message entries still in the list stay to review", () => {
		expect(
			pruneReviewList([whole("tu cherches"), anywhere("c qui")], ["tu cherches", "c qui", "gone"]),
		).toEqual(["tu cherches"]);
	});
});
