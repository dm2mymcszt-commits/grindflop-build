import { beforeEach, describe, expect, test } from "bun:test";
import type { ConversationEntry, Message } from "../src/types/messages";
import {
	clearChatSearchIndex,
	getChatSearchIndexRevision,
	indexConversations,
	indexMessages,
	replaceChatSearchIndex,
	searchConversationsLocal,
	searchMessagesLocal,
	subscribeChatSearchIndex,
} from "../src/pages/app/chat/cache";

function conversation(id: string, name: string): ConversationEntry {
	return {
		type: "Direct",
		data: {
			conversationId: id,
			name,
			participants: [],
			unreadCount: 0,
			muted: false,
			pinned: false,
			favorite: false,
			lastActivityTimestamp: 1,
		},
	};
}

function message(id: string, conversationId: string, text: string | null): Message {
	return {
		messageId: id,
		conversationId,
		senderId: 7,
		timestamp: 1,
		type: "Text",
		chat1Type: "text",
		body: text === null ? null : { text },
		unsent: text === null,
		reactions: [],
	};
}

beforeEach(() => {
	clearChatSearchIndex();
});

describe("chat search cache", () => {
	test("an authoritative replacement removes remotely deleted rows", () => {
		indexConversations([
			conversation("kept", "Kept person"),
			conversation("deleted", "Deleted person"),
		]);
		indexMessages([
			message("kept-message", "kept", "still here"),
			message("deleted-message", "deleted", "remove me"),
		]);

		replaceChatSearchIndex(
			[conversation("kept", "Kept person")],
			[message("kept-message", "kept", "still here")],
		);

		expect(searchConversationsLocal("deleted")).toEqual([]);
		expect(searchMessagesLocal("remove me")).toEqual([]);
		expect(searchMessagesLocal("still here").map((item) => item.messageId)).toEqual([
			"kept-message",
		]);
	});

	test("an incremental content wipe evicts the old searchable message", () => {
		indexMessages([message("message", "conversation", "secret text")]);
		expect(searchMessagesLocal("secret")).toHaveLength(1);

		indexMessages([message("message", "conversation", null)]);
		expect(searchMessagesLocal("secret")).toEqual([]);
	});

	test("subscribers observe one revision for an atomic replacement", () => {
		const revisions: number[] = [];
		const unsubscribe = subscribeChatSearchIndex(() => {
			revisions.push(getChatSearchIndexRevision());
		});

		replaceChatSearchIndex(
			[conversation("conversation", "Person")],
			[message("message", "conversation", "hello")],
		);
		unsubscribe();
		indexMessages([message("later", "conversation", "later")]);

		expect(revisions).toHaveLength(1);
		expect(revisions[0]).toBeGreaterThan(0);
	});
});
