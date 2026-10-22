import { describe, expect, test } from "bun:test";
import {
	createSyncOperation,
	createSyncPackage,
	serializeSyncPackage,
	type ApplySyncPackageResult,
	type ImmutableSyncOperation,
	type SyncPackage,
} from "../src/services/cloudSync";
import {
	createGoogleDriveSyncControllerAdapter,
	type GoogleDriveSyncControllerStore,
} from "../src/services/googleDriveSyncController";
import {
	GoogleDriveNativeError,
	type GoogleDriveConnectionStatus,
	type GoogleDriveEncryptedEnvelope,
	type GoogleDriveFileMetadata,
	type GoogleDriveNativeBridge,
	type GoogleDrivePairingVaultKey,
	type GoogleDriveProfileId,
	type GoogleDriveVaultKeyInfo,
} from "../src/services/googleDriveSyncNative";
import type {
	CachedRemotePackageHeader,
	GoogleDriveSyncBootstrapState,
	GoogleDriveSyncInboundHead,
	GoogleDriveSyncStoreConfig,
	OutboundGoogleDriveSyncPackage,
} from "../src/services/googleDriveSyncStore";
import {
	GOOGLE_DRIVE_SYNC_ANCHOR_KIND,
	GOOGLE_DRIVE_SYNC_PAIRING_KIND,
	GOOGLE_DRIVE_SYNC_WIRE_VERSION,
	decodeGoogleDriveSyncBase64Url,
	decodeGoogleDriveSyncPairingCode,
	encodeGoogleDriveSyncAnchor,
	encodeGoogleDriveSyncBase64Url,
	encodeGoogleDriveSyncEncryptedEnvelope,
	encodeGoogleDriveSyncPairingCode,
	googleDriveSyncAnchorFilename,
	googleDriveSyncAuthenticatedData,
	googleDriveSyncPackageFilename,
	type GoogleDriveSyncAnchorV1,
} from "../src/services/googleDriveSyncWire";

const PROFILE_ID = 42;
const ACCOUNT = "account-test-42";
const LOCAL_DEVICE = "device-windows-local";
const AUTHORITY_DEVICE = "device-windows-authority";
const ZERO_DIGEST = "0".repeat(64);
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

type FakeFile = {
	metadata: GoogleDriveFileMetadata;
	body: string;
};

async function pairingVaultKey(): Promise<GoogleDrivePairingVaultKey> {
	const key = new Uint8Array(32);
	const digest = new Uint8Array(
		await crypto.subtle.digest("SHA-256", Uint8Array.from(key).buffer),
	);
	return {
		encoding: "base64url-no-padding",
		key: encodeGoogleDriveSyncBase64Url(key),
		fingerprint: encodeGoogleDriveSyncBase64Url(digest.subarray(0, 8)),
	};
}

function metadata(id: string, name: string): GoogleDriveFileMetadata {
	return {
		id,
		name,
		mimeType: "application/octet-stream",
		size: null,
		modifiedTime: null,
		md5Checksum: null,
	};
}

class FakeNative implements GoogleDriveNativeBridge {
	readonly events: string[];
	readonly files: FakeFile[] = [];
	platform = "windows";
	configured = true;
	oauthSupported = true;
	connected = true;
	connectCalls = 0;
	connectFailure: Error | null = null;
	vaultKey: GoogleDrivePairingVaultKey;
	vaultPresent = true;
	pageSize = 1000;
	uncertainCreateOnce = false;
	listFailuresRemaining = 0;
	downloadFailuresRemaining = 0;
	repeatPaginationToken = false;
	deleteFailuresRemaining = new Map<string, number>();
	afterDelete?: (fileId: string) => void | Promise<void>;
	afterCreate?: (created: GoogleDriveFileMetadata) => void | Promise<void>;
	createCalls: string[] = [];
	deleteCalls: string[] = [];
	readonly #authenticatedDataByCiphertext = new Map<string, string>();
	#nextFileId = 1;

	private constructor(vaultKey: GoogleDrivePairingVaultKey, events: string[]) {
		this.vaultKey = vaultKey;
		this.events = events;
	}

	static async create(events: string[] = []): Promise<FakeNative> {
		return new FakeNative(await pairingVaultKey(), events);
	}

	async configStatus() {
		return {
			platform: this.platform,
			configured: this.configured,
			oauthSupported: this.oauthSupported,
			scope: "https://www.googleapis.com/auth/drive.appdata" as const,
			redirectMode: this.oauthSupported ? "loopback" : "unsupported",
			problem:
				this.configured && this.oauthSupported
					? null
					: "Google Drive OAuth is unavailable on this platform.",
		};
	}

	async connectionStatus(_profileId: GoogleDriveProfileId) {
		return this.#connection();
	}

	async connect(_profileId: GoogleDriveProfileId) {
		this.connectCalls += 1;
		if (this.connectFailure) throw this.connectFailure;
		this.connected = true;
		return this.#connection();
	}

	async disconnect(_profileId: GoogleDriveProfileId): Promise<void> {
		this.events.push("disconnect");
		this.connected = false;
	}

	async vaultKeyStatus(_profileId: GoogleDriveProfileId): Promise<GoogleDriveVaultKeyInfo> {
		return this.#vaultInfo();
	}

	async vaultKeyCreate(_profileId: GoogleDriveProfileId): Promise<GoogleDriveVaultKeyInfo> {
		this.events.push("vault-create");
		this.vaultPresent = true;
		return this.#vaultInfo();
	}

	async vaultKeyImport(
		_profileId: GoogleDriveProfileId,
		keyBase64: string,
	): Promise<GoogleDriveVaultKeyInfo> {
		this.events.push("vault-import");
		if (keyBase64 !== this.vaultKey.key) {
			throw new GoogleDriveNativeError("conflict", "different key");
		}
		this.vaultPresent = true;
		return this.#vaultInfo();
	}

	async vaultKeyExportForPairing(
		_profileId: GoogleDriveProfileId,
		_acknowledgeSecretExposure: boolean,
	): Promise<GoogleDrivePairingVaultKey> {
		return this.vaultKey;
	}

	async vaultKeyDelete(
		_profileId: GoogleDriveProfileId,
		_confirmLocalKeyRemoval: boolean,
	): Promise<void> {
		this.events.push("vault-delete");
		this.vaultPresent = false;
	}

	async encrypt(
		_profileId: GoogleDriveProfileId,
		plaintextBase64: string,
		aad: string,
	): Promise<GoogleDriveEncryptedEnvelope> {
		const envelope = {
			version: 1,
			algorithm: "A256GCM",
			nonce: encodeGoogleDriveSyncBase64Url(new Uint8Array(12)),
			ciphertext: encodeGoogleDriveSyncBase64Url(textEncoder.encode(plaintextBase64)),
		} as const;
		this.#authenticatedDataByCiphertext.set(envelope.ciphertext, aad);
		return envelope;
	}

	async decrypt(
		_profileId: GoogleDriveProfileId,
		envelope: GoogleDriveEncryptedEnvelope,
		aad: string,
	): Promise<string> {
		const expected = this.#authenticatedDataByCiphertext.get(envelope.ciphertext);
		if (expected && expected !== aad) {
			throw new GoogleDriveNativeError(
				"crypto",
				"The encrypted file failed authenticated filename verification",
			);
		}
		return textDecoder.decode(decodeGoogleDriveSyncBase64Url(envelope.ciphertext));
	}

	async listAppData(_profileId: GoogleDriveProfileId, pageToken?: string | null) {
		this.events.push("list");
		if (this.listFailuresRemaining > 0) {
			this.listFailuresRemaining -= 1;
			throw new GoogleDriveNativeError("transport", "injected transient list failure");
		}
		if (this.repeatPaginationToken) {
			return {
				files: pageToken ? [] : this.files.slice(0, 1).map((file) => file.metadata),
				nextPageToken: "repeated-token",
			};
		}
		const start = pageToken ? Number(pageToken) : 0;
		const next = start + this.pageSize;
		return {
			files: this.files.slice(start, next).map((file) => file.metadata),
			nextPageToken: next < this.files.length ? String(next) : null,
		};
	}

	async getStartPageToken(_profileId: GoogleDriveProfileId) {
		return { startPageToken: "unused" };
	}

	async listChanges(_profileId: GoogleDriveProfileId, _pageToken: string) {
		return { nextPageToken: null, newStartPageToken: "unused", changes: [] };
	}

	async downloadAppData(_profileId: GoogleDriveProfileId, fileId: string) {
		this.events.push(`download:${fileId}`);
		if (this.downloadFailuresRemaining > 0) {
			this.downloadFailuresRemaining -= 1;
			throw new GoogleDriveNativeError(
				"remote",
				"injected transient download failure",
			);
		}
		const file = this.files.find((candidate) => candidate.metadata.id === fileId);
		if (!file) throw new GoogleDriveNativeError("remote", "missing fake file");
		return { contentType: "application/octet-stream", dataBase64: file.body };
	}

	async createAppData(
		_profileId: GoogleDriveProfileId,
		name: string,
		dataBase64: string,
	): Promise<GoogleDriveFileMetadata> {
		this.events.push(`create:${name.includes("anchor-") ? "anchor" : "package"}`);
		this.createCalls.push(name);
		const created = metadata(`remote-${this.#nextFileId++}`, name);
		this.files.push({ metadata: created, body: dataBase64 });
		await this.afterCreate?.(created);
		if (this.uncertainCreateOnce) {
			this.uncertainCreateOnce = false;
			throw new GoogleDriveNativeError("transport", "response lost");
		}
		return created;
	}

	async updateAppData(): Promise<GoogleDriveFileMetadata> {
		throw new Error("Immutable sync files must never be updated");
	}

	async deleteAppData(
		_profileId: GoogleDriveProfileId,
		fileId: string,
		_confirmPermanentDelete: boolean,
	): Promise<void> {
		this.events.push(`delete:${fileId}`);
		this.deleteCalls.push(fileId);
		const failuresRemaining = this.deleteFailuresRemaining.get(fileId) ?? 0;
		if (failuresRemaining > 0) {
			this.deleteFailuresRemaining.set(fileId, failuresRemaining - 1);
			throw new GoogleDriveNativeError("remote", "injected delete failure");
		}
		const index = this.files.findIndex((file) => file.metadata.id === fileId);
		if (index >= 0) this.files.splice(index, 1);
		await this.afterDelete?.(fileId);
	}

	async seedAnchor(anchor: GoogleDriveSyncAnchorV1, id = "anchor-id"): Promise<void> {
		const name = await googleDriveSyncAnchorFilename(anchor.accountNamespace);
		const aad = await googleDriveSyncAuthenticatedData(
			"anchor",
			anchor.accountNamespace,
			name,
		);
		const envelope = await this.encrypt(
			String(PROFILE_ID) as GoogleDriveProfileId,
			encodeGoogleDriveSyncBase64Url(encodeGoogleDriveSyncAnchor(anchor)),
			aad,
		);
		this.files.push({
			metadata: metadata(id, name),
			body: encodeGoogleDriveSyncBase64Url(
				encodeGoogleDriveSyncEncryptedEnvelope(envelope),
			),
		});
	}

	async seedPackage(syncPackage: SyncPackage, id = `package-${this.#nextFileId++}`) {
		const name = await googleDriveSyncPackageFilename({
			accountNamespace: syncPackage.accountNamespace,
			sourceDeviceId: syncPackage.sourceDeviceId,
			packageId: syncPackage.packageId,
			contentDigest: syncPackage.contentDigest,
		});
		const aad = await googleDriveSyncAuthenticatedData(
			"package",
			syncPackage.accountNamespace,
			name,
		);
		const envelope = await this.encrypt(
			String(PROFILE_ID) as GoogleDriveProfileId,
			encodeGoogleDriveSyncBase64Url(
				textEncoder.encode(serializeSyncPackage(syncPackage)),
			),
			aad,
		);
		this.files.push({
			metadata: metadata(id, name),
			body: encodeGoogleDriveSyncBase64Url(
				encodeGoogleDriveSyncEncryptedEnvelope(envelope),
			),
		});
	}

	#vaultInfo(): GoogleDriveVaultKeyInfo {
		return {
			present: this.vaultPresent,
			fingerprint: this.vaultPresent ? this.vaultKey.fingerprint : null,
		};
	}

	#connection(): GoogleDriveConnectionStatus {
		return {
			connected: this.connected,
			googleAccountEmail: this.connected ? "person@example.com" : null,
			canRefresh: this.connected,
			credentialExpiresAt: null,
			vaultKey: this.#vaultInfo(),
		};
	}
}

