import { describe, expect, test } from "bun:test";
import {
	earliestTimestamp,
	NO_EARLIER_HISTORY,
	summarizeEarlierHistory,
} from "../src/utils/autoBlockHistory";

const ME = 1;
const THEM = 2;

describe("summarizeEarlierHistory", () => {
	test("reports nothing for an empty history", () => {
		expect(summarizeEarlierHistory([], ME)).toEqual(NO_EARLIER_HISTORY);
	});

	test("ignores system notes, which are stored with sender 0", () => {
		const summary = summarizeEarlierHistory(
			[{ senderId: 0, body: null }, { senderId: 0, body: { text: "not a real message" } }],
			ME,
		);
		expect(summary).toEqual(NO_EARLIER_HISTORY);
	});

	test("counts anything this account sent as outgoing", () => {
		const summary = summarizeEarlierHistory([{ senderId: ME, body: { url: "photo" } }], ME);
		expect(summary.hasOutgoing).toBe(true);
		expect(summary.hasIncoming).toBe(false);
	});

	test("media from them is incoming, but not text", () => {
		const summary = summarizeEarlierHistory([{ senderId: THEM, body: { albumId: 7 } }], ME);
		expect(summary.hasIncoming).toBe(true);
		expect(summary.hasIncomingText).toBe(false);
	});

	test("whitespace-only text is not text", () => {
		const summary = summarizeEarlierHistory([{ senderId: THEM, body: { text: "   " } }], ME);
		expect(summary.hasIncomingText).toBe(false);
	});

	test("text from them is incoming text, whether the body is an object or a string", () => {
		expect(summarizeEarlierHistory([{ senderId: THEM, body: { text: "hey" } }], ME).hasIncomingText).toBe(true);
		expect(summarizeEarlierHistory([{ senderId: String(THEM), body: "hey" }], ME).hasIncomingText).toBe(true);
	});

	test("a conversation deleted on Grindr still shows its earlier text here", () => {
		// The case that was auto-blocked: someone chats, the conversation is
		// deleted, and they come back with a lone album. Grindr's copy holds only
		// the album; the text before it survives only in local history.
		const summary = summarizeEarlierHistory(
			[
				{ senderId: THEM, body: { text: "hey, how are you?" } },
				{ senderId: THEM, body: { text: "wanna talk?" } },
			],
			ME,
		);
		expect(summary.hasIncoming).toBe(true);
		expect(summary.hasIncomingText).toBe(true);
	});
});

describe("earliestTimestamp", () => {
	test("is null when there are no messages", () => {
		expect(earliestTimestamp([])).toBeNull();
	});

	test("picks the smallest timestamp regardless of order", () => {
		expect(earliestTimestamp([{ timestamp: 300 }, { timestamp: 100 }, { timestamp: 200 }])).toBe(100);
	});

	test("skips messages without a usable timestamp", () => {
		expect(earliestTimestamp([{ timestamp: null }, {}, { timestamp: 0 }, { timestamp: 50 }])).toBe(50);
		expect(earliestTimestamp([{ timestamp: null }, {}])).toBeNull();
	});
});
