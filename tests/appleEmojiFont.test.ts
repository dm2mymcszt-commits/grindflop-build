import { describe, expect, test } from "bun:test";
import { applePreviewFontFamily, classifyAppleEmojiFont } from "../src/utils/emojiStyle";

const font = (family: string) => ({ family, file: `C:\\Fonts\\${family}.ttf` });

describe("finding the Apple emoji font", () => {
	test("a font that loads under an Apple name is used by name", () => {
		expect(classifyAppleEmojiFont(true, [])).toBe("named");
		expect(classifyAppleEmojiFont(false, [font("Apple Color Emoji")])).toBe("named");
	});

	test("the Windows copy, installed as Segoe UI Emoji with bitmaps, is recognised", () => {
		expect(classifyAppleEmojiFont(false, [font("Segoe UI Emoji")])).toBe("replaces-windows");
	});

	test("Windows' own emoji font alone is not Apple", () => {
		// Its outline font never reaches the bitmap list, which is then empty.
		expect(classifyAppleEmojiFont(false, [])).toBe("missing");
		expect(classifyAppleEmojiFont(false, [font("Noto Color Emoji")])).toBe("missing");
	});

	test("the Apple sample uses the copy that was found", () => {
		expect(applePreviewFontFamily("replaces-windows").startsWith('"Segoe UI Emoji"')).toBe(true);
		expect(applePreviewFontFamily("named").startsWith('"Apple Color Emoji"')).toBe(true);
		expect(applePreviewFontFamily("missing")).toContain("GrindFlop Twemoji");
	});
});