class FakeStore implements GoogleDriveSyncControllerStore {
	readonly events: string[];
	closed = false;
	boundDeviceId: string | null;
	bindCalls: string[] = [];
	config: GoogleDriveSyncStoreConfig;
	bootstrap: GoogleDriveSyncBootstrapState;
	localSequence = 0;
	pending: OutboundGoogleDriveSyncPackage[] = [];
	inboundHeads: GoogleDriveSyncInboundHead[] = [];
	uploaded = new Map<string, string>();
	applied = new Set<string>();
	appliedDigests = new Map<string, string>();
	applyOptions: unknown[] = [];
	failAfterApplyOnce = false;
	supersedeCalls: Array<{
		entityId: string;
		maxOriginSequence: number;
	}> = [];
	onReconcile?: () => void | Promise<void>;
	onUpdateConfig?: (patch: Partial<GoogleDriveSyncStoreConfig>) => void | Promise<void>;
	onCommitInboundHeads?: () => void | Promise<void>;

	constructor(
		events: string[] = [],
		options: Partial<{
			config: GoogleDriveSyncStoreConfig;
			bootstrap: GoogleDriveSyncBootstrapState;
			boundDeviceId: string | null;
		}> = {},
	) {
		this.events = events;
		this.config =
			options.config ??
			({
				enabled: false,
				accountNamespace: null,
				mediaPolicy: "off",
				lastSuccessfulSyncAt: null,
				lastError: null,
			} as const);
		this.bootstrap =
			options.bootstrap ??
			({
				authorityDeviceId: null,
				authoritySequenceEnd: 0,
				authorityHeadDigest: null,
				bootstrapPending: false,
				anchorRequired: false,
				localBaselineSequence: null,
			} as const);
		this.boundDeviceId =
			options.boundDeviceId !== undefined
				? options.boundDeviceId
				: this.config.accountNamespace !== null || this.bootstrap.authorityDeviceId !== null
					? LOCAL_DEVICE
					: null;
	}

	async close(): Promise<void> {
		this.closed = true;
		this.events.push("store-close");
	}

	async getLocalSourceDeviceId() {
		return this.boundDeviceId;
	}

	async hasPriorLocalSyncState() {
		return (
			this.config.accountNamespace !== null ||
			this.bootstrap.authorityDeviceId !== null ||
			this.localSequence > 0 ||
			this.pending.length > 0 ||
			this.inboundHeads.length > 0
		);
	}

	async bindLocalSourceDeviceId(sourceDeviceId: string) {
		this.bindCalls.push(sourceDeviceId);
		const legacySources = new Set(
			this.pending.map((outbound) => outbound.syncPackage.sourceDeviceId),
		);
		if (
			legacySources.size > 1 ||
			(legacySources.size === 1 && !legacySources.has(sourceDeviceId))
		) {
			throw new Error("The Google Drive sync store contains a different local source identity");
		}
		if (this.boundDeviceId === null) {
			this.boundDeviceId = sourceDeviceId;
			this.events.push(`bind:${sourceDeviceId}`);
		}
		if (this.boundDeviceId !== sourceDeviceId) {
			throw new Error("The browser and Google Drive sync store device ids conflict");
		}
		return this.boundDeviceId;
	}

	async getConfig() {
		return this.config;
	}

	async updateConfig(patch: Partial<GoogleDriveSyncStoreConfig>) {
		this.events.push(`config:${patch.accountNamespace ?? "unchanged"}:${String(patch.enabled)}`);
		await this.onUpdateConfig?.(patch);
		this.config = { ...this.config, ...patch };
		return this.config;
	}

	async getBootstrapState() {
		return this.bootstrap;
	}

	async updateBootstrapState(patch: Partial<GoogleDriveSyncBootstrapState>) {
		this.events.push(
			`bootstrap:${String(patch.bootstrapPending)}:${String(patch.localBaselineSequence)}`,
		);
		this.bootstrap = { ...this.bootstrap, ...patch };
		return this.bootstrap;
	}

	async getOutboundHead(_accountNamespace: string, _sourceDeviceId: string) {
		const uploaded = this.pending
			.filter((outbound) => this.uploaded.has(outbound.syncPackage.packageId))
			.sort(
				(left, right) =>
					right.syncPackage.sequenceRange.end - left.syncPackage.sequenceRange.end,
			)[0];
		return uploaded
			? {
					sequenceEnd: uploaded.syncPackage.sequenceRange.end,
					contentDigest: uploaded.syncPackage.contentDigest,
				}
			: null;
	}

	async commitInboundHeads(
		_accountNamespace: string,
		heads: readonly GoogleDriveSyncInboundHead[],
	) {
		this.events.push(`commit-heads:${heads.length}`);
		for (const head of heads) {
			const index = this.inboundHeads.findIndex(
				(existing) => existing.sourceDeviceId === head.sourceDeviceId,
			);
			const existing = this.inboundHeads[index];
			if (
				existing?.sequenceEnd === head.sequenceEnd &&
				existing.contentDigest !== head.contentDigest
			) {
				throw new Error("conflicting fake remote-head commitment");
			}
			if (!existing) this.inboundHeads.push(head);
			else if (head.sequenceEnd > existing.sequenceEnd) this.inboundHeads[index] = head;
		}
		await this.onCommitInboundHeads?.();
		return this.inboundHeads;
	}

	async listInboundHeads() {
		return this.inboundHeads;
	}

	async getLocalOriginSequence(_accountNamespace: string, _sourceDeviceId: string) {
		return this.localSequence;
	}

	reconcileScopes: (string | undefined)[] = [];

	async reconcileCurrentData(input?: { contactScope?: string }) {
		this.reconcileScopes.push(input?.contactScope);
		this.events.push("reconcile");
		await this.onReconcile?.();
		return {
			createdUpserts: 0,
			createdTombstones: 0,
			unchangedEntities: 0,
			firstSequence: null,
			lastSequence: null,
		};
	}

	readonly remotePackageCache = new Map<string, string>();
	bodyReads = 0;

	async readCachedRemotePackages(_namespace: string, keys: readonly string[]) {
		const found = new Map<string, string>();
		for (const key of keys) {
			const body = this.remotePackageCache.get(key);
			if (body !== undefined) {
				this.bodyReads += 1;
				found.set(key, body);
			}
		}
		return found;
	}

	// Mirrors the real store's json_extract: fields as stored, missing ones null.
	async readCachedRemotePackageHeaders(_namespace: string, keys: readonly string[]) {
		const found = new Map<string, CachedRemotePackageHeader>();
		for (const key of keys) {
			const body = this.remotePackageCache.get(key);
			if (body === undefined) continue;
			let value: Record<string, unknown> = {};
			try {
				value = JSON.parse(body) as Record<string, unknown>;
			} catch {
				continue;
			}
			const range = (value.sequenceRange ?? {}) as Record<string, unknown>;
			found.set(key, {
				packageId: value.packageId ?? null,
				accountNamespace: value.accountNamespace ?? null,
				sourceDeviceId: value.sourceDeviceId ?? null,
				sequenceStart: range.start ?? null,
				sequenceEnd: range.end ?? null,
				contentDigest: value.contentDigest ?? null,
				previousPackageDigest: value.previousPackageDigest ?? null,
			});
		}
		return found;
	}

	async writeCachedRemotePackages(
		_namespace: string,
		entries: readonly { cacheKey: string; serialized: string }[],
	) {
		for (const entry of entries) {
			this.remotePackageCache.set(entry.cacheKey, entry.serialized);
		}
	}

	async pruneCachedRemotePackages(_namespace: string, live: readonly string[]) {
		const keep = new Set(live);
		for (const key of [...this.remotePackageCache.keys()]) {
			if (!keep.has(key)) this.remotePackageCache.delete(key);
		}
	}

	clearedAccountNamespaces: string[] = [];

	async clearAccountState(accountNamespace: string) {
		this.clearedAccountNamespaces.push(accountNamespace);
		this.events.push("clear-account-state");
		this.pending.length = 0;
	}

	async getPendingCounts() {
		const outstanding = this.pending.filter(
			(outbound) => !this.uploaded.has(outbound.syncPackage.packageId),
		);
		return { changes: outstanding.length, bytes: outstanding.length * 100 };
	}

	async supersedeUnuploadedEntityOperations(input: {
		entityId: string;
		maxOriginSequence: number;
	}) {
		this.events.push(`supersede:${input.entityId}`);
		this.supersedeCalls.push({
			entityId: input.entityId,
			maxOriginSequence: input.maxOriginSequence,
		});
		return 1;
	}

	async createNextOutboundPackage() {
		this.events.push("stage");
		return null;
	}

	async listPendingOutboundPackages() {
		return this.pending.filter(
			(outbound) => !this.uploaded.has(outbound.syncPackage.packageId),
		);
	}

	async markOutboundPackageUploaded(packageId: string, remoteFileId: string) {
		this.events.push(`mark:${packageId}`);
		this.uploaded.set(packageId, remoteFileId);
	}

	async applyIncomingPackage(
		input: unknown,
		options?: unknown,
	): Promise<ApplySyncPackageResult> {
		const syncPackage = input as SyncPackage;
		this.events.push(`apply:${syncPackage.sourceDeviceId}:${syncPackage.sequenceRange.end}`);
		this.applyOptions.push(options);
		const duplicate = this.applied.has(syncPackage.packageId);
		this.applied.add(syncPackage.packageId);
		this.appliedDigests.set(syncPackage.packageId, syncPackage.contentDigest);
		if (this.failAfterApplyOnce) {
			this.failAfterApplyOnce = false;
			throw new Error("injected crash after durable apply receipt");
		}
		return {
			packageId: syncPackage.packageId,
			contentDigest: syncPackage.contentDigest,
			appliedOperations: duplicate ? 0 : syncPackage.operations.length,
			duplicateOperations: duplicate ? syncPackage.operations.length : 0,
			alreadyApplied: duplicate,
			sequenceEnd: syncPackage.sequenceRange.end,
		};
	}
}

async function operation(
	accountNamespace: string,
	deviceId: string,
	sequence: number,
	entityId: string,
): Promise<ImmutableSyncOperation> {
	return createSyncOperation({
		operationId: `op-${deviceId}-${sequence}`,
		accountNamespace,
		sourceDeviceId: deviceId,
		sequence: { originSequence: sequence, logicalClock: sequence },
		section: "core",
		entityType: "message",
		entityId,
		createdAtMs: sequence,
		mutation: { kind: "upsert", value: { id: entityId, body: `v${sequence}` } },
	});
}

async function syncPackage(
	accountNamespace: string,
	deviceId: string,
	operations: readonly ImmutableSyncOperation[],
	previousPackageDigest: string | null = null,
): Promise<SyncPackage> {
	return createSyncPackage({
		packageId: `pkg-${deviceId}-${operations[0].originSequence}`,
		accountNamespace,
		sourceDeviceId: deviceId,
		createdAtMs: operations[0].originSequence,
		previousPackageDigest,
		operations,
	});
}

function outbound(syncPackage: SyncPackage): OutboundGoogleDriveSyncPackage {
	return {
		syncPackage,
		serialized: serializeSyncPackage(syncPackage),
		createdAtMs: syncPackage.createdAtMs,
		uploadedAtMs: null,
		remoteFileId: null,
	};
}

function configuredStore(
	events: string[],
	bootstrap: Partial<GoogleDriveSyncBootstrapState> = {},
): FakeStore {
	return new FakeStore(events, {
		config: {
			enabled: true,
			accountNamespace: ACCOUNT,
			mediaPolicy: "off",
			lastSuccessfulSyncAt: null,
			lastError: null,
		},
		bootstrap: {
			authorityDeviceId: LOCAL_DEVICE,
			authoritySequenceEnd: 0,
			authorityHeadDigest: null,
			bootstrapPending: false,
			anchorRequired: true,
			localBaselineSequence: null,
			...bootstrap,
		},
	});
}

function adapter(
	native: FakeNative,
	store: FakeStore,
	active = () => true,
	onRemoteApplied: (profileId: number) => void | Promise<void> = () => undefined,
	deviceId: (boundDeviceId: string | null, allowCreate: boolean) => string | null = () =>
		LOCAL_DEVICE,
) {
	return createGoogleDriveSyncControllerAdapter({
		native,
		storeFactory: async () => store,
		isActiveProfile: active,
		deviceId,
		deviceName: () => "Windows PC",
		generateNamespace: () => ACCOUNT,
		now: () => 1_000,
		sleep: async () => undefined,
		onRemoteApplied,
	});
}

function anchor(
	authorityDeviceId = LOCAL_DEVICE,
	sequenceEnd = 0,
	headDigest: string | null = null,
	accountNamespace = ACCOUNT,
): GoogleDriveSyncAnchorV1 {
	return {
		kind: GOOGLE_DRIVE_SYNC_ANCHOR_KIND,
		version: GOOGLE_DRIVE_SYNC_WIRE_VERSION,
		accountNamespace,
		bootstrapAuthorityDeviceId: authorityDeviceId,
		bootstrapSequenceEnd: sequenceEnd,
		bootstrapHeadDigest: headDigest,
		createdAtMs: 100,
	};
}

