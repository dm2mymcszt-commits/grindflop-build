import { Database as BunDatabase } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
	createSyncOperation,
	createSyncPackage,
	serializeSyncPackage,
	type ImmutableSyncOperation,
	type JsonValue,
	type SyncSection,
} from "../src/services/cloudSync";
import {
	GOOGLE_DRIVE_FULL_SCAN_INTERVAL_MS,
	GOOGLE_DRIVE_MAX_JOURNALED_CHANGES,
	GOOGLE_DRIVE_SYNC_TARGET_PACKAGE_BYTES,
	GoogleDriveSyncStore,
	chooseGoogleDriveReconcileMode,
	type GoogleDriveSyncChangeSource,
	type GoogleDriveSyncSqlDatabase,
} from "../src/services/googleDriveSyncStore";
import type {
	GoogleDriveSyncChangedEntity,
	GoogleDriveSyncEntity,
} from "../src/services/googleDriveSyncData";

const PROFILE_ID = 12345;
const ACCOUNT = "acct-test-vault";
const LOCAL_DEVICE = "device-windows";
const REMOTE_DEVICE = "device-iphone";

class BunSqliteAdapter implements GoogleDriveSyncSqlDatabase {
	readonly path = ":memory:";
	readonly database: BunDatabase;
	readonly #closeDatabase: boolean;
	failNextShadowWrite = false;
	failNextShadowDelete = false;

	constructor(options: { closeDatabase?: boolean } = {}) {
		this.database = new BunDatabase(":memory:");
		this.#closeDatabase = options.closeDatabase ?? true;
	}

	async execute(query: string, bindValues: unknown[] = []) {
		if (this.failNextShadowWrite && /INSERT INTO sync_entity_shadow/i.test(query)) {
			this.failNextShadowWrite = false;
			throw new Error("injected shadow write failure");
		}
		if (this.failNextShadowDelete && /DELETE FROM sync_entity_shadow/i.test(query)) {
			this.failNextShadowDelete = false;
			throw new Error("injected shadow delete failure");
		}
		const result = this.database.query(query).run(...(bindValues as never[]));
		return {
			rowsAffected: result.changes,
			lastInsertId: Number(result.lastInsertRowid),
		};
	}

	async select<T>(query: string, bindValues: unknown[] = []): Promise<T> {
		return this.database.query(query).all(...(bindValues as never[])) as T;
	}

