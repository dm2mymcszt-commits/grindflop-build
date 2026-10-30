import { describe, expect, test } from "bun:test";
import {
	GOOGLE_DRIVE_SYNC_ANCHOR_KIND,
	GOOGLE_DRIVE_SYNC_PAIRING_KIND,
	GOOGLE_DRIVE_SYNC_WIRE_VERSION,
	MAX_GOOGLE_DRIVE_SYNC_ENVELOPE_BYTES,
	classifyGoogleDriveSyncFilename,
	decodeGoogleDriveSyncAnchor,
	decodeGoogleDriveSyncBase64Url,
	decodeGoogleDriveSyncEncryptedEnvelope,
	decodeGoogleDriveSyncPairingCode,
	decodeGoogleDriveSyncUtf8Base64Url,
	encodeGoogleDriveSyncAnchor,
	encodeGoogleDriveSyncBase64Url,
	encodeGoogleDriveSyncEncryptedEnvelope,
	encodeGoogleDriveSyncPairingCode,
	encodeGoogleDriveSyncUtf8Base64Url,
	googleDriveSyncAnchorFilename,
	googleDriveSyncAuthenticatedData,
	googleDriveSyncNamespacePrefix,
	googleDriveSyncPackageFilename,
	isGoogleDriveSyncNamespaceFilename,
	type GoogleDriveSyncAnchorV1,
	type GoogleDriveSyncPairingCodeV1,
} from "../src/services/googleDriveSyncWire";

const ACCOUNT = "acct-profile-123";
const DEVICE = "device-windows-primary";
const DIGEST = "a".repeat(64);

async function pairingKey() {
	const key = new Uint8Array(32);
	const digest = new Uint8Array(
		await crypto.subtle.digest("SHA-256", Uint8Array.from(key).buffer),
	);
	return {
		encoding: "base64url-no-padding" as const,
		key: encodeGoogleDriveSyncBase64Url(key),
		fingerprint: encodeGoogleDriveSyncBase64Url(digest.subarray(0, 8)),
	};
}

