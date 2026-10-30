import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as chatDb from "../src/services/chatDb";
import {
	markConversationDeleteHandled,
	toggleArchiveOnConversationDelete,
} from "../src/services/conversationArchive";

const store = new Map<string, string>();
const dispatched: { type: string; detail: unknown }[] = [];
const globalScope = globalThis as unknown as { window?: unknown };
const previousWindow = globalScope.window;
// bun shares one global across test files; put it back so a later suite does
// not take a browser code path because of this one.
afterAll(() => {
	if (previousWindow === undefined) delete globalScope.window;
	else globalScope.window = previousWindow;
});
globalScope.window = {
	localStorage: {
		getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
		setItem: (key: string, value: string) => {
			store.set(key, value);
		},
	},
	dispatchEvent: (event: Event) => {
		dispatched.push({ type: event.type, detail: (event as CustomEvent).detail });
		return true;
	},
};

const USER_ID = 1;

type Harness = ReturnType<typeof mockChatDb>;

function mockChatDb(otherProfileId: string) {
	const spies = {
		getConversation: spyOn(chatDb, "getConversation").mockImplementation(
			async (conversationId: string) =>
				({
					conversationId,
					otherProfileId,
					blockState: null,
					archived: false,
					archivedReason: null,
				}) as unknown as Awaited<ReturnType<typeof chatDb.getConversation>>,
		),
		backfillOtherProfileId: spyOn(chatDb, "backfillOtherProfileId").mockResolvedValue(undefined),
		setConversationArchived: spyOn(chatDb, "setConversationArchived").mockResolvedValue(undefined),
		setBlockState: spyOn(chatDb, "setBlockState").mockResolvedValue(undefined),
		insertSystemMessage: spyOn(chatDb, "insertSystemMessage").mockImplementation(
			async (conversationId: string, type: string) =>
				({
					messageId: `local-system:${type}:${conversationId}`,
					conversationId,
					senderId: 0,
					timestamp: Date.now(),
					type,
					body: null,
				}) as unknown as Awaited<ReturnType<typeof chatDb.insertSystemMessage>>,
		),
	};
	return {
		...spies,
		restore: () => {
			for (const spy of Object.values(spies)) spy.mockRestore();
		},
	};
}

function counterBlockEvents() {
	return dispatched.filter((event) => event.type === "fg:trigger-counter-block");
}

// Each test uses its own conversation: the handler deliberately ignores a
// repeat event for the same conversation within a short window.
let nextOther = 500;

