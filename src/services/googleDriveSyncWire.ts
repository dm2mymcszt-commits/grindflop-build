import z from "zod";
import {
	accountNamespaceSchema,
	deviceIdSchema,
	nonNegativeSafeIntegerSchema,
	packageIdSchema,
	positiveSafeIntegerSchema,
	sha256HexSchema,
} from "./cloudSync";
import {
	googleDriveEncryptedEnvelopeSchema,
	googleDrivePairingVaultKeySchema,
	type GoogleDriveEncryptedEnvelope,
} from "./googleDriveSyncNative";

export const GOOGLE_DRIVE_SYNC_WIRE_VERSION = 1 as const;
export const GOOGLE_DRIVE_SYNC_ANCHOR_KIND = "free-grind.sync.anchor" as const;
export const GOOGLE_DRIVE_SYNC_PAIRING_KIND = "free-grind.sync.pairing" as const;
export const GOOGLE_DRIVE_SYNC_PAIRING_CODE_PREFIX = "fgsync1." as const;

export const MAX_GOOGLE_DRIVE_SYNC_ANCHOR_BYTES = 4 * 1024;
export const MAX_GOOGLE_DRIVE_SYNC_PAIRING_CODE_BYTES = 8 * 1024;
export const MAX_GOOGLE_DRIVE_SYNC_PLAINTEXT_PACKAGE_BYTES = 3 * 1024 * 1024;
export const MAX_GOOGLE_DRIVE_SYNC_ENVELOPE_BYTES = 5 * 1024 * 1024;

const DECIMAL_PROFILE_ID_PATTERN = /^[1-9][0-9]{0,31}$/;
const SAFE_DRIVE_FILENAME_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;
const PACKAGE_FILENAME_SUFFIX_PATTERN = /^package-[a-f0-9]{64}\.bin$/;
const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function bootstrapHeadInvariant(value: {
	bootstrapSequenceEnd: number;
	bootstrapHeadDigest: string | null;
}): boolean {
	return value.bootstrapSequenceEnd === 0
		? value.bootstrapHeadDigest === null
		: value.bootstrapHeadDigest !== null;
}

export const googleDriveSyncAnchorV1Schema = z
	.object({
		kind: z.literal(GOOGLE_DRIVE_SYNC_ANCHOR_KIND),
		version: z.literal(GOOGLE_DRIVE_SYNC_WIRE_VERSION),
		accountNamespace: accountNamespaceSchema,
		bootstrapAuthorityDeviceId: deviceIdSchema,
		bootstrapSequenceEnd: nonNegativeSafeIntegerSchema,
		bootstrapHeadDigest: sha256HexSchema.nullable(),
		createdAtMs: nonNegativeSafeIntegerSchema,
	})
	.strict()
	.refine(bootstrapHeadInvariant, {
		message:
			"The bootstrap head digest must be null only when the sequence end is zero",
		path: ["bootstrapHeadDigest"],
	});

export const googleDriveSyncPairingSourceHeadV1Schema = z
	.object({
		sourceDeviceId: deviceIdSchema,
		sequenceEnd: positiveSafeIntegerSchema,
		contentDigest: sha256HexSchema,
	})
	.strict();

/**
 * This unreleased v1 format deliberately requires observedSourceHeads. Draft
 * codes created before that field existed are rejected rather than accepted
 * without a post-bootstrap rollback commitment.
 */
export const googleDriveSyncPairingCodeV1Schema = z
	.object({
		kind: z.literal(GOOGLE_DRIVE_SYNC_PAIRING_KIND),
		version: z.literal(GOOGLE_DRIVE_SYNC_WIRE_VERSION),
		profileId: z.string().regex(DECIMAL_PROFILE_ID_PATTERN),
		accountNamespace: accountNamespaceSchema,
		vaultKey: googleDrivePairingVaultKeySchema,
		bootstrapAuthorityDeviceId: deviceIdSchema,
		bootstrapSequenceEnd: nonNegativeSafeIntegerSchema,
		bootstrapHeadDigest: sha256HexSchema.nullable(),
		observedSourceHeads: z.array(googleDriveSyncPairingSourceHeadV1Schema),
	})
	.strict()
	.superRefine((value, context) => {
		if (!bootstrapHeadInvariant(value)) {
			context.addIssue({
				code: "custom",
				message:
					"The bootstrap head digest must be null only when the sequence end is zero",
				path: ["bootstrapHeadDigest"],
			});
		}
		let previousSourceDeviceId: string | null = null;
		for (let index = 0; index < value.observedSourceHeads.length; index += 1) {
			const head = value.observedSourceHeads[index];
			if (
				previousSourceDeviceId !== null &&
				head.sourceDeviceId <= previousSourceDeviceId
			) {
				context.addIssue({
					code: "custom",
					message:
						"Observed source heads must be unique and strictly ordered by source device ID",
					path: ["observedSourceHeads", index, "sourceDeviceId"],
				});
			}
			previousSourceDeviceId = head.sourceDeviceId;
		}
		if (value.bootstrapSequenceEnd > 0) {
			const authorityHead = value.observedSourceHeads.find(
				(head) => head.sourceDeviceId === value.bootstrapAuthorityDeviceId,
			);
			if (
				!authorityHead ||
				authorityHead.sequenceEnd < value.bootstrapSequenceEnd ||
				(authorityHead.sequenceEnd === value.bootstrapSequenceEnd &&
					authorityHead.contentDigest !== value.bootstrapHeadDigest)
			) {
				context.addIssue({
					code: "custom",
					message:
						"Observed source heads must include the bootstrap authority at or beyond its anchored cutoff",
					path: ["observedSourceHeads"],
				});
			}
		}
	});

