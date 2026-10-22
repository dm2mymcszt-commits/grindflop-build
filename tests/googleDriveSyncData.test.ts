import { describe, expect, spyOn, test } from "bun:test";
import {
	createSyncOperation,
	entityIdSchema,
	InMemorySyncSequenceAllocator,
	type JsonValue,
} from "../src/services/cloudSync";
import * as chatDb from "../src/services/chatDb";
import * as contactIndex from "../src/services/chatContactIndex";
import * as interestViews from "../src/services/interestViewsStore";
import {
	applyGoogleDriveSyncOperation,
	applyGoogleDriveSyncOperationConditionally,
	CLOUD_SYNCABLE_DB_SETTING_KEYS,
	CLOUD_SYNCABLE_LOCAL_STORAGE_KEYS,
	decodeSyncEntityId,
	encodeSyncEntityId,
	scanGoogleDriveSyncEntities,
	type GoogleDriveSyncEntity,
	validateGoogleDriveSyncOperationBoundary,
} from "../src/services/googleDriveSyncData";

const TEST_PROFILE_ID = 123;
const TEST_INTEREST_ACCOUNT = `open-grind-interest-${TEST_PROFILE_ID}`;

function installMinimalWindow(): () => void {
	const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: {
			localStorage: {
				getItem: () => null,
			},
		},
	});
	return () => {
		if (previous) {
			Object.defineProperty(globalThis, "window", previous);
		} else {
			Reflect.deleteProperty(globalThis, "window");
		}
	};
}

function installMutableWindow(initial: Record<string, string>): {
	values: Map<string, string>;
	setCalls: Array<readonly [string, string]>;
	removeCalls: string[];
	restore: () => void;
} {
	const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
	const values = new Map(Object.entries(initial));
	const setCalls: Array<readonly [string, string]> = [];
	const removeCalls: string[] = [];
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: {
			localStorage: {
				getItem: (key: string) => values.get(key) ?? null,
				setItem: (key: string, value: string) => {
					setCalls.push([key, value]);
					values.set(key, value);
				},
				removeItem: (key: string) => {
					removeCalls.push(key);
					values.delete(key);
				},
			},
		},
	});
	return {
		values,
		setCalls,
		removeCalls,
		restore: () => {
			if (previous) {
				Object.defineProperty(globalThis, "window", previous);
			} else {
				Reflect.deleteProperty(globalThis, "window");
			}
		},
	};
}

function installActiveProfileSpies(): {
	restore: () => void;
} {
	const chatProfile = spyOn(chatDb, "getActiveChatDbUser").mockReturnValue(TEST_PROFILE_ID);
	const contactProfile = spyOn(
		contactIndex,
		"getActiveChatContactIndexUser",
	).mockReturnValue(TEST_PROFILE_ID);
	const interestAccount = spyOn(
		interestViews,
		"getActiveInterestViewsAccount",
	).mockReturnValue(TEST_INTEREST_ACCOUNT);
	return {
		restore: () => {
			interestAccount.mockRestore();
			contactProfile.mockRestore();
			chatProfile.mockRestore();
		},
	};
}

async function makeConditionalOperations(
	section: "core" | "contact-index" | "interest-views" | "preferences",
	entityType: string,
	primaryKey: string,
	expectedValue: JsonValue,
	incomingValue: JsonValue,
) {
	const allocator = new InMemorySyncSequenceAllocator();
	const expected = createSyncOperation({
		operationId: `expected-${entityType}`,
		accountNamespace: "acct-test",
		sourceDeviceId: "device-a",
		sequence: await allocator.next("acct-test", "device-a"),
		section,
		entityType,
		entityId: encodeSyncEntityId(primaryKey),
		mutation: { kind: "upsert", value: expectedValue },
	});
	const incoming = createSyncOperation({
		operationId: `incoming-${entityType}`,
		accountNamespace: "acct-test",
		sourceDeviceId: "device-b",
		sequence: await allocator.next("acct-test", "device-b"),
		section,
		entityType,
		entityId: encodeSyncEntityId(primaryKey),
		mutation: { kind: "upsert", value: incomingValue },
	});
	return { expected, incoming };
}

