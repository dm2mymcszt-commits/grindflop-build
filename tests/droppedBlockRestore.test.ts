import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as chatDb from "../src/services/chatDb";
import {
	reconcileArchivedConversationForProfile,
	restoreDroppedBlock,
} from "../src/services/conversationArchive";

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
	localStorage: { getItem: () => null, setItem: () => {} },
	dispatchEvent: (event: Event) => {
		dispatched.push({ type: event.type, detail: (event as CustomEvent).detail });
		return true;
	},
};

type Stored = NonNullable<Awaited<ReturnType<typeof chatDb.findConversationByProfileId>>>;

const BLOCKED_AT = 1_791_310_663_000;
const LONG_AFTER = BLOCKED_AT + 13.5 * 60_000;

// Each test uses its own person: who acted recently, and who was rechecked
// recently, are both remembered per conversation for the whole run.
let nextProfile = 9000;

function mockChatDb(overrides: Partial<Stored> | null) {
	const profileId = String(nextProfile++);
	const stored =
		overrides === null
			? null
			: ({
					conversationId: `1:${profileId}`,
					otherProfileId: profileId,
					archived: true,
					archivedReason: "ws_delete",
					archivedAt: BLOCKED_AT,
					blockState: "blocked_by_me",
					...overrides,
				} as Stored);
	const spies = {
		findConversationByProfileId: spyOn(chatDb, "findConversationByProfileId").mockResolvedValue(stored),
		getConversation: spyOn(chatDb, "getConversation").mockResolvedValue(stored),
		setConversationArchived: spyOn(chatDb, "setConversationArchived").mockResolvedValue(undefined),
		setBlockState: spyOn(chatDb, "setBlockState").mockResolvedValue(undefined),
		setConversationUnreadCount: spyOn(chatDb, "setConversationUnreadCount").mockResolvedValue(
			undefined,
		),
	};
	return {
		profileId,
		...spies,
		restore: () => {
			for (const spy of Object.values(spies)) spy.mockRestore();
		},
	};
}

function blocker(outcome: "ok" | "fails" = "ok") {
	const calls: number[] = [];
	return {
		calls,
		blockProfile: async () => {
			calls.push(Date.now());
			if (outcome === "fails") throw new Error("network");
		},
	};
}

describe("restoreDroppedBlock", () => {
	let harness: ReturnType<typeof mockChatDb> | null = null;

	beforeEach(() => {
		dispatched.length = 0;
	});

	afterEach(() => {
		harness?.restore();
		harness = null;
	});

	// Auto-blocked at 20:17; at 20:31 their profile was opened and Grindr served
	// it in full. The chat used to be taken out of the archive at that moment.
	test("a block Grindr dropped is sent again, and the chat is left as it was", async () => {
		harness = mockChatDb({});
		const { calls, blockProfile } = blocker();

		const outcome = await restoreDroppedBlock({
			profileId: harness.profileId,
			evidenceAt: LONG_AFTER,
			blockProfile,
		});

		expect(outcome).toBe("restored");
		expect(calls).toHaveLength(1);
		expect(harness.setConversationArchived).not.toHaveBeenCalled();
		expect(harness.setBlockState).not.toHaveBeenCalled();
		// The blocked-list cache learns of it without waiting for a refetch.
		expect(dispatched).toContainEqual({
			type: "fg:self-block",
			detail: { profileId: harness.profileId },
		});
	});

	test("a second sign of life straight after does not send it twice", async () => {
		harness = mockChatDb({});
		const { calls, blockProfile } = blocker();
		const input = { profileId: harness.profileId, evidenceAt: LONG_AFTER, blockProfile };

		expect(await restoreDroppedBlock(input)).toBe("restored");
		expect(await restoreDroppedBlock(input)).toBe("none");
		expect(calls).toHaveLength(1);
	});

	test("a request that fails is reported, and the chat still stays archived", async () => {
		harness = mockChatDb({});
		const { blockProfile } = blocker("fails");

		const outcome = await restoreDroppedBlock({
			profileId: harness.profileId,
			evidenceAt: LONG_AFTER,
			blockProfile,
		});

		expect(outcome).toBe("failed");
		expect(harness.setConversationArchived).not.toHaveBeenCalled();
		expect(harness.setBlockState).not.toHaveBeenCalled();
		expect(dispatched.filter((event) => event.type === "fg:self-block")).toHaveLength(0);
	});

	test("nobody is blocked unless their chat says this account blocked them", async () => {
		const cases: (Partial<Stored> | null)[] = [
			// They blocked this account.
			{ blockState: "blocked_by_other" },
			// Unblocked since, here or on another device.
			{ blockState: null, archived: false, archivedReason: null, archivedAt: null },
			// Archived because the profile was gone, not because of a block.
			{ blockState: null, archivedReason: "not_found" },
			// No chat at all.
			null,
		];
		for (const overrides of cases) {
			harness = mockChatDb(overrides);
			const { calls, blockProfile } = blocker();
			const outcome = await restoreDroppedBlock({
				profileId: harness.profileId,
				evidenceAt: LONG_AFTER,
				blockProfile,
			});
			expect(outcome).toBe("none");
			expect(calls).toHaveLength(0);
			harness.restore();
			harness = null;
		}
	});

	test("a message sent before the block does not count", async () => {
		harness = mockChatDb({});
		const { calls, blockProfile } = blocker();

		const outcome = await restoreDroppedBlock({
			profileId: harness.profileId,
			evidenceAt: BLOCKED_AT - 2_000,
			blockProfile,
		});

		expect(outcome).toBe("none");
		expect(calls).toHaveLength(0);
	});
});

describe("reconcileArchivedConversationForProfile", () => {
	let harness: ReturnType<typeof mockChatDb> | null = null;

	afterEach(() => {
		harness?.restore();
		harness = null;
	});

	// The bulk lookup finds someone this account blocked just as it finds anyone
	// else, so once Grindr's list no longer held them, a view or a read receipt
	// was enough to bring the chat back.
	test("activity from someone this account blocked does not reopen their chat", async () => {
		harness = mockChatDb({});
		let lookups = 0;

		await reconcileArchivedConversationForProfile(harness.profileId, async () => {
			lookups += 1;
			return true;
		});

		expect(lookups).toBe(0);
		expect(harness.setConversationArchived).not.toHaveBeenCalled();
		expect(harness.setBlockState).not.toHaveBeenCalled();
	});

	test("activity from someone who had blocked this account still does", async () => {
		harness = mockChatDb({ blockState: "blocked_by_other" });

		await reconcileArchivedConversationForProfile(harness.profileId, async () => true);

		expect(harness.setBlockState).toHaveBeenCalledWith(`1:${harness.profileId}`, null);
		expect(harness.setConversationArchived).toHaveBeenCalledWith(
			`1:${harness.profileId}`,
			false,
			null,
		);
	});
});
