import { platform } from "@tauri-apps/plugin-os";
import twemojiFontUrl from "twemoji-colr-font/twemoji.woff2?url";
import { isTauriRuntime } from "../services/tauriWebSocket";

/**
 * How emoji are drawn on a computer. Phones always use their own emoji.
 *
 * - "system": the operating system's emoji, with Twemoji standing in for any
 *   it cannot draw. Windows 10's emoji font stops at Emoji 13, so newer ones
 *   such as 🫠 used to show as empty boxes.
 * - "twemoji": Twemoji everywhere, for one consistent up-to-date look.
 *
 * Apple's emoji are not an option: their artwork is licensed for Apple
 * devices only. Twemoji graphics are © Twitter, Inc and other contributors,
 * CC-BY 4.0; the font build is OFL-1.1.
 */
export type EmojiStyle = "system" | "twemoji";

const STORAGE_KEY = "fg-emoji-style";
/** The name the app's stylesheet refers to; see index.css. */
const FONT_FAMILY = "GrindFlop Twemoji";

export const EMOJI_STYLE_OPTIONS: readonly {
	value: EmojiStyle;
	label: string;
	/** Draws the option's own sample in that style, whatever is applied now. */
	previewFontFamily: string;
}[] = [
	{ value: "system", label: "System", previewFontFamily: `"Segoe UI Emoji", "Apple Color Emoji", "${FONT_FAMILY}"` },
	{ value: "twemoji", label: "Twemoji", previewFontFamily: `"${FONT_FAMILY}"` },
];

/**
 * Emoji blocks only, so letters, digits and symbols like © never switch to
 * Twemoji, and the font file is only fetched once a page shows an emoji.
 */
const EMOJI_UNICODE_RANGE = [
	"U+200D",
	"U+20E3",
	"U+231A-23FF",
	"U+24C2",
	"U+25AA-25FE",
	"U+2600-27BF",
	"U+2934-2935",
	"U+2B05-2B55",
	"U+3030",
	"U+303D",
	"U+3297",
	"U+3299",
	"U+FE0F",
	"U+1F000-1FAFF",
	"U+E0020-E007F",
].join(", ");

/** The choice is only offered on computers; phones keep their own emoji. */
export function canChooseEmojiStyle(): boolean {
	if (!isTauriRuntime()) return false;
	try {
		const os = platform();
		return os === "windows" || os === "macos" || os === "linux";
	} catch {
		return false;
	}
}

function isEmojiStyle(value: unknown): value is EmojiStyle {
	return value === "system" || value === "twemoji";
}

export function getEmojiStyle(): EmojiStyle {
	if (!canChooseEmojiStyle()) return "system";
	try {
		const stored = window.localStorage.getItem(STORAGE_KEY);
		return isEmojiStyle(stored) ? stored : "system";
	} catch {
		return "system";
	}
}

export function applyEmojiStyle(style: EmojiStyle): void {
	if (typeof document === "undefined") return;
	document.documentElement.dataset.emojiStyle = style;
}

export function setEmojiStyle(style: EmojiStyle): void {
	try {
		window.localStorage.setItem(STORAGE_KEY, style);
	} catch {
		// Applies for this session only.
	}
	applyEmojiStyle(style);
}

/** Registers the bundled Twemoji font and applies the saved style. Call once at startup. */
export function installEmojiStyle(): void {
	if (typeof document === "undefined" || typeof FontFace === "undefined") return;
	try {
		// Loaded lazily: a FontFace with a unicode-range is only fetched when text needs it.
		const face = new FontFace(FONT_FAMILY, `url("${twemojiFontUrl}") format("woff2")`, {
			unicodeRange: EMOJI_UNICODE_RANGE,
			display: "swap",
		});
		document.fonts.add(face);
	} catch {
		// Without the font, emoji fall back to whatever the system has.
	}
	applyEmojiStyle(getEmojiStyle());
}
