import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import z from "zod";

const DECIMAL_PROFILE_ID_PATTERN = /^[1-9][0-9]{0,31}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const OPTIONAL_BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;

const googleDriveNativeErrorCodeSchema = z.enum([
	"configuration",
	"invalidInput",
	"notConnected",
	"reauthenticationRequired",
	"secureStorage",
	"transport",
	"remote",
	"integrity",
	"conflict",
	"unsupported",
]);

export type GoogleDriveNativeErrorCode =
	| z.infer<typeof googleDriveNativeErrorCodeSchema>
	| "unknown";

export class GoogleDriveNativeError extends Error {
	readonly code: GoogleDriveNativeErrorCode;
	readonly cause?: unknown;

	constructor(
		code: GoogleDriveNativeErrorCode,
		message: string,
		options: Readonly<{ cause?: unknown }> = {},
	) {
		super(message);
		this.name = "GoogleDriveNativeError";
		this.code = code;
		this.cause = options.cause;
	}

	get requiresReauthentication(): boolean {
		return this.code === "reauthenticationRequired";
	}
}

const structuredNativeErrorSchema = z
	.object({
		code: googleDriveNativeErrorCodeSchema,
		message: z.string().min(1).max(8_192),
	})
	.strict();

function parseStructuredNativeError(value: unknown): GoogleDriveNativeError | undefined {
	const parsed = structuredNativeErrorSchema.safeParse(value);
	if (!parsed.success) return undefined;
	return new GoogleDriveNativeError(parsed.data.code, parsed.data.message, {
		cause: value,
	});
}

/** Converts every Tauri rejection shape into one stable, non-secret error type. */
export function normalizeGoogleDriveNativeError(error: unknown): GoogleDriveNativeError {
	if (error instanceof GoogleDriveNativeError) return error;

	const direct = parseStructuredNativeError(error);
	if (direct) return direct;

	if (typeof error === "string") {
		try {
			const parsed = parseStructuredNativeError(JSON.parse(error) as unknown);
			if (parsed) return parsed;
		} catch {
			// A plain rejection string is handled below without exposing object details.
		}
		return new GoogleDriveNativeError(
			"unknown",
			error.trim() || "The native Google Drive operation failed",
			{ cause: error },
		);
	}

	if (error instanceof Error) {
		return new GoogleDriveNativeError(
			"unknown",
			error.message || "The native Google Drive operation failed",
			{ cause: error },
		);
	}

	return new GoogleDriveNativeError(
		"unknown",
		"The native Google Drive operation failed",
		{ cause: error },
	);
}

export type GoogleDriveProfileId = string & {
	readonly __googleDriveProfileId: unique symbol;
};

/** Native credential records are keyed by canonical decimal profile strings. */
export function toGoogleDriveProfileId(profileId: number | string): GoogleDriveProfileId {
	const value = typeof profileId === "number" ? String(profileId) : profileId;
	if (
		!DECIMAL_PROFILE_ID_PATTERN.test(value) ||
		(typeof profileId === "number" &&
			(!Number.isSafeInteger(profileId) || profileId <= 0))
	) {
		throw new GoogleDriveNativeError(
			"invalidInput",
			"Google Drive sync requires a positive decimal profile ID",
		);
	}
	return value as GoogleDriveProfileId;
}

export const googleDriveConfigStatusSchema = z
	.object({
		platform: z.string().min(1).max(32),
		configured: z.boolean(),
		oauthSupported: z.boolean(),
		scope: z.literal("https://www.googleapis.com/auth/drive.appdata"),
		redirectMode: z.string().min(1).max(64),
		problem: z.string().min(1).max(8_192).nullable(),
	})
	.strict();

export const googleDriveVaultKeyInfoSchema = z
	.object({
		present: z.boolean(),
		fingerprint: z.string().length(11).regex(BASE64URL_PATTERN).nullable(),
	})
	.strict()
	.refine((value) => value.present === (value.fingerprint !== null), {
		message: "Vault-key presence and fingerprint must agree",
	});

export const googleDriveConnectionStatusSchema = z
	.object({
		connected: z.boolean(),
		googleAccountEmail: z.string().email().max(320).nullable(),
		canRefresh: z.boolean(),
		credentialExpiresAt: z.number().int().nonnegative().safe().nullable(),
		vaultKey: googleDriveVaultKeyInfoSchema,
	})
	.strict();

export const googleDrivePairingVaultKeySchema = z
	.object({
		encoding: z.literal("base64url-no-padding"),
		key: z.string().length(43).regex(BASE64URL_PATTERN),
		fingerprint: z.string().length(11).regex(BASE64URL_PATTERN),
	})
	.strict();

export const googleDriveEncryptedEnvelopeSchema = z
	.object({
		version: z.literal(1),
		algorithm: z.literal("A256GCM"),
		nonce: z.string().length(16).regex(BASE64URL_PATTERN),
		ciphertext: z.string().min(22).max(12 * 1024 * 1024).regex(BASE64URL_PATTERN),
	})
	.strict();

