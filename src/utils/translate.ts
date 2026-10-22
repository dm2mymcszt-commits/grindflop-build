/**
 * A translator for code outside React: rules, services, notifications.
 *
 * These modules are unit-tested without a browser, where the i18n setup
 * cannot load, so they must not import it. The app hands its translator over
 * once at start (see i18n.ts). Until then, and in tests, the English default
 * written at the call site is used.
 */
export type TranslateOptions = Record<string, unknown> & { defaultValue?: string };

type Translator = (key: string, options?: TranslateOptions) => string;

function fromDefault(key: string, options?: TranslateOptions): string {
	const count = options?.count;
	const plural =
		typeof count === "number"
			? options?.[count === 1 ? "defaultValue_one" : "defaultValue_other"]
			: undefined;
	const text = typeof plural === "string" ? plural : (options?.defaultValue ?? key);
	return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, name: string) =>
		options && name in options ? String(options[name]) : whole,
	);
}

let translator: Translator = fromDefault;

/** Null puts the call-site English back, which is what tests start from. */
export function setTranslator(next: Translator | null): void {
	translator = next ?? fromDefault;
}

export function translate(key: string, options?: TranslateOptions): string {
	return translator(key, options);
}
