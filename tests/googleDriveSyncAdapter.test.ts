import { describe, expect, test } from "bun:test";
import {
	connectGoogleDriveSync,
	exportGoogleDriveSyncPairingCode,
	getGoogleDriveSyncStatus,
	importGoogleDriveSyncPairingCode,
	registerGoogleDriveSyncAdapter,
	subscribeGoogleDriveSyncStatus,
	type GoogleDriveSyncAdapter,
	type GoogleDriveSyncStatus,
} from "../src/services/googleDriveSync";

const PROFILE_ID = 12345;

function disconnectedStatus(): GoogleDriveSyncStatus {
	return {
		phase: "disconnected",
		available: true,
		googleConnected: false,
		vaultState: "none",
		vaultFingerprint: null,
		googleAccountEmail: null,
		deviceName: "Test laptop",
		lastSuccessfulSyncAt: null,
		pendingChanges: 0,
		pendingBytes: 0,
		mediaPolicy: "off",
		error: null,
	};
}

describe("Google Drive sync UI adapter", () => {
	test("routes OAuth and pairing through a replaceable mock", async () => {
		let status = disconnectedStatus();
		const adapter: GoogleDriveSyncAdapter = {
			getStatus: async () => status,
			connect: async () => {
				status = {
					...status,
					phase: "pairing",
					googleConnected: true,
					vaultState: "awaiting-key",
					googleAccountEmail: "user@example.com",
				};
				return status;
			},
			exportPairingCode: async () => ({
				pairingCode: "test-secret-key",
				fingerprint: "vault-1234",
				expiresAt: null,
			}),
			importPairingCode: async ({ pairingCode }) => {
				expect(pairingCode).toBe("test-secret-key");
				status = {
					...status,
					phase: "paired",
					vaultState: "ready",
					vaultFingerprint: "vault-1234",
				};
				return status;
			},
			syncNow: async () => status,
			setMediaPolicy: async () => status,
			disconnectDevice: async () => {
				status = disconnectedStatus();
				return status;
			},
			resetCloudData: async () => {
				status = disconnectedStatus();
				return status;
			},
		};

		const unregister = registerGoogleDriveSyncAdapter(adapter);
		try {
			expect((await getGoogleDriveSyncStatus({ profileId: PROFILE_ID })).phase).toBe(
				"disconnected",
			);
			expect((await connectGoogleDriveSync({ profileId: PROFILE_ID })).vaultState).toBe(
				"awaiting-key",
			);
			expect(
				(await exportGoogleDriveSyncPairingCode({ profileId: PROFILE_ID })).fingerprint,
			).toBe("vault-1234");
			expect(
				(
					await importGoogleDriveSyncPairingCode({
						profileId: PROFILE_ID,
						pairingCode: "test-secret-key",
					})
				).vaultState,
			).toBe("ready");
		} finally {
			unregister();
		}

		expect((await getGoogleDriveSyncStatus({ profileId: PROFILE_ID })).available).toBe(
			false,
		);
	});

	test("ignores delayed snapshots and callbacks from a replaced adapter", async () => {
		let resolveOldSnapshot!: (status: GoogleDriveSyncStatus) => void;
		let publishOldStatus: ((status: GoogleDriveSyncStatus) => void) | undefined;
		const oldStatus = {
			...disconnectedStatus(),
			deviceName: "Old adapter",
		};
		const newStatus = {
			...disconnectedStatus(),
			phase: "paired" as const,
			googleConnected: true,
			vaultState: "ready" as const,
			vaultFingerprint: "vault-new",
			deviceName: "New adapter",
		};
		const oldSnapshot = new Promise<GoogleDriveSyncStatus>((resolve) => {
			resolveOldSnapshot = resolve;
		});
		const oldAdapter: GoogleDriveSyncAdapter = {
			getStatus: () => oldSnapshot,
			connect: async () => oldStatus,
			exportPairingCode: async () => ({
				pairingCode: "old",
				fingerprint: null,
				expiresAt: null,
			}),
			importPairingCode: async () => oldStatus,
			syncNow: async () => oldStatus,
			setMediaPolicy: async () => oldStatus,
			disconnectDevice: async () => oldStatus,
			resetCloudData: async () => oldStatus,
			subscribe: (_input, listener) => {
				publishOldStatus = listener;
				// Deliberately leave the captured callback callable after cleanup. The
				// facade must defend against a misbehaving or already-queued source.
				return () => undefined;
			},
		};
		const newAdapter: GoogleDriveSyncAdapter = {
			getStatus: async () => newStatus,
			connect: async () => newStatus,
			exportPairingCode: async () => ({
				pairingCode: "new",
				fingerprint: "vault-new",
				expiresAt: null,
			}),
			importPairingCode: async () => newStatus,
			syncNow: async () => newStatus,
			setMediaPolicy: async () => newStatus,
			disconnectDevice: async () => newStatus,
			resetCloudData: async () => newStatus,
		};

		const unregisterOld = registerGoogleDriveSyncAdapter(oldAdapter);
		const received: GoogleDriveSyncStatus[] = [];
		const unsubscribe = subscribeGoogleDriveSyncStatus(
			{ profileId: PROFILE_ID },
			(status) => received.push(status),
		);
		const unregisterNew = registerGoogleDriveSyncAdapter(newAdapter);
		try {
			await Promise.resolve();
			expect(received.at(-1)?.deviceName).toBe("New adapter");

			resolveOldSnapshot(oldStatus);
			publishOldStatus?.(oldStatus);
			await Promise.resolve();

			expect(received.map((status) => status.deviceName)).toEqual([
				"New adapter",
			]);
		} finally {
			unsubscribe();
			unregisterNew();
			unregisterOld();
		}
	});
});
