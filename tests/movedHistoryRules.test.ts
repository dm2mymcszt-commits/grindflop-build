import { describe, expect, test } from "bun:test";
import { rehomeConversationId, rehomeMessageRow } from "../src/utils/movedHistoryRules";

const OLD = "900000002";
const NEW = "920000003";

describe("rehomeConversationId", () => {
	test("keeps Grindr's smaller-id-first order under the new owner", () => {
		expect(rehomeConversationId(`177734404:${OLD}`, OLD, NEW)).toBe(`177734404:${NEW}`);
		// Between the two owners' ids: after the old one, before the new one.
		expect(rehomeConversationId(`${OLD}:910170960`, OLD, NEW)).toBe(`910170960:${NEW}`);
		expect(rehomeConversationId(`${OLD}:930000000`, OLD, NEW)).toBe(`${NEW}:930000000`);
	});

	test("orders by number, not by text", () => {
		expect(rehomeConversationId(`99:${OLD}`, OLD, NEW)).toBe(`99:${NEW}`);
	});

	test("refuses ids that aren't the old owner's conversations", () => {
		expect(rehomeConversationId("1:2", OLD, NEW)).toBeNull();
		expect(rehomeConversationId("direct:abc", OLD, NEW)).toBeNull();
		expect(rehomeConversationId(`${OLD}:${NEW}`, OLD, NEW)).toBeNull();
	});
});

describe("rehomeMessageRow", () => {
	const row = {
		message_id: "m1",
		conversation_id: `5:${OLD}`,
		sender_id: 5,
		timestamp: 10,
		type: "Text",
		body_json: '{"text":"hi"}',
		reactions_json: null,
	};

	test("their message keeps its sender", () => {
		expect(rehomeMessageRow(row, OLD, NEW)).toEqual({ ...row, conversation_id: `5:${NEW}` });
	});

	test("the old owner's own message becomes the new owner's", () => {
		const mine = rehomeMessageRow({ ...row, sender_id: Number(OLD) }, OLD, NEW);
		expect(mine?.sender_id).toBe(Number(NEW));
	});

	test("the old owner's reactions follow", () => {
		const reacted = rehomeMessageRow(
			{ ...row, reactions_json: `[{"profileId":${OLD},"reactionType":1},{"profileId":5,"reactionType":1}]` },
			OLD,
			NEW,
		);
		expect(JSON.parse(String(reacted?.reactions_json))).toEqual([
			{ profileId: Number(NEW), reactionType: 1 },
			{ profileId: 5, reactionType: 1 },
		]);
	});

	test("system markers keep sender 0", () => {
		const marker = rehomeMessageRow({ ...row, sender_id: 0, type: "SystemBlockedBySelf" }, OLD, NEW);
		expect(marker?.sender_id).toBe(0);
	});

	test("rows from other conversations are dropped", () => {
		expect(rehomeMessageRow({ ...row, conversation_id: "5:6" }, OLD, NEW)).toBeNull();
	});
});