async function pairingCodeFor(
	native: FakeNative,
	options: Readonly<{
		accountNamespace?: string;
		authorityDeviceId?: string;
		sequenceEnd?: number;
		headDigest?: string | null;
		observedSourceHeads?: readonly GoogleDriveSyncInboundHead[];
	}> = {},
): Promise<string> {
	const authorityDeviceId = options.authorityDeviceId ?? AUTHORITY_DEVICE;
	const sequenceEnd = options.sequenceEnd ?? 0;
	const headDigest = options.headDigest ?? null;
	return encodeGoogleDriveSyncPairingCode({
		kind: GOOGLE_DRIVE_SYNC_PAIRING_KIND,
		version: GOOGLE_DRIVE_SYNC_WIRE_VERSION,
		profileId: String(PROFILE_ID),
		accountNamespace: options.accountNamespace ?? ACCOUNT,
		vaultKey: native.vaultKey,
		bootstrapAuthorityDeviceId: authorityDeviceId,
		bootstrapSequenceEnd: sequenceEnd,
		bootstrapHeadDigest: headDigest,
		observedSourceHeads:
			options.observedSourceHeads ??
			(sequenceEnd > 0 && headDigest
				? [{ sourceDeviceId: authorityDeviceId, sequenceEnd, contentDigest: headDigest }]
				: []),
	});
}

function expectFreshPairingRollback(
	native: FakeNative,
	store: FakeStore,
	events: readonly string[],
): void {
	expect(events.filter((event) => event.startsWith("vault-"))).toEqual([
		"vault-import",
		"vault-delete",
	]);
	expect(native.vaultPresent).toBe(false);
	expect(store.config).toEqual({
		enabled: false,
		accountNamespace: null,
		mediaPolicy: "off",
		lastSuccessfulSyncAt: null,
		lastError: null,
	});
	expect(store.bootstrap).toEqual({
		authorityDeviceId: null,
		authoritySequenceEnd: 0,
		authorityHeadDigest: null,
		bootstrapPending: false,
		anchorRequired: false,
		localBaselineSequence: null,
	});
	expect(
		events.filter(
			(event) => event.startsWith("config:") || event.startsWith("bootstrap:"),
		),
	).toEqual([]);
}