describe("conversation.delete attribution", () => {
	let harness: Harness | null = null;

	beforeEach(() => {
		store.clear();
		store.set("fg-autoblock-counter-block", "true");
		dispatched.length = 0;
	});

	afterEach(() => {
		harness?.restore();
		harness = null;
	});

	function fresh() {
		const other = String(nextOther++);
		harness = mockChatDb(other);
		return { conversationId: `${USER_ID}:${other}`, other, db: harness };
	}

	test("a delete for a profile that is still visible is not treated as a block", async () => {
		// This is what our own delete looks like when it arrives from another
		// device, and what an unblock looks like: their profile is visible.
		const { conversationId, db } = fresh();
		const result = await toggleArchiveOnConversationDelete(
			[conversationId],
			null,
			undefined,
			undefined,
			async () => "accessible",
			USER_ID,
		);
		expect(db.setBlockState).not.toHaveBeenCalled();
		expect(db.setConversationArchived).not.toHaveBeenCalled();
		expect(db.insertSystemMessage).not.toHaveBeenCalled();
		expect(counterBlockEvents()).toEqual([]);
		expect(result.archived).toEqual([]);
		expect(result.systemMessages).toEqual([]);
	});

	test("a lookup that fails is not treated as a block", async () => {
		const { conversationId, db } = fresh();
		await toggleArchiveOnConversationDelete(
			[conversationId],
			null,
			undefined,
			undefined,
			async () => {
				throw new Error("network down");
			},
			USER_ID,
		);
		expect(db.setBlockState).not.toHaveBeenCalled();
		expect(db.insertSystemMessage).not.toHaveBeenCalled();
		expect(counterBlockEvents()).toEqual([]);
	});

	test("a lookup that says blocked records the block and hands it to counter-block", async () => {
		const { conversationId, other, db } = fresh();
		const result = await toggleArchiveOnConversationDelete(
			[conversationId],
			null,
			undefined,
			undefined,
			async () => "blocked",
			USER_ID,
		);
		expect(db.setBlockState).toHaveBeenCalledWith(conversationId, "blocked_by_other");
		expect(db.setConversationArchived).toHaveBeenCalledWith(conversationId, true, "ws_delete");
		expect(db.insertSystemMessage).toHaveBeenCalledWith(conversationId, "SystemBlocked");
		expect(result.archived).toEqual([conversationId]);
		expect(counterBlockEvents()).toEqual([
			{ type: "fg:trigger-counter-block", detail: { profileId: other, conversationId } },
		]);
	});

	test("a deleted or banned account is archived as not found, never as a block", async () => {
		const { conversationId, db } = fresh();
		await toggleArchiveOnConversationDelete(
			[conversationId],
			null,
			undefined,
			undefined,
			async () => "not_found",
			USER_ID,
		);
		expect(db.setConversationArchived).toHaveBeenCalledWith(conversationId, true, "not_found");
		expect(db.setBlockState).not.toHaveBeenCalled();
		expect(db.insertSystemMessage).not.toHaveBeenCalled();
		expect(counterBlockEvents()).toEqual([]);
	});

	test("the echo of a delete this device just made is ignored outright", async () => {
		const { conversationId, db } = fresh();
		let lookups = 0;
		markConversationDeleteHandled(conversationId);
		await toggleArchiveOnConversationDelete(
			[conversationId],
			null,
			undefined,
			undefined,
			async () => {
				lookups += 1;
				return "blocked";
			},
			USER_ID,
		);
		expect(lookups).toBe(0);
		expect(db.getConversation).not.toHaveBeenCalled();
		expect(db.setBlockState).not.toHaveBeenCalled();
	});

	// Someone writes and blocks, or is removed, seconds later: the message is
	// saved but the chat has no row yet, and archiving a chat without a row
	// changes nothing. It then showed in no list, after a notification.
	describe("a chat with saved messages and no row yet", () => {
		const extra: { mockRestore: () => void }[] = [];
		const order: string[] = [];

		afterEach(() => {
			for (const spy of extra.splice(0)) spy.mockRestore();
			order.length = 0;
		});

		function unlisted(lastMessageAgeMs: number) {
			const { conversationId, other, db } = fresh();
			db.getConversation.mockImplementation(async () => null);
			db.setConversationArchived.mockImplementation(async () => {
				order.push("archive");
			});
			const recover = spyOn(chatDb, "recoverLatestOrphanedConversationForProfile").mockImplementation(
				async () =>
					({
						conversationId,
						otherProfileId: other,
						entry: { data: { conversationId, lastActivityTimestamp: Date.now() - lastMessageAgeMs } },
					}) as unknown as Awaited<ReturnType<typeof chatDb.recoverLatestOrphanedConversationForProfile>>,
			);
			const upsert = spyOn(chatDb, "upsertConversation").mockImplementation(async () => {
				order.push("list");
			});
			extra.push(recover, upsert);
			return { conversationId, other, db, upsert };
		}

		test("is listed first when they blocked right after writing", async () => {
			const { conversationId, other, upsert } = unlisted(3_000);
			const result = await toggleArchiveOnConversationDelete(
				[conversationId], null, undefined, undefined, async () => "blocked", USER_ID,
			);
			expect(upsert).toHaveBeenCalledTimes(1);
			expect(upsert.mock.calls[0][1]).toBe(other);
			expect(order).toEqual(["list", "archive"]);
			expect(result.archived).toEqual([conversationId]);
		});

		test("is listed first when their account was removed right after writing", async () => {
			const { conversationId, db, upsert } = unlisted(20_000);
			await toggleArchiveOnConversationDelete(
				[conversationId], null, undefined, undefined, async () => "not_found", USER_ID,
			);
			expect(order).toEqual(["list", "archive"]);
			expect(upsert).toHaveBeenCalledTimes(1);
			expect(db.setConversationArchived).toHaveBeenCalledWith(conversationId, true, "not_found");
		});

		test("stays gone when its last message is old: that is a chat the user deleted", async () => {
			const { conversationId, upsert } = unlisted(3 * 60 * 60_000);
			await toggleArchiveOnConversationDelete(
				[conversationId], null, undefined, undefined, async () => "blocked", USER_ID,
			);
			expect(upsert).not.toHaveBeenCalled();
		});

		test("is left alone when the event was not a block at all", async () => {
			const { conversationId, upsert } = unlisted(3_000);
			await toggleArchiveOnConversationDelete(
				[conversationId], null, undefined, undefined, async () => "accessible", USER_ID,
			);
			expect(upsert).not.toHaveBeenCalled();
			expect(order).toEqual([]);
		});
	});
});