describe("Google Drive sync data boundary", () => {
	test("encodes arbitrary Unicode primary keys as schema-safe reversible IDs", () => {
		const original = "Hello\n👋 café — 你好";
		const encoded = encodeSyncEntityId(original);
		expect(entityIdSchema.parse(encoded)).toBe(encoded);
		expect(decodeSyncEntityId(encoded)).toBe(original);
	});

	test("rejects oversized entity keys before they can create invalid packages", () => {
		expect(() => encodeSyncEntityId("x".repeat(600))).toThrow();
	});

	test("excludes every app-global browser preference from new cloud data", () => {
		expect(CLOUD_SYNCABLE_LOCAL_STORAGE_KEYS.size).toBe(0);
		expect(CLOUD_SYNCABLE_LOCAL_STORAGE_KEYS.has("app_preferences")).toBe(false);
		expect(CLOUD_SYNCABLE_LOCAL_STORAGE_KEYS.has("fg-auto-block-whitelist")).toBe(false);
		expect(CLOUD_SYNCABLE_LOCAL_STORAGE_KEYS.has("fg-ghost-exceptions")).toBe(false);

		for (const forbidden of [
			"fg-user-id",
			"fg-fcm-token",
			"fg-fcm-token-synced",
			"fg-device-id",
			"fg-backup-peers",
			"fg-saved-account-profiles",
			"fg-view-scanner-last-run",
			"fg-analytics-consent",
			"fg-reporter-details",
		]) {
			expect(CLOUD_SYNCABLE_LOCAL_STORAGE_KEYS.has(forbidden)).toBe(false);
		}
	});

	test("does not scan legacy global preferences even when they are populated", async () => {
		const localStorage = installMutableWindow({
			"fg-auto-block-whitelist": '[{"profileId":"belongs-to-another-account"}]',
			"fg-ghost-exceptions": '{"conversation-from-another-account":true}',
		});
		const activeProfile = installActiveProfileSpies();
		const chatPage = spyOn(chatDb, "selectTablePageAfter").mockResolvedValue([]);
		const contactPage = spyOn(
			contactIndex,
			"selectContactIndexPageAfter",
		).mockResolvedValue([]);
		const exportViews = spyOn(interestViews, "exportInterestViewRows").mockResolvedValue([]);
		const emitted: GoogleDriveSyncEntity[] = [];

		try {
			await scanGoogleDriveSyncEntities(TEST_PROFILE_ID, false, async (entity) => {
				emitted.push(entity);
			});
			expect(emitted).toEqual([]);
		} finally {
			exportViews.mockRestore();
			contactPage.mockRestore();
			chatPage.mockRestore();
			activeProfile.restore();
			localStorage.restore();
		}
	});

	test("defaults unknown database settings to device-local", () => {
		expect(CLOUD_SYNCABLE_DB_SETTING_KEYS.has("automation")).toBe(true);
		expect(CLOUD_SYNCABLE_DB_SETTING_KEYS.has("privacy")).toBe(true);
		for (const deviceOnly of [
			"autoDownloadMedia",
			"inboxSyncCompletedV1",
			"syntheticBlockedConversationPurgeV1",
			"automation_age_defaults_seeded_v2",
			"newly-added-unreviewed-setting",
		]) {
			expect(CLOUD_SYNCABLE_DB_SETTING_KEYS.has(deviceOnly)).toBe(false);
		}
	});

	test("rejects section smuggling and unclassified settings before applying", async () => {
		const allocator = new InMemorySyncSequenceAllocator();
		const sequence = await allocator.next("acct-test", "device-a");
		const wrongSection = createSyncOperation({
			accountNamespace: "acct-test",
			sourceDeviceId: "device-a",
			sequence,
			section: "media",
			entityType: "message",
			entityId: encodeSyncEntityId("message-1"),
			mutation: { kind: "delete" },
		});
		expect(() => validateGoogleDriveSyncOperationBoundary(wrongSection)).toThrow();

		const settingSequence = await allocator.next("acct-test", "device-a");
		const unknownSetting = createSyncOperation({
			accountNamespace: "acct-test",
			sourceDeviceId: "device-a",
			sequence: settingSequence,
			section: "core",
			entityType: "setting",
			entityId: encodeSyncEntityId("future-secret"),
			mutation: { kind: "delete" },
		});
		expect(() => validateGoogleDriveSyncOperationBoundary(unknownSetting)).toThrow();
	});

	test("includes the interest-view account in the active profile guard", async () => {
		const chatProfile = spyOn(chatDb, "getActiveChatDbUser").mockReturnValue(TEST_PROFILE_ID);
		const contactProfile = spyOn(
			contactIndex,
			"getActiveChatContactIndexUser",
		).mockReturnValue(TEST_PROFILE_ID);
		const interestAccount = spyOn(
			interestViews,
			"getActiveInterestViewsAccount",
		).mockReturnValue("open-grind-interest-999");

		try {
			await expect(
				scanGoogleDriveSyncEntities(TEST_PROFILE_ID, false, async () => {}),
			).rejects.toThrow("active GrindFlop profile changed");
		} finally {
			interestAccount.mockRestore();
			contactProfile.mockRestore();
			chatProfile.mockRestore();
		}
	});

	test("advances keyset paging past a full page of device-local settings", async () => {
		const restoreWindow = installMinimalWindow();
		const chatProfile = spyOn(chatDb, "getActiveChatDbUser").mockReturnValue(TEST_PROFILE_ID);
		const contactProfile = spyOn(
			contactIndex,
			"getActiveChatContactIndexUser",
		).mockReturnValue(TEST_PROFILE_ID);
		const interestAccount = spyOn(
			interestViews,
			"getActiveInterestViewsAccount",
		).mockReturnValue(TEST_INTEREST_ACCOUNT);
		const skippedSettings = Array.from({ length: 500 }, (_, index) => ({
			key: `device-only-${String(index).padStart(3, "0")}`,
			value: "not-portable",
		}));
		const settingsCursors: Array<string | null> = [];
		const chatPage = spyOn(chatDb, "selectTablePageAfter").mockImplementation(
			async (table, after) => {
				if (table !== "settings") return [];
				settingsCursors.push(after);
				return after == null ? skippedSettings : [];
			},
		);
		const contactPage = spyOn(
			contactIndex,
			"selectContactIndexPageAfter",
		).mockResolvedValue([]);
		const exportViews = spyOn(interestViews, "exportInterestViewRows").mockResolvedValue([]);

		try {
			await scanGoogleDriveSyncEntities(TEST_PROFILE_ID, false, async () => {});
			expect(settingsCursors).toEqual([null, "device-only-499"]);
		} finally {
			exportViews.mockRestore();
			contactPage.mockRestore();
			chatPage.mockRestore();
			interestAccount.mockRestore();
			contactProfile.mockRestore();
			chatProfile.mockRestore();
			restoreWindow();
		}
	});

	test("cancels an interest export if the active account changes during the read", async () => {
		const chatProfile = spyOn(chatDb, "getActiveChatDbUser").mockReturnValue(TEST_PROFILE_ID);
		const contactProfile = spyOn(
			contactIndex,
			"getActiveChatContactIndexUser",
		).mockReturnValue(TEST_PROFILE_ID);
		let activeInterestAccount = TEST_INTEREST_ACCOUNT;
		const interestAccount = spyOn(
			interestViews,
			"getActiveInterestViewsAccount",
		).mockImplementation(() => activeInterestAccount);
		const chatPage = spyOn(chatDb, "selectTablePageAfter").mockResolvedValue([]);
		const contactPage = spyOn(
			contactIndex,
			"selectContactIndexPageAfter",
		).mockResolvedValue([]);
		const exportViews = spyOn(interestViews, "exportInterestViewRows").mockImplementation(
			async () => {
				activeInterestAccount = "open-grind-interest-999";
				return [
					{
						profileId: "viewer-1",
						displayName: "Viewer",
						imageHash: null,
						timestamp: 1,
						viewCount: 1,
						updatedAt: 1,
					},
				];
			},
		);
		let emitted = 0;

		try {
			await expect(
				scanGoogleDriveSyncEntities(TEST_PROFILE_ID, false, async () => {
					emitted += 1;
				}),
			).rejects.toThrow("active GrindFlop profile changed");
			expect(emitted).toBe(0);
		} finally {
			exportViews.mockRestore();
			contactPage.mockRestore();
			chatPage.mockRestore();
			interestAccount.mockRestore();
			contactProfile.mockRestore();
			chatProfile.mockRestore();
		}
	});

	test("cancels interest deletes and imports that finish after an account switch", async () => {
		const chatProfile = spyOn(chatDb, "getActiveChatDbUser").mockReturnValue(TEST_PROFILE_ID);
		const contactProfile = spyOn(
			contactIndex,
			"getActiveChatContactIndexUser",
		).mockReturnValue(TEST_PROFILE_ID);
		let activeInterestAccount = TEST_INTEREST_ACCOUNT;
		const interestAccount = spyOn(
			interestViews,
			"getActiveInterestViewsAccount",
		).mockImplementation(() => activeInterestAccount);
		const deleteMany = spyOn(interestViews.interestViewsStore, "deleteMany").mockImplementation(
			async () => {
				activeInterestAccount = "open-grind-interest-999";
			},
		);

		const allocator = new InMemorySyncSequenceAllocator();
		const deleteOperation = createSyncOperation({
			accountNamespace: "acct-test",
			sourceDeviceId: "device-a",
			sequence: await allocator.next("acct-test", "device-a"),
			section: "interest-views",
			entityType: "interest-view",
			entityId: encodeSyncEntityId("viewer-1"),
			mutation: { kind: "delete" },
		});

		try {
			await expect(
				applyGoogleDriveSyncOperation(TEST_PROFILE_ID, deleteOperation),
			).rejects.toThrow("active GrindFlop profile changed");

			activeInterestAccount = TEST_INTEREST_ACCOUNT;
			deleteMany.mockRestore();
			const importRows = spyOn(interestViews, "importInterestViewRows").mockImplementation(
				async () => {
					activeInterestAccount = "open-grind-interest-999";
					return true;
				},
			);
			const importOperation = createSyncOperation({
				accountNamespace: "acct-test",
				sourceDeviceId: "device-a",
				sequence: await allocator.next("acct-test", "device-a"),
				section: "interest-views",
				entityType: "interest-view",
				entityId: encodeSyncEntityId("viewer-1"),
				mutation: {
					kind: "upsert",
					value: {
						profileId: "viewer-1",
						displayName: "Viewer",
						imageHash: null,
						timestamp: 1,
						viewCount: 1,
						updatedAt: 1,
					},
				},
			});
			try {
				await expect(
					applyGoogleDriveSyncOperation(TEST_PROFILE_ID, importOperation),
				).rejects.toThrow("active GrindFlop profile changed");
			} finally {
				importRows.mockRestore();
			}
		} finally {
			deleteMany.mockRestore();
			interestAccount.mockRestore();
			contactProfile.mockRestore();
			chatProfile.mockRestore();
		}
	});
});

