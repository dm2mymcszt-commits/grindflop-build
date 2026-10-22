import { describe, expect, test } from "bun:test";
import {
	MAX_PAST_MESSAGES,
	buildPastContacts,
	describePastContact,
	otherProfileInConversation,
	type PastContactMessage,
} from "../src/utils/pastContactRules";

const OLD = "900000002";
const text = (from: string, other: string, timestamp: number, body = "hi"): PastContactMessage => ({
	conversationId: `${other}:${OLD}`,
	senderId: from,
	type: "Text",
	timestamp,
	text: body,
});
const marker = (other: string, type: string, timestamp: number): PastContactMessage => ({
	conversationId: `${other}:${OLD}`,
	senderId: "0",
	type,
	timestamp,
	text: "",
});

describe("otherProfileInConversation", () => {
	test("finds the other side on either end", () => {
		expect(otherProfileInConversation(`123:${OLD}`, OLD)).toBe("123");
		expect(otherProfileInConversation(`${OLD}:456`, OLD)).toBe("456");
	});
	test("ignores conversations of another account and odd ids", () => {
		expect(otherProfileInConversation("123:456", OLD)).toBeNull();
		expect(otherProfileInConversation("group-chat", OLD)).toBeNull();
	});
});

describe("buildPastContacts", () => {
	test("counts their messages and my replies, and keeps their last words", () => {
		const [contact] = buildPastContacts({
			sourceProfileId: OLD,
			messages: [text("5", "5", 100, "hey"), text(OLD, "5", 200, "hello"), text("5", "5", 300, "  how  are you ")],
			loggedBlocks: [],
		});
		expect(contact).toMatchObject({
			profileId: "5",
			theirMessages: 2,
			myMessages: 1,
			firstMessageAt: 100,
			lastMessageAt: 300,
			lastText: "how are you",
			blockedByMeAt: null,
		});
	});

	test("keeps the old conversation in order, naming photos instead of linking them", () => {
		const [contact] = buildPastContacts({
			sourceProfileId: OLD,
			messages: [
				text(OLD, "5", 300, "sure"),
				{ ...text("5", "5", 100, ""), type: "Image" },
				text("5", "5", 200, "hey"),
				marker("5", "SystemBlockedBySelf", 400),
			],
			loggedBlocks: [],
		});
		expect(contact.messages).toEqual([
			{ at: 100, mine: false, text: "Photo" },
			{ at: 200, mine: false, text: "hey" },
			{ at: 300, mine: true, text: "sure" },
		]);
	});

	test("keeps only the newest messages of a long conversation", () => {
		const many = Array.from({ length: MAX_PAST_MESSAGES + 5 }, (_, index) => text("5", "5", index, `m${index}`));
		const [contact] = buildPastContacts({ sourceProfileId: OLD, messages: many, loggedBlocks: [] });
		expect(contact.messages).toHaveLength(MAX_PAST_MESSAGES);
		expect(contact.messages[0].text).toBe("m5");
		expect(contact.theirMessages).toBe(MAX_PAST_MESSAGES + 5);
	});

	test("system markers are blocks, not messages", () => {
		const [contact] = buildPastContacts({
			sourceProfileId: OLD,
			messages: [marker("7", "SystemBlockedBySelf", 500)],
			loggedBlocks: [],
		});
		expect(contact).toMatchObject({ theirMessages: 0, myMessages: 0, blockedByMeAt: 500 });
	});

	test("a later unblock clears the block and its reason", () => {
		const [contact] = buildPastContacts({
			sourceProfileId: OLD,
			messages: [text("8", "8", 10), marker("8", "SystemBlockedBySelf", 20), marker("8", "SystemUnblockedBySelf", 30)],
			loggedBlocks: [{ profileId: "8", blocked: true, timestamp: 21, reason: "Age limit (30)" }],
		});
		expect(contact.blockedByMeAt).toBeNull();
		expect(contact.blockReason).toBeNull();
	});

	test("the Stats reason sticks whichever of the two is newer", () => {
		for (const [markerAt, loggedAt] of [
			[100, 101],
			[101, 100],
		]) {
			const [contact] = buildPastContacts({
				sourceProfileId: OLD,
				messages: [marker("9", "SystemBlockedBySelf", markerAt)],
				loggedBlocks: [{ profileId: "9", blocked: true, timestamp: loggedAt, reason: "No Age Set" }],
			});
			expect(contact.blockedByMeAt).toBe(Math.max(markerAt, loggedAt));
			expect(contact.blockReason).toBe("No Age Set");
		}
	});

	test("records when they blocked the old account", () => {
		const [contact] = buildPastContacts({
			sourceProfileId: OLD,
			messages: [marker("3", "SystemBlocked", 40)],
			loggedBlocks: [],
		});
		expect(contact.blockedMeAt).toBe(40);
	});

	test("blocks from the Stats log alone still make a contact", () => {
		const contacts = buildPastContacts({
			sourceProfileId: OLD,
			messages: [],
			loggedBlocks: [
				{ profileId: "11", blocked: true, timestamp: 1, reason: null },
				{ profileId: OLD, blocked: true, timestamp: 1, reason: null },
				{ profileId: "abc", blocked: true, timestamp: 1, reason: null },
			],
		});
		expect(contacts.map((contact) => contact.profileId)).toEqual(["11"]);
	});

	test("people with nothing to remember are left out", () => {
		const contacts = buildPastContacts({
			sourceProfileId: OLD,
			messages: [marker("12", "SystemBlockedBySelf", 1), marker("12", "SystemUnblockedBySelf", 2)],
			loggedBlocks: [],
		});
		expect(contacts).toEqual([]);
	});
});

describe("describePastContact", () => {
	const date = (timestamp: number) => `day${timestamp}`;
	const base = {
		profileId: "5",
		sourceProfileId: OLD,
		displayName: null,
		theirMessages: 0,
		myMessages: 0,
		firstMessageAt: null,
		lastMessageAt: null,
		lastText: null,
		blockedByMeAt: null,
		blockReason: null,
		blockedMeAt: null,
		messages: [],
	};

	test("someone who wrote and never got an answer", () => {
		const summary = describePastContact({ ...base, theirMessages: 3, lastMessageAt: 9, lastText: "hey" }, date);
		expect(summary.badge).toBe("Old account: no reply");
		expect(summary.lines).toEqual([
			"Wrote to your old account (3 messages, last on day9).",
			"You never replied.",
			"Their last message: “hey”",
		]);
	});

	test("someone blocked, with the reason", () => {
		const summary = describePastContact(
			{ ...base, theirMessages: 1, lastMessageAt: 4, myMessages: 1, blockedByMeAt: 5, blockReason: "Age limit (30)" },
			date,
		);
		expect(summary.badge).toBe("Old account: wrote · blocked");
		expect(summary.lines).toContain("You replied (1 message).");
		expect(summary.lines).toContain("You blocked them on day5 — Age limit (30).");
	});

	test("someone who blocked the old account", () => {
		const summary = describePastContact({ ...base, blockedMeAt: 6 }, date);
		expect(summary.badge).toBe("Old account: blocked you");
		expect(summary.lines).toEqual(["They blocked your old account on day6."]);
	});
});
