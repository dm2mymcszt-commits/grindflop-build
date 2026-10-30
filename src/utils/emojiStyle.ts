import { invoke } from "@tauri-apps/api/core";
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
 * - "apple": an installed Apple emoji font, the default on computers.
 *
 * Apple artwork is never bundled or downloaded. Its installed version decides
 * which emoji are available; Twemoji fills in missing glyphs or a missing font.
 *
 * On Windows the usual copy (AppleColorEmoji-Windows.ttf) is named "Segoe UI
 * Emoji", like Windows' own emoji font, and replaces it everywhere once the app
 * restarts. Its name gives nothing away, so the native side checks how the
 * installed font draws: Windows' own uses outlines, the Apple copy bitmaps.
 */
export type EmojiStyle = "system" | "twemoji" | "apple";

const STORAGE_KEY = "fg-emoji-style";
/** The name the app's stylesheet refers to; see index.css. */
const FONT_FAMILY = "GrindFlop Twemoji";
const APPLE_FONT_NAMES = ["Apple Color Emoji", "Apple MFFM Color Emoji", "AppleColorEmoji"];
const APPLE_FONT_STACK = APPLE_FONT_NAMES.map((name) => `"${name}"`).join(", ");
const WINDOWS_EMOJI_FONT = "Segoe UI Emoji";

/**
 * Where the Apple emoji font was found: under its own name, in place of
 * Windows' emoji font, or not at all.
 */
export type AppleEmojiFont = "named" | "replaces-windows" | "missing";

export const EMOJI_STYLE_OPTIONS: readonly {
	value: EmojiStyle;
	label: string;
	/** Draws the option's own sample in that style, whatever is applied now. */
	previewFontFamily: string;
}[] = [
	{ value: "system", label: "System", previewFontFamily: `"Segoe UI Emoji", "Apple Color Emoji", "${FONT_FAMILY}"` },
	{ value: "twemoji", label: "Twemoji", previewFontFamily: `"${FONT_FAMILY}"` },
	{ value: "apple", label: "Apple", previewFontFamily: `${APPLE_FONT_STACK}, "${FONT_FAMILY}", "Segoe UI Emoji", sans-serif` },
];

/**
 * Emoji and their sequence components (including keycaps and head-shaking
 * arrows). The body text font stays first, so ordinary text keeps its font.
 * The emoji files are only fetched when text needs them.
 */
const EMOJI_UNICODE_RANGE = [
	"U+0023",
	"U+002A",
	"U+0030-0039",
	"U+00A9",
	"U+00AE",
	"U+200D",
	"U+203C",
	"U+2049",
	"U+20E3",
	"U+2122",
	"U+2139",
	"U+2194-21AA",
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

/** Probe local font names only. FontFaceSet.check alone also succeeds on fallback. */
async function hasNamedAppleEmojiFont(): Promise<boolean> {
	if (typeof FontFace === "undefined") return false;
	try {
		const sources = APPLE_FONT_NAMES.map((name) => `local("${name}")`).join(", ");
		await new FontFace("GrindFlop Apple Emoji Probe", sources).load();
		return true;
	} catch {
		return false;
	}
}

type ColorBitmapFont = { family: string; file: string };

/** Pure decision, kept apart for tests. */
export function classifyAppleEmojiFont(
	namedFontLoads: boolean,
	colorBitmapFonts: readonly ColorBitmapFont[],
): AppleEmojiFont {
	const families = colorBitmapFonts.map((font) => font.family.toLowerCase());
	if (namedFontLoads || APPLE_FONT_NAMES.some((name) => families.includes(name.toLowerCase()))) {
		return "named";
	}
	return families.includes(WINDOWS_EMOJI_FONT.toLowerCase()) ? "replaces-windows" : "missing";
}

let appleEmojiFontCheck: Promise<AppleEmojiFont> | null = null;

/** Checked once per app run: a newly installed font needs a restart anyway. */
export function detectAppleEmojiFont(): Promise<AppleEmojiFont> {
	if (!canChooseEmojiStyle()) return Promise.resolve("missing");
	appleEmojiFontCheck ??= (async () => {
		if (await hasNamedAppleEmojiFont()) return "named" as const;
		let fonts: ColorBitmapFont[] = [];
		try {
			fonts = await invoke<ColorBitmapFont[]>("color_bitmap_emoji_fonts");
		} catch {
			// An older native side without the check: only the name probe counts.
		}
		return classifyAppleEmojiFont(false, fonts);
	})();
	return appleEmojiFontCheck;
}

/** The Apple option's own sample, drawn with whichever copy is installed. */
export function applePreviewFontFamily(font: AppleEmojiFont): string {
	return font === "replaces-windows"
		? `"${WINDOWS_EMOJI_FONT}", "${FONT_FAMILY}", sans-serif`
		: `${APPLE_FONT_STACK}, "${FONT_FAMILY}", "${WINDOWS_EMOJI_FONT}", sans-serif`;
}

function isEmojiStyle(value: unknown): value is EmojiStyle {
	return value === "system" || value === "twemoji" || value === "apple";
}

export function getEmojiStyle(): EmojiStyle {
	if (!canChooseEmojiStyle()) return "system";
	try {
		const stored = window.localStorage.getItem(STORAGE_KEY);
		return isEmojiStyle(stored) ? stored : "apple";
	} catch {
		return "apple";
	}
}

export function applyEmojiStyle(style: EmojiStyle): void {
	if (typeof document === "undefined") return;
	document.documentElement.dataset.emojiStyle = canChooseEmojiStyle() ? style : "system";
}

/** Lets the stylesheet put Windows' emoji font name first when it is the Apple copy. */
function applyAppleEmojiFont(font: AppleEmojiFont): void {
	if (typeof document === "undefined") return;
	document.documentElement.dataset.appleEmojiFont = font;
}

export function setEmojiStyle(style: EmojiStyle): void {
	if (!canChooseEmojiStyle()) return;
	try {
		window.localStorage.setItem(STORAGE_KEY, style);
	} catch {
		// Applies for this session only.
	}
	applyEmojiStyle(style);
}

/** Registers bundled Twemoji and applies the saved style. Apple uses local fonts. */
export function installEmojiStyle(): void {
	if (typeof document === "undefined") return;
	applyEmojiStyle(getEmojiStyle());
	void detectAppleEmojiFont().then(applyAppleEmojiFont);
	if (typeof FontFace === "undefined") return;
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
}