export const googleDriveFileMetadataSchema = z
	.object({
		id: z.string().min(1).max(256),
		name: z.string().min(1).max(200),
		mimeType: z.string().min(1).max(256).nullable(),
		size: z.string().regex(/^\d+$/).max(32).nullable(),
		modifiedTime: z.string().min(1).max(128).nullable(),
		md5Checksum: z.string().min(1).max(128).nullable(),
	})
	.strict();

const googleDriveFileListSchema = z
	.object({
		nextPageToken: z.string().min(1).max(4_096).nullable(),
		files: z.array(googleDriveFileMetadataSchema).max(1_000),
	})
	.strict();

const googleDriveStartPageTokenSchema = z
	.object({ startPageToken: z.string().min(1).max(4_096) })
	.strict();

const googleDriveChangeSchema = z
	.object({
		fileId: z.string().min(1).max(256),
		removed: z.boolean(),
		file: googleDriveFileMetadataSchema.nullable(),
	})
	.strict();

const googleDriveChangeListSchema = z
	.object({
		nextPageToken: z.string().min(1).max(4_096).nullable(),
		newStartPageToken: z.string().min(1).max(4_096).nullable(),
		changes: z.array(googleDriveChangeSchema).max(1_000),
	})
	.strict();

const googleDriveDownloadSchema = z
	.object({
		contentType: z.string().min(1).max(256).nullable(),
		dataBase64: z
			.string()
			.max(12 * 1024 * 1024)
			.regex(OPTIONAL_BASE64URL_PATTERN),
	})
	.strict();

export type GoogleDriveConfigStatus = z.infer<typeof googleDriveConfigStatusSchema>;
export type GoogleDriveConnectionStatus = z.infer<
	typeof googleDriveConnectionStatusSchema
>;
export type GoogleDriveVaultKeyInfo = z.infer<typeof googleDriveVaultKeyInfoSchema>;
export type GoogleDrivePairingVaultKey = z.infer<
	typeof googleDrivePairingVaultKeySchema
>;
export type GoogleDriveEncryptedEnvelope = z.infer<
	typeof googleDriveEncryptedEnvelopeSchema
>;
export type GoogleDriveFileMetadata = z.infer<typeof googleDriveFileMetadataSchema>;
export type GoogleDriveFileList = z.infer<typeof googleDriveFileListSchema>;
export type GoogleDriveStartPageToken = z.infer<
	typeof googleDriveStartPageTokenSchema
>;
export type GoogleDriveChange = z.infer<typeof googleDriveChangeSchema>;
export type GoogleDriveChangeList = z.infer<typeof googleDriveChangeListSchema>;
export type GoogleDriveDownload = z.infer<typeof googleDriveDownloadSchema>;

export type GoogleDriveNativeInvoke = (
	command: string,
	args?: Record<string, unknown>,
) => Promise<unknown>;

export interface GoogleDriveNativeBridge {
	configStatus(): Promise<GoogleDriveConfigStatus>;
	connectionStatus(profileId: GoogleDriveProfileId): Promise<GoogleDriveConnectionStatus>;
	connect(profileId: GoogleDriveProfileId): Promise<GoogleDriveConnectionStatus>;
	disconnect(profileId: GoogleDriveProfileId): Promise<void>;
	vaultKeyStatus(profileId: GoogleDriveProfileId): Promise<GoogleDriveVaultKeyInfo>;
	vaultKeyCreate(profileId: GoogleDriveProfileId): Promise<GoogleDriveVaultKeyInfo>;
	vaultKeyImport(
		profileId: GoogleDriveProfileId,
		keyBase64: string,
	): Promise<GoogleDriveVaultKeyInfo>;
	vaultKeyExportForPairing(
		profileId: GoogleDriveProfileId,
		acknowledgeSecretExposure: boolean,
	): Promise<GoogleDrivePairingVaultKey>;
	vaultKeyDelete(
		profileId: GoogleDriveProfileId,
		confirmLocalKeyRemoval: boolean,
	): Promise<void>;
	encrypt(
		profileId: GoogleDriveProfileId,
		plaintextBase64: string,
		aad: string,
	): Promise<GoogleDriveEncryptedEnvelope>;
	decrypt(
		profileId: GoogleDriveProfileId,
		envelope: GoogleDriveEncryptedEnvelope,
		aad: string,
	): Promise<string>;
	listAppData(
		profileId: GoogleDriveProfileId,
		pageToken?: string | null,
	): Promise<GoogleDriveFileList>;
	getStartPageToken(profileId: GoogleDriveProfileId): Promise<GoogleDriveStartPageToken>;
	listChanges(
		profileId: GoogleDriveProfileId,
		pageToken: string,
	): Promise<GoogleDriveChangeList>;
	downloadAppData(
		profileId: GoogleDriveProfileId,
		fileId: string,
	): Promise<GoogleDriveDownload>;
	createAppData(
		profileId: GoogleDriveProfileId,
		name: string,
		dataBase64: string,
	): Promise<GoogleDriveFileMetadata>;
	updateAppData(
		profileId: GoogleDriveProfileId,
		fileId: string,
		dataBase64: string,
		expectedEtag?: string | null,
	): Promise<GoogleDriveFileMetadata>;
	deleteAppData(
		profileId: GoogleDriveProfileId,
		fileId: string,
		confirmPermanentDelete: boolean,
	): Promise<void>;
}