export type GoogleDriveSyncAnchorV1 = z.infer<
	typeof googleDriveSyncAnchorV1Schema
>;
export type GoogleDriveSyncPairingSourceHeadV1 = z.infer<
	typeof googleDriveSyncPairingSourceHeadV1Schema
>;
export type GoogleDriveSyncPairingCodeV1 = z.infer<
	typeof googleDriveSyncPairingCodeV1Schema
>;
export type GoogleDriveSyncWireFileKind = "anchor" | "package";

function maximumBase64UrlLength(byteLength: number): number {
	return Math.floor((byteLength * 4 + 2) / 3);
}

function assertByteLimit(bytes: Uint8Array, limit: number, label: string): void {
	if (bytes.byteLength > limit) {
		throw new Error(`${label} exceeds the ${limit}-byte wire limit`);
	}
}

function wireError(message: string, cause: unknown): Error {
	const error = new Error(message) as Error & { cause?: unknown };
	error.cause = cause;
	return error;
}

function encodeBytesAsBase64Url(bytes: Uint8Array): string {
	let binary = "";
	const chunkSize = 0x8000;
	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
	}
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/u, "");
}

/** Strict, canonical base64url decoding without padding. */
export function decodeGoogleDriveSyncBase64Url(
	encoded: string,
	maxDecodedBytes = MAX_GOOGLE_DRIVE_SYNC_ENVELOPE_BYTES,
): Uint8Array {
	if (!Number.isSafeInteger(maxDecodedBytes) || maxDecodedBytes < 0) {
		throw new TypeError("The decoded-byte limit must be a non-negative safe integer");
	}
	if (
		encoded.length > maximumBase64UrlLength(maxDecodedBytes) ||
		(encoded.length > 0 && !/^[A-Za-z0-9_-]+$/.test(encoded)) ||
		encoded.length % 4 === 1
	) {
		throw new Error("The value is not canonical base64url without padding");
	}
	const padded = encoded.replace(/-/g, "+").replace(/_/g, "/") +
		"=".repeat((4 - (encoded.length % 4)) % 4);
	let binary: string;
	try {
		binary = atob(padded);
	} catch (error) {
		throw wireError("The value is not valid base64url", error);
	}
	if (binary.length > maxDecodedBytes) {
		throw new Error(`The decoded value exceeds ${maxDecodedBytes} bytes`);
	}
	const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
	if (encodeBytesAsBase64Url(bytes) !== encoded) {
		throw new Error("The value is not canonical base64url without padding");
	}
	return bytes;
}

export function encodeGoogleDriveSyncBase64Url(bytes: Uint8Array): string {
	return encodeBytesAsBase64Url(bytes);
}

export function encodeGoogleDriveSyncUtf8Base64Url(value: string): string {
	return encodeBytesAsBase64Url(UTF8_ENCODER.encode(value));
}

export function decodeGoogleDriveSyncUtf8Base64Url(
	encoded: string,
	maxDecodedBytes = MAX_GOOGLE_DRIVE_SYNC_ENVELOPE_BYTES,
): string {
	try {
		return UTF8_DECODER.decode(
			decodeGoogleDriveSyncBase64Url(encoded, maxDecodedBytes),
		);
	} catch (error) {
		throw wireError("The value is not canonical base64url UTF-8", error);
	}
}

function parseStrictJson(bytes: Uint8Array, label: string): unknown {
	let serialized: string;
	try {
		serialized = UTF8_DECODER.decode(bytes);
	} catch (error) {
		throw wireError(`${label} is not valid UTF-8`, error);
	}
	try {
		return JSON.parse(serialized) as unknown;
	} catch (error) {
		throw wireError(`${label} is not valid JSON`, error);
	}
}