describe("Google Drive sync controller", () => {
	test("reconciles local data before the first remote read", async () => {
		const events: string[] = [];
		const native = await FakeNative.create(events);
		const store = configuredStore(events);
		await native.seedAnchor(anchor());
		await adapter(native, store).syncNow({ profileId: PROFILE_ID });
		expect(events.indexOf("reconcile")).toBeGreaterThanOrEqual(0);
		expect(events.indexOf("reconcile")).toBeLessThan(events.indexOf("list"));
		// The full domain scan is the most expensive step of a cycle, so when no
		// remote work is applied it runs once rather than after every inventory
		// read. The leading reconcile above remains the data-loss boundary.
		expect(events.filter((event) => event === "reconcile")).toHaveLength(1);
	});

	test("a cycle that applies remote work still reconciles after the final apply", async () => {
		const events: string[] = [];
		const native = await FakeNative.create(events);
		await native.seedAnchor(anchor());
		const remote = await syncPackage(ACCOUNT, AUTHORITY_DEVICE, [
			await operation(ACCOUNT, AUTHORITY_DEVICE, 1, "remote-entity"),
		]);
		await native.seedPackage(remote, "package-1");
		const store = configuredStore(events);

		await adapter(native, store).syncNow({ profileId: PROFILE_ID });

		// A conditional apply can preserve a concurrent local write, and only a
		// reconcile after that apply promotes it above the remote clock, so newly
		// applied work must still open a follow-up scan.
		const firstApply = events.findIndex((event) => event.startsWith("apply:"));
		expect(firstApply).toBeGreaterThanOrEqual(0);
		expect(events.lastIndexOf("reconcile")).toBeGreaterThan(firstApply);
		// Exactly two: the leading data-loss boundary and the one the applied work
		// opened. The trailing duplicate replay applies nothing new, so it adds no
		// third full scan of every entity.
		expect(events.filter((event) => event === "reconcile")).toHaveLength(2);
	});

	test("an unenrolled device never announces the syncing phase", async () => {
		const native = await FakeNative.create();
		// A second device that has authenticated Google but holds no vault yet.
		const store = new FakeStore();
		const manager = adapter(native, store);
		const seenPhases: string[] = [];
		const unsubscribe = manager.subscribe({ profileId: PROFILE_ID }, (status) => {
			seenPhases.push(status.phase);
		});

		await manager.syncNow({ profileId: PROFILE_ID });
		unsubscribe();

		// Announcing "syncing" here makes the card treat the device as busy and
		// disables the connect and pairing controls, which are the only way to
		// finish enrolling it. That is an unrecoverable state on a fresh device.
		expect(seenPhases).not.toContain("syncing");
	});

	test("status is readable while a cycle is still running", async () => {
		const native = await FakeNative.create();
		await native.seedAnchor(anchor());
		const store = configuredStore([]);
		const manager = adapter(native, store);

		// Hold the cycle open inside its first remote read.
		let releaseList = (): void => undefined;
		const listGate = new Promise<void>((resolve) => {
			releaseList = resolve;
		});
		const realList = native.listAppData.bind(native);
		let gated = false;
		native.listAppData = async (
			profileId: Parameters<typeof realList>[0],
			pageToken?: Parameters<typeof realList>[1],
		) => {
			if (!gated) {
				gated = true;
				await listGate;
			}
			return realList(profileId, pageToken);
		};

		const running = manager.syncNow({ profileId: PROFILE_ID });

		// A read must not wait on the write queue. Before this, the card could not
		// describe the device until the cycle finished, which on a cold device is
		// minutes and looks exactly like a hang.
		const status = await manager.getStatus({ profileId: PROFILE_ID });
		expect(status.phase).not.toBe("loading");
		expect(status.googleConnected).toBe(true);

		releaseList();
		await running;
	});

	test("every reconcile carries the configured contact scope, pairing included", async () => {
		const events: string[] = [];
		const native = await FakeNative.create(events);
		native.platform = "ios";
		native.connected = false;
		native.vaultPresent = false;
		await native.seedAnchor(anchor(AUTHORITY_DEVICE));
		const store = new FakeStore(events);
		const manager = createGoogleDriveSyncControllerAdapter({
			native,
			storeFactory: async () => store,
			isActiveProfile: () => true,
			deviceId: () => LOCAL_DEVICE,
			deviceName: () => "iPhone",
			generateNamespace: () => ACCOUNT,
			now: () => 1_000,
			sleep: async () => undefined,
			onRemoteApplied: () => undefined,
			contactScope: () => "conversations",
		});

		await manager.connect({ profileId: PROFILE_ID });
		const code = await encodeGoogleDriveSyncPairingCode({
			kind: GOOGLE_DRIVE_SYNC_PAIRING_KIND,
			version: GOOGLE_DRIVE_SYNC_WIRE_VERSION,
			profileId: String(PROFILE_ID),
			accountNamespace: ACCOUNT,
			vaultKey: native.vaultKey,
			bootstrapAuthorityDeviceId: AUTHORITY_DEVICE,
			bootstrapSequenceEnd: 0,
			bootstrapHeadDigest: null,
			observedSourceHeads: [],
		});
		await manager.importPairingCode({ profileId: PROFILE_ID, pairingCode: code });

		// The pairing baseline scan snapshots this device's local entities. Running
		// it unscoped published tens of thousands of browse-only rows the setting
		// was meant to exclude, and that baseline is what a phone then uploads.
		expect(store.reconcileScopes.length).toBeGreaterThan(0);
		expect(store.reconcileScopes).not.toContain(undefined);
		for (const scope of store.reconcileScopes) {
			expect(scope).toBe("conversations");
		}
	});

	test("a successful reset clears the local ledger for the destroyed vault", async () => {
		const events: string[] = [];
		const native = await FakeNative.create(events);
		await native.seedAnchor(anchor());
		const store = configuredStore(events);

		await adapter(native, store).resetCloudData({ profileId: PROFILE_ID });

		// Journal rows are unreadable once the key is gone, and a device that
		// re-paired used to inherit them as pending uploads.
		expect(store.clearedAccountNamespaces).toEqual([ACCOUNT]);
		expect(events.indexOf("clear-account-state")).toBeGreaterThan(
			events.lastIndexOf("delete:anchor-id"),
		);
	});

	test("a restarted controller reuses persisted package bodies", async () => {
		const events: string[] = [];
		const native = await FakeNative.create(events);
		await native.seedAnchor(anchor());
		const remote = await syncPackage(ACCOUNT, AUTHORITY_DEVICE, [
			await operation(ACCOUNT, AUTHORITY_DEVICE, 1, "remote-entity"),
		]);
		await native.seedPackage(remote, "package-1");
		const store = configuredStore(events);

		await adapter(native, store).syncNow({ profileId: PROFILE_ID });
		expect(events.filter((event) => event === "download:package-1")).toHaveLength(1);
		expect(store.remotePackageCache.size).toBe(1);

		// A new adapter is a new controller with an empty in-memory cache, which
		// is what a restarted app has. Without a durable cache it re-downloads and
		// re-decrypts the entire history before it can do anything at all.
		await adapter(native, store).syncNow({ profileId: PROFILE_ID });
		expect(events.filter((event) => event === "download:package-1")).toHaveLength(1);
		expect(store.config.lastError).toBeNull();
	});

	test("a persisted body that no longer verifies is re-downloaded, not trusted", async () => {
		const events: string[] = [];
		const native = await FakeNative.create(events);
		await native.seedAnchor(anchor());
		const remote = await syncPackage(ACCOUNT, AUTHORITY_DEVICE, [
			await operation(ACCOUNT, AUTHORITY_DEVICE, 1, "remote-entity"),
		]);
		await native.seedPackage(remote, "package-1");
		const store = configuredStore(events);

		await adapter(native, store).syncNow({ profileId: PROFILE_ID });
		expect(events.filter((event) => event === "download:package-1")).toHaveLength(1);

		// Reuse must never weaken verification: a cached body still has to produce
		// the content digest its authenticated filename commits to.
		for (const key of store.remotePackageCache.keys()) {
			store.remotePackageCache.set(key, '{"tampered":true}');
		}

		await adapter(native, store).syncNow({ profileId: PROFILE_ID });
		expect(events.filter((event) => event === "download:package-1")).toHaveLength(2);
		expect(store.config.lastError).toBeNull();
	});

	test("a missing required anchor hard-stops before any upload or deletion", async () => {
		const events: string[] = [];
		const native = await FakeNative.create(events);
		const store = configuredStore(events);
		await expect(adapter(native, store).syncNow({ profileId: PROFILE_ID })).rejects.toThrow(
			"anchor is missing",
		);
		expect(events[0]).toBe("reconcile");
		expect(native.createCalls).toEqual([]);
		expect(native.deleteCalls).toEqual([]);
	});

	test("fresh iOS OAuth waits for a pairing code before creating sync state", async () => {
		const events: string[] = [];
		const native = await FakeNative.create(events);
		native.platform = "ios";
		native.connected = false;
		native.vaultPresent = false;
		await native.seedAnchor(anchor(AUTHORITY_DEVICE));
		const store = new FakeStore(events);
		const manager = adapter(native, store);

		const connected = await manager.connect({ profileId: PROFILE_ID });
		expect(connected).toMatchObject({
			phase: "pairing",
			googleConnected: true,
			vaultState: "none",
		});
		expect(store.config).toMatchObject({
			enabled: false,
			accountNamespace: null,
		});
		expect(store.bootstrap.authorityDeviceId).toBeNull();
		expect(events).not.toContain("vault-create");
		expect(native.createCalls).toEqual([]);

		const code = await encodeGoogleDriveSyncPairingCode({
			kind: GOOGLE_DRIVE_SYNC_PAIRING_KIND,
			version: GOOGLE_DRIVE_SYNC_WIRE_VERSION,
			profileId: String(PROFILE_ID),
			accountNamespace: ACCOUNT,
			vaultKey: native.vaultKey,
			bootstrapAuthorityDeviceId: AUTHORITY_DEVICE,
			bootstrapSequenceEnd: 0,
			bootstrapHeadDigest: null,
			observedSourceHeads: [],
		});
		const paired = await manager.importPairingCode({
			profileId: PROFILE_ID,
			pairingCode: code,
		});
		expect(paired).toMatchObject({
			phase: "paired",
			googleConnected: true,
			vaultState: "ready",
		});
		expect(store.config).toMatchObject({
			enabled: true,
			accountNamespace: ACCOUNT,
		});
		expect(events).toContain("vault-import");
	});

	test("a failed OAuth connection leaves an actionable error instead of connecting forever", async () => {
		const native = await FakeNative.create();
		native.connected = false;
		native.vaultPresent = false;
		native.connectFailure = new GoogleDriveNativeError(
			"transport",
			"OAuth window was closed",
		);
		const store = new FakeStore();
		const manager = adapter(native, store);
		let latestPhase = "";
		let latestError: string | null = null;
		const unsubscribe = manager.subscribe(
			{ profileId: PROFILE_ID },
			(status) => {
				latestPhase = status.phase;
				latestError = status.error?.message ?? null;
			},
		);

		await expect(manager.connect({ profileId: PROFILE_ID })).rejects.toThrow(
			"OAuth window was closed",
		);
		expect(latestPhase).toBe("error");
		expect(latestError).toBe("OAuth window was closed");
		expect(store.config.accountNamespace).toBeNull();
		expect(native.createCalls).toEqual([]);
		unsubscribe();
	});

	test("first enrollment binds its local source before OAuth or vault side effects", async () => {
		const native = await FakeNative.create();
		native.connected = false;
		native.vaultPresent = false;
		const store = new FakeStore();
		const status = await adapter(
			native,
			store,
			() => true,
			() => undefined,
			(boundDeviceId, allowCreate) => {
				expect(boundDeviceId).toBeNull();
				expect(allowCreate).toBe(true);
				expect(native.connectCalls).toBe(0);
				expect(native.vaultPresent).toBe(false);
				return LOCAL_DEVICE;
			},
		).connect({ profileId: PROFILE_ID });

		expect(status.phase).toBe("paired");
		expect(store.boundDeviceId).toBe(LOCAL_DEVICE);
		expect(store.bindCalls).toEqual([LOCAL_DEVICE]);
		expect(native.connectCalls).toBe(1);
		expect(store.bootstrap.authorityDeviceId).toBe(LOCAL_DEVICE);
	});

	test("an injected browser/store identity conflict fails before connect side effects", async () => {
		const native = await FakeNative.create();
		native.connected = false;
		const store = configuredStore([]);
		store.boundDeviceId = "different-bound-device";
		const originalConfig = { ...store.config };
		const originalBootstrap = { ...store.bootstrap };

		await expect(
			adapter(
				native,
				store,
				() => true,
				() => undefined,
				() => LOCAL_DEVICE,
			).connect({ profileId: PROFILE_ID }),
		).rejects.toThrow("device ids conflict");

		expect(native.connectCalls).toBe(0);
		expect(native.createCalls).toEqual([]);
		expect(store.config).toEqual(originalConfig);
		expect(store.bootstrap).toEqual(originalBootstrap);
		expect(store.boundDeviceId).toBe("different-bound-device");
	});

	test("an unbound retained enrollment never mints a replacement source", async () => {
		const native = await FakeNative.create();
		native.connected = false;
		const store = configuredStore([]);
		store.boundDeviceId = null;
		let allowCreate: boolean | null = null;

		await expect(
			adapter(
				native,
				store,
				() => true,
				() => undefined,
				(_boundDeviceId, mayCreate) => {
					allowCreate = mayCreate;
					return null;
				},
			).connect({ profileId: PROFILE_ID }),
		).rejects.toThrow("lost its browser device id");

		expect(allowCreate).toBe(false);
		expect(store.bindCalls).toEqual([]);
		expect(native.connectCalls).toBe(0);
		expect(store.boundDeviceId).toBeNull();
	});

	test("a restored bound source uploads its existing pending outbox", async () => {
		const native = await FakeNative.create();
		await native.seedAnchor(anchor());
		const store = configuredStore([]);
		const pending = await syncPackage(ACCOUNT, LOCAL_DEVICE, [
			await operation(ACCOUNT, LOCAL_DEVICE, 1, "pending-before-browser-repair"),
		]);
		store.pending.push(outbound(pending));
		let resolverCalls = 0;

		await adapter(
			native,
			store,
			() => true,
			() => undefined,
			(boundDeviceId, allowCreate) => {
				resolverCalls += 1;
				expect(boundDeviceId).toBe(LOCAL_DEVICE);
				expect(allowCreate).toBe(false);
				return boundDeviceId;
			},
		).syncNow({ profileId: PROFILE_ID });

		expect(resolverCalls).toBe(1);
		expect(store.uploaded.has(pending.packageId)).toBe(true);
		expect(native.createCalls).toHaveLength(1);
	});

	test("reauthorizing an enrolled device preserves its vault key and sync identity", async () => {
		const events: string[] = [];
		const native = await FakeNative.create(events);
		const store = configuredStore(events);
		await native.seedAnchor(anchor());
		const originalVaultKey = { ...native.vaultKey };
		const originalBootstrap = { ...store.bootstrap };

		const status = await adapter(native, store).connect({ profileId: PROFILE_ID });

		expect(status).toMatchObject({
			phase: "paired",
			googleConnected: true,
			vaultState: "ready",
		});
		expect(native.vaultKey).toEqual(originalVaultKey);
		expect(native.vaultPresent).toBe(true);
		expect(store.config.accountNamespace).toBe(ACCOUNT);
		expect(store.bootstrap).toEqual(originalBootstrap);
		expect(events).not.toContain("vault-create");
		expect(events).not.toContain("vault-import");
		expect(events).not.toContain("vault-delete");
	});

	test("keeping media off refreshes status without deadlocking the controller queue", async () => {
		const manager = adapter(await FakeNative.create(), configuredStore([]));
		const status = await manager.setMediaPolicy({
			profileId: PROFILE_ID,
			mediaPolicy: "off",
		});
		expect(status.phase).toBe("paired");
		expect(status.mediaPolicy).toBe("off");
	});

	test("first Windows enrollment persists authority first, uploads seed, then anchor", async () => {
		const events: string[] = [];
		const native = await FakeNative.create(events);
		native.connected = false;
		native.vaultPresent = false;
		const store = new FakeStore(events);
		const pkg = await syncPackage(ACCOUNT, LOCAL_DEVICE, [
			await operation(ACCOUNT, LOCAL_DEVICE, 1, "seed"),
		]);
		store.pending.push(outbound(pkg));

		const status = await adapter(native, store).connect({ profileId: PROFILE_ID });
		expect(status.phase).toBe("paired");
		expect(store.bootstrap).toMatchObject({
			authorityDeviceId: LOCAL_DEVICE,
			authoritySequenceEnd: 1,
			authorityHeadDigest: pkg.contentDigest,
			anchorRequired: true,
		});
		const authorityWrite = events.findIndex((event) => event.startsWith("bootstrap:"));
		const namespaceWrite = events.findIndex((event) => event === `config:${ACCOUNT}:true`);
		expect(authorityWrite).toBeLessThan(namespaceWrite);
		expect(events.indexOf("create:package")).toBeLessThan(events.indexOf("create:anchor"));
		expect(store.uploaded.has(pkg.packageId)).toBe(true);
	});

	test("secondary bootstrap supersedes only overlapping baseline entities", async () => {
		const events: string[] = [];
		const native = await FakeNative.create(events);
		const authorityPackage = await syncPackage(ACCOUNT, AUTHORITY_DEVICE, [
			await operation(ACCOUNT, AUTHORITY_DEVICE, 1, "overlap"),
			await operation(ACCOUNT, AUTHORITY_DEVICE, 2, "authority-only"),
		]);
		await native.seedAnchor(
			anchor(AUTHORITY_DEVICE, 2, authorityPackage.contentDigest),
		);
		await native.seedPackage(authorityPackage);
		const store = configuredStore(events, {
			authorityDeviceId: AUTHORITY_DEVICE,
			authoritySequenceEnd: 2,
			authorityHeadDigest: authorityPackage.contentDigest,
			bootstrapPending: true,
			anchorRequired: true,
			localBaselineSequence: 7,
		});
		store.localSequence = 9; // sequences 8-9 represent post-baseline phone edits

		await adapter(native, store).syncNow({ profileId: PROFILE_ID });
		expect(store.supersedeCalls).toEqual([
			{ entityId: "overlap", maxOriginSequence: 7 },
			{ entityId: "authority-only", maxOriginSequence: 7 },
		]);
		expect(store.supersedeCalls.some((call) => call.entityId === "phone-only")).toBe(false);
		expect(store.applyOptions[0]).toMatchObject({
			bootstrapAuthority: {
				localSourceDeviceId: LOCAL_DEVICE,
				localBaselineSequence: 7,
			},
		});
		expect(store.bootstrap.bootstrapPending).toBe(false);
		expect(store.bootstrap.localBaselineSequence).toBeNull();
		expect(events.indexOf(`apply:${AUTHORITY_DEVICE}:2`)).toBeLessThan(
			events.indexOf("supersede:overlap"),
		);
	});

	test("bootstrap replay supersedes the saved baseline after a crash following apply", async () => {
		const events: string[] = [];
		const native = await FakeNative.create(events);
		const authorityPackage = await syncPackage(ACCOUNT, AUTHORITY_DEVICE, [
			await operation(ACCOUNT, AUTHORITY_DEVICE, 1, "overlap"),
		]);
		await native.seedAnchor(
			anchor(AUTHORITY_DEVICE, 1, authorityPackage.contentDigest),
		);
		await native.seedPackage(authorityPackage);
		const store = configuredStore(events, {
			authorityDeviceId: AUTHORITY_DEVICE,
			authoritySequenceEnd: 1,
			authorityHeadDigest: authorityPackage.contentDigest,
			bootstrapPending: true,
			anchorRequired: true,
			localBaselineSequence: 4,
		});
		store.failAfterApplyOnce = true;
		const manager = adapter(native, store);

		await expect(manager.syncNow({ profileId: PROFILE_ID })).rejects.toThrow(
			"crash after durable apply receipt",
		);
		expect(store.supersedeCalls).toEqual([]);
		expect(store.bootstrap.bootstrapPending).toBe(true);

		await manager.syncNow({ profileId: PROFILE_ID });
		expect(store.applyOptions).toHaveLength(3);
		expect(store.applyOptions.slice(0, 2)).toEqual([
			expect.objectContaining({
				bootstrapAuthority: {
					localSourceDeviceId: LOCAL_DEVICE,
					localBaselineSequence: 4,
				},
			}),
			expect.objectContaining({
				bootstrapAuthority: {
					localSourceDeviceId: LOCAL_DEVICE,
					localBaselineSequence: 4,
				},
			}),
		]);
		expect(store.supersedeCalls).toEqual([
			{ entityId: "overlap", maxOriginSequence: 4 },
		]);
		expect(store.bootstrap.bootstrapPending).toBe(false);
	});

	test("uncertain immutable create is recovered by re-listing and verifying", async () => {
		const events: string[] = [];
		const native = await FakeNative.create(events);
		await native.seedAnchor(anchor());
		native.uncertainCreateOnce = true;
		const store = configuredStore(events);
		const pkg = await syncPackage(ACCOUNT, LOCAL_DEVICE, [
			await operation(ACCOUNT, LOCAL_DEVICE, 1, "new-local"),
		]);
		store.pending.push(outbound(pkg));

		await adapter(native, store).syncNow({ profileId: PROFILE_ID });
		expect(native.createCalls).toHaveLength(1);
		expect(store.uploaded.get(pkg.packageId)).toBeTruthy();
		expect(events.filter((event) => event === "list").length).toBeGreaterThan(2);
	});

	test("an anchor deleted concurrently after upload cleans up the unconfirmed package", async () => {
		const native = await FakeNative.create();
		await native.seedAnchor(anchor(), "anchor-race");
		const store = configuredStore([]);
		const pkg = await syncPackage(ACCOUNT, LOCAL_DEVICE, [
			await operation(ACCOUNT, LOCAL_DEVICE, 1, "late-local"),
		]);
		store.pending.push(outbound(pkg));
		const packageName = await googleDriveSyncPackageFilename({
			accountNamespace: ACCOUNT,
			sourceDeviceId: LOCAL_DEVICE,
			packageId: pkg.packageId,
			contentDigest: pkg.contentDigest,
		});
		native.afterCreate = (created) => {
			if (created.name !== packageName) return;
			const anchorIndex = native.files.findIndex(
				(file) => file.metadata.id === "anchor-race",
			);
			if (anchorIndex >= 0) native.files.splice(anchorIndex, 1);
		};

		await expect(
			adapter(native, store).syncNow({ profileId: PROFILE_ID }),
		).rejects.toThrow("disappeared immediately after an upload");

		expect(native.createCalls).toEqual([packageName]);
		expect(store.uploaded.has(pkg.packageId)).toBe(false);
		expect(native.deleteCalls).toEqual(["remote-1"]);
		expect(
			native.files.some((file) => file.metadata.name === packageName),
		).toBe(false);
		expect(native.files.some((file) => file.metadata.id === "anchor-race")).toBe(
			false,
		);
	});

	test("a response-lost upload deletes every verified recovered package after anchor revocation", async () => {
		const native = await FakeNative.create();
		await native.seedAnchor(anchor(), "anchor-response-lost-race");
		native.uncertainCreateOnce = true;
		const store = configuredStore([]);
		const pkg = await syncPackage(ACCOUNT, LOCAL_DEVICE, [
			await operation(ACCOUNT, LOCAL_DEVICE, 1, "response-lost-late-local"),
		]);
		store.pending.push(outbound(pkg));
		const packageName = await googleDriveSyncPackageFilename({
			accountNamespace: ACCOUNT,
			sourceDeviceId: LOCAL_DEVICE,
			packageId: pkg.packageId,
			contentDigest: pkg.contentDigest,
		});
		native.afterCreate = (created) => {
			if (created.name !== packageName) return;
			const anchorIndex = native.files.findIndex(
				(file) => file.metadata.id === "anchor-response-lost-race",
			);
			if (anchorIndex >= 0) native.files.splice(anchorIndex, 1);
		};

		await expect(
			adapter(native, store).syncNow({ profileId: PROFILE_ID }),
		).rejects.toThrow("disappeared after recovering an upload");

		expect(native.createCalls).toEqual([packageName]);
		expect(native.deleteCalls).toEqual(["remote-1"]);
		expect(store.uploaded.has(pkg.packageId)).toBe(false);
		expect(native.files.some((file) => file.metadata.name === packageName)).toBe(false);
	});

	test("response-lost cleanup failure preserves the revoked-anchor error and pending ledger", async () => {
		const native = await FakeNative.create();
		await native.seedAnchor(anchor(), "anchor-cleanup-failure");
		native.uncertainCreateOnce = true;
		native.deleteFailuresRemaining.set("remote-1", 1);
		const store = configuredStore([]);
		const pkg = await syncPackage(ACCOUNT, LOCAL_DEVICE, [
			await operation(ACCOUNT, LOCAL_DEVICE, 1, "response-lost-cleanup-failure"),
		]);
		store.pending.push(outbound(pkg));
		const packageName = await googleDriveSyncPackageFilename({
			accountNamespace: ACCOUNT,
			sourceDeviceId: LOCAL_DEVICE,
			packageId: pkg.packageId,
			contentDigest: pkg.contentDigest,
		});
		native.afterCreate = (created) => {
			if (created.name !== packageName) return;
			const anchorIndex = native.files.findIndex(
				(file) => file.metadata.id === "anchor-cleanup-failure",
			);
			if (anchorIndex >= 0) native.files.splice(anchorIndex, 1);
		};

		await expect(
			adapter(native, store).syncNow({ profileId: PROFILE_ID }),
		).rejects.toThrow("disappeared after recovering an upload");

		expect(native.deleteCalls).toEqual(["remote-1"]);
		expect(store.uploaded.has(pkg.packageId)).toBe(false);
		expect(native.files.some((file) => file.metadata.name === packageName)).toBe(true);
	});

	test("response-lost recovery never deletes a package when a conflicting anchor is present", async () => {
		const native = await FakeNative.create();
		await native.seedAnchor(anchor(), "anchor-before-conflict");
		native.uncertainCreateOnce = true;
		const store = configuredStore([]);
		const pkg = await syncPackage(ACCOUNT, LOCAL_DEVICE, [
			await operation(ACCOUNT, LOCAL_DEVICE, 1, "response-lost-anchor-conflict"),
		]);
		store.pending.push(outbound(pkg));
		const packageName = await googleDriveSyncPackageFilename({
			accountNamespace: ACCOUNT,
			sourceDeviceId: LOCAL_DEVICE,
			packageId: pkg.packageId,
			contentDigest: pkg.contentDigest,
		});
		native.afterCreate = async (created) => {
			if (created.name !== packageName) return;
			const anchorIndex = native.files.findIndex(
				(file) => file.metadata.id === "anchor-before-conflict",
			);
			if (anchorIndex >= 0) native.files.splice(anchorIndex, 1);
			await native.seedAnchor(anchor(AUTHORITY_DEVICE), "anchor-conflict");
		};

		await expect(
			adapter(native, store).syncNow({ profileId: PROFILE_ID }),
		).rejects.toThrow("anchor changed after recovering an upload");

		expect(native.deleteCalls).toEqual([]);
		expect(store.uploaded.has(pkg.packageId)).toBe(false);
		expect(native.files.some((file) => file.metadata.name === packageName)).toBe(true);
	});

	test("remote-apply refresh fires once for unseen operations and not for replay", async () => {
		const native = await FakeNative.create();
		await native.seedAnchor(anchor());
		const remote = await syncPackage(ACCOUNT, AUTHORITY_DEVICE, [
			await operation(ACCOUNT, AUTHORITY_DEVICE, 1, "remote-message"),
		]);
		await native.seedPackage(remote);
		const refreshedProfiles: number[] = [];
		const manager = adapter(
			native,
			configuredStore([]),
			() => true,
			(profileId) => void refreshedProfiles.push(profileId),
		);

		await manager.syncNow({ profileId: PROFILE_ID });
		await manager.syncNow({ profileId: PROFILE_ID });
		expect(refreshedProfiles).toEqual([PROFILE_ID]);
	});

	test("pairing rejects a different profile before importing a key", async () => {
		const native = await FakeNative.create();
		const store = new FakeStore();
		const code = await encodeGoogleDriveSyncPairingCode({
			kind: GOOGLE_DRIVE_SYNC_PAIRING_KIND,
			version: GOOGLE_DRIVE_SYNC_WIRE_VERSION,
			profileId: "999",
			accountNamespace: ACCOUNT,
			vaultKey: native.vaultKey,
			bootstrapAuthorityDeviceId: AUTHORITY_DEVICE,
			bootstrapSequenceEnd: 0,
			bootstrapHeadDigest: null,
			observedSourceHeads: [],
		});
		await expect(
			adapter(native, store).importPairingCode({
				profileId: PROFILE_ID,
				pairingCode: code,
			}),
		).rejects.toThrow("different GrindFlop profile");
		expect(native.events).not.toContain("vault-import");
	});

	test("fresh secondary pairing rolls back its new key when the selected Drive account has no matching anchor", async () => {
		const events: string[] = [];
		const native = await FakeNative.create(events);
		native.vaultPresent = false;
		await native.seedAnchor(
			anchor(AUTHORITY_DEVICE, 0, null, "different-drive-account"),
		);
		const store = new FakeStore(events);

		await expect(
			adapter(native, store).importPairingCode({
				profileId: PROFILE_ID,
				pairingCode: await pairingCodeFor(native),
			}),
		).rejects.toThrow("does not match the immutable anchor");
		expectFreshPairingRollback(native, store, events);
	});

	test("fresh secondary pairing rolls back its new key when Drive contains conflicting anchors", async () => {
		const events: string[] = [];
		const native = await FakeNative.create(events);
		native.vaultPresent = false;
		await native.seedAnchor(anchor(AUTHORITY_DEVICE), "anchor-expected");
		await native.seedAnchor(anchor("device-conflicting-authority"), "anchor-conflict");
		const store = new FakeStore(events);

		await expect(
			adapter(native, store).importPairingCode({
				profileId: PROFILE_ID,
				pairingCode: await pairingCodeFor(native),
			}),
		).rejects.toThrow("conflicting immutable sync anchors");
		expectFreshPairingRollback(native, store, events);
	});

	test("fresh secondary pairing rolls back its new key when authority history is incomplete", async () => {
		const events: string[] = [];
		const native = await FakeNative.create(events);
		native.vaultPresent = false;
		const first = await syncPackage(ACCOUNT, AUTHORITY_DEVICE, [
			await operation(ACCOUNT, AUTHORITY_DEVICE, 1, "authority-first"),
		]);
		const missingHead = await syncPackage(
			ACCOUNT,
			AUTHORITY_DEVICE,
			[await operation(ACCOUNT, AUTHORITY_DEVICE, 2, "authority-missing-head")],
			first.contentDigest,
		);
		await native.seedAnchor(
			anchor(AUTHORITY_DEVICE, 2, missingHead.contentDigest),
		);
		await native.seedPackage(first);
		const store = new FakeStore(events);

		await expect(
			adapter(native, store).importPairingCode({
				profileId: PROFILE_ID,
				pairingCode: await pairingCodeFor(native, {
					sequenceEnd: 2,
					headDigest: missingHead.contentDigest,
				}),
			}),
		).rejects.toThrow("exact authority package");
		expectFreshPairingRollback(native, store, events);
	});

	test("fresh pairing rejects a post-bootstrap package deleted after the code was exported", async () => {
		const events: string[] = [];
		const native = await FakeNative.create(events);
		const cutoff = await syncPackage(ACCOUNT, AUTHORITY_DEVICE, [
			await operation(ACCOUNT, AUTHORITY_DEVICE, 1, "authority-cutoff"),
		]);
		const observedTail = await syncPackage(
			ACCOUNT,
			AUTHORITY_DEVICE,
			[await operation(ACCOUNT, AUTHORITY_DEVICE, 2, "post-bootstrap-tail")],
			cutoff.contentDigest,
		);
		await native.seedAnchor(anchor(AUTHORITY_DEVICE, 1, cutoff.contentDigest));
		await native.seedPackage(cutoff, "authority-cutoff-file");
		await native.seedPackage(observedTail, "observed-tail-file");
		const exporterStore = configuredStore(events, {
			authorityDeviceId: AUTHORITY_DEVICE,
			authoritySequenceEnd: 1,
			authorityHeadDigest: cutoff.contentDigest,
		});
		const exported = await adapter(native, exporterStore).exportPairingCode({
			profileId: PROFILE_ID,
		});
		const decoded = await decodeGoogleDriveSyncPairingCode(exported.pairingCode);
		expect(decoded.observedSourceHeads).toEqual([
			{
				sourceDeviceId: AUTHORITY_DEVICE,
				sequenceEnd: 2,
				contentDigest: observedTail.contentDigest,
			},
		]);

		await native.deleteAppData(
			String(PROFILE_ID) as GoogleDriveProfileId,
			"observed-tail-file",
			true,
		);
		native.vaultPresent = false;
		const freshStore = new FakeStore(events);
		await expect(
			adapter(native, freshStore).importPairingCode({
				profileId: PROFILE_ID,
				pairingCode: exported.pairingCode,
			}),
		).rejects.toThrow("missing immutable history observed");
		expectFreshPairingRollback(native, freshStore, events);
	});

	test("pairing head commitments survive a deletion between validation and bootstrap retry", async () => {
		const events: string[] = [];
		const native = await FakeNative.create(events);
		const cutoff = await syncPackage(ACCOUNT, AUTHORITY_DEVICE, [
			await operation(ACCOUNT, AUTHORITY_DEVICE, 1, "authority-cutoff"),
		]);
		const observedTail = await syncPackage(
			ACCOUNT,
			AUTHORITY_DEVICE,
			[await operation(ACCOUNT, AUTHORITY_DEVICE, 2, "observed-tail")],
			cutoff.contentDigest,
		);
		await native.seedAnchor(anchor(AUTHORITY_DEVICE, 1, cutoff.contentDigest));
		await native.seedPackage(cutoff, "authority-cutoff-file");
		await native.seedPackage(observedTail, "observed-tail-file");
		const exported = await adapter(
			native,
			configuredStore(events, {
				authorityDeviceId: AUTHORITY_DEVICE,
				authoritySequenceEnd: 1,
				authorityHeadDigest: cutoff.contentDigest,
			}),
		).exportPairingCode({ profileId: PROFILE_ID });

		native.vaultPresent = false;
		const freshStore = new FakeStore(events);
		freshStore.onCommitInboundHeads = async () => {
			freshStore.onCommitInboundHeads = undefined;
			await native.deleteAppData(
				String(PROFILE_ID) as GoogleDriveProfileId,
				"observed-tail-file",
				true,
			);
		};
		const manager = adapter(native, freshStore);
		await expect(
			manager.importPairingCode({
				profileId: PROFILE_ID,
				pairingCode: exported.pairingCode,
			}),
		).rejects.toThrow("Previously applied immutable history is missing");
		expect(freshStore.inboundHeads).toContainEqual({
			sourceDeviceId: AUTHORITY_DEVICE,
			sequenceEnd: 2,
			contentDigest: observedTail.contentDigest,
		});
		expect(freshStore.bootstrap.bootstrapPending).toBe(true);

		await expect(
			manager.importPairingCode({
				profileId: PROFILE_ID,
				pairingCode: exported.pairingCode,
			}),
		).rejects.toThrow("missing immutable history observed");
	});

	test("pairing captures and persists the baseline before enabling the namespace", async () => {
		const events: string[] = [];
		const native = await FakeNative.create(events);
		await native.seedAnchor(anchor(AUTHORITY_DEVICE));
		const store = new FakeStore(events);
		store.localSequence = 11;
		const code = await encodeGoogleDriveSyncPairingCode({
			kind: GOOGLE_DRIVE_SYNC_PAIRING_KIND,
			version: GOOGLE_DRIVE_SYNC_WIRE_VERSION,
			profileId: String(PROFILE_ID),
			accountNamespace: ACCOUNT,
			vaultKey: native.vaultKey,
			bootstrapAuthorityDeviceId: AUTHORITY_DEVICE,
			bootstrapSequenceEnd: 0,
			bootstrapHeadDigest: null,
			observedSourceHeads: [],
		});
		await adapter(native, store).importPairingCode({
			profileId: PROFILE_ID,
			pairingCode: code,
		});
		const firstReconcile = events.indexOf("reconcile");
		const pendingWrite = events.indexOf("bootstrap:true:11");
		const namespaceWrite = events.indexOf(`config:${ACCOUNT}:true`);
		expect(firstReconcile).toBeLessThan(pendingWrite);
		expect(pendingWrite).toBeLessThan(namespaceWrite);
	});

	test("pairing retry preserves its original local cutoff", async () => {
		const events: string[] = [];
		const native = await FakeNative.create(events);
		native.vaultPresent = false;
		const authorityPackage = await syncPackage(ACCOUNT, AUTHORITY_DEVICE, [
			await operation(ACCOUNT, AUTHORITY_DEVICE, 1, "authority-baseline"),
		]);
		await native.seedAnchor(
			anchor(AUTHORITY_DEVICE, 1, authorityPackage.contentDigest),
		);
		await native.seedPackage(authorityPackage);
		const store = new FakeStore(events, {
			config: {
				enabled: false,
				accountNamespace: ACCOUNT,
				mediaPolicy: "off",
				lastSuccessfulSyncAt: null,
				lastError: "interrupted pairing",
			},
			bootstrap: {
				authorityDeviceId: AUTHORITY_DEVICE,
				authoritySequenceEnd: 1,
				authorityHeadDigest: authorityPackage.contentDigest,
				bootstrapPending: true,
				anchorRequired: true,
				localBaselineSequence: 11,
			},
		});
		store.localSequence = 99;
		let cutoffWhenEnabled: number | null | undefined;
		store.onUpdateConfig = (patch) => {
			if (patch.enabled) cutoffWhenEnabled = store.bootstrap.localBaselineSequence;
		};
		const code = await encodeGoogleDriveSyncPairingCode({
			kind: GOOGLE_DRIVE_SYNC_PAIRING_KIND,
			version: GOOGLE_DRIVE_SYNC_WIRE_VERSION,
			profileId: String(PROFILE_ID),
			accountNamespace: ACCOUNT,
			vaultKey: native.vaultKey,
			bootstrapAuthorityDeviceId: AUTHORITY_DEVICE,
			bootstrapSequenceEnd: 1,
			bootstrapHeadDigest: authorityPackage.contentDigest,
			observedSourceHeads: [
				{
					sourceDeviceId: AUTHORITY_DEVICE,
					sequenceEnd: 1,
					contentDigest: authorityPackage.contentDigest,
				},
			],
		});

		await adapter(native, store).importPairingCode({
			profileId: PROFILE_ID,
			pairingCode: code,
		});
		expect(cutoffWhenEnabled).toBe(11);
		expect(events).not.toContain("bootstrap:true:99");
		expect(events).toContain("vault-import");
		expect(store.applyOptions[0]).toMatchObject({
			bootstrapAuthority: {
				localSourceDeviceId: LOCAL_DEVICE,
				localBaselineSequence: 11,
			},
		});
		expect(store.supersedeCalls).toEqual([
			{ entityId: "authority-baseline", maxOriginSequence: 11 },
		]);
	});

	test("established pairing key recovery does not re-enter bootstrap", async () => {
		const events: string[] = [];
		const native = await FakeNative.create(events);
		native.vaultPresent = false;
		await native.seedAnchor(anchor(AUTHORITY_DEVICE));
		const store = new FakeStore(events, {
			config: {
				enabled: false,
				accountNamespace: ACCOUNT,
				mediaPolicy: "off",
				lastSuccessfulSyncAt: null,
				lastError: null,
			},
			bootstrap: {
				authorityDeviceId: AUTHORITY_DEVICE,
				authoritySequenceEnd: 0,
				authorityHeadDigest: null,
				bootstrapPending: false,
				anchorRequired: true,
				localBaselineSequence: null,
			},
		});
		store.localSequence = 77;
		const code = await encodeGoogleDriveSyncPairingCode({
			kind: GOOGLE_DRIVE_SYNC_PAIRING_KIND,
			version: GOOGLE_DRIVE_SYNC_WIRE_VERSION,
			profileId: String(PROFILE_ID),
			accountNamespace: ACCOUNT,
			vaultKey: native.vaultKey,
			bootstrapAuthorityDeviceId: AUTHORITY_DEVICE,
			bootstrapSequenceEnd: 0,
			bootstrapHeadDigest: null,
			observedSourceHeads: [],
		});

		await adapter(native, store).importPairingCode({
			profileId: PROFILE_ID,
			pairingCode: code,
		});
		expect(events.some((event) => event.startsWith("bootstrap:true:"))).toBe(false);
		expect(store.bootstrap).toMatchObject({
			bootstrapPending: false,
			localBaselineSequence: null,
		});
		expect(events).toContain("vault-import");
	});

	test("unknown same-device remote tail stops upload instead of forking", async () => {
		const native = await FakeNative.create();
		await native.seedAnchor(anchor(AUTHORITY_DEVICE));
		const first = await syncPackage(ACCOUNT, LOCAL_DEVICE, [
			await operation(ACCOUNT, LOCAL_DEVICE, 1, "first"),
		]);
		const second = await syncPackage(
			ACCOUNT,
			LOCAL_DEVICE,
			[await operation(ACCOUNT, LOCAL_DEVICE, 2, "second")],
			first.contentDigest,
		);
		await native.seedPackage(first);
		await native.seedPackage(second);
		const store = configuredStore([], {
			authorityDeviceId: AUTHORITY_DEVICE,
		});
		store.pending.push(outbound(first));
		store.uploaded.set(first.packageId, "remote-first");

		await expect(adapter(native, store).syncNow({ profileId: PROFILE_ID })).rejects.toThrow(
			"same-device history",
		);
		expect(native.createCalls).toEqual([]);
	});

	test("an exact response-lost remote prefix is confirmed from the pending ledger", async () => {
		const native = await FakeNative.create();
		await native.seedAnchor(anchor(AUTHORITY_DEVICE));
		const recovered = await syncPackage(ACCOUNT, LOCAL_DEVICE, [
			await operation(ACCOUNT, LOCAL_DEVICE, 1, "response-lost"),
		]);
		await native.seedPackage(recovered, "already-created");
		const store = configuredStore([], {
			authorityDeviceId: AUTHORITY_DEVICE,
		});
		store.pending.push(outbound(recovered));

		await adapter(native, store).syncNow({ profileId: PROFILE_ID });
		expect(store.uploaded.get(recovered.packageId)).toBe("already-created");
		expect(native.createCalls).toEqual([]);
	});

	test("a pending package with a missing local predecessor is never uploaded", async () => {
		const native = await FakeNative.create();
		await native.seedAnchor(anchor(AUTHORITY_DEVICE));
		const brokenSuccessor = await syncPackage(
			ACCOUNT,
			LOCAL_DEVICE,
			[await operation(ACCOUNT, LOCAL_DEVICE, 2, "broken-successor")],
			ZERO_DIGEST,
		);
		const store = configuredStore([], {
			authorityDeviceId: AUTHORITY_DEVICE,
		});
		store.pending.push(outbound(brokenSuccessor));

		await expect(adapter(native, store).syncNow({ profileId: PROFILE_ID })).rejects.toThrow(
			"pending package ledger does not continue",
		);
		expect(native.createCalls).toEqual([]);
	});

	test("a secondary that published local history before bootstrap must re-pair", async () => {
		const native = await FakeNative.create();
		const authorityPackage = await syncPackage(ACCOUNT, AUTHORITY_DEVICE, [
			await operation(ACCOUNT, AUTHORITY_DEVICE, 1, "authority"),
		]);
		const prematurePhonePackage = await syncPackage(ACCOUNT, LOCAL_DEVICE, [
			await operation(ACCOUNT, LOCAL_DEVICE, 1, "premature-phone"),
		]);
		await native.seedAnchor(
			anchor(AUTHORITY_DEVICE, 1, authorityPackage.contentDigest),
		);
		await native.seedPackage(authorityPackage);
		await native.seedPackage(prematurePhonePackage);
		const store = configuredStore([], {
			authorityDeviceId: AUTHORITY_DEVICE,
			authoritySequenceEnd: 1,
			authorityHeadDigest: authorityPackage.contentDigest,
			bootstrapPending: true,
			anchorRequired: true,
			localBaselineSequence: 1,
		});
		store.pending.push(outbound(prematurePhonePackage));

		await expect(adapter(native, store).syncNow({ profileId: PROFILE_ID })).rejects.toThrow(
			"already published local history",
		);
		expect(store.supersedeCalls).toEqual([]);
	});

	test("missing confirmed local package stops before upload", async () => {
		const native = await FakeNative.create();
		await native.seedAnchor(anchor(AUTHORITY_DEVICE));
		const confirmed = await syncPackage(ACCOUNT, LOCAL_DEVICE, [
			await operation(ACCOUNT, LOCAL_DEVICE, 1, "confirmed"),
		]);
		const store = configuredStore([], {
			authorityDeviceId: AUTHORITY_DEVICE,
		});
		store.pending.push(outbound(confirmed));
		store.uploaded.set(confirmed.packageId, "deleted-remote-file");

		await expect(adapter(native, store).syncNow({ profileId: PROFILE_ID })).rejects.toThrow(
			"previously confirmed immutable package is missing",
		);
		expect(native.createCalls).toEqual([]);
	});

	test("missing previously applied remote suffix is treated as rollback", async () => {
		const native = await FakeNative.create();
		await native.seedAnchor(anchor());
		const first = await syncPackage(ACCOUNT, AUTHORITY_DEVICE, [
			await operation(ACCOUNT, AUTHORITY_DEVICE, 1, "remote-first"),
		]);
		const missingSecond = await syncPackage(
			ACCOUNT,
			AUTHORITY_DEVICE,
			[await operation(ACCOUNT, AUTHORITY_DEVICE, 2, "remote-second")],
			first.contentDigest,
		);
		await native.seedPackage(first);
		const store = configuredStore([]);
		store.inboundHeads.push({
			sourceDeviceId: AUTHORITY_DEVICE,
			sequenceEnd: 2,
			contentDigest: missingSecond.contentDigest,
		});

		await expect(adapter(native, store).syncNow({ profileId: PROFILE_ID })).rejects.toThrow(
			"Previously applied immutable history is missing",
		);
		expect(native.createCalls).toEqual([]);
	});

	test("deleting an entire previously applied remote source is treated as rollback", async () => {
		const native = await FakeNative.create();
		await native.seedAnchor(anchor());
		const deleted = await syncPackage(ACCOUNT, AUTHORITY_DEVICE, [
			await operation(ACCOUNT, AUTHORITY_DEVICE, 1, "deleted-source"),
		]);
		const store = configuredStore([]);
		store.inboundHeads.push({
			sourceDeviceId: AUTHORITY_DEVICE,
			sequenceEnd: 1,
			contentDigest: deleted.contentDigest,
		});

		await expect(adapter(native, store).syncNow({ profileId: PROFILE_ID })).rejects.toThrow(
			"Previously applied immutable history is missing",
		);
		expect(native.createCalls).toEqual([]);
	});

	test("a transient list failure recovers on the second read attempt", async () => {
		const events: string[] = [];
		const native = await FakeNative.create(events);
		await native.seedAnchor(anchor());
		native.listFailuresRemaining = 1;
		const store = configuredStore(events);

		await adapter(native, store).syncNow({ profileId: PROFILE_ID });
		const firstDownload = events.findIndex((event) => event.startsWith("download:"));
		expect(events.slice(0, firstDownload).filter((event) => event === "list")).toHaveLength(2);
		expect(store.config.lastError).toBeNull();
	});

	test("transient download failures recover on the third read attempt", async () => {
		const events: string[] = [];
		const native = await FakeNative.create(events);
		await native.seedAnchor(anchor());
		native.downloadFailuresRemaining = 2;
		const store = configuredStore(events);

		await adapter(native, store).syncNow({ profileId: PROFILE_ID });
		expect(
			events.filter((event) => event === "download:anchor-id").length,
		).toBeGreaterThanOrEqual(3);
		expect(store.config.lastError).toBeNull();
	});

	test("a third transient list failure stops before domain apply or upload", async () => {
		const events: string[] = [];
		const native = await FakeNative.create(events);
		await native.seedAnchor(anchor());
		native.listFailuresRemaining = 3;
		const store = configuredStore(events);

		await expect(adapter(native, store).syncNow({ profileId: PROFILE_ID })).rejects.toThrow(
			"injected transient list failure",
		);
		expect(events.filter((event) => event === "list")).toHaveLength(3);
		expect(events.some((event) => event.startsWith("apply:"))).toBe(false);
		expect(native.createCalls).toEqual([]);
	});

	test("a third transient download failure stops before domain apply or upload", async () => {
		const events: string[] = [];
		const native = await FakeNative.create(events);
		await native.seedAnchor(anchor());
		native.downloadFailuresRemaining = 3;
		const store = configuredStore(events);

		await expect(adapter(native, store).syncNow({ profileId: PROFILE_ID })).rejects.toThrow(
			"injected transient download failure",
		);
		expect(events.filter((event) => event === "download:anchor-id")).toHaveLength(3);
		expect(events.some((event) => event.startsWith("apply:"))).toBe(false);
		expect(native.createCalls).toEqual([]);
	});

	test("a repeated Drive pagination token stops before reading file bodies", async () => {
		const events: string[] = [];
		const native = await FakeNative.create(events);
		await native.seedAnchor(anchor());
		native.repeatPaginationToken = true;
		const store = configuredStore(events);

		await expect(adapter(native, store).syncNow({ profileId: PROFILE_ID })).rejects.toThrow(
			"repeated pagination token",
		);
		expect(events.filter((event) => event === "list")).toHaveLength(2);
		expect(events.some((event) => event.startsWith("download:"))).toBe(false);
		expect(events.some((event) => event.startsWith("apply:"))).toBe(false);
		expect(native.createCalls).toEqual([]);
	});

	test("conflicting duplicate anchors stop a normal sync before mutation", async () => {
		const events: string[] = [];
		const native = await FakeNative.create(events);
		await native.seedAnchor(anchor(), "anchor-expected");
		await native.seedAnchor(anchor("different-authority"), "anchor-conflict");
		const store = configuredStore(events);

		await expect(adapter(native, store).syncNow({ profileId: PROFILE_ID })).rejects.toThrow(
			"conflicting immutable sync anchors",
		);
		expect(events.some((event) => event.startsWith("apply:"))).toBe(false);
		expect(native.createCalls).toEqual([]);
	});

	test("a missing middle package breaks the remote digest chain before mutation", async () => {
		const events: string[] = [];
		const native = await FakeNative.create(events);
		await native.seedAnchor(anchor());
		const first = await syncPackage(ACCOUNT, AUTHORITY_DEVICE, [
			await operation(ACCOUNT, AUTHORITY_DEVICE, 1, "first"),
		]);
		const missingMiddle = await syncPackage(
			ACCOUNT,
			AUTHORITY_DEVICE,
			[await operation(ACCOUNT, AUTHORITY_DEVICE, 2, "missing-middle")],
			first.contentDigest,
		);
		const third = await syncPackage(
			ACCOUNT,
			AUTHORITY_DEVICE,
			[await operation(ACCOUNT, AUTHORITY_DEVICE, 3, "third")],
			missingMiddle.contentDigest,
		);
		await native.seedPackage(first);
		await native.seedPackage(third);
		const store = configuredStore(events);

		await expect(adapter(native, store).syncNow({ profileId: PROFILE_ID })).rejects.toThrow(
			"do not form a complete digest chain",
		);
		expect(store.applied.size).toBe(0);
		expect(native.createCalls).toEqual([]);
	});

	test("overlapping remote source ranges stop before mutation", async () => {
		const events: string[] = [];
		const native = await FakeNative.create(events);
		await native.seedAnchor(anchor());
		const first = await syncPackage(ACCOUNT, AUTHORITY_DEVICE, [
			await operation(ACCOUNT, AUTHORITY_DEVICE, 1, "first"),
			await operation(ACCOUNT, AUTHORITY_DEVICE, 2, "second"),
		]);
		const overlapping = await syncPackage(
			ACCOUNT,
			AUTHORITY_DEVICE,
			[
				await operation(ACCOUNT, AUTHORITY_DEVICE, 2, "overlap"),
				await operation(ACCOUNT, AUTHORITY_DEVICE, 3, "third"),
			],
			first.contentDigest,
		);
		await native.seedPackage(first);
		await native.seedPackage(overlapping);
		const store = configuredStore(events);

		await expect(adapter(native, store).syncNow({ profileId: PROFILE_ID })).rejects.toThrow(
			"overlap within one source chain",
		);
		expect(store.applied.size).toBe(0);
		expect(native.createCalls).toEqual([]);
	});

	test("a tampered encrypted envelope stops before domain mutation", async () => {
		const events: string[] = [];
		const native = await FakeNative.create(events);
		await native.seedAnchor(anchor());
		const remote = await syncPackage(ACCOUNT, AUTHORITY_DEVICE, [
			await operation(ACCOUNT, AUTHORITY_DEVICE, 1, "tampered"),
		]);
		await native.seedPackage(remote, "tampered-package");
		const file = native.files.find(
			(candidate) => candidate.metadata.id === "tampered-package",
		);
		if (!file) throw new Error("The tampered package fixture was not created");
		file.body = encodeGoogleDriveSyncBase64Url(textEncoder.encode('{"version":1}'));
		const store = configuredStore(events);

		await expect(
			adapter(native, store).syncNow({ profileId: PROFILE_ID }),
		).rejects.toThrow();
		expect(store.applied.size).toBe(0);
		expect(native.createCalls).toEqual([]);
	});

	test("a package encrypted for another authenticated filename stops before mutation", async () => {
		const events: string[] = [];
		const native = await FakeNative.create(events);
		await native.seedAnchor(anchor());
		const remote = await syncPackage(ACCOUNT, AUTHORITY_DEVICE, [
			await operation(ACCOUNT, AUTHORITY_DEVICE, 1, "wrong-filename"),
		]);
		await native.seedPackage(remote, "wrong-filename-package");
		const file = native.files.find(
			(candidate) => candidate.metadata.id === "wrong-filename-package",
		);
		if (!file) throw new Error("The wrong-filename fixture was not created");
		file.metadata = metadata(
			file.metadata.id,
			await googleDriveSyncPackageFilename({
				accountNamespace: ACCOUNT,
				sourceDeviceId: AUTHORITY_DEVICE,
				packageId: "different-package-id",
				contentDigest: ZERO_DIGEST,
			}),
		);
		const store = configuredStore(events);

		await expect(adapter(native, store).syncNow({ profileId: PROFILE_ID })).rejects.toThrow(
			"authenticated filename verification",
		);
		expect(store.applied.size).toBe(0);
		expect(native.createCalls).toEqual([]);
	});

	test("account switch cancels before upload and does not persist a stale error", async () => {
		const events: string[] = [];
		const native = await FakeNative.create(events);
		await native.seedAnchor(anchor());
		const store = configuredStore(events);
		let active = true;
		store.onReconcile = () => {
			active = false;
		};
		await expect(
			adapter(native, store, () => active).syncNow({ profileId: PROFILE_ID }),
		).rejects.toThrow("active profile changed");
		expect(native.createCalls).toEqual([]);
		expect(store.config.lastError).toBeNull();
	});

	test("invalidation masks a late rejection from abandoned in-flight work", async () => {
		const native = await FakeNative.create();
		await native.seedAnchor(anchor());
		const store = configuredStore([]);
		let rejectReconcile!: (error: Error) => void;
		let signalStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			signalStarted = resolve;
		});
		store.onReconcile = () =>
			new Promise<void>((_resolve, reject) => {
				rejectReconcile = reject;
				signalStarted();
			});
		const manager = adapter(native, store);
		const running = manager.syncNow({ profileId: PROFILE_ID });
		await started;
		manager.invalidateProfile(PROFILE_ID);
		rejectReconcile(new Error("late database rejection"));
		await expect(running).rejects.toThrow("active profile changed");
		expect(store.config.lastError).toBeNull();
		expect(native.createCalls).toEqual([]);
	});

	test("closing a profile waits for its cancelled sync before closing the store", async () => {
		const native = await FakeNative.create();
		await native.seedAnchor(anchor());
		const store = configuredStore([]);
		let finishReconcile!: () => void;
		let signalStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			signalStarted = resolve;
		});
		store.onReconcile = () =>
			new Promise<void>((resolve) => {
				finishReconcile = resolve;
				signalStarted();
			});
		const manager = adapter(native, store);
		const running = manager.syncNow({ profileId: PROFILE_ID });
		await started;
		const queued = manager.connect({ profileId: PROFILE_ID });
		const queuedCancellation = queued.then(
			() => null,
			(error: unknown) => error,
		);

		let closeFinished = false;
		const closing = manager.closeProfile(PROFILE_ID).then(() => {
			closeFinished = true;
		});
		await Promise.resolve();
		expect(closeFinished).toBe(false);
		expect(store.closed).toBe(false);

		finishReconcile();
		await expect(running).rejects.toThrow("active profile changed");
		const queuedError = await queuedCancellation;
		expect(queuedError).toBeInstanceOf(Error);
		expect((queuedError as Error).message).toContain("active profile changed");
		await closing;
		expect(store.closed).toBe(true);
	});

	test("unsupported iOS OAuth maps to an unavailable status", async () => {
		const native = await FakeNative.create();
		native.platform = "ios";
		native.oauthSupported = false;
		native.configured = false;
		const status = await adapter(native, new FakeStore()).getStatus({
			profileId: PROFILE_ID,
		});
		expect(status.available).toBe(false);
		expect(status.unavailableReason).toContain("unavailable");
	});

	test("reset deletes only the exact namespace and removes the anchor as its revocation barrier", async () => {
		const events: string[] = [];
		const native = await FakeNative.create(events);
		const store = configuredStore(events);
		const packageName = await googleDriveSyncPackageFilename({
			accountNamespace: ACCOUNT,
			sourceDeviceId: LOCAL_DEVICE,
			packageId: "pkg-reset",
			contentDigest: ZERO_DIGEST,
		});
		const anchorName = await googleDriveSyncAnchorFilename(ACCOUNT);
		native.files.push(
			{ metadata: metadata("pkg-a", packageName), body: "" },
			{ metadata: metadata("unrelated", "someone-elses-file.bin"), body: "" },
			{ metadata: metadata("anchor-a", anchorName), body: "" },
			{ metadata: metadata("pkg-b", packageName), body: "" },
		);

		await adapter(native, store).resetCloudData({ profileId: PROFILE_ID });
		expect(native.deleteCalls).toEqual(["anchor-a", "pkg-a", "pkg-b"]);
		expect(native.files.map((file) => file.metadata.id)).toEqual(["unrelated"]);
		expect(store.config.accountNamespace).toBeNull();
		expect(store.bootstrap.authorityDeviceId).toBeNull();
		expect(native.vaultPresent).toBe(false);
		expect(native.connected).toBe(false);
		expect(events.at(-1)).toBe("disconnect");
	});

	test("a partially failed anchor-first reset retries remaining packages before local teardown", async () => {
		const events: string[] = [];
		const native = await FakeNative.create(events);
		const store = configuredStore(events);
		const packageName = await googleDriveSyncPackageFilename({
			accountNamespace: ACCOUNT,
			sourceDeviceId: LOCAL_DEVICE,
			packageId: "pkg-reset-retry",
			contentDigest: ZERO_DIGEST,
		});
		const anchorName = await googleDriveSyncAnchorFilename(ACCOUNT);
		native.files.push(
			{ metadata: metadata("pkg-a", packageName), body: "" },
			{ metadata: metadata("unrelated", "someone-elses-file.bin"), body: "" },
			{ metadata: metadata("anchor-a", anchorName), body: "" },
			{ metadata: metadata("pkg-b", packageName), body: "" },
		);
		native.deleteFailuresRemaining.set("pkg-b", 1);
		const manager = adapter(native, store);

		await expect(manager.resetCloudData({ profileId: PROFILE_ID })).rejects.toThrow(
			"injected delete failure",
		);
		expect(native.deleteCalls).toEqual(["anchor-a", "pkg-a", "pkg-b"]);
		expect(native.files.map((file) => file.metadata.id)).toEqual([
			"unrelated",
			"pkg-b",
		]);
		expect(store.config).toMatchObject({
			enabled: true,
			accountNamespace: ACCOUNT,
		});
		expect(store.bootstrap).toMatchObject({
			authorityDeviceId: LOCAL_DEVICE,
			anchorRequired: true,
		});
		expect(native.vaultPresent).toBe(true);
		expect(events).not.toContain("vault-delete");

		await manager.resetCloudData({ profileId: PROFILE_ID });
		expect(native.deleteCalls).toEqual([
			"anchor-a",
			"pkg-a",
			"pkg-b",
			"pkg-b",
		]);
		expect(native.files.map((file) => file.metadata.id)).toEqual(["unrelated"]);
		const anchorDelete = events.indexOf("delete:anchor-a");
		const finalPackageDelete = events.lastIndexOf("delete:pkg-b");
		const configReset = events.findIndex(
			(event, index) => index > finalPackageDelete && event === "config:unchanged:false",
		);
		const bootstrapReset = events.findIndex(
			(event, index) => index > anchorDelete && event === "bootstrap:false:null",
		);
		const vaultDelete = events.lastIndexOf("vault-delete");
		expect(anchorDelete).toBeGreaterThanOrEqual(0);
		expect(finalPackageDelete).toBeGreaterThan(anchorDelete);
		expect(configReset).toBeGreaterThan(finalPackageDelete);
		expect(bootstrapReset).toBeGreaterThan(configReset);
		expect(vaultDelete).toBeGreaterThan(bootstrapReset);
		expect(store.config.accountNamespace).toBeNull();
		expect(store.bootstrap.authorityDeviceId).toBeNull();
		expect(native.vaultPresent).toBe(false);
		expect(native.connected).toBe(false);
		expect(events.lastIndexOf("disconnect")).toBeGreaterThan(vaultDelete);
	});

	test("reset sweeps a package uploaded after the anchor deletion before local teardown", async () => {
		const events: string[] = [];
		const native = await FakeNative.create(events);
		const store = configuredStore(events);
		const packageName = await googleDriveSyncPackageFilename({
			accountNamespace: ACCOUNT,
			sourceDeviceId: LOCAL_DEVICE,
			packageId: "pkg-reset-race",
			contentDigest: ZERO_DIGEST,
		});
		const anchorName = await googleDriveSyncAnchorFilename(ACCOUNT);
		native.files.push(
			{ metadata: metadata("pkg-initial", packageName), body: "" },
			{ metadata: metadata("anchor-initial", anchorName), body: "" },
		);
		let injected = false;
		native.afterDelete = (fileId) => {
			if (fileId !== "anchor-initial" || injected) return;
			injected = true;
			native.files.push({
				metadata: metadata("pkg-late", packageName),
				body: "",
			});
		};

		await adapter(native, store).resetCloudData({ profileId: PROFILE_ID });

		expect(native.deleteCalls).toEqual([
			"anchor-initial",
			"pkg-initial",
			"pkg-late",
		]);
		expect(native.files).toHaveLength(0);
		expect(store.config.accountNamespace).toBeNull();
		expect(native.vaultPresent).toBe(false);
		expect(native.connected).toBe(false);
	});

	test("reset fails without deleting local identity or key when remote uploads never become quiet", async () => {
		const events: string[] = [];
		const native = await FakeNative.create(events);
		const store = configuredStore(events);
		const packageName = await googleDriveSyncPackageFilename({
			accountNamespace: ACCOUNT,
			sourceDeviceId: LOCAL_DEVICE,
			packageId: "pkg-reset-busy",
			contentDigest: ZERO_DIGEST,
		});
		const anchorName = await googleDriveSyncAnchorFilename(ACCOUNT);
		native.files.push(
			{ metadata: metadata("pkg-busy-0", packageName), body: "" },
			{ metadata: metadata("anchor-busy", anchorName), body: "" },
		);
		let nextLateId = 1;
		native.afterDelete = () => {
			native.files.push({
				metadata: metadata(`pkg-busy-${nextLateId++}`, packageName),
				body: "",
			});
		};

		await expect(
			adapter(native, store).resetCloudData({ profileId: PROFILE_ID }),
		).rejects.toThrow("stable empty state");

		expect(store.config).toMatchObject({
			enabled: true,
			accountNamespace: ACCOUNT,
		});
		expect(store.bootstrap).toMatchObject({
			authorityDeviceId: LOCAL_DEVICE,
			anchorRequired: true,
		});
		expect(native.vaultPresent).toBe(true);
		expect(native.connected).toBe(true);
		expect(events).not.toContain("vault-delete");
		expect(events).not.toContain("disconnect");
		expect(native.files.length).toBeGreaterThan(0);
	});

	test("a successful reset disconnects and can create a fresh Windows authority", async () => {
		const events: string[] = [];
		const native = await FakeNative.create(events);
		const store = configuredStore(events);
		await native.seedAnchor(anchor(), "old-anchor");
		const manager = adapter(native, store);

		const resetStatus = await manager.resetCloudData({ profileId: PROFILE_ID });
		expect(resetStatus.phase).toBe("disconnected");
		expect(resetStatus.googleConnected).toBe(false);
		expect(resetStatus.vaultState).toBe("none");

		const connectedStatus = await manager.connect({ profileId: PROFILE_ID });
		expect(connectedStatus.phase).toBe("paired");
		expect(connectedStatus.googleConnected).toBe(true);
		expect(connectedStatus.vaultState).toBe("ready");
		expect(store.config).toMatchObject({
			enabled: true,
			accountNamespace: ACCOUNT,
		});
		expect(store.bootstrap).toMatchObject({
			authorityDeviceId: LOCAL_DEVICE,
			anchorRequired: true,
		});
		expect(native.vaultPresent).toBe(true);
		expect(native.files).toHaveLength(1);
		expect(native.files[0].metadata.name).toBe(
			await googleDriveSyncAnchorFilename(ACCOUNT),
		);
	});
});