describe("conditional Google Drive sync apply", () => {
	test("maps chat compare results and passes incoming and expected row predicates", async () => {
		const activeProfile = installActiveProfileSpies();
		const expectedRow = {
			conversation_id: "conversation-1",
			name: "Before",
		};
		const incomingRow = {
			conversation_id: "conversation-1",
			name: "After",
		};
		const { expected, incoming } = await makeConditionalOperations(
			"core",
			"conversation",
			"conversation-1",
			expectedRow,
			incomingRow,
		);
		const results: Array<"applied" | "already-current" | "changed"> = [
			"applied",
			"already-current",
			"changed",
		];
		let predicates:
			| Parameters<typeof chatDb.compareAndApplyPortableTableRow>[3]
			| undefined;
		const compare = spyOn(
			chatDb,
			"compareAndApplyPortableTableRow",
		).mockImplementation(async (_table, _key, _mutation, options) => {
			predicates ??= options;
			return results.shift() ?? "changed";
		});

		try {
			expect(
				await applyGoogleDriveSyncOperationConditionally(
					TEST_PROFILE_ID,
					incoming,
					expected,
				),
			).toBe(true);
			expect(
				await applyGoogleDriveSyncOperationConditionally(
					TEST_PROFILE_ID,
					incoming,
					expected,
				),
			).toBe(true);
			expect(
				await applyGoogleDriveSyncOperationConditionally(
					TEST_PROFILE_ID,
					incoming,
					expected,
				),
			).toBe(false);
			expect(compare).toHaveBeenCalledTimes(3);
			expect(predicates?.matchesIncoming(incomingRow)).toBe(true);
			expect(predicates?.matchesIncoming(expectedRow)).toBe(false);
			expect(predicates?.matchesExpected(expectedRow)).toBe(true);
			expect(
				predicates?.matchesExpected({
					conversation_id: "conversation-1",
					name: "Concurrent local edit",
				}),
			).toBe(false);
		} finally {
			compare.mockRestore();
			activeProfile.restore();
		}
	});

	test("maps contact compare results and passes incoming and expected row predicates", async () => {
		const activeProfile = installActiveProfileSpies();
		const expectedRow = {
			profile_id: "profile-1",
			nickname: "Before",
			updated_at: 1,
		};
		const incomingRow = {
			profile_id: "profile-1",
			nickname: "After",
			updated_at: 2,
		};
		const { expected, incoming } = await makeConditionalOperations(
			"contact-index",
			"profile-nickname",
			"profile-1",
			expectedRow,
			incomingRow,
		);
		const results: Array<"applied" | "already-current" | "changed"> = [
			"applied",
			"already-current",
			"changed",
		];
		let predicates:
			| Parameters<typeof contactIndex.compareAndApplyContactIndexRow>[3]
			| undefined;
		const compare = spyOn(
			contactIndex,
			"compareAndApplyContactIndexRow",
		).mockImplementation(async (_table, _key, _mutation, options) => {
			predicates ??= options;
			return results.shift() ?? "changed";
		});

		try {
			expect(
				await applyGoogleDriveSyncOperationConditionally(
					TEST_PROFILE_ID,
					incoming,
					expected,
				),
			).toBe(true);
			expect(
				await applyGoogleDriveSyncOperationConditionally(
					TEST_PROFILE_ID,
					incoming,
					expected,
				),
			).toBe(true);
			expect(
				await applyGoogleDriveSyncOperationConditionally(
					TEST_PROFILE_ID,
					incoming,
					expected,
				),
			).toBe(false);
			expect(compare).toHaveBeenCalledTimes(3);
			expect(predicates?.matchesIncoming(incomingRow)).toBe(true);
			expect(predicates?.matchesIncoming(expectedRow)).toBe(false);
			expect(predicates?.matchesExpected(expectedRow)).toBe(true);
			expect(
				predicates?.matchesExpected({
					profile_id: "profile-1",
					nickname: "Concurrent local edit",
					updated_at: 3,
				}),
			).toBe(false);
		} finally {
			compare.mockRestore();
			activeProfile.restore();
		}
	});

	test("maps interest-view compare results and passes incoming and expected row predicates", async () => {
		const activeProfile = installActiveProfileSpies();
		const expectedRow = {
			profileId: "profile-1",
			displayName: "Before",
			imageHash: null,
			timestamp: 1,
			viewCount: 1,
			updatedAt: 1,
		};
		const incomingRow = {
			profileId: "profile-1",
			displayName: "After",
			imageHash: null,
			timestamp: 2,
			viewCount: 2,
			updatedAt: 2,
		};
		const { expected, incoming } = await makeConditionalOperations(
			"interest-views",
			"interest-view",
			"profile-1",
			expectedRow,
			incomingRow,
		);
		const results: Array<"applied" | "already-current" | "changed"> = [
			"applied",
			"already-current",
			"changed",
		];
		let predicates:
			| Parameters<typeof interestViews.compareAndApplyInterestViewRow>[2]
			| undefined;
		const compare = spyOn(
			interestViews,
			"compareAndApplyInterestViewRow",
		).mockImplementation(async (_key, _mutation, options) => {
			predicates ??= options;
			return results.shift() ?? "changed";
		});

		try {
			expect(
				await applyGoogleDriveSyncOperationConditionally(
					TEST_PROFILE_ID,
					incoming,
					expected,
				),
			).toBe(true);
			expect(
				await applyGoogleDriveSyncOperationConditionally(
					TEST_PROFILE_ID,
					incoming,
					expected,
				),
			).toBe(true);
			expect(
				await applyGoogleDriveSyncOperationConditionally(
					TEST_PROFILE_ID,
					incoming,
					expected,
				),
			).toBe(false);
			expect(compare).toHaveBeenCalledTimes(3);
			expect(predicates?.matchesIncoming(incomingRow)).toBe(true);
			expect(predicates?.matchesIncoming(expectedRow)).toBe(false);
			expect(predicates?.matchesExpected(expectedRow)).toBe(true);
			expect(
				predicates?.matchesExpected({
					...expectedRow,
					displayName: "Concurrent local edit",
				}),
			).toBe(false);
		} finally {
			compare.mockRestore();
			activeProfile.restore();
		}
	});

	test("consumes legacy preference history without mutating app-global storage", async () => {
		const activeProfile = installActiveProfileSpies();
		const preferenceKey = "fg-ghost-mode";
		const localStorage = installMutableWindow({ [preferenceKey]: "local-profile-value" });
		const { expected, incoming } = await makeConditionalOperations(
			"preferences",
			"preference",
			preferenceKey,
			"before",
			"remote",
		);

		try {
			expect(() => validateGoogleDriveSyncOperationBoundary(incoming)).not.toThrow();
			expect(
				await applyGoogleDriveSyncOperationConditionally(
					TEST_PROFILE_ID,
					incoming,
					expected,
				),
			).toBe(true);
			await applyGoogleDriveSyncOperation(TEST_PROFILE_ID, incoming);
			expect(localStorage.values.get(preferenceKey)).toBe("local-profile-value");
			expect(localStorage.setCalls).toEqual([]);
			expect(localStorage.removeCalls).toEqual([]);

			const allocator = new InMemorySyncSequenceAllocator();
			const unknown = createSyncOperation({
				accountNamespace: "acct-test",
				sourceDeviceId: "device-c",
				sequence: await allocator.next("acct-test", "device-c"),
				section: "preferences",
				entityType: "preference",
				entityId: encodeSyncEntityId("new-unreviewed-browser-preference"),
				mutation: { kind: "upsert", value: "unsafe" },
			});
			expect(() => validateGoogleDriveSyncOperationBoundary(unknown)).toThrow(
				"outside the portability registry",
			);
			await expect(
				applyGoogleDriveSyncOperation(TEST_PROFILE_ID, unknown),
			).rejects.toThrow("outside the portability registry");
		} finally {
			localStorage.restore();
			activeProfile.restore();
		}
	});
});

