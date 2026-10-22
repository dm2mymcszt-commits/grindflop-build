/**
 * Keyword lists are stored as one comma-separated string, the format that
 * settings sync, custom automation rules and exported .txt files already
 * carry. An entry in double quotes matches only when the whole message (or
 * the whole name, or the whole bio) is that entry; a bare entry matches
 * anywhere, as whole words.
 *
 *     telegram, "tu cherches", "salut, ça va"
 *
 * A quote inside a quoted entry is doubled, as in CSV.
 */

export type KeywordMatchMode = "whole" | "anywhere";

export type KeywordEntry = {
	text: string;
	mode: KeywordMatchMode;
};

/**
 * The version of that format. Lists saved before format 2 had no quoted
 * entries, so every phrase in them matched anywhere — which is how
 * "tu cherches" blocked someone mid-sentence.
 */
export const KEYWORD_LIST_FORMAT = 2;

const EDGE_PUNCTUATION = /^[\s.,!?:;\-—–_"'`~()[\]{}<>*]+|[\s.,!?:;\-—–_"'`~()[\]{}<>*]+$/gu;

function collapseWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/**
 * Reduces text to the form whole-message entries are compared in: whitespace
 * collapsed, lowercased, and stripped of the punctuation people put around a
 * short message. "Hot", "hot!!" and " Hot ... " all become "hot".
 *
 * Nothing *inside* the text is touched, so "hello, hot" stays "hello, hot"
 * and can never equal "hot".
 */
export function normalizeWholeText(text: string): string {
	const collapsed = collapseWhitespace(text).toLowerCase();
	const stripped = collapsed.replace(EDGE_PUNCTUATION, "").trim();
	// "?" is a real opener someone might list, and stripping its punctuation
	// leaves nothing — so only take the stripped form when something is left.
	return stripped || collapsed;
}

/** Two entries with the same identity are the same keyword, whatever their mode. */
export function keywordIdentity(text: string): string {
	return normalizeWholeText(text);
}

function makeEntry(text: string, mode: KeywordMatchMode): KeywordEntry | null {
	const collapsed = collapseWhitespace(text);
	return collapsed ? { text: collapsed, mode } : null;
}

export function parseKeywordList(raw: string | null | undefined): KeywordEntry[] {
	const entries: KeywordEntry[] = [];
	if (!raw) return entries;

	const length = raw.length;
	let index = 0;
	while (index < length) {
		while (index < length && /\s/.test(raw[index])) index++;
		if (index >= length) break;
		if (raw[index] === ",") {
			index++;
			continue;
		}

		if (raw[index] === '"') {
			let cursor = index + 1;
			let text = "";
			let closed = false;
			while (cursor < length) {
				if (raw[cursor] === '"') {
					if (raw[cursor + 1] === '"') {
						text += '"';
						cursor += 2;
						continue;
					}
					closed = true;
					cursor++;
					break;
				}
				text += raw[cursor];
				cursor++;
			}
			if (closed) {
				let end = cursor;
				while (end < length && raw[end] !== ",") end++;
				if (raw.slice(cursor, end).trim() === "") {
					const entry = makeEntry(text, "whole");
					if (entry) entries.push(entry);
					index = end + 1;
					continue;
				}
			}
			// An unclosed quote, or text after the closing one: not a quoted
			// entry, so read it as a plain one rather than guess.
		}

		let end = raw.indexOf(",", index);
		if (end === -1) end = length;
		const entry = makeEntry(raw.slice(index, end), "anywhere");
		if (entry) entries.push(entry);
		index = end + 1;
	}
	return entries;
}

function quote(text: string): string {
	return `"${text.replace(/"/g, '""')}"`;
}

/** A bare entry cannot hold a comma or open with a quote without being misread. */
export function canMatchAnywhere(text: string): boolean {
	return !text.includes(",") && !text.startsWith('"');
}

export function serializeKeywordList(entries: readonly KeywordEntry[]): string {
	return entries
		.map((entry) =>
			entry.mode === "whole" || !canMatchAnywhere(entry.text) ? quote(entry.text) : entry.text,
		)
		.join(", ");
}

/**
 * What an anywhere entry matches: the keyword bounded by anything that is not
 * a letter, number or underscore, so "sub" cannot match "submit" while
 * accented words and multi-word phrases still match cleanly. Null when the
 * engine refuses the entry, which a half emoji from a pasted list can do.
 */
export function buildAnywhereRegex(text: string): RegExp | null {
	const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	try {
		return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escaped}(?:$|[^\\p{L}\\p{N}_])`, "ui");
	} catch {
		return null;
	}
}

export function findKeyword(entries: readonly KeywordEntry[], text: string): KeywordEntry | null {
	const identity = keywordIdentity(text);
	if (!identity) return null;
	return entries.find((entry) => keywordIdentity(entry.text) === identity) ?? null;
}

export type KeywordAddResult = {
	entries: KeywordEntry[];
	added: KeywordEntry[];
	/** Entries that were already in the list, each reported once. */
	duplicates: KeywordEntry[];
};

export function addKeywords(
	list: readonly KeywordEntry[],
	additions: readonly KeywordEntry[],
): KeywordAddResult {
	const entries = [...list];
	const byIdentity = new Map<string, KeywordEntry>();
	for (const entry of entries) {
		const identity = keywordIdentity(entry.text);
		if (!byIdentity.has(identity)) byIdentity.set(identity, entry);
	}
	const added: KeywordEntry[] = [];
	const duplicates: KeywordEntry[] = [];

	for (const addition of additions) {
		const entry = makeEntry(addition.text, addition.mode);
		if (!entry) continue;
		const identity = keywordIdentity(entry.text);
		const existing = byIdentity.get(identity);
		if (existing) {
			// Repeating an entry inside the same paste is not "already there".
			if (!added.includes(existing) && !duplicates.includes(existing)) {
				duplicates.push(existing);
			}
			continue;
		}
		entries.push(entry);
		byIdentity.set(identity, entry);
		added.push(entry);
	}
	return { entries, added, duplicates };
}

function unwrapQuotes(text: string): string {
	const trimmed = text.trim();
	return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
		? trimmed.slice(1, -1)
		: trimmed;
}

/**
 * What typing into the add field and pressing Enter adds. A whole-message
 * entry is kept as typed, commas included, since "salut, ça va" is one
 * message; an anywhere entry cannot hold a comma, so commas separate several.
 */
export function keywordsFromInput(text: string, mode: KeywordMatchMode): KeywordEntry[] {
	const value = unwrapQuotes(text);
	const parts = mode === "whole" ? [value] : value.split(",");
	return parts
		.map((part) => makeEntry(part, mode))
		.filter((entry): entry is KeywordEntry => entry !== null);
}

/** A pasted list: quoted entries stay whole-message, the rest take the chosen mode. */
export function keywordsFromPastedList(text: string, mode: KeywordMatchMode): KeywordEntry[] {
	return parseKeywordList(text.replace(/\r?\n/g, ",")).map((entry) =>
		entry.mode === "whole" ? entry : { ...entry, mode },
	);
}

export type KeywordUpgrade = {
	entries: KeywordEntry[];
	value: string;
	/** Identities of the phrases that were switched to whole-message matching. */
	switchedToWhole: string[];
};

/**
 * Brings a list written before format 2 up to date. Such a list has no
 * quoted entries, and every phrase in it matched anywhere. Phrases become
 * whole-message entries, the safer reading, and are reported so they can be
 * reviewed; single words keep matching anywhere. Duplicates are dropped.
 */
export function upgradeLegacyKeywordList(raw: string | null | undefined): KeywordUpgrade {
	const switchedToWhole: string[] = [];
	const converted = parseKeywordList(raw).map((entry) => {
		if (entry.mode === "anywhere" && entry.text.includes(" ")) {
			switchedToWhole.push(keywordIdentity(entry.text));
			return { ...entry, mode: "whole" as const };
		}
		return entry;
	});
	const { entries } = addKeywords([], converted);
	return {
		entries,
		value: serializeKeywordList(entries),
		switchedToWhole: [...new Set(switchedToWhole)],
	};
}

export function upgradeLegacyOpenerList(raw: string | null | undefined): KeywordUpgrade {
	const converted = parseKeywordList(raw).map((entry) => ({ ...entry, mode: "whole" as const }));
	const { entries } = addKeywords([], converted);
	return { entries, value: serializeKeywordList(entries), switchedToWhole: [] };
}

/**
 * Reads an imported .txt. Files exported before format 2 carry no quotes at
 * all, so a file without a single quoted entry is upgraded the same way a
 * stored list is.
 */
export function readKeywordFile(text: string): KeywordUpgrade {
	const flattened = text.replace(/\r?\n/g, ",");
	if (/(^|,)\s*"/.test(flattened)) {
		const entries = addKeywords([], parseKeywordList(flattened)).entries;
		return { entries, value: serializeKeywordList(entries), switchedToWhole: [] };
	}
	return upgradeLegacyKeywordList(flattened);
}

/** Only whole-message entries still in the list can be waiting for review. */
export function pruneReviewList(
	entries: readonly KeywordEntry[],
	review: readonly string[],
): string[] {
	const wholeIdentities = new Set(
		entries.filter((entry) => entry.mode === "whole").map((entry) => keywordIdentity(entry.text)),
	);
	return [...new Set(review)].filter((identity) => wholeIdentities.has(identity));
}
