import { describe, expect, test } from "bun:test";
import {
	GoogleDriveNativeError,
	createGoogleDriveNativeBridge,
	normalizeGoogleDriveNativeError,
	toGoogleDriveProfileId,
	type GoogleDriveNativeInvoke,
} from "../src/services/googleDriveSyncNative";

const PROFILE_ID = toGoogleDriveProfileId(12345);

const CONFIG_STATUS = {
	platform: "windows",
	configured: true,
	oauthSupported: true,
	scope: "https://www.googleapis.com/auth/drive.appdata",
	redirectMode: "loopback-pkce",
	problem: null,
} as const;

const CONNECTION_STATUS = {
	connected: true,
	googleAccountEmail: "person@example.com",
	canRefresh: true,
	credentialExpiresAt: 1234,
	vaultKey: { present: true, fingerprint: "AAAAAAAAAAA" },
} as const;

const FILE = {
	id: "drive-file-1",
	name: "opaque.bin",
	mimeType: "application/octet-stream",
	size: "10",
	modifiedTime: "2026-08-30T00:00:00Z",
	md5Checksum: "abc",
} as const;

describe("Google Drive native bridge", () => {
	test("uses decimal profile strings and exact camelCase Tauri arguments", async () => {
		const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
		const invoke: GoogleDriveNativeInvoke = async (command, args) => {
			calls.push({ command, args });
			switch (command) {
				case "google_drive_config_status":
					return CONFIG_STATUS;
				case "google_drive_connection_status":
				case "google_drive_connect":
					return CONNECTION_STATUS;
				case "google_drive_vault_key_status":
				case "google_drive_vault_key_create":
				case "google_drive_vault_key_import":
					return CONNECTION_STATUS.vaultKey;
				case "google_drive_vault_key_export_for_pairing":
					return {
						encoding: "base64url-no-padding",
						key: "A".repeat(43),
						fingerprint: "AAAAAAAAAAA",
					};
				case "google_drive_encrypt":
					return {
						version: 1,
						algorithm: "A256GCM",
						nonce: "A".repeat(16),
						ciphertext: "A".repeat(22),
					};
				case "google_drive_decrypt":
					return "cGxhaW50ZXh0";
				case "google_drive_list_app_data":
					return { nextPageToken: null, files: [FILE] };
				case "google_drive_get_start_page_token":
					return { startPageToken: "start" };
				case "google_drive_list_changes":
					return {
						nextPageToken: null,
						newStartPageToken: "next",
						changes: [{ fileId: FILE.id, removed: false, file: FILE }],
					};
				case "google_drive_download_app_data":
					return { contentType: null, dataBase64: "AA" };
				case "google_drive_create_app_data":
				case "google_drive_update_app_data":
					return FILE;
				default:
					return null;
			}
		};
		const bridge = createGoogleDriveNativeBridge(invoke);

		expect(Object.keys(bridge)).toHaveLength(18);
		await bridge.configStatus();
		await bridge.connectionStatus(PROFILE_ID);
		await bridge.connect(PROFILE_ID);
		await bridge.disconnect(PROFILE_ID);
		await bridge.vaultKeyStatus(PROFILE_ID);
		await bridge.vaultKeyCreate(PROFILE_ID);
		await bridge.vaultKeyImport(PROFILE_ID, "A".repeat(43));
		await bridge.vaultKeyExportForPairing(PROFILE_ID, true);
		await bridge.vaultKeyDelete(PROFILE_ID, true);
		const envelope = await bridge.encrypt(PROFILE_ID, "AA", "aad");
		await bridge.decrypt(PROFILE_ID, envelope, "aad");
		await bridge.listAppData(PROFILE_ID);
		await bridge.getStartPageToken(PROFILE_ID);
		await bridge.listChanges(PROFILE_ID, "start");
		await bridge.downloadAppData(PROFILE_ID, FILE.id);
		await bridge.createAppData(PROFILE_ID, FILE.name, "AA");
		await bridge.updateAppData(PROFILE_ID, FILE.id, "AA", "etag");
		await bridge.deleteAppData(PROFILE_ID, FILE.id, true);

		expect(calls.map(({ command }) => command)).toEqual([
			"google_drive_config_status",
			"google_drive_connection_status",
			"google_drive_connect",
			"google_drive_disconnect",
			"google_drive_vault_key_status",
			"google_drive_vault_key_create",
			"google_drive_vault_key_import",
			"google_drive_vault_key_export_for_pairing",
			"google_drive_vault_key_delete",
			"google_drive_encrypt",
			"google_drive_decrypt",
			"google_drive_list_app_data",
			"google_drive_get_start_page_token",
			"google_drive_list_changes",
			"google_drive_download_app_data",
			"google_drive_create_app_data",
			"google_drive_update_app_data",
			"google_drive_delete_app_data",
		]);
		expect(calls[6]?.args).toEqual({
			profileId: "12345",
			keyBase64: "A".repeat(43),
		});
		expect(calls[16]?.args).toEqual({
			profileId: "12345",
			fileId: FILE.id,
			dataBase64: "AA",
			expectedEtag: "etag",
		});
	});

	test("normalizes structured native errors and rejects malformed responses", async () => {
		const structured = normalizeGoogleDriveNativeError({
			code: "reauthenticationRequired",
			message: "Sign in again",
		});
		expect(structured).toBeInstanceOf(GoogleDriveNativeError);
		expect(structured.code).toBe("reauthenticationRequired");
		expect(structured.requiresReauthentication).toBe(true);

		const serialized = normalizeGoogleDriveNativeError(
			JSON.stringify({ code: "conflict", message: "Already running" }),
		);
		expect(serialized.code).toBe("conflict");

		const rejecting = createGoogleDriveNativeBridge(async () => {
			throw { code: "notConnected", message: "Connect first" };
		});
		await expect(rejecting.configStatus()).rejects.toMatchObject({
			code: "notConnected",
			message: "Connect first",
		});

		const malformed = createGoogleDriveNativeBridge(async () => ({
			...CONFIG_STATUS,
			credential: "must not be accepted",
		}));
		await expect(malformed.configStatus()).rejects.toMatchObject({
			code: "integrity",
		});
	});

	test("rejects non-canonical profile IDs before invoking native code", () => {
		expect(() => toGoogleDriveProfileId(0)).toThrow();
		expect(() => toGoogleDriveProfileId("0")).toThrow();
		expect(() => toGoogleDriveProfileId("001")).toThrow();
		expect(() => toGoogleDriveProfileId("1 ")).toThrow();
		expect(toGoogleDriveProfileId("1")).toBe("1");
	});
});
