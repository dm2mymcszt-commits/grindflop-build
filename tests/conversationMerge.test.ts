import { describe, expect, test } from "bun:test";
import type { ConversationEntry } from "../src/types/messages";
import { mergeConversationForPreserve } from "../src/utils/conversationMerge";

function entry(data: Partial<ConversationEntry["data"]>): ConversationEntry {
	return {
		type: "Conversation",
		data: {
			conversationId: "1:2",
			name: "",
			participants: [{ profileId: 2 }],
			lastActivityTimestamp: 100,
			unreadCount: 0,
			muted: false,
			pinned: false,
			favorite: false,
			preview: null,
			...data,
		},
	} as ConversationEntry;
}

describe("the conversation saved just before an auto-block", () => {
	test("keeps the stored name and photo when the incoming entry has neither", () => {
		const merged = mergeConversationForPreserve(
			entry({ name: "", participants: [{ profileId: 2 }] }),
			entry({ name: "Alex", participants: [{ profileId: 2, primaryMediaHash: "abc" }] }),
		);
		expect(merged.data.name).toBe("Alex");
		expect(merged.data.participants).toEqual([{ profileId: 2, primaryMediaHash: "abc" }]);
	});

	test("prefers what the incoming entry does carry", () => {
		const merged = mergeConversationForPreserve(
			entry({ name: "Alex 2", participants: [{ profileId: 2, primaryMediaHash: "new" }] }),
			entry({ name: "Alex", participants: [{ profileId: 2, primaryMediaHash: "old" }] }),
		);
		expect(merged.data.name).toBe("Alex 2");
		expect(merged.data.participants[0].primaryMediaHash).toBe("new");
	});

	test("a display name fills a blank name before the stored one does", () => {
		expect(mergeConversationForPreserve(entry({ name: "" }), entry({ name: "Old" }), "Fresh").data.name).toBe(
			"Fresh",
		);
	});

	test("with nothing stored, the incoming entry is written as it is", () => {
		const incoming = entry({ name: "", participants: [{ profileId: 2 }] });
		expect(mergeConversationForPreserve(incoming, null)).toEqual(incoming);
	});

	test("someone with no profile name stays nameless", () => {
		expect(mergeConversationForPreserve(entry({ name: "" }), entry({ name: "" }), "").data.name).toBe("");
	});
});