function responseValidationError(command: string, error: unknown): GoogleDriveNativeError {
	return new GoogleDriveNativeError(
		"integrity",
		`The native response for ${command} failed validation`,
		{ cause: error },
	);
}

/** Creates an injectable bridge; production defaults to Tauri's invoke transport. */
export function createGoogleDriveNativeBridge(
	invoke: GoogleDriveNativeInvoke = tauriInvoke as GoogleDriveNativeInvoke,
): GoogleDriveNativeBridge {
	async function call<T>(
		command: string,
		args: Record<string, unknown> | undefined,
		schema: z.ZodType<T>,
	): Promise<T> {
		let result: unknown;
		try {
			result = await invoke(command, args);
		} catch (error) {
			throw normalizeGoogleDriveNativeError(error);
		}
		try {
			return schema.parse(result);
		} catch (error) {
			throw responseValidationError(command, error);
		}
	}

	async function callVoid(
		command: string,
		args: Record<string, unknown>,
	): Promise<void> {
		await call(command, args, z.null());
	}

	return {
		configStatus: () =>
			call("google_drive_config_status", undefined, googleDriveConfigStatusSchema),
		connectionStatus: (profileId) =>
			call(
				"google_drive_connection_status",
				{ profileId },
				googleDriveConnectionStatusSchema,
			),
		connect: (profileId) =>
			call("google_drive_connect", { profileId }, googleDriveConnectionStatusSchema),
		disconnect: (profileId) =>
			callVoid("google_drive_disconnect", { profileId }),
		vaultKeyStatus: (profileId) =>
			call(
				"google_drive_vault_key_status",
				{ profileId },
				googleDriveVaultKeyInfoSchema,
			),
		vaultKeyCreate: (profileId) =>
			call(
				"google_drive_vault_key_create",
				{ profileId },
				googleDriveVaultKeyInfoSchema,
			),
		vaultKeyImport: (profileId, keyBase64) =>
			call(
				"google_drive_vault_key_import",
				{ profileId, keyBase64 },
				googleDriveVaultKeyInfoSchema,
			),
		vaultKeyExportForPairing: (profileId, acknowledgeSecretExposure) =>
			call(
				"google_drive_vault_key_export_for_pairing",
				{ profileId, acknowledgeSecretExposure },
				googleDrivePairingVaultKeySchema,
			),
		vaultKeyDelete: (profileId, confirmLocalKeyRemoval) =>
			callVoid("google_drive_vault_key_delete", {
				profileId,
				confirmLocalKeyRemoval,
			}),
		encrypt: (profileId, plaintextBase64, aad) =>
			call(
				"google_drive_encrypt",
				{ profileId, plaintextBase64, aad },
				googleDriveEncryptedEnvelopeSchema,
			),
		decrypt: (profileId, envelope, aad) =>
			call(
				"google_drive_decrypt",
				{ profileId, envelope: googleDriveEncryptedEnvelopeSchema.parse(envelope), aad },
				z.string().max(12 * 1024 * 1024).regex(OPTIONAL_BASE64URL_PATTERN),
			),
		listAppData: (profileId, pageToken = null) =>
			call(
				"google_drive_list_app_data",
				{ profileId, pageToken },
				googleDriveFileListSchema,
			),
		getStartPageToken: (profileId) =>
			call(
				"google_drive_get_start_page_token",
				{ profileId },
				googleDriveStartPageTokenSchema,
			),
		listChanges: (profileId, pageToken) =>
			call(
				"google_drive_list_changes",
				{ profileId, pageToken },
				googleDriveChangeListSchema,
			),
		downloadAppData: (profileId, fileId) =>
			call(
				"google_drive_download_app_data",
				{ profileId, fileId },
				googleDriveDownloadSchema,
			),
		createAppData: (profileId, name, dataBase64) =>
			call(
				"google_drive_create_app_data",
				{ profileId, name, dataBase64 },
				googleDriveFileMetadataSchema,
			),
		updateAppData: (profileId, fileId, dataBase64, expectedEtag = null) =>
			call(
				"google_drive_update_app_data",
				{ profileId, fileId, dataBase64, expectedEtag },
				googleDriveFileMetadataSchema,
			),
		deleteAppData: (profileId, fileId, confirmPermanentDelete) =>
			callVoid("google_drive_delete_app_data", {
				profileId,
				fileId,
				confirmPermanentDelete,
			}),
	};
}

export const googleDriveNative = createGoogleDriveNativeBridge();
