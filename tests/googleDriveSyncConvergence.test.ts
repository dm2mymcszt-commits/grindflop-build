import { Database as BunDatabase } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
	canonicalJson,
	parseAndVerifySyncPackage,
	type ImmutableSyncOperation,
	type JsonValue,
	type SyncPackage,
} from "../src/services/cloudSync";
import type { GoogleDriveSyncEntity } from "../src/services/googleDriveSyncData";
import {
	GoogleDriveSyncStore,
	type GoogleDriveSyncSqlDatabase,
} from "../src/services/googleDriveSyncStore";

const ACCOUNT = "acct-convergence-vault";
const DEVICE_A = "device-a-windows";
const DEVICE_B = "device-z-iphone";
const ENTITY_TYPE = "conversation";
const ENTITY_ID = "shared-conversation";

type DeviceId = typeof DEVICE_A | typeof DEVICE_B;
type DomainValue = JsonValue | undefined;
type SyncOrder = readonly [DeviceId, DeviceId];

class BunSqliteAdapter implements GoogleDriveSyncSqlDatabase {
	readonly path = ":memory:";
	readonly database = new BunDatabase(":memory:");

	async execute(query: string, bindValues: unknown[] = []) {
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
		this.database.close();
	}
}

type RemotePackage = Readonly<{
	syncPackage: SyncPackage;
	serialized: string;
	remoteFileId: string;
}>;

/** Append-only shared transport standing in for Drive's appDataFolder. */
class SharedRemoteHistory {
	readonly #packagesBySource = new Map<DeviceId, RemotePackage[]>();
	#nextFileId = 1;

	async append(serialized: string): Promise<RemotePackage> {
		// Cross the same serialization/verification boundary used by the real wire.
		const syncPackage = await parseAndVerifySyncPackage(serialized);
		const sourceDeviceId = syncPackage.sourceDeviceId as DeviceId;
		if (sourceDeviceId !== DEVICE_A && sourceDeviceId !== DEVICE_B) {
			throw new Error(
				`Unexpected convergence source device: ${sourceDeviceId}`,
			);
		}
		const sourcePackages = this.#packagesBySource.get(sourceDeviceId) ?? [];
		const existing = sourcePackages.find(
			(remotePackage) =>
				remotePackage.syncPackage.packageId === syncPackage.packageId,
		);
		if (existing) {
			if (existing.syncPackage.contentDigest !== syncPackage.contentDigest) {
				throw new Error("A package ID was reused for different remote content");
			}
			return existing;
		}

		const previous = sourcePackages[sourcePackages.length - 1]?.syncPackage;
		if (
			(previous?.contentDigest ?? null) !== syncPackage.previousPackageDigest
		) {
			throw new Error("The shared remote package chain forked");
		}
		const remotePackage = Object.freeze({
			syncPackage,
			serialized,
			remoteFileId: `remote-convergence-${this.#nextFileId++}`,
		});
		sourcePackages.push(remotePackage);
		this.#packagesBySource.set(sourceDeviceId, sourcePackages);
		return remotePackage;
	}

	listSource(sourceDeviceId: DeviceId): readonly RemotePackage[] {
		return this.#packagesBySource.get(sourceDeviceId) ?? [];
	}

	heads(): Record<DeviceId, { sequenceEnd: number; contentDigest: string }> {
		const result = {} as Record<
			DeviceId,
			{ sequenceEnd: number; contentDigest: string }
		>;
		for (const sourceDeviceId of [DEVICE_A, DEVICE_B] as const) {
			const head = this.listSource(sourceDeviceId).at(-1)?.syncPackage;
			if (!head)
				throw new Error(`Missing remote history for ${sourceDeviceId}`);
			result[sourceDeviceId] = {
				sequenceEnd: head.sequenceRange.end,
				contentDigest: head.contentDigest,
			};
		}
		return result;
	}
}

function domainValuesEqual(left: DomainValue, right: DomainValue): boolean {
	if (left === undefined || right === undefined) return left === right;
	return canonicalJson(left) === canonicalJson(right);
}

function operationValue(operation?: ImmutableSyncOperation): DomainValue {
	return operation?.mutation.kind === "upsert"
		? operation.mutation.value
		: undefined;
}

class ConvergenceDevice {
	readonly deviceId: DeviceId;
	readonly store: GoogleDriveSyncStore;
	readonly adapter: BunSqliteAdapter;
	#domainValue: DomainValue;

	private constructor(
		deviceId: DeviceId,
		store: GoogleDriveSyncStore,
		adapter: BunSqliteAdapter,
	) {
		this.deviceId = deviceId;
		this.store = store;
		this.adapter = adapter;
	}

