import { describe, expect, test } from "bun:test";
import { isLinkBotHistory, isLinkOnlyMessage, linkBotMessageText } from "../src/utils/linkBotMessage";

const me = 920000003;
const them = 900000001;
const text = (senderId: number, value: string) => ({ senderId, type: "Text", body: { text: value } });

describe("link-only messages", () => {
	test("the message from the report counts, and so do the usual link shapes", () => {
		for (const value of [
			"bassew.com",
			" bassew.com ",
			"bassew.com.",
			"Bassew.COM",
			"https://bassew.com",
			"http://my-site.xyz/promo?id=4",
			"www.example.fr",
			"www.whatever.unusualtld",
			"cutt.ly/abc123",
			"<hot-guys.online>",
		]) {
			expect([value, isLinkOnlyMessage(value)]).toEqual([value, true]);
		}
	});

	test("what a person writes does not", () => {
		for (const value of [
			"",
			"hey",
			"Hey, check bassew.com",
			"bassew.com 🔥",
			"Mr.Smith",
			"lol.ok",
			"18.5",
			"me@gmail.com",
			"...",
			"ok.",
			"sup?",
		]) {
			expect([value, isLinkOnlyMessage(value)]).toEqual([value, false]);
		}
	});
});

describe("link-bot history", () => {
	test("only links from them and nothing from me is a bot", () => {
		expect(isLinkBotHistory([text(them, "bassew.com")], me)).toBe(true);
		expect(isLinkBotHistory([text(them, "bassew.com"), text(them, "https://bassew.com/x")], me)).toBe(true);
	});

	test("the app's own block note does not change the answer", () => {
		const note = { senderId: 0, type: "SystemBlocked", body: null };
		expect(isLinkBotHistory([text(them, "bassew.com"), note], me)).toBe(true);
	});

	test("a word from me, a sentence from them, or a photo means a person", () => {
		expect(isLinkBotHistory([text(them, "bassew.com"), text(me, "who are you?")], me)).toBe(false);
		expect(isLinkBotHistory([text(them, "hey"), text(them, "bassew.com")], me)).toBe(false);
		expect(isLinkBotHistory([{ senderId: them, type: "Image", body: { imageHash: "x" } }], me)).toBe(false);
	});

	test("no message from them, or no account, decides nothing", () => {
		expect(isLinkBotHistory([], me)).toBe(false);
		expect(isLinkBotHistory([text(them, "bassew.com")], null)).toBe(false);
	});

	test("reads stored bodies, live bodies and inbox previews", () => {
		expect(linkBotMessageText({ body: { text: "a.com" } })).toBe("a.com");
		expect(linkBotMessageText({ body: "a.com" })).toBe("a.com");
		expect(linkBotMessageText({ text: "a.com" })).toBe("a.com");
	});
});
