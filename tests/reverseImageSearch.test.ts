import { describe, expect, test } from "bun:test";
import { googleLensUrlForImage, linksFromYandexUpload, yandexSearchUrlForId } from "../src/services/reverseImageSearch";

describe("linksFromYandexUpload", () => {
	test("searches Yandex by id and Google Lens by Yandex's public copy", () => {
		const response = {
			blocks: [
				{
					params: {
						cbirId: "1107986/EWBWePlE61KKgW1TEXVLOg8632",
						originalImageUrl: "https://avatars.mds.yandex.net/get-images-cbir/1107986/EWBWePlE61KKgW1TEXVLOg8632/orig",
					},
				},
			],
		};
		expect(linksFromYandexUpload(response)).toEqual({
			yandex: "https://yandex.com/images/search?rpt=imageview&cbir_id=1107986%2FEWBWePlE61KKgW1TEXVLOg8632",
			googleLens:
				"https://lens.google.com/uploadbyurl?url=https%3A%2F%2Favatars.mds.yandex.net%2Fget-images-cbir%2F1107986%2FEWBWePlE61KKgW1TEXVLOg8632%2Forig",
		});
	});

	test("gives up without a search id, and never hands Lens a non-https copy", () => {
		expect(linksFromYandexUpload({ blocks: [{ params: {} }] })).toBeNull();
		expect(linksFromYandexUpload(null)).toBeNull();
		expect(
			linksFromYandexUpload({ blocks: [{ params: { cbirId: "1/abc", originalImageUrl: "javascript:alert(1)" } }] })?.googleLens,
		).toBe("https://lens.google.com/");
	});

	test("builds engine URLs with their arguments encoded", () => {
		expect(yandexSearchUrlForId("a/b c")).toBe("https://yandex.com/images/search?rpt=imageview&cbir_id=a%2Fb%20c");
		expect(googleLensUrlForImage("https://x.test/a?b=1&c=2")).toBe(
			"https://lens.google.com/uploadbyurl?url=https%3A%2F%2Fx.test%2Fa%3Fb%3D1%26c%3D2",
		);
	});
});