describe("immutable package reuse", () => {
	test("one cycle downloads each package body once and still re-reads the anchor", async () => {
		const events: string[] = [];
		const native = await FakeNative.create(events);
		await native.seedAnchor(anchor());
		const remote = await syncPackage(ACCOUNT, AUTHORITY_DEVICE, [
			await operation(ACCOUNT, AUTHORITY_DEVICE, 1, "remote-entity"),
		]);
		await native.seedPackage(remote, "package-1");
		const store = configuredStore(events);

		await adapter(native, store).syncNow({ profileId: PROFILE_ID });

		// A cycle loads the inventory three times. The anchor is the freshness
		// signal every rollback and race check depends on, so it is still re-read.
		expect(
			events.filter((event) => event === "download:anchor-id").length,
		).toBeGreaterThan(1);
		// The package body is content addressed and immutable, so it is decrypted
		// and verified once and reused for the remaining loads.
		expect(events.filter((event) => event === "download:package-1")).toHaveLength(1);
		expect(store.config.lastError).toBeNull();
	});

	test("a later cycle on the same controller reuses verified package bodies", async () => {
		const events: string[] = [];
		const native = await FakeNative.create(events);
		await native.seedAnchor(anchor());
		const remote = await syncPackage(ACCOUNT, AUTHORITY_DEVICE, [
			await operation(ACCOUNT, AUTHORITY_DEVICE, 1, "remote-entity"),
		]);
		await native.seedPackage(remote, "package-1");
		const store = configuredStore(events);
		const sync = adapter(native, store);

		await sync.syncNow({ profileId: PROFILE_ID });
		await sync.syncNow({ profileId: PROFILE_ID });

		expect(events.filter((event) => event === "download:package-1")).toHaveLength(1);
		expect(store.config.lastError).toBeNull();
	});

	test("a newly published package is still downloaded while cached bodies are reused", async () => {
		const events: string[] = [];
		const native = await FakeNative.create(events);
		await native.seedAnchor(anchor());
		const first = await syncPackage(ACCOUNT, AUTHORITY_DEVICE, [
			await operation(ACCOUNT, AUTHORITY_DEVICE, 1, "remote-entity"),
		]);
		await native.seedPackage(first, "package-1");
		const store = configuredStore(events);
		const sync = adapter(native, store);

		await sync.syncNow({ profileId: PROFILE_ID });

		const second = await syncPackage(
			ACCOUNT,
			AUTHORITY_DEVICE,
			[await operation(ACCOUNT, AUTHORITY_DEVICE, 2, "second-entity")],
			first.contentDigest,
		);
		await native.seedPackage(second, "package-2");
		await sync.syncNow({ profileId: PROFILE_ID });

		expect(events.filter((event) => event === "download:package-1")).toHaveLength(1);
		expect(events.filter((event) => event === "download:package-2")).toHaveLength(1);
		expect(store.config.lastError).toBeNull();
	});
});

