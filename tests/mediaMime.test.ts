import { describe, expect, test } from "bun:test";
import { isPictureUrl, sniffMediaMime } from "../src/utils/mediaMime";

function base64Of(bytes: number[], text = ""): string {
	return btoa(String.fromCharCode(...bytes) + text);
}

describe("sniffMediaMime", () => {
	test("recognises pictures by their first bytes", () => {
		expect(sniffMediaMime(base64Of([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]))).toBe("image/jpeg");
		expect(sniffMediaMime(base64Of([0x89], "PNG\r\n\x1a\n\0\0\0\r"))).toBe("image/png");
		expect(sniffMediaMime(btoa("GIF89a\x01\0\x01\0\0\0"))).toBe("image/gif");
		expect(sniffMediaMime(btoa("RIFF\x24\0\0\0WEBPVP8 "))).toBe("image/webp");
		expect(sniffMediaMime(btoa("\0\0\0\x18ftypheic\0\0\0\0"))).toBe("image/heic");
	});

	test("recognises videos, so a video is never offered as a picture", () => {
		expect(sniffMediaMime(btoa("\0\0\0\x20ftypisom\0\0\x02\0"))).toBe("video/mp4");
		expect(sniffMediaMime(btoa("\0\0\0\x14ftypqt  \0\0\0\0"))).toBe("video/quicktime");
		expect(sniffMediaMime(base64Of([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 1, 0x42, 0xf7, 0x81]))).toBe("video/webm");
	});

	test("gives up on anything else", () => {
		expect(sniffMediaMime(btoa("hello world!"))).toBeNull();
		expect(sniffMediaMime("")).toBeNull();
		expect(sniffMediaMime("not base64 at all!!")).toBeNull();
	});
});

describe("isPictureUrl", () => {
	test("keeps saved videos and sounds out of image slots", () => {
		expect(isPictureUrl("data:image/jpeg;base64,AAAA")).toBe(true);
		expect(isPictureUrl("https://cdns.grindr.com/thumb.jpg")).toBe(true);
		expect(isPictureUrl("data:video/mp4;base64,AAAA")).toBe(false);
		expect(isPictureUrl("data:audio/mp4;base64,AAAA")).toBe(false);
		expect(isPictureUrl(null)).toBe(false);
	});
});