export function encodeGoogleDriveSyncAnchor(
	anchor: GoogleDriveSyncAnchorV1,
): Uint8Array {
	const parsed = googleDriveSyncAnchorV1Schema.parse(anchor);
	const bytes = UTF8_ENCODER.encode(JSON.stringify(parsed));
	assertByteLimit(bytes, MAX_GOOGLE_DRIVE_SYNC_ANCHOR_BYTES, "The sync anchor");
	return bytes;
}

export function decodeGoogleDriveSyncAnchor(
	bytes: Uint8Array,
): GoogleDriveSyncAnchorV1 {
	assertByteLimit(bytes, MAX_GOOGLE_DRIVE_SYNC_ANCHOR_BYTES, "The sync anchor");
	return googleDriveSyncAnchorV1Schema.parse(parseStrictJson(bytes, "The sync anchor"));
}

async function vaultFingerprint(vaultKeyBase64: string): Promise<string> {
	const key = decodeGoogleDriveSyncBase64Url(vaultKeyBase64, 32);
	if (key.length !== 32) throw new Error("The pairing vault key must contain 32 bytes");
	if (!globalThis.crypto?.subtle) {
		throw new Error("Web Crypto SHA-256 is unavailable in this runtime");
	}
	const digest = new Uint8Array(
		await globalThis.crypto.subtle.digest("SHA-256", Uint8Array.from(key).buffer),
	);
	return encodeBytesAsBase64Url(digest.subarray(0, 8));
}

async function validatePairingFingerprint(
	pairing: GoogleDriveSyncPairingCodeV1,
): Promise<void> {
	if ((await vaultFingerprint(pairing.vaultKey.key)) !== pairing.vaultKey.fingerprint) {
		throw new Error("The pairing vault-key fingerprint is invalid");
	}
}

export async function encodeGoogleDriveSyncPairingCode(
	pairing: GoogleDriveSyncPairingCodeV1,
): Promise<string> {
	const parsed = googleDriveSyncPairingCodeV1Schema.parse(pairing);
	await validatePairingFingerprint(parsed);
	const bytes = UTF8_ENCODER.encode(JSON.stringify(parsed));
	assertByteLimit(
		bytes,
		MAX_GOOGLE_DRIVE_SYNC_PAIRING_CODE_BYTES,
		"The Google Drive pairing code",
	);
	return `${GOOGLE_DRIVE_SYNC_PAIRING_CODE_PREFIX}${encodeBytesAsBase64Url(bytes)}`;
}

export async function decodeGoogleDriveSyncPairingCode(
	code: string,
): Promise<GoogleDriveSyncPairingCodeV1> {
	if (!code.startsWith(GOOGLE_DRIVE_SYNC_PAIRING_CODE_PREFIX)) {
		throw new Error("This is not a GrindFlop Google Drive pairing code");
	}
	const bytes = decodeGoogleDriveSyncBase64Url(
		code.slice(GOOGLE_DRIVE_SYNC_PAIRING_CODE_PREFIX.length),
		MAX_GOOGLE_DRIVE_SYNC_PAIRING_CODE_BYTES,
	);
	const parsed = googleDriveSyncPairingCodeV1Schema.parse(
		parseStrictJson(bytes, "The Google Drive pairing code"),
	);
	await validatePairingFingerprint(parsed);
	return parsed;
}

/** Drive stores the native AES-GCM result as a strictly bounded JSON blob. */
export function encodeGoogleDriveSyncEncryptedEnvelope(
	envelope: GoogleDriveEncryptedEnvelope,
): Uint8Array {
	const parsed = googleDriveEncryptedEnvelopeSchema.parse(envelope);
	validateEncryptedEnvelopeEncoding(parsed);
	const bytes = UTF8_ENCODER.encode(JSON.stringify(parsed));
	assertByteLimit(
		bytes,
		MAX_GOOGLE_DRIVE_SYNC_ENVELOPE_BYTES,
		"The encrypted sync envelope",
	);
	return bytes;
}

export function decodeGoogleDriveSyncEncryptedEnvelope(
	bytes: Uint8Array,
): GoogleDriveEncryptedEnvelope {
	assertByteLimit(
		bytes,
		MAX_GOOGLE_DRIVE_SYNC_ENVELOPE_BYTES,
		"The encrypted sync envelope",
	);
	const parsed = googleDriveEncryptedEnvelopeSchema.parse(
		parseStrictJson(bytes, "The encrypted sync envelope"),
	);
	validateEncryptedEnvelopeEncoding(parsed);
	return parsed;
}

