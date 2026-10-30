/**
 * Finding a setting by typing part of its name. Kept apart from the list of
 * settings itself, which needs the app around it, so that this can be tested
 * on its own.
 */

export type SearchableSetting = {
	label: string;
	description?: string;
	/** The page the setting is on, as its heading reads. */
	section: string;
};

/** Lower case with the accents dropped, so "ecran" finds "Écran". */
export function foldForSearch(text: string): string {
	return text
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase();
}

/**
 * The settings that contain every word typed, best first: the ones whose own
 * name has all the words, then the ones that need their page's name as well,
 * then the ones only their description brings in. Within each group they
 * stay in the order they were given, which is the order of the settings
 * screens.
 */
export function searchSettings<T extends SearchableSetting>(entries: readonly T[], query: string): T[] {
	const words = foldForSearch(query).split(/\s+/).filter(Boolean);
	if (words.length === 0) {
		return [];
	}

	const byName: T[] = [];
	const byPage: T[] = [];
	const byDescription: T[] = [];

	for (const entry of entries) {
		const label = foldForSearch(entry.label);
		const withPage = `${label} ${foldForSearch(entry.section)}`;
		const everything = entry.description ? `${withPage} ${foldForSearch(entry.description)}` : withPage;

		if (words.every((word) => label.includes(word))) {
			byName.push(entry);
		} else if (words.every((word) => withPage.includes(word))) {
			byPage.push(entry);
		} else if (words.every((word) => everything.includes(word))) {
			byDescription.push(entry);
		}
	}

	return [...byName, ...byPage, ...byDescription];
}
