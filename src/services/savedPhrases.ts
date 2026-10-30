import { appLog } from "../utils/logger";
import { getAllSavedPhrases, setSavedPhrases as setSavedPhrasesInDb } from "./chatDb";
import type { ServerSavedPhrase } from "./api/phrasesMethods";

export const SAVED_PHRASES_UPDATED_EVENT = "fg:saved-phrases-updated";

export function normalizeSavedPhrases(input: string[]): string[] {
	const unique = new Set<string>();
	for (const phrase of input) {
		const normalized = phrase.trim();
		if (normalized.length > 0) {
			unique.add(normalized);
		}
	}
	return Array.from(unique);
}

export async function loadSavedPhrases(): Promise<string[]> {
	try {
		return await getAllSavedPhrases();
	} catch (error) {
		appLog.error("[savedPhrases] loadSavedPhrases failed", error);
		return [];
	}
}

export async function saveSavedPhrases(nextPhrases: string[]): Promise<string[]> {
	const normalized = normalizeSavedPhrases(nextPhrases);
	const stored = await setSavedPhrasesInDb(normalized);
	if (typeof window !== "undefined") {
		window.dispatchEvent(
			new CustomEvent<string[]>(SAVED_PHRASES_UPDATED_EVENT, {
				detail: stored,
			}),
		);
	}
	return stored;
}

/**
 * Merges server-saved phrases into the local list, run once per profile
 * load (see AuthContext). Server is the account's phrase list on Grindr
 * itself; local can hold phrases added while offline or before this sync
 * existed, so this unions rather than replacing either side.
 *
 * `isStillActive` is re-checked right before the write: chatDb is a single
 * shared connection repointed in place on account switch, so if the caller's
 * profile stopped being the active one while the network fetch was in
 * flight, writing here would merge this profile's server phrases into
 * whichever other profile's db is now open.
 */
export async function syncSavedPhrasesFromServer(
	getServerPhrases: () => Promise<ServerSavedPhrase[]>,
	isStillActive: () => boolean = () => true,
): Promise<string[] | null> {
	try {
		const [local, server] = await Promise.all([loadSavedPhrases(), getServerPhrases()]);
		if (!isStillActive()) {
			return null;
		}
		const serverTexts = server
			.filter((phrase) => phrase.type === "SAVED_PHRASE")
			.map((phrase) => phrase.text);
		return await saveSavedPhrases([...local, ...serverTexts]);
	} catch (error) {
		appLog.error("[savedPhrases] syncSavedPhrasesFromServer failed", error);
		return null;
	}
}

export function phrasesToTxt(phrases: string[]): string {
	return normalizeSavedPhrases(phrases).join("\n");
}

export function parsePhrasesFromTxt(content: string): string[] {
	return normalizeSavedPhrases(content.split(/\r?\n/g));
}