describe("hidden conversations sync independently of the conversation row", () => {
	test("the hide decision is scanned as its own entity, carrying nothing else", async () => {
		const activeProfile = installActiveProfileSpies();
		const localStorage = installMutableWindow({});
		const omittedByTable: Record<string, string[] | undefined> = {};
		const chatPage = spyOn(chatDb, "selectTablePageAfter").mockImplementation(
			async (table, after, _limit, options) => {
				if (after !== null) return [];
				const key = `${table}:${(options?.omitColumns ?? []).length}`;
				omittedByTable[key] = options?.omitColumns;
				if (table !== "conversations") return [];
				const row: Record<string, unknown> = { conversation_id: "c-1", hidden: 1 };
				for (const column of options?.omitColumns ?? []) {
					delete row[column];
				}
				if (!(options?.omitColumns ?? []).length) {
					row.unread_count = 3;
					row.updated_at = 42;
				}
				return [row];
			},
		);
		const contactPage = spyOn(
			contactIndex,
			"selectContactIndexPageAfter",
		).mockResolvedValue([]);
		const exportViews = spyOn(interestViews, "exportInterestViewRows").mockResolvedValue([]);
		const emitted: GoogleDriveSyncEntity[] = [];

		try {
			await scanGoogleDriveSyncEntities(TEST_PROFILE_ID, false, async (entity) => {
				emitted.push(entity);
			});

			const hidden = emitted.filter((e) => e.entityType === "conversation-hidden");
			expect(hidden).toHaveLength(1);
			// Only the id and the flag: an unread count or a new preview must not
			// be able to change this entity's digest, or it would emit an
			// operation — and re-assert this device's hide — on every inbox refresh.
			expect(hidden[0].value).toEqual({ conversation_id: "c-1", hidden: 1 });
			expect(hidden[0].section).toBe("core");

			const conversation = emitted.filter((e) => e.entityType === "conversation");
			expect(conversation).toHaveLength(1);
			expect(conversation[0].value).toMatchObject({ unread_count: 3, updated_at: 42 });
		} finally {
			exportViews.mockRestore();
			contactPage.mockRestore();
			chatPage.mockRestore();
			localStorage.restore();
			activeProfile.restore();
		}
	});

	test("a conversation write may create the hide flag but never change it", async () => {
		const activeProfile = installActiveProfileSpies();
		const row = { conversation_id: "c-1", hidden: 0, unread_count: 1 };
		const { expected, incoming } = await makeConditionalOperations(
			"core",
			"conversation",
			"c-1",
			{ conversation_id: "c-1", hidden: 0, unread_count: 0 },
			row,
		);
		let options: chatDb.PortableTableUpsertOptions | undefined;
		const compare = spyOn(
			chatDb,
			"compareAndApplyPortableTableRow",
		).mockImplementation(async (_table, _key, mutation) => {
			if (mutation.kind === "upsert") options = mutation.options;
			return "applied";
		});

		try {
			await applyGoogleDriveSyncOperationConditionally(TEST_PROFILE_ID, incoming, expected);
			// This is what stops the other device's routine inbox churn from
			// un-hiding a conversation it never knew was hidden.
			expect(options?.insertOnlyColumns).toEqual(["hidden"]);
		} finally {
			compare.mockRestore();
			activeProfile.restore();
		}
	});

	test("a hide is update-only, so it cannot half-create the conversation row", async () => {
		const activeProfile = installActiveProfileSpies();
		const { expected, incoming } = await makeConditionalOperations(
			"core",
			"conversation-hidden",
			"c-1",
			{ conversation_id: "c-1", hidden: 0 },
			{ conversation_id: "c-1", hidden: 1 },
		);
		let options: chatDb.PortableTableUpsertOptions | undefined;
		const compare = spyOn(
			chatDb,
			"compareAndApplyPortableTableRow",
		).mockImplementation(async (_table, _key, mutation) => {
			if (mutation.kind === "upsert") options = mutation.options;
			return "applied";
		});

		try {
			await applyGoogleDriveSyncOperationConditionally(TEST_PROFILE_ID, incoming, expected);
			expect(options?.updateOnly).toBe(true);
			expect(options?.skipColumns).not.toContain("hidden");
			expect(options?.skipColumns).toContain("unread_count");
			expect(options?.skipColumns).toContain("updated_at");
		} finally {
			compare.mockRestore();
			activeProfile.restore();
		}
	});

	test("the hide entity is accepted at the operation boundary", async () => {
		const { incoming } = await makeConditionalOperations(
			"core",
			"conversation-hidden",
			"c-1",
			{ conversation_id: "c-1", hidden: 0 },
			{ conversation_id: "c-1", hidden: 1 },
		);
		expect(() => validateGoogleDriveSyncOperationBoundary(incoming)).not.toThrow();
	});
});