describe("Google Drive encrypted wire format", () => {
	test("round-trips strict UTF-8, anchor, pairing, and envelope values", async () => {
		const message = "Free Grind — encrypted 🔐";
		expect(
			decodeGoogleDriveSyncUtf8Base64Url(
				encodeGoogleDriveSyncUtf8Base64Url(message),
			),
		).toBe(message);

		const anchor: GoogleDriveSyncAnchorV1 = {
			kind: GOOGLE_DRIVE_SYNC_ANCHOR_KIND,
			version: GOOGLE_DRIVE_SYNC_WIRE_VERSION,
			accountNamespace: ACCOUNT,
			bootstrapAuthorityDeviceId: DEVICE,
			bootstrapSequenceEnd: 7,
			bootstrapHeadDigest: DIGEST,
			createdAtMs: 123,
		};
		expect(decodeGoogleDriveSyncAnchor(encodeGoogleDriveSyncAnchor(anchor))).toEqual(
			anchor,
		);

		const pairing: GoogleDriveSyncPairingCodeV1 = {
			kind: GOOGLE_DRIVE_SYNC_PAIRING_KIND,
			version: GOOGLE_DRIVE_SYNC_WIRE_VERSION,
			profileId: "12345",
			accountNamespace: ACCOUNT,
			vaultKey: await pairingKey(),
			bootstrapAuthorityDeviceId: DEVICE,
			bootstrapSequenceEnd: 7,
			bootstrapHeadDigest: DIGEST,
			observedSourceHeads: [
				{ sourceDeviceId: DEVICE, sequenceEnd: 7, contentDigest: DIGEST },
			],
		};
		const code = await encodeGoogleDriveSyncPairingCode(pairing);
		expect(await decodeGoogleDriveSyncPairingCode(code)).toEqual(pairing);
		expect(code).not.toContain("token");
		expect(code).not.toContain("@");

		const envelope = {
			version: 1 as const,
			algorithm: "A256GCM" as const,
			nonce: encodeGoogleDriveSyncBase64Url(new Uint8Array(12)),
			ciphertext: encodeGoogleDriveSyncBase64Url(new Uint8Array(16)),
		};
		expect(
			decodeGoogleDriveSyncEncryptedEnvelope(
				encodeGoogleDriveSyncEncryptedEnvelope(envelope),
			),
		).toEqual(envelope);
	});

	test("rejects malformed, non-canonical, smuggled, mismatched, and oversized input", async () => {
		expect(() => decodeGoogleDriveSyncBase64Url("A=", 10)).toThrow();
		expect(() => decodeGoogleDriveSyncBase64Url("A", 10)).toThrow();
		expect(() => decodeGoogleDriveSyncUtf8Base64Url("_w", 1)).toThrow();
		expect(() =>
			decodeGoogleDriveSyncEncryptedEnvelope(
				new TextEncoder().encode(
					JSON.stringify({
						version: 1,
						algorithm: "A256GCM",
						nonce: "A".repeat(16),
						ciphertext: "A".repeat(22),
						accessToken: "smuggled",
					}),
				),
			),
		).toThrow();
		expect(() =>
			decodeGoogleDriveSyncEncryptedEnvelope(
				new TextEncoder().encode(
					JSON.stringify({
						version: 1,
						algorithm: "A256GCM",
						nonce: "A".repeat(16),
						ciphertext: `${"A".repeat(21)}B`,
					}),
				),
			),
		).toThrow();
		expect(() =>
			decodeGoogleDriveSyncEncryptedEnvelope(
				new Uint8Array(MAX_GOOGLE_DRIVE_SYNC_ENVELOPE_BYTES + 1),
			),
		).toThrow();

		const badPairing = {
			kind: GOOGLE_DRIVE_SYNC_PAIRING_KIND,
			version: GOOGLE_DRIVE_SYNC_WIRE_VERSION,
			profileId: "001",
			accountNamespace: ACCOUNT,
			vaultKey: await pairingKey(),
			bootstrapAuthorityDeviceId: DEVICE,
			bootstrapSequenceEnd: 0,
			bootstrapHeadDigest: DIGEST,
			observedSourceHeads: [],
		};
		await expect(
			encodeGoogleDriveSyncPairingCode(
				badPairing as unknown as GoogleDriveSyncPairingCodeV1,
			),
		).rejects.toBeDefined();

		const fingerprintMismatch: GoogleDriveSyncPairingCodeV1 = {
			...badPairing,
			profileId: "1",
			bootstrapSequenceEnd: 1,
			observedSourceHeads: [
				{ sourceDeviceId: DEVICE, sequenceEnd: 1, contentDigest: DIGEST },
			],
			vaultKey: { ...(await pairingKey()), fingerprint: "AAAAAAAAAAA" },
		};
		await expect(
			encodeGoogleDriveSyncPairingCode(fingerprintMismatch),
		).rejects.toThrow("fingerprint");

		const unsortedHeads: GoogleDriveSyncPairingCodeV1 = {
			...fingerprintMismatch,
			vaultKey: await pairingKey(),
			bootstrapAuthorityDeviceId: "device-a",
			bootstrapSequenceEnd: 0,
			bootstrapHeadDigest: null,
			observedSourceHeads: [
				{ sourceDeviceId: "device-b", sequenceEnd: 1, contentDigest: DIGEST },
				{ sourceDeviceId: "device-a", sequenceEnd: 1, contentDigest: DIGEST },
			],
		};
		await expect(encodeGoogleDriveSyncPairingCode(unsortedHeads)).rejects.toThrow(
			"strictly ordered",
		);

		const { observedSourceHeads: _omitted, ...draftWithoutHeads } = unsortedHeads;
		void _omitted;
		await expect(
			encodeGoogleDriveSyncPairingCode(
				draftWithoutHeads as unknown as GoogleDriveSyncPairingCodeV1,
			),
		).rejects.toBeDefined();
	});

	test("derives opaque deterministic names and filters the exact namespace", async () => {
		const prefix = await googleDriveSyncNamespacePrefix(ACCOUNT);
		const anchor = await googleDriveSyncAnchorFilename(ACCOUNT);
		const packageName = await googleDriveSyncPackageFilename({
			accountNamespace: ACCOUNT,
			sourceDeviceId: DEVICE,
			packageId: "pkg-one",
			contentDigest: DIGEST,
		});
		expect(prefix).not.toContain(ACCOUNT);
		expect(packageName).not.toContain(DEVICE);
		expect(packageName).not.toContain("pkg-one");
		expect(
			await googleDriveSyncPackageFilename({
				accountNamespace: ACCOUNT,
				sourceDeviceId: DEVICE,
				packageId: "pkg-one",
				contentDigest: DIGEST,
			}),
		).toBe(packageName);
		expect(await classifyGoogleDriveSyncFilename(ACCOUNT, anchor)).toBe("anchor");
		expect(await classifyGoogleDriveSyncFilename(ACCOUNT, packageName)).toBe(
			"package",
		);
		expect(await isGoogleDriveSyncNamespaceFilename(ACCOUNT, `${packageName}.old`)).toBe(
			false,
		);
		expect(
			await isGoogleDriveSyncNamespaceFilename("acct-profile-12", packageName),
		).toBe(false);

		const aad = await googleDriveSyncAuthenticatedData(
			"package",
			ACCOUNT,
			packageName,
		);
		expect(aad).toContain("authenticated-data");
		expect(aad).toContain(ACCOUNT);
		expect(aad).toContain(packageName);
		await expect(
			googleDriveSyncAuthenticatedData("anchor", ACCOUNT, packageName),
		).rejects.toThrow();
	});
});