	async close(): Promise<void> {
		if (this.#closeDatabase) this.database.close();
	}
}

function entity(
	section: SyncSection,
	entityType: string,
	entityId: string,
	value: JsonValue,
): GoogleDriveSyncEntity {
	return { section, entityType, entityId, value };
}

async function openTestStore(options?: {
	adapter?: BunSqliteAdapter;
	applyOperation?: Parameters<typeof GoogleDriveSyncStore.open>[1] extends infer Options
		? Options extends { applyOperation?: infer Apply }
			? Apply
			: never
		: never;
}) {
	const adapter = options?.adapter ?? new BunSqliteAdapter();
	let openedUrl = "";
	const store = await GoogleDriveSyncStore.open(PROFILE_ID, {
		databaseFactory: async (databaseUrl) => {
			openedUrl = databaseUrl;
			return adapter;
		},
		applyOperation: options?.applyOperation,
	});
	expect(openedUrl).toBe(`sqlite:google-drive-sync-${PROFILE_ID}.sqlite3`);
	return { store, adapter };
}

async function reconcile(
	store: GoogleDriveSyncStore,
	entities: readonly GoogleDriveSyncEntity[],
	scannedSections: readonly SyncSection[] = ["core"],
	deletionSections?: readonly SyncSection[],
) {
	return store.reconcileWithScanner({
		accountNamespace: ACCOUNT,
		sourceDeviceId: LOCAL_DEVICE,
		scannedSections,
		deletionSections,
		scan: async (onEntity) => {
			for (const current of entities) await onEntity(current);
		},
	});
}

async function readConversationShadow(
	adapter: BunSqliteAdapter,
	entityId: string,
): Promise<ImmutableSyncOperation | undefined> {
	const rows = await adapter.select<Array<{ winning_operation_json: string }>>(
		`SELECT winning_operation_json FROM sync_entity_shadow
		 WHERE account_namespace = ? AND section = 'core'
		   AND entity_type = 'conversation' AND entity_id = ?`,
		[ACCOUNT, entityId],
	);
	return rows[0]
		? (JSON.parse(rows[0].winning_operation_json) as ImmutableSyncOperation)
		: undefined;
}

describe("durable Google Drive reconciliation store", () => {
	test("a status snapshot is readable while a long write holds the queue", async () => {
		const { store } = await openTestStore();
		let releaseScan = (): void => undefined;
		const scanGate = new Promise<void>((resolve) => {
			releaseScan = resolve;
		});

		// A real reconcile holds the store's write queue for its whole duration.
		const writing = store.reconcileWithScanner({
			accountNamespace: ACCOUNT,
			sourceDeviceId: LOCAL_DEVICE,
			scannedSections: ["core"],
			scan: async (onEntity) => {
				await scanGate;
				await onEntity(entity("core", "conversation", "c1", { id: "c1" }));
			},
		});

		// Reads that wait on that queue leave the card unable to say what the
		// device is doing for as long as the scan runs, which on a large profile
		// is minutes and is indistinguishable from a hang.
		const snapshot = await store.getStatusSnapshot();
		expect(snapshot.config).toBeDefined();
		expect(snapshot.pending).toBeDefined();

		releaseScan();
		await writing;
		await store.close();
	});

	test("reopening a store prunes vaults it has left", async () => {
		const first = await openTestStore();
		await first.store.updateConfig({ enabled: true, accountNamespace: ACCOUNT });
		await first.adapter.execute(
			"INSERT INTO sync_account_clocks (account_namespace, observed_logical_clock) VALUES (?, 1)",
			[ACCOUNT],
		);
		await first.adapter.execute(
			"INSERT INTO sync_account_clocks (account_namespace, observed_logical_clock) VALUES ('ns-dead-vault', 1)",
		);

		// Opening the store is the only thing that removes state from vaults this
		// device has left, so it has to actually happen on the open path.
		const second = await openTestStore({ adapter: first.adapter });
		const dead = await first.adapter.select<Array<{ count: number }>>(
			"SELECT COUNT(*) AS count FROM sync_account_clocks WHERE account_namespace = 'ns-dead-vault'",
		);
		expect(dead[0].count).toBe(0);
		const live = await first.adapter.select<Array<{ count: number }>>(
			"SELECT COUNT(*) AS count FROM sync_account_clocks WHERE account_namespace = ?",
			[ACCOUNT],
		);
		expect(live[0].count).toBe(1);
		await second.store.close();
	});

	test("state from vaults this device left is pruned, the live vault is kept", async () => {
		const { store, adapter } = await openTestStore();
		await store.updateConfig({ enabled: true, accountNamespace: ACCOUNT });
		await reconcile(store, [entity("core", "conversation", "live", { id: "live" })]);

		// A device reset more than once keeps every earlier vault's rows. They are
		// unreadable without the deleted keys and unreachable because every query
		// filters on the live namespace, but they still dominate the database.
		await adapter.execute(
			`INSERT INTO sync_outbound_operations (
				operation_id, account_namespace, source_device_id, origin_sequence,
				logical_clock, section, entity_type, entity_id, operation_json,
				estimated_bytes, created_at_ms
			) VALUES ('op-dead', 'ns-dead-vault', ?, 1, 1, 'core', 'conversation', 'x', '{}', 10, 1)`,
			[LOCAL_DEVICE],
		);

		const beforeRows = await adapter.select<Array<{ count: number }>>(
			"SELECT COUNT(*) AS count FROM sync_outbound_operations",
		);
		expect(beforeRows[0].count).toBeGreaterThan(1);

		const removed = await store.pruneForeignAccountState(ACCOUNT);
		expect(removed).toBe(true);

		const dead = await adapter.select<Array<{ count: number }>>(
			"SELECT COUNT(*) AS count FROM sync_outbound_operations WHERE account_namespace = 'ns-dead-vault'",
		);
		expect(dead[0].count).toBe(0);
		const live = await adapter.select<Array<{ count: number }>>(
			"SELECT COUNT(*) AS count FROM sync_outbound_operations WHERE account_namespace = ?",
			[ACCOUNT],
		);
		expect(live[0].count).toBeGreaterThan(0);

		// Nothing foreign left, so a second pass reports no work rather than
		// vacuuming the database on every launch.
		expect(await store.pruneForeignAccountState(ACCOUNT)).toBe(false);
		await store.close();
	});

	test("a filtered section keeps its unscanned rows instead of tombstoning them", async () => {
		const { store } = await openTestStore();
		const both = [
			entity("core", "conversation", "kept", { id: "kept" }),
			entity("core", "conversation", "narrowed-away", { id: "narrowed-away" }),
		];
		expect(await reconcile(store, both)).toMatchObject({
			createdUpserts: 2,
			createdTombstones: 0,
		});

		// The same section is scanned again, but through a narrower filter, so the
		// second entity is simply out of scope rather than deleted. Inferring a
		// deletion here would tombstone every row the filter excludes and delete
		// them on every other device.
		expect(
			await reconcile(store, [both[0]], ["core"], []),
		).toMatchObject({
			createdUpserts: 0,
			createdTombstones: 0,
			unchangedEntities: 1,
		});

		// Without the narrowing, absence still means deletion.
		expect(await reconcile(store, [both[0]], ["core"])).toMatchObject({
			createdTombstones: 1,
		});
		await store.close();
	});

	test("a deletion section must also be scanned", async () => {
		const { store } = await openTestStore();
		await expect(
			reconcile(store, [], ["core"], ["interest-views"]),
		).rejects.toThrow("must also be scanned");
		await store.close();
	});

	test("emits changed rows and tombstones only after a completed scan", async () => {
		const { store } = await openTestStore();
		try {
			const firstEntities = [
				entity("core", "conversation", "one", { title: "One" }),
				entity("core", "conversation", "two", { title: "Two" }),
			];
			expect(await reconcile(store, firstEntities)).toEqual({
				createdUpserts: 2,
				createdTombstones: 0,
				unchangedEntities: 0,
				firstSequence: 1,
				lastSequence: 2,
			});
			expect(await reconcile(store, firstEntities)).toMatchObject({
				createdUpserts: 0,
				createdTombstones: 0,
				unchangedEntities: 2,
			});

			await expect(
				store.reconcileWithScanner({
					accountNamespace: ACCOUNT,
					sourceDeviceId: LOCAL_DEVICE,
					scannedSections: ["core"],
					scan: async (onEntity) => {
						await onEntity(firstEntities[0]);
						throw new Error("scan interrupted");
					},
				}),
			).rejects.toThrow("scan interrupted");
			expect((await store.getPendingCounts(ACCOUNT)).changes).toBe(2);

			const completed = await reconcile(store, [
				entity("core", "conversation", "one", { title: "One changed" }),
			]);
			expect(completed).toMatchObject({
				createdUpserts: 1,
				createdTombstones: 1,
				firstSequence: 3,
				lastSequence: 4,
			});
			const operations = await store.listUnpackagedOperations(ACCOUNT, LOCAL_DEVICE);
			expect(operations.map((operation) => operation.originSequence)).toEqual([1, 2, 3, 4]);
			expect(operations[3].mutation.kind).toBe("delete");
			expect(operations[3].entityId).toBe("two");
		} finally {
			await store.close();
		}
	});

	test("recovers an outbox-first crash without duplicating or skipping a sequence", async () => {
		const adapter = new BunSqliteAdapter();
		const { store } = await openTestStore({ adapter });
		try {
			adapter.failNextShadowWrite = true;
			await expect(
				reconcile(store, [entity("core", "conversation", "one", { title: "One" })]),
			).rejects.toThrow("injected shadow write failure");

			const recovered = await reconcile(store, [
				entity("core", "conversation", "one", { title: "One" }),
			]);
			expect(recovered.unchangedEntities).toBe(1);
			expect((await store.getPendingCounts(ACCOUNT)).changes).toBe(1);

			await reconcile(store, [entity("core", "conversation", "one", { title: "Changed" })]);
			const operations = await store.listUnpackagedOperations(ACCOUNT, LOCAL_DEVICE);
			expect(operations.map((operation) => operation.originSequence)).toEqual([1, 2]);
		} finally {
			await store.close();
		}
	});

	test("persists config and immutable outbound package progress", async () => {
		const { store } = await openTestStore();
		try {
			expect(await store.getLocalOriginSequence(ACCOUNT, LOCAL_DEVICE)).toBe(0);
			expect(await store.getConfig()).toEqual({
				enabled: false,
				accountNamespace: null,
				mediaPolicy: "off",
				lastSuccessfulSyncAt: null,
				lastError: null,
			});
			expect(
				await store.updateConfig({
					enabled: true,
					accountNamespace: ACCOUNT,
					mediaPolicy: "wifi-only",
					lastSuccessfulSyncAt: 123,
				}),
			).toMatchObject({
				enabled: true,
				accountNamespace: ACCOUNT,
				mediaPolicy: "wifi-only",
				lastSuccessfulSyncAt: 123,
			});

			await reconcile(store, [
				entity("core", "conversation", "one", { title: "One" }),
				entity("core", "conversation", "two", { title: "Two" }),
			]);
			expect(await store.getLocalOriginSequence(ACCOUNT, LOCAL_DEVICE)).toBe(2);
			const first = await store.createNextOutboundPackage(ACCOUNT, LOCAL_DEVICE, 1);
			const second = await store.createNextOutboundPackage(ACCOUNT, LOCAL_DEVICE, 1);
			expect(first?.syncPackage.sequenceRange).toEqual({ start: 1, end: 1 });
			expect(second?.syncPackage.sequenceRange).toEqual({ start: 2, end: 2 });
			expect(second?.syncPackage.previousPackageDigest).toBe(
				first?.syncPackage.contentDigest,
			);
			expect(await store.createNextOutboundPackage(ACCOUNT, LOCAL_DEVICE)).toBeNull();
			expect(await store.listPendingOutboundPackages(ACCOUNT, LOCAL_DEVICE)).toHaveLength(2);
			expect(await store.getOutboundHead(ACCOUNT, LOCAL_DEVICE)).toBeNull();

			await store.markOutboundPackageUploaded(
				first!.syncPackage.packageId,
				"drive-file-one",
				200,
			);
			expect(await store.getOutboundHead(ACCOUNT, LOCAL_DEVICE)).toEqual({
				sequenceEnd: 1,
				contentDigest: first!.syncPackage.contentDigest,
			});
			expect((await store.getPendingCounts(ACCOUNT)).changes).toBe(1);
			await store.markOutboundPackageUploaded(
				second!.syncPackage.packageId,
				"drive-file-two",
				201,
			);
			expect(await store.getOutboundHead(ACCOUNT, LOCAL_DEVICE)).toEqual({
				sequenceEnd: 2,
				contentDigest: second!.syncPackage.contentDigest,
			});
			expect(await store.getPendingCounts(ACCOUNT)).toMatchObject({ changes: 0 });
		} finally {
			await store.close();
		}
	});

	test("stages and confirms a single operation just below the 3 MiB package ceiling", async () => {
		const { store } = await openTestStore();
		try {
			const payload = "x".repeat(
				GOOGLE_DRIVE_SYNC_TARGET_PACKAGE_BYTES - 4 * 1024,
			);
			await reconcile(store, [
				entity("core", "conversation", "near-package-limit", { payload }),
			]);

			const staged = await store.createNextOutboundPackage(ACCOUNT, LOCAL_DEVICE);
			expect(staged).not.toBeNull();
			const serializedBytes = new TextEncoder().encode(staged!.serialized).byteLength;
			expect(serializedBytes).toBeLessThanOrEqual(
				GOOGLE_DRIVE_SYNC_TARGET_PACKAGE_BYTES,
			);
			expect(serializedBytes).toBeGreaterThan(
				GOOGLE_DRIVE_SYNC_TARGET_PACKAGE_BYTES - 8 * 1024,
			);
			expect(
				await store.listUnpackagedOperations(ACCOUNT, LOCAL_DEVICE),
			).toHaveLength(0);
			expect(
				await store.listPendingOutboundPackages(ACCOUNT, LOCAL_DEVICE),
			).toHaveLength(1);
			expect(await store.getOutboundHead(ACCOUNT, LOCAL_DEVICE)).toBeNull();

			await store.markOutboundPackageUploaded(
				staged!.syncPackage.packageId,
				"drive-near-package-limit",
				200,
			);
			expect(await store.getOutboundHead(ACCOUNT, LOCAL_DEVICE)).toEqual({
				sequenceEnd: 1,
				contentDigest: staged!.syncPackage.contentDigest,
			});
			expect(await store.getPendingCounts(ACCOUNT)).toMatchObject({ changes: 0 });
		} finally {
			await store.close();
		}
	});

	test("rejects a single oversized package without staging or losing its durable operation", async () => {
		const adapter = new BunSqliteAdapter({ closeDatabase: false });
		const opened = await openTestStore({ adapter });
		let store = opened.store;
		try {
			const payload = "x".repeat(
				GOOGLE_DRIVE_SYNC_TARGET_PACKAGE_BYTES + 4 * 1024,
			);
			await reconcile(store, [
				entity("core", "conversation", "over-package-limit", { payload }),
			]);
			const pendingBefore = await store.getPendingCounts(ACCOUNT);
			expect(pendingBefore.changes).toBe(1);
			expect(pendingBefore.bytes).toBeGreaterThan(
				GOOGLE_DRIVE_SYNC_TARGET_PACKAGE_BYTES,
			);

			await expect(
				store.createNextOutboundPackage(ACCOUNT, LOCAL_DEVICE),
			).rejects.toThrow(
				"A single sync operation exceeds the 3 MiB transport-package limit",
			);
			expect(
				await store.listPendingOutboundPackages(ACCOUNT, LOCAL_DEVICE),
			).toEqual([]);
			expect(await store.getOutboundHead(ACCOUNT, LOCAL_DEVICE)).toBeNull();
			expect(await store.getPendingCounts(ACCOUNT)).toEqual(pendingBefore);
			const [stillUnpackaged] = await store.listUnpackagedOperations(
				ACCOUNT,
				LOCAL_DEVICE,
			);
			expect(stillUnpackaged?.entityId).toBe("over-package-limit");
			expect(stillUnpackaged?.mutation).toMatchObject({ kind: "upsert" });

			const packageRows = await adapter.select<Array<{ count: number }>>(
				"SELECT COUNT(*) AS count FROM sync_outbound_packages",
			);
			const operationRows = await adapter.select<
				Array<{ package_id: string | null }>
			>("SELECT package_id FROM sync_outbound_operations");
			expect(packageRows[0]?.count).toBe(0);
			expect(operationRows).toEqual([{ package_id: null }]);

			await store.close();
			store = (await openTestStore({ adapter })).store;
			expect(await store.getPendingCounts(ACCOUNT)).toEqual(pendingBefore);
			expect(
				await store.listUnpackagedOperations(ACCOUNT, LOCAL_DEVICE),
			).toHaveLength(1);
			await expect(
				store.createNextOutboundPackage(ACCOUNT, LOCAL_DEVICE),
			).rejects.toThrow(
				"A single sync operation exceeds the 3 MiB transport-package limit",
			);
			expect(
				await store.listPendingOutboundPackages(ACCOUNT, LOCAL_DEVICE),
			).toEqual([]);
			expect(await store.getOutboundHead(ACCOUNT, LOCAL_DEVICE)).toBeNull();
		} finally {
			await store.close();
			adapter.database.close();
		}
	});

	test("migrates and persists validated bootstrap authority state", async () => {
		const adapter = new BunSqliteAdapter({ closeDatabase: false });
		await adapter.execute(`
			CREATE TABLE sync_meta (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			)
		`);
		await adapter.execute(
			"INSERT INTO sync_meta(key, value) VALUES ('schema_version', '1')",
		);
		const { store } = await openTestStore({ adapter });
		const digest = "a".repeat(64);
		try {
			expect(await store.getBootstrapState()).toEqual({
				authorityDeviceId: null,
				authoritySequenceEnd: 0,
				authorityHeadDigest: null,
				bootstrapPending: false,
				anchorRequired: false,
				localBaselineSequence: null,
			});
			expect(
				await store.updateBootstrapState({
					authorityDeviceId: REMOTE_DEVICE,
					authoritySequenceEnd: 12,
					authorityHeadDigest: digest,
					bootstrapPending: true,
					anchorRequired: true,
					localBaselineSequence: 4,
				}),
			).toEqual({
				authorityDeviceId: REMOTE_DEVICE,
				authoritySequenceEnd: 12,
				authorityHeadDigest: digest,
				bootstrapPending: true,
				anchorRequired: true,
				localBaselineSequence: 4,
			});
		} finally {
			await store.close();
		}

		const { store: reopened } = await openTestStore({ adapter });
		try {
			expect(await reopened.getBootstrapState()).toEqual({
				authorityDeviceId: REMOTE_DEVICE,
				authoritySequenceEnd: 12,
				authorityHeadDigest: digest,
				bootstrapPending: true,
				anchorRequired: true,
				localBaselineSequence: 4,
			});
			expect(
				await adapter.select<Array<{ value: string }>>(
					"SELECT value FROM sync_meta WHERE key = 'schema_version'",
				),
			).toEqual([{ value: "4" }]);

			await expect(
				reopened.updateBootstrapState({ authoritySequenceEnd: 0 }),
			).rejects.toThrow("digest must be null exactly");
			await expect(
				reopened.updateBootstrapState({ authorityHeadDigest: null }),
			).rejects.toThrow("digest must be null exactly");
			await expect(
				reopened.updateBootstrapState({ authorityDeviceId: null }),
			).rejects.toThrow("requires an authority device");
			await expect(
				reopened.updateBootstrapState({ localBaselineSequence: null }),
			).rejects.toThrow("must exist exactly while bootstrap is pending");
			await expect(
				reopened.updateBootstrapState({ authorityHeadDigest: "not-a-digest" }),
			).rejects.toThrow();
			await expect(
				reopened.updateBootstrapState({ localBaselineSequence: -1 }),
			).rejects.toThrow();

			await reopened.updateBootstrapState({
				authorityDeviceId: null,
				authoritySequenceEnd: 0,
				authorityHeadDigest: null,
				bootstrapPending: false,
				anchorRequired: false,
				localBaselineSequence: null,
			});
			await expect(
				reopened.updateBootstrapState({ anchorRequired: true }),
			).rejects.toThrow("requires an authority device");
			await expect(
				reopened.updateBootstrapState({
					bootstrapPending: true,
					localBaselineSequence: 0,
				}),
			).rejects.toThrow("requires an authority device");
			await expect(
				reopened.updateBootstrapState({
					authorityDeviceId: REMOTE_DEVICE,
					localBaselineSequence: 0,
				}),
			).rejects.toThrow("must exist exactly while bootstrap is pending");
		} finally {
			await reopened.close();
			adapter.database.close();
		}
	});

	test("atomically binds the first local source identity and keeps it across reopen", async () => {
		const adapter = new BunSqliteAdapter({ closeDatabase: false });
		let { store } = await openTestStore({ adapter });
		try {
			expect(await store.getLocalSourceDeviceId()).toBeNull();
			expect(await store.hasPriorLocalSyncState()).toBe(false);
			expect(await store.bindLocalSourceDeviceId(LOCAL_DEVICE)).toBe(LOCAL_DEVICE);
			expect(await store.getLocalSourceDeviceId()).toBe(LOCAL_DEVICE);
			await expect(
				store.bindLocalSourceDeviceId("different-browser-device"),
			).rejects.toThrow("device ids conflict");
		} finally {
			await store.close();
		}

		store = (await openTestStore({ adapter })).store;
		try {
			expect(await store.getLocalSourceDeviceId()).toBe(LOCAL_DEVICE);
			expect(
				await adapter.select<Array<{ value: string }>>(
					"SELECT value FROM sync_meta WHERE key = 'schema_version'",
				),
			).toEqual([{ value: "4" }]);
		} finally {
			await store.close();
			adapter.database.close();
		}
	});

	test("v4 migration binds the sole pre-v4 local outbox source", async () => {
		const adapter = new BunSqliteAdapter({ closeDatabase: false });
		let { store } = await openTestStore({ adapter });
		try {
			await store.bindLocalSourceDeviceId(LOCAL_DEVICE);
			await reconcile(store, [
				entity("core", "conversation", "pre-v4-pending", { title: "Pending" }),
			]);
			expect(await store.createNextOutboundPackage(ACCOUNT, LOCAL_DEVICE)).not.toBeNull();
			await adapter.execute("DROP TABLE sync_local_identity");
			await adapter.execute(
				"UPDATE sync_meta SET value = '3' WHERE key = 'schema_version'",
			);
		} finally {
			await store.close();
		}

		store = (await openTestStore({ adapter })).store;
		try {
			expect(await store.getLocalSourceDeviceId()).toBe(LOCAL_DEVICE);
			expect(await store.listPendingOutboundPackages(ACCOUNT, LOCAL_DEVICE)).toHaveLength(1);
			expect(await store.hasPriorLocalSyncState()).toBe(true);
		} finally {
			await store.close();
		}

		store = (await openTestStore({ adapter })).store;
		try {
			expect(await store.getLocalSourceDeviceId()).toBe(LOCAL_DEVICE);
		} finally {
			await store.close();
			adapter.database.close();
		}
	});

	test("persists pairing-observed remote heads as monotonic rollback floors", async () => {
		const adapter = new BunSqliteAdapter({ closeDatabase: false });
		let { store } = await openTestStore({ adapter });
		const firstDigest = "a".repeat(64);
		const secondDigest = "b".repeat(64);
		try {
			expect(
				await store.commitInboundHeads(ACCOUNT, [
					{
						sourceDeviceId: REMOTE_DEVICE,
						sequenceEnd: 2,
						contentDigest: secondDigest,
					},
				]),
			).toEqual([
				{
					sourceDeviceId: REMOTE_DEVICE,
					sequenceEnd: 2,
					contentDigest: secondDigest,
				},
			]);
			// An older pairing code cannot weaken a floor already committed locally.
			await store.commitInboundHeads(ACCOUNT, [
				{
					sourceDeviceId: REMOTE_DEVICE,
					sequenceEnd: 1,
					contentDigest: firstDigest,
				},
			]);
			await store.close();
			store = (await openTestStore({ adapter })).store;
			expect(await store.listInboundHeads(ACCOUNT)).toEqual([
				{
					sourceDeviceId: REMOTE_DEVICE,
					sequenceEnd: 2,
					contentDigest: secondDigest,
				},
			]);
			await expect(
				store.commitInboundHeads(ACCOUNT, [
					{
						sourceDeviceId: REMOTE_DEVICE,
						sequenceEnd: 2,
						contentDigest: firstDigest,
					},
				]),
			).rejects.toThrow("conflicts with durable history");
		} finally {
			await store.close();
			adapter.database.close();
		}
	});

	test("replays a cross-store domain mutation safely until its receipt is durable", async () => {
		const applied: string[] = [];
		let domainValue: JsonValue | null = null;
		let failAfterMutation = true;
		const { store } = await openTestStore({
			applyOperation: async (operation, expectedOperation) => {
				applied.push(operation.operationId);
				expect(expectedOperation).toBeUndefined();
				if (
					operation.mutation.kind === "upsert" &&
					JSON.stringify(domainValue) === JSON.stringify(operation.mutation.value)
				) {
					return true;
				}
				domainValue =
					operation.mutation.kind === "upsert" ? operation.mutation.value : null;
				if (failAfterMutation) {
					failAfterMutation = false;
					throw new Error("crash after idempotent domain upsert");
				}
				return true;
			},
		});
		try {
			const remoteOperation = createSyncOperation({
				operationId: "op-remote-one",
				accountNamespace: ACCOUNT,
				sourceDeviceId: REMOTE_DEVICE,
				sequence: { originSequence: 1, logicalClock: 10 },
				section: "core",
				entityType: "conversation",
				entityId: "one",
				mutation: { kind: "upsert", value: { title: "Remote" } },
			});
			const remotePackage = await createSyncPackage({
				packageId: "pkg-remote-one",
				accountNamespace: ACCOUNT,
				sourceDeviceId: REMOTE_DEVICE,
				operations: [remoteOperation],
			});
			const options = {
				expectedAccountNamespace: ACCOUNT,
				expectedSourceDeviceId: REMOTE_DEVICE,
				now: () => 50,
			};
			await expect(store.applyIncomingPackage(remotePackage, options)).rejects.toThrow(
				"crash after idempotent domain upsert",
			);
			expect(domainValue).toEqual({ title: "Remote" });
			expect(await store.applyIncomingPackage(remotePackage, options)).toMatchObject({
				appliedOperations: 1,
				alreadyApplied: false,
			});
			expect(await store.applyIncomingPackage(remotePackage, options)).toMatchObject({
				appliedOperations: 0,
				alreadyApplied: true,
			});
			expect(applied).toEqual(["op-remote-one", "op-remote-one"]);
			expect(await store.getInboundCursor(ACCOUNT, REMOTE_DEVICE)).toEqual({
				nextSequence: 2,
				previousPackageDigest: remotePackage.contentDigest,
			});

			// The incoming winner is now the shadow, so a local-first scan of the
			// same domain value does not echo it back into the outbox.
			expect(
				await reconcile(store, [
					entity("core", "conversation", "one", { title: "Remote" }),
				]),
			).toMatchObject({ createdUpserts: 0, unchangedEntities: 1 });
		} finally {
			await store.close();
		}
	});

	test("receipts a changed-domain race without advancing its shadow and promotes the local edit", async () => {
		const expectedOperationIds: Array<string | undefined> = [];
		const { store, adapter } = await openTestStore({
			applyOperation: async (_operation, expectedOperation) => {
				expectedOperationIds.push(expectedOperation?.operationId);
				return false;
			},
		});
		try {
			await reconcile(store, [
				entity("core", "conversation", "shared", { title: "Initial local" }),
			]);
			const [localBaseline] = await store.listUnpackagedOperations(
				ACCOUNT,
				LOCAL_DEVICE,
			);
			const remoteOperation = createSyncOperation({
				operationId: "op-race-remote",
				accountNamespace: ACCOUNT,
				sourceDeviceId: REMOTE_DEVICE,
				sequence: { originSequence: 1, logicalClock: 100 },
				section: "core",
				entityType: "conversation",
				entityId: "shared",
				mutation: { kind: "upsert", value: { title: "Remote" } },
			});
			const remotePackage = await createSyncPackage({
				packageId: "pkg-race-remote",
				accountNamespace: ACCOUNT,
				sourceDeviceId: REMOTE_DEVICE,
				operations: [remoteOperation],
			});

			expect(
				await store.applyIncomingPackage(remotePackage, {
					expectedAccountNamespace: ACCOUNT,
					expectedSourceDeviceId: REMOTE_DEVICE,
				}),
			).toMatchObject({ appliedOperations: 1, alreadyApplied: false });
			expect(expectedOperationIds).toEqual([localBaseline.operationId]);
			expect((await readConversationShadow(adapter, "shared"))?.operationId).toBe(
				localBaseline.operationId,
			);
			expect(await store.getInboundCursor(ACCOUNT, REMOTE_DEVICE)).toEqual({
				nextSequence: 2,
				previousPackageDigest: remotePackage.contentDigest,
			});

			const promoted = await reconcile(store, [
				entity("core", "conversation", "shared", { title: "Concurrent local" }),
			]);
			expect(promoted).toMatchObject({ createdUpserts: 1, lastSequence: 2 });
			const operations = await store.listUnpackagedOperations(ACCOUNT, LOCAL_DEVICE);
			const promotedOperation = operations[operations.length - 1];
			expect(promotedOperation.mutation).toEqual({
				kind: "upsert",
				value: { title: "Concurrent local" },
			});
			expect(promotedOperation.revision.logicalClock).toBeGreaterThan(
				remoteOperation.revision.logicalClock,
			);
		} finally {
			await store.close();
		}
	});

	test("preserves a post-baseline bootstrap edit and promotes it above the authority clock", async () => {
		const applied: string[] = [];
		const { store, adapter } = await openTestStore({
			applyOperation: async (operation) => {
				applied.push(operation.operationId);
				return true;
			},
		});
		try {
			await reconcile(store, [
				entity("core", "conversation", "shared", { title: "Phone baseline" }),
			]);
			const localBaselineSequence = await store.getLocalOriginSequence(
				ACCOUNT,
				LOCAL_DEVICE,
			);
			await reconcile(store, [
				entity("core", "conversation", "shared", { title: "Edited while pairing" }),
			]);

			const authorityOperation = createSyncOperation({
				operationId: "op-protected-authority",
				accountNamespace: ACCOUNT,
				sourceDeviceId: REMOTE_DEVICE,
				sequence: { originSequence: 1, logicalClock: 100 },
				section: "core",
				entityType: "conversation",
				entityId: "shared",
				mutation: { kind: "upsert", value: { title: "Laptop baseline" } },
			});
			const authorityPackage = await createSyncPackage({
				packageId: "pkg-protected-authority",
				accountNamespace: ACCOUNT,
				sourceDeviceId: REMOTE_DEVICE,
				operations: [authorityOperation],
			});
			await expect(
				store.applyIncomingPackage(authorityPackage, {
					expectedAccountNamespace: ACCOUNT,
					bootstrapAuthority: {
						localSourceDeviceId: "",
						localBaselineSequence,
					},
				}),
			).rejects.toThrow();
			await expect(
				store.applyIncomingPackage(authorityPackage, {
					expectedAccountNamespace: ACCOUNT,
					bootstrapAuthority: {
						localSourceDeviceId: LOCAL_DEVICE,
						localBaselineSequence: -1,
					},
				}),
			).rejects.toThrow();
			await expect(
				store.applyIncomingPackage(authorityPackage, {
					expectedAccountNamespace: ACCOUNT,
					bootstrapAuthority: {
						localSourceDeviceId: REMOTE_DEVICE,
						localBaselineSequence,
					},
				}),
			).rejects.toThrow("different source device");
			await store.applyIncomingPackage(authorityPackage, {
				expectedAccountNamespace: ACCOUNT,
				expectedSourceDeviceId: REMOTE_DEVICE,
				bootstrapAuthority: { localSourceDeviceId: LOCAL_DEVICE, localBaselineSequence },
			});

			// Protected post-cutoff state is never overwritten in the domain callback,
			// while the authority shadow becomes the causal comparison point.
			expect(applied).toEqual([]);
			expect((await readConversationShadow(adapter, "shared"))?.operationId).toBe(
				authorityOperation.operationId,
			);
			const promoted = await reconcile(store, [
				entity("core", "conversation", "shared", { title: "Edited while pairing" }),
			]);
			expect(promoted).toMatchObject({ createdUpserts: 1, lastSequence: 3 });
			const operations = await store.listUnpackagedOperations(ACCOUNT, LOCAL_DEVICE);
			const promotedOperation = operations[operations.length - 1];
			expect(promotedOperation.mutation).toEqual({
				kind: "upsert",
				value: { title: "Edited while pairing" },
			});
			expect(promotedOperation.revision.logicalClock).toBeGreaterThan(
				authorityOperation.revision.logicalClock,
			);
		} finally {
			await store.close();
		}
	});

	test("keeps a force-applied authority baseline durable across a crash before supersession", async () => {
		const adapter = new BunSqliteAdapter({ closeDatabase: false });
		let domainValue: JsonValue = { title: "Phone baseline" };
		const applied: string[] = [];
		const first = await openTestStore({
			adapter,
			applyOperation: async (operation, expectedOperation) => {
				applied.push(operation.operationId);
				expect(expectedOperation?.sourceDeviceId).toBe(LOCAL_DEVICE);
				domainValue =
					operation.mutation.kind === "upsert" ? operation.mutation.value : null;
				return true;
			},
		});
		const authorityOperation = createSyncOperation({
			operationId: "op-crash-authority",
			accountNamespace: ACCOUNT,
			sourceDeviceId: REMOTE_DEVICE,
			// Ordinary LWW would retain device-windows for this exact clock tie.
			sequence: { originSequence: 1, logicalClock: 1 },
			section: "core",
			entityType: "conversation",
			entityId: "shared",
			mutation: { kind: "upsert", value: { title: "Laptop authority" } },
		});
		const authorityPackage = await createSyncPackage({
			packageId: "pkg-crash-authority",
			accountNamespace: ACCOUNT,
			sourceDeviceId: REMOTE_DEVICE,
			operations: [authorityOperation],
		});
		const bootstrapOptions = {
			expectedAccountNamespace: ACCOUNT,
			expectedSourceDeviceId: REMOTE_DEVICE,
			bootstrapAuthority: {
				localSourceDeviceId: LOCAL_DEVICE,
				localBaselineSequence: 1,
			},
		};
		try {
			await reconcile(first.store, [
				entity("core", "conversation", "shared", { title: "Phone baseline" }),
			]);
			await first.store.updateConfig({
				enabled: true,
				accountNamespace: ACCOUNT,
			});
			await first.store.updateBootstrapState({
				authorityDeviceId: REMOTE_DEVICE,
				authoritySequenceEnd: 1,
				authorityHeadDigest: authorityPackage.contentDigest,
				bootstrapPending: true,
				anchorRequired: true,
				localBaselineSequence: 1,
			});
			await first.store.applyIncomingPackage(authorityPackage, bootstrapOptions);
			expect(domainValue).toEqual({ title: "Laptop authority" });
			expect((await readConversationShadow(adapter, "shared"))?.operationId).toBe(
				authorityOperation.operationId,
			);
		} finally {
			await first.store.close();
		}

		const reopened = await openTestStore({
			adapter,
			applyOperation: async () => {
				throw new Error("a receipted authority operation must not be applied again");
			},
		});
		try {
			// Startup outbox repair must not resurrect the force-losing phone shadow.
			expect((await readConversationShadow(adapter, "shared"))?.operationId).toBe(
				authorityOperation.operationId,
			);
			expect(
				await reopened.store.applyIncomingPackage(authorityPackage, bootstrapOptions),
			).toMatchObject({ appliedOperations: 0, alreadyApplied: true });
			expect(applied).toEqual([authorityOperation.operationId]);

			expect(
				await reopened.store.supersedeUnuploadedEntityOperations({
					accountNamespace: ACCOUNT,
					sourceDeviceId: LOCAL_DEVICE,
					section: "core",
					entityType: "conversation",
					entityId: "shared",
					supersededByOperationId: authorityOperation.operationId,
					maxOriginSequence: 1,
				}),
			).toBe(1);
			expect((await readConversationShadow(adapter, "shared"))?.operationId).toBe(
				authorityOperation.operationId,
			);
		} finally {
			await reopened.store.close();
			adapter.database.close();
		}
	});

	test("supersedes only matching unuploaded bootstrap conflicts", async () => {
		const applied: string[] = [];
		const { store, adapter } = await openTestStore({
			applyOperation: async (operation) => {
				applied.push(operation.operationId);
			},
		});
		try {
			// Controller contract: capture every local row before considering the
			// laptop's authoritative bootstrap snapshot.
			await reconcile(store, [
				entity("core", "conversation", "shared", { title: "Phone copy" }),
				entity("core", "conversation", "phone-only", { title: "Local only" }),
			]);
			const prematurelyStaged = await store.createNextOutboundPackage(ACCOUNT, LOCAL_DEVICE);
			expect(prematurelyStaged?.syncPackage.operationCount).toBe(2);
			const authoritative = createSyncOperation({
				operationId: "op-bootstrap-authority",
				accountNamespace: ACCOUNT,
				sourceDeviceId: REMOTE_DEVICE,
				sequence: { originSequence: 1, logicalClock: 100 },
				section: "core",
				entityType: "conversation",
				entityId: "shared",
				mutation: { kind: "upsert", value: { title: "Laptop copy" } },
			});
			const supersedeInput = {
				accountNamespace: ACCOUNT,
				sourceDeviceId: LOCAL_DEVICE,
				section: "core" as const,
				entityType: "conversation",
				entityId: "shared",
				supersededByOperationId: authoritative.operationId,
				maxOriginSequence: 2,
				atMs: 40,
			};
			adapter.failNextShadowDelete = true;
			await expect(
				store.supersedeUnuploadedEntityOperations(supersedeInput),
			).rejects.toThrow("injected shadow delete failure");
			expect(
				await store.listUnuploadedEntityOperations({
					accountNamespace: ACCOUNT,
					sourceDeviceId: LOCAL_DEVICE,
					section: "core",
					entityType: "conversation",
					entityId: "shared",
				}),
			).toHaveLength(1);
			expect(await store.supersedeUnuploadedEntityOperations(supersedeInput)).toBe(1);
			expect(
				await store.listUnuploadedEntityOperations({
					accountNamespace: ACCOUNT,
					sourceDeviceId: LOCAL_DEVICE,
					section: "core",
					entityType: "conversation",
					entityId: "shared",
				}),
			).toHaveLength(0);
			expect(
				await store.listUnuploadedEntityOperations({
					accountNamespace: ACCOUNT,
					sourceDeviceId: LOCAL_DEVICE,
					section: "core",
					entityType: "conversation",
					entityId: "phone-only",
				}),
			).toHaveLength(1);
			expect(await store.getPendingCounts(ACCOUNT)).toMatchObject({ changes: 1 });

			const authoritativePackage = await createSyncPackage({
				packageId: "pkg-bootstrap-authority",
				accountNamespace: ACCOUNT,
				sourceDeviceId: REMOTE_DEVICE,
				operations: [authoritative],
			});
			await store.applyIncomingPackage(authoritativePackage, {
				expectedAccountNamespace: ACCOUNT,
				expectedSourceDeviceId: REMOTE_DEVICE,
			});
			expect(applied).toEqual(["op-bootstrap-authority"]);

			// Superseding invalidates the previously staged immutable package. The
			// replacement starts at sequence 2 (a deliberate, digest-chain-safe gap)
			// and never transports the canceled shared entity operation.
			const phonePackage = await store.createNextOutboundPackage(ACCOUNT, LOCAL_DEVICE);
			expect(phonePackage?.syncPackage.sequenceRange).toEqual({ start: 2, end: 2 });
			expect(
				phonePackage?.syncPackage.operations.map((operation) => operation.entityId),
			).toEqual(["phone-only"]);
			expect(await store.listPendingOutboundPackages(ACCOUNT, LOCAL_DEVICE)).toHaveLength(1);

			const received: string[] = [];
			const { store: receiver } = await openTestStore({
				applyOperation: async (operation) => {
					received.push(operation.entityId);
				},
			});
			try {
				await receiver.applyIncomingPackage(phonePackage!.syncPackage, {
					expectedAccountNamespace: ACCOUNT,
					expectedSourceDeviceId: LOCAL_DEVICE,
				});
				expect(received).toEqual(["phone-only"]);
			} finally {
				await receiver.close();
			}
		} finally {
			await store.close();
		}
	});

	test("never supersedes a phone edit created after the persisted bootstrap cutoff", async () => {
		const { store } = await openTestStore();
		try {
			await reconcile(store, [
				entity("core", "conversation", "shared", { title: "Baseline phone copy" }),
			]);
			const baselineCutoff = await store.getLocalOriginSequence(ACCOUNT, LOCAL_DEVICE);
			expect(baselineCutoff).toBe(1);

			await reconcile(store, [
				entity("core", "conversation", "shared", { title: "Edited after baseline" }),
			]);
			expect(await store.getLocalOriginSequence(ACCOUNT, LOCAL_DEVICE)).toBe(2);

			expect(
				await store.supersedeUnuploadedEntityOperations({
					accountNamespace: ACCOUNT,
					sourceDeviceId: LOCAL_DEVICE,
					section: "core",
					entityType: "conversation",
					entityId: "shared",
					supersededByOperationId: "op-bootstrap-cutoff",
					maxOriginSequence: baselineCutoff,
					atMs: 60,
				}),
			).toBe(1);
			const remaining = await store.listUnuploadedEntityOperations({
				accountNamespace: ACCOUNT,
				sourceDeviceId: LOCAL_DEVICE,
				section: "core",
				entityType: "conversation",
				entityId: "shared",
			});
			expect(remaining.map((operation) => operation.originSequence)).toEqual([2]);
			expect(remaining[0].mutation).toEqual({
				kind: "upsert",
				value: { title: "Edited after baseline" },
			});

			await expect(
				store.supersedeUnuploadedEntityOperations({
					accountNamespace: ACCOUNT,
					sourceDeviceId: LOCAL_DEVICE,
					section: "core",
					entityType: "conversation",
					entityId: "shared",
					supersededByOperationId: "op-bootstrap-invalid-cutoff",
					maxOriginSequence: -1,
				}),
			).rejects.toThrow();
		} finally {
			await store.close();
		}
	});
});

describe("bounded reads", () => {
	test("reads cached package headers without the bodies", async () => {
		const { store } = await openTestStore();
		try {
			const syncPackage = await createSyncPackage({
				packageId: "pkg-header",
				accountNamespace: ACCOUNT,
				sourceDeviceId: REMOTE_DEVICE,
				createdAtMs: 1,
				previousPackageDigest: null,
				operations: [
					createSyncOperation({
						operationId: "op-header",
						accountNamespace: ACCOUNT,
						sourceDeviceId: REMOTE_DEVICE,
						sequence: { originSequence: 4, logicalClock: 4 },
						section: "core",
						entityType: "conversation",
						entityId: "header",
						mutation: { kind: "upsert", value: { title: "Header" } },
					}),
				],
			});
			await store.writeCachedRemotePackages(ACCOUNT, [
				{ cacheKey: "package", serialized: serializeSyncPackage(syncPackage) },
				{ cacheKey: "not-json", serialized: "{not json" },
				{ cacheKey: "not-a-package", serialized: '{"tampered":true}' },
			]);

			const headers = await store.readCachedRemotePackageHeaders(ACCOUNT, [
				"package",
				"not-json",
				"not-a-package",
				"missing",
			]);

			expect(headers.get("package")).toEqual({
				packageId: "pkg-header",
				accountNamespace: ACCOUNT,
				sourceDeviceId: REMOTE_DEVICE,
				sequenceStart: 4,
				sequenceEnd: 4,
				contentDigest: syncPackage.contentDigest,
				previousPackageDigest: null,
			});
			expect(headers.has("not-json")).toBe(false);
			expect(headers.get("not-a-package")?.packageId).toBeNull();
			expect(headers.has("missing")).toBe(false);
		} finally {
			await store.close();
		}
	});

	test("lists applied package digests for one account", async () => {
		const { store, adapter } = await openTestStore();
		try {
			for (const [packageId, accountNamespace, digest] of [
				["pkg-a", ACCOUNT, "a".repeat(64)],
				["pkg-b", "acct-other-vault", "b".repeat(64)],
			]) {
				await adapter.execute(
					`INSERT INTO sync_applied_packages (
						package_id, account_namespace, source_device_id, sequence_start,
						sequence_end, content_digest, previous_package_digest, applied_at_ms
					 ) VALUES (?, ?, ?, 1, 1, ?, NULL, 1)`,
					[packageId, accountNamespace, REMOTE_DEVICE, digest],
				);
			}
			expect(await store.listAppliedPackageDigests(ACCOUNT)).toEqual(
				new Map([["pkg-a", "a".repeat(64)]]),
			);
		} finally {
			await store.close();
		}
	});

	test("startup shadow repair pages through the whole outbox", async () => {
		const adapter = new BunSqliteAdapter({ closeDatabase: false });
		const first = await openTestStore({ adapter });
		const entities = Array.from({ length: 610 }, (_, index) =>
			entity("core", "conversation", `conversation-${index}`, { index }),
		);
		try {
			await reconcile(first.store, entities);
		} finally {
			await first.store.close();
		}
		await adapter.execute("DELETE FROM sync_entity_shadow");

		const reopened = await openTestStore({ adapter });
		try {
			const rows = await adapter.select<Array<{ count: number }>>(
				"SELECT COUNT(*) AS count FROM sync_entity_shadow",
			);
			expect(rows[0].count).toBe(entities.length);
			expect((await readConversationShadow(adapter, "conversation-609"))?.mutation).toEqual({
				kind: "upsert",
				value: { index: 609 },
			});
		} finally {
			await reopened.store.close();
		}
	});
});

describe("reading only what changed", () => {
	/**
	 * A device's data and its change journal, the way the real chat database
	 * behaves: every write to a conversations row logs its key.
	 */
	class FakeChangeSource implements GoogleDriveSyncChangeSource {
		journalId = "journal-1";
		rearmNext = false;
		armFails = false;
		readonly domain = new Map<string, JsonValue>();
		log: Array<{ id: number; table: string; key: string }> = [];
		#nextId = 1;
		coreScans = 0;
		otherScans = 0;
		disarmed = 0;
		loadFails = false;

		write(key: string, value: JsonValue | null): void {
			if (value === null) this.domain.delete(key);
			else this.domain.set(key, value);
			this.log.push({ id: this.#nextId++, table: "conversations", key });
		}

		async scan(
			_includeMedia: boolean,
			_scope: string,
			includeChat: boolean,
			onEntity: (entity: GoogleDriveSyncEntity) => Promise<void>,
		): Promise<void> {
			if (includeChat) {
				this.coreScans += 1;
				for (const [key, value] of this.domain) {
					await onEntity(entity("core", "conversation", key, value));
				}
			} else {
				this.otherScans += 1;
			}
			await onEntity(entity("interest-views", "interest-view", "viewer-1", { seen: 1 }));
		}

		async arm() {
			if (this.armFails) throw new Error("injected arm failure");
			if (this.rearmNext) {
				this.rearmNext = false;
				this.journalId = `${this.journalId}-rearmed`;
				this.log = [];
				return { journalId: this.journalId, rearmed: true };
			}
			return { journalId: this.journalId, rearmed: false };
		}

		async mark() {
			const throughId = this.log.reduce((max, row) => Math.max(max, row.id), 0);
			return { journalId: this.journalId, throughId, rowCount: this.log.length };
		}

		async read(throughId: number) {
			const seen = new Set<string>();
			const entries: Array<{ table: string; key: string }> = [];
			for (const row of this.log) {
				if (row.id > throughId || seen.has(row.key)) continue;
				seen.add(row.key);
				entries.push({ table: row.table, key: row.key });
			}
			return entries;
		}

		async load(
			entries: readonly { table: string; key: string }[],
			onBatch: (batch: readonly GoogleDriveSyncChangedEntity[]) => Promise<void>,
		) {
			if (this.loadFails) throw new Error("injected load failure");
			await onBatch(
				entries.map((entry) => ({
					section: "core" as const,
					entityType: "conversation",
					entityId: entry.key,
					value: this.domain.get(entry.key) ?? null,
				})),
			);
		}

		async clear(journalId: string, throughId: number) {
			if (journalId === this.journalId) {
				this.log = this.log.filter((row) => row.id > throughId);
			}
		}

		async disarm() {
			this.disarmed += 1;
		}
	}

	let clock = 1_000_000;
	async function openJournaledStore(
		source: FakeChangeSource,
		adapter = new BunSqliteAdapter(),
	) {
		const store = await GoogleDriveSyncStore.open(PROFILE_ID, {
			databaseFactory: async () => adapter,
			changeSource: source,
			now: () => clock,
		});
		return { store, adapter };
	}

	const pass = (store: GoogleDriveSyncStore) =>
		store.reconcileCurrentData({
			accountNamespace: ACCOUNT,
			sourceDeviceId: LOCAL_DEVICE,
			includeMedia: false,
			contactScope: "conversations",
		});

	test("the first pass scans everything, later passes read only the journal", async () => {
		const source = new FakeChangeSource();
		source.write("a", { title: "A" });
		source.write("b", { title: "B" });
		const { store } = await openJournaledStore(source);
		try {
			const first = await pass(store);
			expect(first).toMatchObject({
				mode: "full",
				fullScanReason: "no-baseline",
				createdUpserts: 3,
			});
			// Everything logged before the scan is now journaled, so it is cleared.
			expect(source.log).toEqual([]);

			const quiet = await pass(store);
			expect(quiet).toMatchObject({ mode: "changes", createdUpserts: 0, createdTombstones: 0 });
			expect(source.coreScans).toBe(1);
			// The small sections are still scanned each time.
			expect(source.otherScans).toBe(1);
			expect(quiet.unchangedEntities).toBe(1);
		} finally {
			await store.close();
		}
	});

	test("a changed row is sent and a deleted row is removed, nothing else is read", async () => {
		const source = new FakeChangeSource();
		source.write("a", { title: "A" });
		source.write("b", { title: "B" });
		const { store } = await openJournaledStore(source);
		try {
			await pass(store);
			source.write("a", { title: "A2" });
			source.write("b", null);
			// Written and removed between two passes: the other devices never knew it.
			source.write("never-sent", { title: "X" });
			source.write("never-sent", null);
			const result = await pass(store);
			expect(result).toMatchObject({
				mode: "changes",
				createdUpserts: 1,
				createdTombstones: 1,
				unchangedEntities: 2,
			});
			const operations = await store.listUnpackagedOperations(ACCOUNT, LOCAL_DEVICE);
			const last = operations
				.slice(-2)
				.map((operation) => [operation.entityId, operation.mutation.kind]);
			expect(last).toEqual([
				["a", "upsert"],
				["b", "delete"],
			]);
		} finally {
			await store.close();
		}
	});

	test("a row written back to its synced value journals nothing", async () => {
		const source = new FakeChangeSource();
		source.write("a", { title: "A" });
		const { store } = await openJournaledStore(source);
		try {
			await pass(store);
			source.write("a", { title: "temporary" });
			source.write("a", { title: "A" });
			expect(await pass(store)).toMatchObject({ createdUpserts: 0, unchangedEntities: 2 });
		} finally {
			await store.close();
		}
	});

	test("writes made during a pass stay in the journal for the next one", async () => {
		const source = new FakeChangeSource();
		source.write("a", { title: "A" });
		const { store } = await openJournaledStore(source);
		try {
			await pass(store);
			source.write("a", { title: "A2" });
			const originalLoad = source.load.bind(source);
			source.load = async (entries, onBatch) => {
				// Another write lands while this pass is reading.
				source.write("late", { title: "Late" });
				await originalLoad(entries, onBatch);
			};
			await pass(store);
			expect(source.log.map((row) => row.key)).toEqual(["late"]);
			source.load = originalLoad;
			expect(await pass(store)).toMatchObject({ mode: "changes", createdUpserts: 1 });
		} finally {
			await store.close();
		}
	});

	test("a failed pass leaves the journal untouched", async () => {
		const source = new FakeChangeSource();
		source.write("a", { title: "A" });
		const { store } = await openJournaledStore(source);
		try {
			await pass(store);
			source.write("a", { title: "A2" });
			source.loadFails = true;
			await expect(pass(store)).rejects.toThrow("injected load failure");
			expect(source.log.map((row) => row.key)).toEqual(["a"]);
			source.loadFails = false;
			expect(await pass(store)).toMatchObject({ mode: "changes", createdUpserts: 1 });
		} finally {
			await store.close();
		}
	});

	test("a re-armed journal means writes may be missing: scan everything", async () => {
		const source = new FakeChangeSource();
		source.write("a", { title: "A" });
		const { store } = await openJournaledStore(source);
		try {
			await pass(store);
			source.rearmNext = true;
			expect(await pass(store)).toMatchObject({ mode: "full", fullScanReason: "rearmed" });
			expect(await pass(store)).toMatchObject({ mode: "changes" });
		} finally {
			await store.close();
		}
	});

	test("a journal that cannot be set up never stops a sync", async () => {
		const source = new FakeChangeSource();
		source.write("a", { title: "A" });
		source.armFails = true;
		const { store } = await openJournaledStore(source);
		try {
			expect(await pass(store)).toMatchObject({ mode: "full", fullScanReason: "no-journal" });
			source.armFails = false;
			// Nothing was recorded against a journal, so the next pass scans too.
			expect(await pass(store)).toMatchObject({ mode: "full", fullScanReason: "no-baseline" });
		} finally {
			await store.close();
		}
	});

	test("a week after the last full scan, scans in full again", async () => {
		const source = new FakeChangeSource();
		source.write("a", { title: "A" });
		const { store } = await openJournaledStore(source);
		try {
			await pass(store);
			clock += GOOGLE_DRIVE_FULL_SCAN_INTERVAL_MS - 1;
			expect(await pass(store)).toMatchObject({ mode: "changes" });
			clock += 1;
			expect(await pass(store)).toMatchObject({ mode: "full", fullScanReason: "weekly" });
			expect(await pass(store)).toMatchObject({ mode: "changes" });
		} finally {
			await store.close();
		}
	});

	test("superseding during pairing forces the next pass to scan", async () => {
		const source = new FakeChangeSource();
		source.write("shared", { title: "Phone" });
		const { store } = await openJournaledStore(source);
		try {
			await pass(store);
			await store.supersedeUnuploadedEntityOperations({
				accountNamespace: ACCOUNT,
				sourceDeviceId: LOCAL_DEVICE,
				section: "core",
				entityType: "conversation",
				entityId: "shared",
				supersededByOperationId: "op-authority",
				maxOriginSequence: 10,
			});
			expect(await pass(store)).toMatchObject({ mode: "full", fullScanReason: "no-baseline" });
		} finally {
			await store.close();
		}
	});

	test("a pending pairing bootstrap always scans in full", async () => {
		const source = new FakeChangeSource();
		source.write("a", { title: "A" });
		const { store } = await openJournaledStore(source);
		try {
			await pass(store);
			await store.updateBootstrapState({
				authorityDeviceId: REMOTE_DEVICE,
				authoritySequenceEnd: 0,
				authorityHeadDigest: null,
				bootstrapPending: true,
				anchorRequired: false,
				localBaselineSequence: 0,
			});
			expect(await pass(store)).toMatchObject({ mode: "full", fullScanReason: "bootstrap" });
		} finally {
			await store.close();
		}
	});

	test("cleared history (a reset by an older build) is never trusted", async () => {
		const source = new FakeChangeSource();
		source.write("a", { title: "A" });
		const adapter = new BunSqliteAdapter();
		const { store } = await openJournaledStore(source, adapter);
		try {
			await pass(store);
			// An older build's reset does not know about baselines.
			await adapter.execute("DELETE FROM sync_outbound_operations");
			await adapter.execute("DELETE FROM sync_entity_shadow");
			expect(await pass(store)).toMatchObject({
				mode: "full",
				fullScanReason: "baseline-history-missing",
				createdUpserts: 2,
			});
		} finally {
			await store.close();
		}
	});

	test("a reset through this store clears the baseline with everything else", async () => {
		const source = new FakeChangeSource();
		source.write("a", { title: "A" });
		const { store, adapter } = await openJournaledStore(source);
		try {
			await pass(store);
			await store.clearAccountState(ACCOUNT);
			const rows = await adapter.select<Array<{ count: number }>>(
				"SELECT COUNT(*) AS count FROM sync_reconcile_baselines",
			);
			expect(rows[0].count).toBe(0);
		} finally {
			await store.close();
		}
	});

	test("stopping the journal removes it and forgets the baseline", async () => {
		const source = new FakeChangeSource();
		source.write("a", { title: "A" });
		const { store } = await openJournaledStore(source);
		try {
			await pass(store);
			await store.stopChangeJournal();
			expect(source.disarmed).toBe(1);
			expect(await pass(store)).toMatchObject({ mode: "full", fullScanReason: "no-baseline" });
		} finally {
			await store.close();
		}
	});

	test("a section is read either from changes or from a scan, never both", async () => {
		const { store } = await openTestStore();
		try {
			await expect(
				store.reconcileWithScanner({
					accountNamespace: ACCOUNT,
					sourceDeviceId: LOCAL_DEVICE,
					scannedSections: ["core"],
					scan: async () => undefined,
					changes: { sections: ["core"], load: async () => undefined },
				}),
			).rejects.toThrow("either scanned or read from changes");
		} finally {
			await store.close();
		}
	});
});

describe("shadow repair inside SQLite", () => {
	test("a launch with nothing to repair reads no operation JSON at all", async () => {
		const adapter = new BunSqliteAdapter({ closeDatabase: false });
		const first = await openTestStore({ adapter });
		try {
			await reconcile(
				first.store,
				Array.from({ length: 300 }, (_, index) =>
					entity("core", "conversation", `c-${index}`, { index }),
				),
			);
		} finally {
			await first.store.close();
		}
		const jsonReads: string[] = [];
		const select = adapter.select.bind(adapter);
		adapter.select = (async (query: string, bindValues?: unknown[]) => {
			if (/operation_json/i.test(query) && /sync_outbound_operations/i.test(query)) {
				jsonReads.push(query);
			}
			return select(query, bindValues);
		}) as typeof adapter.select;
		const reopened = await openTestStore({ adapter });
		try {
			await reconcile(reopened.store, [entity("core", "conversation", "c-0", { index: 0 })], [
				"core",
			], []);
			expect(jsonReads).toEqual([]);
		} finally {
			await reopened.store.close();
			adapter.database.close();
		}
	});

	test("a lost shadow is found and restored, and only its operation is read", async () => {
		const adapter = new BunSqliteAdapter({ closeDatabase: false });
		const first = await openTestStore({ adapter });
		try {
			await reconcile(first.store, [
				entity("core", "conversation", "keep", { title: "Keep" }),
				entity("core", "conversation", "lost", { title: "Lost" }),
			]);
		} finally {
			await first.store.close();
		}
		await adapter.execute("DELETE FROM sync_entity_shadow WHERE entity_id = 'lost'");
		const read: unknown[][] = [];
		const select = adapter.select.bind(adapter);
		adapter.select = (async (query: string, bindValues: unknown[] = []) => {
			if (/SELECT operation_id, operation_json/i.test(query)) read.push(bindValues);
			return select(query, bindValues);
		}) as typeof adapter.select;
		const reopened = await openTestStore({ adapter });
		try {
			expect((await readConversationShadow(adapter, "lost"))?.mutation).toEqual({
				kind: "upsert",
				value: { title: "Lost" },
			});
			expect(read).toHaveLength(1);
			expect(read[0]).toHaveLength(1);
		} finally {
			await reopened.store.close();
			adapter.database.close();
		}
	});

	test("chooses a full scan for every reason the journal cannot be trusted", () => {
		const base = {
			baseline: { journalId: "j", lastOperationId: "op", fullScanAtMs: 0 },
			baselineHistoryPresent: true,
			journalId: "j",
			rearmed: false,
			bootstrapPending: false,
			journaledChanges: 10,
			nowMs: 1,
		};
		expect(chooseGoogleDriveReconcileMode(base)).toEqual({ mode: "changes" });
		const reasons = [
			[{ baseline: null }, "no-baseline"],
			[{ rearmed: true }, "rearmed"],
			[{ journalId: "other" }, "journal-changed"],
			[{ bootstrapPending: true }, "bootstrap"],
			[{ baselineHistoryPresent: false }, "baseline-history-missing"],
			[{ baseline: { ...base.baseline, lastOperationId: null } }, "baseline-history-missing"],
			[{ nowMs: GOOGLE_DRIVE_FULL_SCAN_INTERVAL_MS }, "weekly"],
			[{ journaledChanges: GOOGLE_DRIVE_MAX_JOURNALED_CHANGES + 1 }, "too-many-changes"],
		] as const;
		for (const [patch, reason] of reasons) {
			expect(chooseGoogleDriveReconcileMode({ ...base, ...patch })).toEqual({
				mode: "full",
				reason,
			});
		}
	});
});

describe("applying a package in batches", () => {
	async function remotePackage(count: number, entityFor = (index: number) => `e-${index}`) {
		const operations = [];
		for (let index = 0; index < count; index += 1) {
			operations.push(
				createSyncOperation({
					operationId: `op-batch-${index}`,
					accountNamespace: ACCOUNT,
					sourceDeviceId: REMOTE_DEVICE,
					sequence: { originSequence: index + 1, logicalClock: 100 + index },
					section: "core",
					entityType: "conversation",
					entityId: entityFor(index),
					mutation: { kind: "upsert", value: { index } },
				}),
			);
		}
		return createSyncPackage({
			packageId: `pkg-batch-${count}`,
			accountNamespace: ACCOUNT,
			sourceDeviceId: REMOTE_DEVICE,
			operations,
		});
	}

	const options = {
		expectedAccountNamespace: ACCOUNT,
		expectedSourceDeviceId: REMOTE_DEVICE,
		now: () => 50,
	};

	function countQueries(adapter: BunSqliteAdapter) {
		const counts = { shadowReads: 0, shadowWrites: 0, clockWrites: 0, order: [] as string[] };
		const select = adapter.select.bind(adapter);
		const execute = adapter.execute.bind(adapter);
		adapter.select = (async (query: string, bindValues?: unknown[]) => {
			if (/FROM sync_entity_shadow/i.test(query)) counts.shadowReads += 1;
			return select(query, bindValues);
		}) as typeof adapter.select;
		adapter.execute = (async (query: string, bindValues?: unknown[]) => {
			if (/INSERT INTO sync_entity_shadow/i.test(query)) {
				counts.shadowWrites += 1;
				counts.order.push("shadow");
			}
			if (/INSERT INTO sync_account_clocks/i.test(query)) counts.clockWrites += 1;
			if (/INSERT INTO sync_applied_operations/i.test(query)) counts.order.push("receipt");
			return execute(query, bindValues);
		}) as typeof adapter.execute;
		return counts;
	}

	test("a package reads its shadows once and writes them in batches", async () => {
		const adapter = new BunSqliteAdapter();
		const { store } = await openTestStore({ adapter, applyOperation: async () => true });
		try {
			const counts = countQueries(adapter);
			const pkg = await remotePackage(250);
			expect(await store.applyIncomingPackage(pkg, options)).toMatchObject({
				appliedOperations: 250,
			});
			// One read for 250 entities (400 per chunk), three writes of up to 100,
			// one clock record: instead of 250 of each.
			expect(counts.shadowReads).toBe(1);
			expect(counts.shadowWrites).toBe(3);
			expect(counts.clockWrites).toBe(1);
			const rows = await adapter.select<Array<{ count: number }>>(
				"SELECT COUNT(*) AS count FROM sync_entity_shadow",
			);
			expect(rows[0].count).toBe(250);
		} finally {
			await store.close();
		}
	});

	test("shadows are always durable before the receipts that claim them", async () => {
		const adapter = new BunSqliteAdapter();
		const { store } = await openTestStore({ adapter, applyOperation: async () => true });
		try {
			const counts = countQueries(adapter);
			await store.applyIncomingPackage(await remotePackage(30), options);
			const firstReceipt = counts.order.indexOf("receipt");
			expect(firstReceipt).toBeGreaterThan(0);
			expect(counts.order.slice(0, firstReceipt)).toContain("shadow");
			expect(counts.order.slice(firstReceipt)).not.toContain("shadow");
		} finally {
			await store.close();
		}
	});

	test("two changes to one entity in a package compare in order", async () => {
		const expectations: Array<string | undefined> = [];
		const adapter = new BunSqliteAdapter();
		const { store } = await openTestStore({
			adapter,
			applyOperation: async (_operation, expected) => {
				expectations.push(expected?.operationId);
				return true;
			},
		});
		try {
			await store.applyIncomingPackage(await remotePackage(2, () => "same"), options);
			// The second sees the first as the current shadow, as it did one by one.
			expect(expectations).toEqual([undefined, "op-batch-0"]);
			expect((await readConversationShadow(adapter, "same"))?.operationId).toBe("op-batch-1");
		} finally {
			await store.close();
		}
	});

	test("a failure part way keeps the shadows of what was already written", async () => {
		let calls = 0;
		const adapter = new BunSqliteAdapter();
		const { store } = await openTestStore({
			adapter,
			applyOperation: async () => {
				calls += 1;
				if (calls === 4) throw new Error("injected domain failure");
				return true;
			},
		});
		try {
			await expect(
				store.applyIncomingPackage(await remotePackage(6), options),
			).rejects.toThrow("injected domain failure");
			const rows = await adapter.select<Array<{ entity_id: string }>>(
				"SELECT entity_id FROM sync_entity_shadow ORDER BY entity_id",
			);
			// Three rows reached the profile before the failure; their shadows are
			// there, so a scan will not mistake them for local edits.
			expect(rows.map((row) => row.entity_id)).toEqual(["e-0", "e-1", "e-2"]);
			expect(
				await reconcile(store, [
					entity("core", "conversation", "e-0", { index: 0 }),
					entity("core", "conversation", "e-1", { index: 1 }),
					entity("core", "conversation", "e-2", { index: 2 }),
				]),
			).toMatchObject({ createdUpserts: 0, unchangedEntities: 3 });
		} finally {
			await store.close();
		}
	});

	test("an older incoming change still loses to the shadow read up front", async () => {
		const applied: string[] = [];
		const adapter = new BunSqliteAdapter();
		const { store } = await openTestStore({
			adapter,
			applyOperation: async (operation) => {
				applied.push(operation.operationId);
				return true;
			},
		});
		try {
			// A local edit with a clock above the incoming one.
			await reconcile(store, [entity("core", "conversation", "e-0", { local: true })]);
			await adapter.execute(
				"UPDATE sync_entity_shadow SET logical_clock = 10000, winning_operation_json = json_set(winning_operation_json, '$.revision.logicalClock', 10000)",
			);
			await store.applyIncomingPackage(await remotePackage(2), options);
			expect(applied).toEqual(["op-batch-1"]);
		} finally {
			await store.close();
		}
	});
});