function validateEncryptedEnvelopeEncoding(
	envelope: GoogleDriveEncryptedEnvelope,
): void {
	const nonce = decodeGoogleDriveSyncBase64Url(envelope.nonce, 12);
	if (nonce.byteLength !== 12) {
		throw new Error("The encrypted sync envelope nonce must contain 12 bytes");
	}
	const ciphertext = decodeGoogleDriveSyncBase64Url(
		envelope.ciphertext,
		MAX_GOOGLE_DRIVE_SYNC_PLAINTEXT_PACKAGE_BYTES + 16,
	);
	if (ciphertext.byteLength < 16) {
		throw new Error("The encrypted sync envelope is missing its authentication tag");
	}
}

function domainSeparatedInput(domain: string, parts: readonly string[]): string {
	return ["free-grind.google-drive-wire.v1", domain, ...parts]
		.map((part) => `${UTF8_ENCODER.encode(part).byteLength}:${part}`)
		.join("|");
}

async function domainSeparatedSha256(
	domain: string,
	parts: readonly string[],
): Promise<string> {
	if (!globalThis.crypto?.subtle) {
		throw new Error("Web Crypto SHA-256 is unavailable in this runtime");
	}
	const digest = await globalThis.crypto.subtle.digest(
		"SHA-256",
		UTF8_ENCODER.encode(domainSeparatedInput(domain, parts)),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

/** Opaque account prefix; no profile ID, device ID, email, or package ID leaks. */
export async function googleDriveSyncNamespacePrefix(
	accountNamespace: string,
): Promise<string> {
	accountNamespaceSchema.parse(accountNamespace);
	const digest = await domainSeparatedSha256("namespace-prefix", [accountNamespace]);
	return `fgs-v1-${digest.slice(0, 48)}-`;
}

export async function googleDriveSyncAnchorFilename(
	accountNamespace: string,
): Promise<string> {
	accountNamespaceSchema.parse(accountNamespace);
	const [prefix, digest] = await Promise.all([
		googleDriveSyncNamespacePrefix(accountNamespace),
		domainSeparatedSha256("anchor-filename", [accountNamespace]),
	]);
	return `${prefix}anchor-${digest}.bin`;
}

export async function googleDriveSyncPackageFilename(input: Readonly<{
	accountNamespace: string;
	sourceDeviceId: string;
	packageId: string;
	contentDigest: string;
}>): Promise<string> {
	accountNamespaceSchema.parse(input.accountNamespace);
	deviceIdSchema.parse(input.sourceDeviceId);
	packageIdSchema.parse(input.packageId);
	sha256HexSchema.parse(input.contentDigest);
	const [prefix, digest] = await Promise.all([
		googleDriveSyncNamespacePrefix(input.accountNamespace),
		domainSeparatedSha256("package-filename", [
			input.accountNamespace,
			input.sourceDeviceId,
			input.packageId,
			input.contentDigest,
		]),
	]);
	return `${prefix}package-${digest}.bin`;
}

/** Exact account prefix plus an exact v1 anchor/package suffix shape. */
export async function classifyGoogleDriveSyncFilename(
	accountNamespace: string,
	filename: string,
): Promise<GoogleDriveSyncWireFileKind | null> {
	if (!SAFE_DRIVE_FILENAME_PATTERN.test(filename)) return null;
	const [prefix, anchorFilename] = await Promise.all([
		googleDriveSyncNamespacePrefix(accountNamespace),
		googleDriveSyncAnchorFilename(accountNamespace),
	]);
	if (filename === anchorFilename) return "anchor";
	if (!filename.startsWith(prefix)) return null;
	const suffix = filename.slice(prefix.length);
	return PACKAGE_FILENAME_SUFFIX_PATTERN.test(suffix) ? "package" : null;
}

export async function isGoogleDriveSyncNamespaceFilename(
	accountNamespace: string,
	filename: string,
): Promise<boolean> {
	return (await classifyGoogleDriveSyncFilename(accountNamespace, filename)) !== null;
}

/**
 * Authenticated metadata binds ciphertext to its wire kind, version, account,
 * and exact opaque Drive filename. The native layer additionally binds profileId.
 */
export async function googleDriveSyncAuthenticatedData(
	kind: GoogleDriveSyncWireFileKind,
	accountNamespace: string,
	filename: string,
): Promise<string> {
	const classified = await classifyGoogleDriveSyncFilename(accountNamespace, filename);
	if (classified !== kind) {
		throw new Error("The encrypted filename does not match its sync account and kind");
	}
	return domainSeparatedInput("authenticated-data", [
		String(GOOGLE_DRIVE_SYNC_WIRE_VERSION),
		kind,
		accountNamespace,
		filename,
	]);
}