/** A store that can list its apply receipts, as the real one does. */
class ReceiptStore extends FakeStore {
	async listAppliedPackageDigests() {
		return new Map(this.appliedDigests);
	}
}

describe("bounded package memory", () => {
	async function seededHistory(events: string[]) {
		const native = await FakeNative.create(events);
		await native.seedAnchor(anchor());
		const first = await syncPackage(ACCOUNT, AUTHORITY_DEVICE, [
			await operation(ACCOUNT, AUTHORITY_DEVICE, 1, "first-entity"),
		]);
		const second = await syncPackage(
			ACCOUNT,
			AUTHORITY_DEVICE,
			[await operation(ACCOUNT, AUTHORITY_DEVICE, 2, "second-entity")],
			first.contentDigest,
		);
		await native.seedPackage(first, "package-1");
		await native.seedPackage(second, "package-2");
		return native;
	}

	function receiptStore(events: string[]): ReceiptStore {
		const template = configuredStore(events);
		return new ReceiptStore(events, { config: template.config, bootstrap: template.bootstrap });
	}

	test("a restarted controller checks applied history from headers alone", async () => {
		const events: string[] = [];
		const native = await seededHistory(events);
		const store = receiptStore(events);

		await adapter(native, store).syncNow({ profileId: PROFILE_ID });
		expect(store.applied.size).toBe(2);

		// What a relaunch sees: nothing in memory, every body on disk. Reading the
		// bodies back to rebuild the inventory is what held the whole remote
		// history in the webview and got it killed on iOS.
		store.bodyReads = 0;
		const appliesBefore = events.filter((event) => event.startsWith("apply:")).length;
		await adapter(native, store).syncNow({ profileId: PROFILE_ID });

		expect(store.bodyReads).toBe(0);
		expect(events.filter((event) => event.startsWith("download:package"))).toHaveLength(2);
		expect(events.filter((event) => event.startsWith("apply:")).length).toBe(appliesBefore);
		expect(store.config.lastError).toBeNull();
	});

	test("a new package is loaded and applied while applied ones stay unread", async () => {
		const events: string[] = [];
		const native = await seededHistory(events);
		const store = receiptStore(events);
		await adapter(native, store).syncNow({ profileId: PROFILE_ID });

		const [, second] = [...store.remotePackageCache.values()].map(
			(body) => JSON.parse(body) as SyncPackage,
		);
		const third = await syncPackage(
			ACCOUNT,
			AUTHORITY_DEVICE,
			[await operation(ACCOUNT, AUTHORITY_DEVICE, 3, "third-entity")],
			second.contentDigest,
		);
		await native.seedPackage(third, "package-3");
		store.bodyReads = 0;
		await adapter(native, store).syncNow({ profileId: PROFILE_ID });

		expect(store.applied.has(third.packageId)).toBe(true);
		expect(store.bodyReads).toBe(1);
		expect(store.config.lastError).toBeNull();
	});

	test("a receipt for different content under the same package id stops the sync", async () => {
		const events: string[] = [];
		const native = await seededHistory(events);
		const store = receiptStore(events);
		await adapter(native, store).syncNow({ profileId: PROFILE_ID });

		const [packageId] = [...store.appliedDigests.keys()];
		store.appliedDigests.set(packageId, "0".repeat(64));

		await expect(adapter(native, store).syncNow({ profileId: PROFILE_ID })).rejects.toThrow(
			"identifies different content",
		);
	});

	test("a stored header that does not reproduce its filename is re-downloaded", async () => {
		const events: string[] = [];
		const native = await seededHistory(events);
		const store = receiptStore(events);
		await adapter(native, store).syncNow({ profileId: PROFILE_ID });

		for (const [key, body] of store.remotePackageCache) {
			const value = JSON.parse(body) as Record<string, unknown>;
			store.remotePackageCache.set(key, JSON.stringify({ ...value, packageId: "pkg-forged" }));
		}
		await adapter(native, store).syncNow({ profileId: PROFILE_ID });

		expect(events.filter((event) => event.startsWith("download:package"))).toHaveLength(4);
		expect(store.config.lastError).toBeNull();
	});
});
