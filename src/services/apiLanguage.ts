import { invoke, isTauri } from "@tauri-apps/api/core";

/**
 * Grindr answers in the language its requests say (gender and pronoun
 * names, for one). The native client used to send the device's language, so
 * a French phone or PC got French names on English screens. The app now
 * tells it which language its screens are in.
 */

let ready: Promise<void> = Promise.resolve();
let current: string | null = null;

/** The app's language as a short tag: "en", "fr". */
export function appLanguageTag(language: string | undefined | null): string {
	return (language || "en").split(/[-_]/)[0].toLowerCase() || "en";
}

export function syncApiLanguage(language: string | undefined | null): Promise<void> {
	const tag = appLanguageTag(language);
	if (tag === current || !isTauri()) return ready;
	current = tag;
	ready = invoke("set_api_language", { language: tag }).then(
		() => undefined,
		() => undefined,
	);
	return ready;
}

/** Resolves once the language last given to syncApiLanguage is in place. */
export function apiLanguageReady(): Promise<void> {
	return ready;
}
