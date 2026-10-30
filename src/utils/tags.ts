/**
 * Profile tags come from a managed catalog, which pairs a stable `key` with the
 * text shown for it in the current language. The server matches on the key, in
 * the grid's tag filter and when a profile is saved, and a profile's own tags
 * come back as keys.
 *
 * This app used to store the text instead (lower-cased in the grid filter). The
 * server only understood that where a text happened to spell its own key, and
 * never in a language other than English. Values are stored as keys now, and
 * this index reads both forms so anything saved the old way keeps its meaning.
 */
export interface CatalogTag {
	key: string;
	text: string;
}

export interface TagIndex {
	/**
	 * The catalog key a stored value stands for, or the value itself when the
	 * catalog does not know it (a free-typed tag, or the catalog not loaded yet).
	 */
	keyFor(value: string): string;
	/** The text to show for a stored value. */
	labelFor(value: string): string;
}

export function buildTagIndex(allTags: CatalogTag[]): TagIndex {
	const labelByKey = new Map<string, string>();
	const keyByLower = new Map<string, string>();

	// Keys go in first, so a text that happens to spell another tag's key can
	// never take that key's place.
	for (const tag of allTags) {
		labelByKey.set(tag.key, tag.text);
		keyByLower.set(tag.key.toLowerCase(), tag.key);
	}
	for (const tag of allTags) {
		const lowerText = tag.text.trim().toLowerCase();
		if (lowerText && !keyByLower.has(lowerText)) {
			keyByLower.set(lowerText, tag.key);
		}
	}

	const keyFor = (value: string): string => {
		const trimmed = value.trim();
		if (labelByKey.has(trimmed)) {
			return trimmed;
		}
		return keyByLower.get(trimmed.toLowerCase()) ?? trimmed;
	};

	return {
		keyFor,
		labelFor: (value) => labelByKey.get(keyFor(value)) ?? value,
	};
}

/** Stored values as the keys to send: in order, without blanks or repeats. */
export function toTagKeys(index: TagIndex, values: string[]): string[] {
	const seen = new Set<string>();
	const keys: string[] = [];
	for (const value of values) {
		const key = index.keyFor(value);
		if (!key || seen.has(key)) {
			continue;
		}
		seen.add(key);
		keys.push(key);
	}
	return keys;
}
