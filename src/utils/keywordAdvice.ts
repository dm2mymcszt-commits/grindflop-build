/**
 * Advice on a keyword's match mode, so that a rule does not block the wrong
 * people or miss the ones it was written for.
 *
 * Two things are looked at. What the word is: an everyday word matched
 * anywhere blocks anyone who happens to use it ("qui" catches "tu cherches
 * qui ?"). And what this device has seen: the messages people sent and the
 * names they had, which say how many of them a keyword reaches in each mode.
 *
 * Advice only ever suggests; nothing here changes a list.
 */

import { buildAnywhereRegex, normalizeWholeText, type KeywordEntry, type KeywordMatchMode } from "./keywordList";

export type KeywordListKind = "forbidden" | "openers";

type CorpusText = { text: string; lower: string };

export type KeywordAdviceCorpus = {
	/** One entry per person who wrote: their texts, oldest first. */
	people: readonly (readonly CorpusText[])[];
	/** Display names seen on this account, one per person. */
	names: readonly CorpusText[];
};

/** Lowercases every text once, so that hundreds of keywords do not each do it again. */
export function prepareKeywordAdviceCorpus(raw: {
	people: readonly (readonly string[])[];
	names: readonly string[];
}): KeywordAdviceCorpus {
	const prepare = (text: string): CorpusText => ({ text, lower: text.toLowerCase() });
	return {
		people: raw.people.map((texts) => texts.map(prepare)),
		names: raw.names.map(prepare),
	};
}

export type KeywordAdviceKind =
	/** Matched anywhere, and a word nearly everybody uses. */
	| "everyday_word"
	/** Matched anywhere, and reaching a large share of the people seen. */
	| "matches_many"
	/** Whole only, and missing people a wider match would have caught. */
	| "would_catch_more";

export type KeywordAdvice = {
	kind: KeywordAdviceKind;
	/** The mode the advice points to. */
	suggest: KeywordMatchMode;
	/** People whose messages or name it is about, out of `total`; 0 of 0 without history. */
	people: number;
	total: number;
	/** One real text or name that shows the point, when there is one. */
	example: string | null;
};

/**
 * Words that say nothing about the person using them: function words,
 * greetings and small talk, in French and English. Matched anywhere, any of
 * them blocks most of an inbox.
 *
 * Two-letter slang ("bz", "dl") is deliberately not treated as everyday: it
 * is banned on purpose, and matching whole words keeps it narrow.
 */
const EVERYDAY_WORDS: ReadonlySet<string> = new Set(
	(
		"a ai as au aux avec bien bon bonjour bonsoir c ca ça cc ce ces cette chez comment coucou cv d dans de des du " +
		"elle en es est et eu hello hey hi il ils j jai je l la le les lui m ma mais me merci mes moi mon n ne non nous " +
		"on ou où oui pas plus pour pourquoi qu quand que quel quelle qui quoi re s sa salut se ses si slt son suis sur " +
		"t ta te tes toi ton tous tout très trop tu un une va vas veux vous y yo " +
		"about all am an and any are at be but by can do for from get go good got have he her here him his how i if in " +
		"is it its just know like me more my no not now of ok okay on one or our out she so some sup thanks that the " +
		"their them then there they this to too up us want was we what when where who why will with yes you your"
	).split(" "),
);

/** At or above this share of the people seen, an "anywhere" keyword is worth a second look. */
const MANY_SHARE = 0.03;
/** Below this many people seen, shares say nothing. */
const MIN_PEOPLE_FOR_SHARES = 150;
/** A whole-only word is only offered a wider match if that would stay under this share. */
const SAFE_WIDER_SHARE = 0.01;

function letterCount(text: string): number {
	return [...text].filter((char) => /\p{L}/u.test(char)).length;
}

/** A single ordinary word nearly everybody uses. */
export function isEverydayWord(text: string): boolean {
	const word = normalizeWholeText(text);
	return word !== "" && !/\s/.test(word) && EVERYDAY_WORDS.has(word);
}

/**
 * What can be said from the word alone, before any history is read: used
 * while a keyword is being typed.
 */
export function quickKeywordAdvice(text: string, mode: KeywordMatchMode): KeywordAdvice | null {
	if (mode === "anywhere" && isEverydayWord(text)) {
		return { kind: "everyday_word", suggest: "whole", people: 0, total: 0, example: null };
	}
	return null;
}

type Reach = { people: number; example: string | null };

/** How many of the people seen a keyword reaches when matched anywhere. */
function reachAnywhere(
	entry: KeywordEntry,
	list: KeywordListKind,
	corpus: KeywordAdviceCorpus,
	/** Leaves out texts that are the keyword and nothing else: those a whole match already gets. */
	onlyInsideLongerText: boolean,
): Reach {
	const needle = entry.text.toLowerCase();
	const regex = buildAnywhereRegex(needle);
	if (!regex) return { people: 0, example: null };
	const whole = normalizeWholeText(entry.text);

	const matches = (candidate: CorpusText): boolean =>
		// The plain search is far cheaper than the expression and rules most texts out.
		candidate.lower.includes(needle) &&
		regex.test(candidate.text) &&
		!(onlyInsideLongerText && normalizeWholeText(candidate.text) === whole);

	let people = 0;
	let example: string | null = null;
	const count = (texts: readonly CorpusText[]) => {
		const hit = texts.find(matches);
		if (!hit) return;
		people += 1;
		if (example === null) example = hit.text;
	};

	for (const texts of corpus.people) {
		// An opener rule only ever judges the first message.
		count(list === "openers" ? texts.slice(0, 1) : texts);
	}
	if (list === "forbidden") {
		for (const name of corpus.names) count([name]);
	}
	return { people, example };
}

export function adviseKeyword(
	entry: KeywordEntry,
	list: KeywordListKind,
	corpus: KeywordAdviceCorpus | null,
): KeywordAdvice | null {
	const total = corpus ? corpus.people.length + (list === "forbidden" ? corpus.names.length : 0) : 0;
	const hasShares = corpus !== null && corpus.people.length >= MIN_PEOPLE_FOR_SHARES;

	if (entry.mode === "anywhere") {
		const everyday = isEverydayWord(entry.text);
		if (!everyday && !hasShares) return null;
		const reach = corpus ? reachAnywhere(entry, list, corpus, false) : { people: 0, example: null };
		if (everyday) {
			return { kind: "everyday_word", suggest: "whole", people: reach.people, total, example: reach.example };
		}
		if (reach.people / total >= MANY_SHARE) {
			return { kind: "matches_many", suggest: "whole", people: reach.people, total, example: reach.example };
		}
		return null;
	}

	// Whole only. A phrase is whole on purpose; a single distinctive word that
	// keeps turning up inside longer names and messages may be worth widening,
	// as long as widening it would still reach few people.
	if (!corpus || !hasShares) return null;
	const word = normalizeWholeText(entry.text);
	if (/\s/.test(word) || letterCount(word) < 4 || isEverydayWord(word)) return null;
	const wider = reachAnywhere(entry, list, corpus, false);
	if (wider.people === 0 || wider.people / total >= SAFE_WIDER_SHARE) return null;
	const missed = reachAnywhere(entry, list, corpus, true);
	if (missed.people === 0) return null;
	return { kind: "would_catch_more", suggest: "anywhere", people: missed.people, total, example: missed.example };
}

/** Identifies one piece of advice, so that "it's intended" is remembered for it and nothing else. */
export function keywordAdviceId(list: KeywordListKind, entry: KeywordEntry, advice: KeywordAdvice): string {
	return `${list}:${advice.kind}:${normalizeWholeText(entry.text)}`;
}