	static async open(
		deviceId: DeviceId,
		profileId: number,
	): Promise<ConvergenceDevice> {
		const adapter = new BunSqliteAdapter();
		let device: ConvergenceDevice | undefined;
		const store = await GoogleDriveSyncStore.open(profileId, {
			databaseFactory: async () => adapter,
			applyOperation: async (incoming, expected) => {
				if (!device)
					throw new Error("The convergence device is not initialized");
				const incomingValue = operationValue(incoming);
				const expectedValue = operationValue(expected);
				// Match the production compare-and-apply contract: crash replay of an
				// already-applied value succeeds, while a newly diverged local value is
				// preserved and causally promoted by the next reconciliation scan.
				if (domainValuesEqual(device.#domainValue, incomingValue)) return true;
				if (!domainValuesEqual(device.#domainValue, expectedValue))
					return false;
				device.#domainValue = incomingValue;
				return true;
			},
		});
		device = new ConvergenceDevice(deviceId, store, adapter);
		return device;
	}

	setDomain(value: DomainValue): void {
		this.#domainValue = value;
	}

	domainValue(): DomainValue {
		return this.#domainValue;
	}

	async reconcile() {
		const entities: GoogleDriveSyncEntity[] =
			this.#domainValue === undefined
				? []
				: [
						{
							section: "core",
							entityType: ENTITY_TYPE,
							entityId: ENTITY_ID,
							value: this.#domainValue,
						},
					];
		return this.store.reconcileWithScanner({
			accountNamespace: ACCOUNT,
			sourceDeviceId: this.deviceId,
			scannedSections: ["core"],
			scan: async (onEntity) => {
				for (const entity of entities) await onEntity(entity);
			},
		});
	}

	async publish(remote: SharedRemoteHistory): Promise<number> {
		let published = 0;
		for (;;) {
			const outbound = await this.store.createNextOutboundPackage(
				ACCOUNT,
				this.deviceId,
			);
			if (!outbound) return published;
			const remotePackage = await remote.append(outbound.serialized);
			await this.store.markOutboundPackageUploaded(
				outbound.syncPackage.packageId,
				remotePackage.remoteFileId,
			);
			published += 1;
		}
	}

	async pull(remote: SharedRemoteHistory): Promise<number> {
		let appliedPackages = 0;
		for (const sourceDeviceId of [DEVICE_A, DEVICE_B] as const) {
			if (sourceDeviceId === this.deviceId) continue;
			for (const remotePackage of remote.listSource(sourceDeviceId)) {
				const cursor = await this.store.getInboundCursor(
					ACCOUNT,
					sourceDeviceId,
				);
				if (remotePackage.syncPackage.sequenceRange.end < cursor.nextSequence)
					continue;
				await this.store.applyIncomingPackage(remotePackage.syncPackage, {
					expectedAccountNamespace: ACCOUNT,
					expectedSourceDeviceId: sourceDeviceId,
				});
				appliedPackages += 1;
			}
		}
		return appliedPackages;
	}

	async winningShadow(): Promise<ImmutableSyncOperation> {
		const rows = await this.adapter.select<
			Array<{ winning_operation_json: string }>
		>(
			`SELECT winning_operation_json FROM sync_entity_shadow
			 WHERE account_namespace = ? AND section = 'core'
			   AND entity_type = ? AND entity_id = ?`,
			[ACCOUNT, ENTITY_TYPE, ENTITY_ID],
		);
		if (!rows[0]) throw new Error("The convergence winner shadow is missing");
		return JSON.parse(rows[0].winning_operation_json) as ImmutableSyncOperation;
	}

	async sourceHeads(): Promise<
		Record<DeviceId, { sequenceEnd: number; contentDigest: string }>
	> {
		const result = {} as Record<
			DeviceId,
			{ sequenceEnd: number; contentDigest: string }
		>;
		const own = await this.store.getOutboundHead(ACCOUNT, this.deviceId);
		if (!own) throw new Error("The local outbound head is missing");
		result[this.deviceId] = own;
		for (const inbound of await this.store.listInboundHeads(ACCOUNT)) {
			result[inbound.sourceDeviceId as DeviceId] = {
				sequenceEnd: inbound.sequenceEnd,
				contentDigest: inbound.contentDigest,
			};
		}
		return result;
	}

	async close(): Promise<void> {
		await this.store.close();
	}
}

type RoundProgress = Readonly<{
	createdOperations: number;
	publishedPackages: number;
	appliedPackages: number;
}>;

async function syncRound(
	devices: ReadonlyMap<DeviceId, ConvergenceDevice>,
	remote: SharedRemoteHistory,
	order: SyncOrder,
): Promise<RoundProgress> {
	let createdOperations = 0;
	let publishedPackages = 0;
	let appliedPackages = 0;
	for (const deviceId of order) {
		const device = devices.get(deviceId);
		if (!device) throw new Error(`Missing convergence device ${deviceId}`);
		const beforePull = await device.reconcile();
		createdOperations +=
			beforePull.createdUpserts + beforePull.createdTombstones;
		publishedPackages += await device.publish(remote);
		appliedPackages += await device.pull(remote);
		const afterPull = await device.reconcile();
		createdOperations += afterPull.createdUpserts + afterPull.createdTombstones;
		publishedPackages += await device.publish(remote);
	}
	return { createdOperations, publishedPackages, appliedPackages };
}

async function convergeUntilStable(
	devices: ReadonlyMap<DeviceId, ConvergenceDevice>,
	remote: SharedRemoteHistory,
	order: SyncOrder,
): Promise<RoundProgress> {
	let progress: RoundProgress = {
		createdOperations: 0,
		publishedPackages: 0,
		appliedPackages: 0,
	};
	for (let round = 0; round < 8; round += 1) {
		progress = await syncRound(devices, remote, order);
		if (
			progress.createdOperations === 0 &&
			progress.publishedPackages === 0 &&
			progress.appliedPackages === 0
		) {
			return progress;
		}
	}
	throw new Error("Two-device reconciliation did not reach a fixed point");
}

type Scenario = Readonly<{
	name: string;
	deviceBValue: DomainValue;
	expectedWinnerValue: DomainValue;
	expectedWinnerKind: "upsert" | "delete";
}>;

const scenarios: readonly Scenario[] = [
	{
		name: "offline update versus update",
		deviceBValue: { title: "iPhone edit" },
		expectedWinnerValue: { title: "iPhone edit" },
		expectedWinnerKind: "upsert",
	},
	{
		name: "offline update versus delete",
		deviceBValue: undefined,
		expectedWinnerValue: undefined,
		expectedWinnerKind: "delete",
	},
];

const syncOrders: readonly SyncOrder[] = [
	[DEVICE_A, DEVICE_B],
	[DEVICE_B, DEVICE_A],
];

describe("two-device durable Google Drive convergence", () => {
	for (const scenario of scenarios) {
		for (const order of syncOrders) {
			test(`${scenario.name} converges with ${order[0]} syncing first`, async () => {
				const remote = new SharedRemoteHistory();
				const deviceA = await ConvergenceDevice.open(DEVICE_A, 91_001);
				const deviceB = await ConvergenceDevice.open(DEVICE_B, 91_002);
				const devices = new Map<DeviceId, ConvergenceDevice>([
					[DEVICE_A, deviceA],
					[DEVICE_B, deviceB],
				]);
				try {
					// Establish one common synced shadow before both devices go offline.
					deviceA.setDomain({ title: "Shared baseline" });
					expect(await deviceA.reconcile()).toMatchObject({
						createdUpserts: 1,
					});
					expect(await deviceA.publish(remote)).toBe(1);
					expect(await deviceB.pull(remote)).toBe(1);
					expect(await deviceB.reconcile()).toMatchObject({
						createdUpserts: 0,
						createdTombstones: 0,
					});

					// Both edits are journaled before either device can observe the other.
					deviceA.setDomain({ title: "Windows edit" });
					deviceB.setDomain(scenario.deviceBValue);
					const [offlineA, offlineB] = await Promise.all([
						deviceA.reconcile(),
						deviceB.reconcile(),
					]);
					expect(offlineA.createdUpserts).toBe(1);
					expect(
						scenario.expectedWinnerKind === "delete"
							? offlineB.createdTombstones
							: offlineB.createdUpserts,
					).toBe(1);

					// DEVICE_B is lexicographically greater, so equal Lamport clocks have
					// the same deterministic winner regardless of transport order.
					expect(await convergeUntilStable(devices, remote, order)).toEqual({
						createdOperations: 0,
						publishedPackages: 0,
						appliedPackages: 0,
					});
					expect(
						domainValuesEqual(
							deviceA.domainValue(),
							scenario.expectedWinnerValue,
						),
					).toBe(true);
					expect(
						domainValuesEqual(
							deviceB.domainValue(),
							scenario.expectedWinnerValue,
						),
					).toBe(true);

					const [winnerA, winnerB] = await Promise.all([
						deviceA.winningShadow(),
						deviceB.winningShadow(),
					]);
					expect(winnerA).toEqual(winnerB);
					expect(winnerA.sourceDeviceId).toBe(DEVICE_B);
					expect(winnerA.mutation.kind).toBe(scenario.expectedWinnerKind);

					const remoteHeads = remote.heads();
					expect(await deviceA.sourceHeads()).toEqual(remoteHeads);
					expect(await deviceB.sourceHeads()).toEqual(remoteHeads);

					// One additional complete cycle must remain silent: no echo operation,
					// no package, and no pending durable outbox entry on either device.
					expect(await syncRound(devices, remote, order)).toEqual({
						createdOperations: 0,
						publishedPackages: 0,
						appliedPackages: 0,
					});
					for (const device of devices.values()) {
						expect(await device.store.getPendingCounts(ACCOUNT)).toMatchObject({
							changes: 0,
						});
						expect(
							await device.store.createNextOutboundPackage(
								ACCOUNT,
								device.deviceId,
							),
						).toBeNull();
					}
				} finally {
					await Promise.all([deviceA.close(), deviceB.close()]);
				}
			});
		}
	}
});
