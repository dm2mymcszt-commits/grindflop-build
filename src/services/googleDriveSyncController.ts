import {
	SyncProtocolError,
	parseAndVerifySyncPackage,
	sha256HexSchema,
	type ApplySyncPackageResult,
	type SyncPackage,
} from "./cloudSync";
import { translate } from "../utils/translate";
import { getDeviceName, resolveGoogleDriveSyncDeviceId } from "./backupPeers";
import {
	getActiveChatContactIndexUser,
	type ContactIndexSyncScope,
} from "./chatContactIndex";
import { getActiveChatDbUser } from "./chatDb";
import {
	getActiveInterestViewsAccount,
	getInterestViewsAccountForUser,
} from "./interestViewsStore";
import type {
	GoogleDriveMediaPolicyInput,
	GoogleDrivePairingCode,
	GoogleDrivePairingCodeInput,
	GoogleDriveSyncAdapter,
	GoogleDriveSyncError,
	GoogleDriveSyncProfileInput,
	GoogleDriveSyncStatus,
	GoogleDriveSyncStatusListener,
	GoogleDriveSyncStep,
} from "./googleDriveSync";
import {
	GoogleDriveNativeError,
	googleDriveNative,
	normalizeGoogleDriveNativeError,
	toGoogleDriveProfileId,
	type GoogleDriveConfigStatus,
	type GoogleDriveConnectionStatus,
	type GoogleDriveFileMetadata,
	type GoogleDriveNativeBridge,
	type GoogleDriveProfileId,
} from "./googleDriveSyncNative";
import {
	openGoogleDriveSyncStore,
	type CachedRemotePackageHeader,
	type GoogleDriveSyncBootstrapState,
	type GoogleDriveSyncPendingCounts,
	type GoogleDriveSyncStore,
	type GoogleDriveSyncStoreConfig,
	type OutboundGoogleDriveSyncPackage,
} from "./googleDriveSyncStore";
import {
	GOOGLE_DRIVE_SYNC_ANCHOR_KIND,
	GOOGLE_DRIVE_SYNC_WIRE_VERSION,
	MAX_GOOGLE_DRIVE_SYNC_ANCHOR_BYTES,
	MAX_GOOGLE_DRIVE_SYNC_PLAINTEXT_PACKAGE_BYTES,
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
	googleDriveSyncPackageFilename,
	type GoogleDriveSyncAnchorV1,
	type GoogleDriveSyncPairingSourceHeadV1,
} from "./googleDriveSyncWire";

const MAX_REMOTE_READ_ATTEMPTS = 3;
const REMOTE_READ_RETRY_DELAYS_MS = [120, 350] as const;
const MAX_RESET_DELETE_PASSES = 6;
const REQUIRED_RESET_EMPTY_OBSERVATIONS = 2;
const RESET_QUIET_CHECK_DELAY_MS = 350;

export type GoogleDriveSyncControllerStore = Pick<
	GoogleDriveSyncStore,
	| "close"
	| "getConfig"
	| "updateConfig"
	| "getLocalSourceDeviceId"
	| "hasPriorLocalSyncState"
	| "bindLocalSourceDeviceId"
	| "getBootstrapState"
	| "updateBootstrapState"
	| "getOutboundHead"
	| "commitInboundHeads"
	| "listInboundHeads"
	| "getLocalOriginSequence"
	| "reconcileCurrentData"
	| "getPendingCounts"
	| "supersedeUnuploadedEntityOperations"
	| "createNextOutboundPackage"
	| "listPendingOutboundPackages"
	| "markOutboundPackageUploaded"
	| "applyIncomingPackage"
	| "clearAccountState"
> &
	Partial<
		Pick<
			GoogleDriveSyncStore,
			| "getStatusSnapshot"
			| "readCachedRemotePackages"
			| "readCachedRemotePackageHeaders"
			| "writeCachedRemotePackages"
			| "pruneCachedRemotePackages"
			| "listAppliedPackageDigests"
		>
	> &
	Partial<Pick<GoogleDriveSyncStore, "recordCycleTimings">>;

export type GoogleDriveSyncControllerStoreFactory = (
	profileId: number,
) => Promise<GoogleDriveSyncControllerStore>;

export interface GoogleDriveSyncControllerDependencies {
	native?: GoogleDriveNativeBridge;
	storeFactory?: GoogleDriveSyncControllerStoreFactory;
	now?: () => number;
	sleep?: (milliseconds: number) => Promise<void>;
	generateNamespace?: () => string;
	isActiveProfile?: (profileId: number) => boolean;
	onRemoteApplied?: (profileId: number) => void | Promise<void>;
	deviceId?: (boundDeviceId: string | null, allowCreate: boolean) => string | null;
	deviceName?: () => string;
	contactScope?: () => ContactIndexSyncScope;
}

type RequiredControllerDependencies = Required<GoogleDriveSyncControllerDependencies>;

const CYCLE_STEP_BY_BUCKET: Readonly<Record<string, GoogleDriveSyncStep>> = {
	reconcile: "scanning",
	inventory: "reading",
	apply: "applying",
	upload: "uploading",
};

function remotePackageCacheKey(
	accountNamespace: string,
	metadata: GoogleDriveFileMetadata,
): string {
	// Packages are immutable and content addressed: the authenticated filename is
	// derived from the namespace, source device, package id and content digest,
	// and #downloadPackage rejects any file whose verified content does not
	// reproduce that exact name. Identical identity therefore implies identical
	// verified content, so a decoded package is safe to memoize against this key.
	// Length prefixes keep the key injective without relying on a separator
	// that cannot occur inside a Drive id, filename, size or checksum.
	return [
		accountNamespace,
		metadata.id,
		metadata.name,
		metadata.size ?? "",
		metadata.md5Checksum ?? "",
	]
		.map((part) => `${part.length}:${part}`)
		.join("|");
}

type RemoteInventory = Readonly<{
	allExactFiles: readonly ClassifiedRemoteFile[];
	anchor: GoogleDriveSyncAnchorV1 | null;
	anchorFiles: readonly ClassifiedRemoteFile[];
	packages: readonly RemotePackage[];
}>;

type ClassifiedRemoteFile = Readonly<{
	metadata: GoogleDriveFileMetadata;
	kind: "anchor" | "package";
}>;

/** A remote package's identity and chain fields: all an inventory needs to check. */
type RemotePackageHeader = Readonly<{
	packageId: string;
	accountNamespace: string;
	sourceDeviceId: string;
	sequenceRange: Readonly<{ start: number; end: number }>;
	contentDigest: string;
	previousPackageDigest: string | null;
}>;

/**
 * A remote package as an inventory holds it: its header, never its body.
 * Holding bodies meant holding the entire remote history, hundreds of
 * megabytes, which iOS answers by killing the web content process. A body is
 * loaded, verified and dropped when a package has to be applied or compared.
 */
type RemotePackage = Readonly<{
	metadata: GoogleDriveFileMetadata;
	cacheKey: string;
	syncPackage: RemotePackageHeader;
}>;

/** A package body whose content digest and authenticated filename have been verified. */
type VerifiedRemotePackage = Readonly<{
	metadata: GoogleDriveFileMetadata;
	syncPackage: SyncPackage;
	serialized: string;
}>;

function headerOf(syncPackage: SyncPackage): RemotePackageHeader {
	return {
		packageId: syncPackage.packageId,
		accountNamespace: syncPackage.accountNamespace,
		sourceDeviceId: syncPackage.sourceDeviceId,
		sequenceRange: {
			start: syncPackage.sequenceRange.start,
			end: syncPackage.sequenceRange.end,
		},
		contentDigest: syncPackage.contentDigest,
		previousPackageDigest: syncPackage.previousPackageDigest,
	};
}

function sameHeader(left: RemotePackageHeader, right: RemotePackageHeader): boolean {
	return (
		left.packageId === right.packageId &&
		left.accountNamespace === right.accountNamespace &&
		left.sourceDeviceId === right.sourceDeviceId &&
		left.sequenceRange.start === right.sequenceRange.start &&
		left.sequenceRange.end === right.sequenceRange.end &&
		left.contentDigest === right.contentDigest &&
		left.previousPackageDigest === right.previousPackageDigest
	);
}

/** Shape checks on a stored header; identity is checked against the filename separately. */
function parseCachedHeader(stored: CachedRemotePackageHeader): RemotePackageHeader | null {
	const {
		packageId,
		accountNamespace,
		sourceDeviceId,
		sequenceStart,
		sequenceEnd,
		contentDigest,
		previousPackageDigest,
	} = stored;
	const digest = sha256HexSchema.safeParse(contentDigest);
	const previousDigest = sha256HexSchema.nullable().safeParse(previousPackageDigest);
	if (
		typeof packageId !== "string" ||
		typeof accountNamespace !== "string" ||
		typeof sourceDeviceId !== "string" ||
		!digest.success ||
		!previousDigest.success ||
		typeof sequenceStart !== "number" ||
		typeof sequenceEnd !== "number" ||
		!Number.isSafeInteger(sequenceStart) ||
		!Number.isSafeInteger(sequenceEnd) ||
		sequenceStart < 1 ||
		sequenceEnd < sequenceStart
	) {
		return null;
	}
	return {
		packageId,
		accountNamespace,
		sourceDeviceId,
		sequenceRange: { start: sequenceStart, end: sequenceEnd },
		contentDigest: digest.data,
		previousPackageDigest: previousDigest.data,
	};
}

type CycleResult = Readonly<{
	remoteMutations: number;
}>;

class GoogleDriveSyncCancelledError extends Error {
	constructor() {
		super("Google Drive sync was cancelled because the active profile changed");
		this.name = "GoogleDriveSyncCancelledError";
	}
}

export class GoogleDriveSyncControllerError extends Error {
	readonly requiresReauthentication: boolean;
	readonly cause?: unknown;

	constructor(
		message: string,
		options: Readonly<{ requiresReauthentication?: boolean; cause?: unknown }> = {},
	) {
		super(message);
		this.name = "GoogleDriveSyncControllerError";
		this.requiresReauthentication = options.requiresReauthentication ?? false;
		this.cause = options.cause;
	}
}

class GoogleDriveSyncAnchorValidationError extends GoogleDriveSyncControllerError {
	readonly reason: "absent" | "changed";

	constructor(message: string, reason: "absent" | "changed") {
		super(message);
		this.name = "GoogleDriveSyncAnchorValidationError";
		this.reason = reason;
	}
}

function defaultSleep(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function defaultNamespace(): string {
	const random = globalThis.crypto?.randomUUID?.();
	if (!random) {
		throw new GoogleDriveSyncControllerError(
			"Secure random generation is unavailable; a sync namespace cannot be created",
		);
	}
	return `ns-${random}`;
}

function defaultIsActiveProfile(profileId: number): boolean {
	return (
		getActiveChatDbUser() === profileId &&
		getActiveChatContactIndexUser() === profileId &&
		getActiveInterestViewsAccount() === getInterestViewsAccountForUser(profileId)
	);
}

function dependenciesWithDefaults(
	dependencies: GoogleDriveSyncControllerDependencies,
): RequiredControllerDependencies {
	return {
		native: dependencies.native ?? googleDriveNative,
		storeFactory: dependencies.storeFactory ?? openGoogleDriveSyncStore,
		now: dependencies.now ?? Date.now,
		sleep: dependencies.sleep ?? defaultSleep,
		generateNamespace: dependencies.generateNamespace ?? defaultNamespace,
		isActiveProfile: dependencies.isActiveProfile ?? defaultIsActiveProfile,
		onRemoteApplied: dependencies.onRemoteApplied ?? (() => undefined),
		deviceId:
			dependencies.deviceId ??
			((boundDeviceId, allowCreate) =>
				resolveGoogleDriveSyncDeviceId(boundDeviceId, allowCreate)),
		deviceName: dependencies.deviceName ?? getDeviceName,
		// A controller built without the setting keeps today's behaviour.
		contactScope: dependencies.contactScope ?? (() => "everything"),
	};
}

function unavailableReason(config: GoogleDriveConfigStatus): string | undefined {
	if (config.configured && config.oauthSupported) return undefined;
	return (
		config.problem ??
		(config.oauthSupported
			? translate("data_backup.drive_sync.errors.oauth_not_configured", {
					defaultValue: "Google Drive OAuth is not configured in this build.",
				})
			: translate("data_backup.drive_sync.errors.oauth_unsupported", {
					defaultValue: "Google Drive OAuth is not supported on {{platform}}.",
					platform: config.platform,
				}))
	);
}

function asStatusError(error: unknown): GoogleDriveSyncError {
	if (error instanceof GoogleDriveSyncControllerError) {
		return {
			message: error.message,
			requiresReauthentication: error.requiresReauthentication || undefined,
		};
	}
	if (error instanceof GoogleDriveNativeError) {
		return {
			message: error.message,
			requiresReauthentication: error.requiresReauthentication || undefined,
		};
	}
	return {
		message:
			error instanceof Error
				? error.message
				: translate("data_backup.drive_sync.errors.failed", { defaultValue: "Google Drive sync failed" }),
	};
}

function isTransientRemoteReadError(error: unknown): boolean {
	const normalized = normalizeGoogleDriveNativeError(error);
	return normalized.code === "transport" || normalized.code === "remote";
}

function sameAnchor(
	left: GoogleDriveSyncAnchorV1,
	right: GoogleDriveSyncAnchorV1,
): boolean {
	return (
		left.kind === right.kind &&
		left.version === right.version &&
		left.accountNamespace === right.accountNamespace &&
		left.bootstrapAuthorityDeviceId === right.bootstrapAuthorityDeviceId &&
		left.bootstrapSequenceEnd === right.bootstrapSequenceEnd &&
		left.bootstrapHeadDigest === right.bootstrapHeadDigest &&
		left.createdAtMs === right.createdAtMs
	);
}

function anchorMatchesBootstrap(
	anchor: GoogleDriveSyncAnchorV1,
	bootstrap: GoogleDriveSyncBootstrapState,
): boolean {
	return (
		anchor.bootstrapAuthorityDeviceId === bootstrap.authorityDeviceId &&
		anchor.bootstrapSequenceEnd === bootstrap.authoritySequenceEnd &&
		anchor.bootstrapHeadDigest === bootstrap.authorityHeadDigest
	);
}

function compareRemotePackages(left: RemotePackage, right: RemotePackage): number {
	return (
		left.syncPackage.sourceDeviceId.localeCompare(right.syncPackage.sourceDeviceId) ||
		left.syncPackage.sequenceRange.start - right.syncPackage.sequenceRange.start ||
		left.syncPackage.contentDigest.localeCompare(right.syncPackage.contentDigest)
	);
}

function observedSourceHeads(
	packages: readonly RemotePackage[],
): GoogleDriveSyncPairingSourceHeadV1[] {
	const latest = new Map<string, GoogleDriveSyncPairingSourceHeadV1>();
	for (const remote of packages) {
		const syncPackage = remote.syncPackage;
		const current = latest.get(syncPackage.sourceDeviceId);
		if (!current || syncPackage.sequenceRange.end > current.sequenceEnd) {
			latest.set(syncPackage.sourceDeviceId, {
				sourceDeviceId: syncPackage.sourceDeviceId,
				sequenceEnd: syncPackage.sequenceRange.end,
				contentDigest: syncPackage.contentDigest,
			});
		}
	}
	return Array.from(latest.values()).sort((left, right) =>
		left.sourceDeviceId < right.sourceDeviceId
			? -1
			: left.sourceDeviceId > right.sourceDeviceId
				? 1
				: 0,
	);
}

function compareFileIds(left: ClassifiedRemoteFile, right: ClassifiedRemoteFile): number {
	return left.metadata.id.localeCompare(right.metadata.id);
}

function sameLocalPackage(
	remote: VerifiedRemotePackage,
	local: OutboundGoogleDriveSyncPackage,
): boolean {
	return (
		remote.serialized === local.serialized &&
		remote.syncPackage.packageId === local.syncPackage.packageId &&
		remote.syncPackage.contentDigest === local.syncPackage.contentDigest
	);
}

/**
 * One profile's serialized controller. It is intentionally not registered with
 * the UI here; lifecycle integration can install the exported manager later.
 */
export class GoogleDriveSyncProfileController {
	readonly profileId: number;
	readonly nativeProfileId: GoogleDriveProfileId;

	readonly #dependencies: RequiredControllerDependencies;
	readonly #listeners = new Set<GoogleDriveSyncStatusListener>();
	#storePromise: Promise<GoogleDriveSyncControllerStore> | null = null;
	#queue: Promise<void> = Promise.resolve();
	#coalescedSync: Promise<GoogleDriveSyncStatus> | null = null;
	// Package headers memoized by content-addressed identity. One sync cycle
	// loads the inventory three times and the five-minute catch-up reloads the
	// same history again; without this each pass re-read the entire history.
	// Headers only: see RemotePackage.
	readonly #packageCache = new Map<string, RemotePackage>();
	// Diagnostic only. Populated for the duration of one sync cycle so slow
	// phases can be identified from the durable store instead of guessed at.
	#cycleTimings: Map<string, { ms: number; calls: number }> | null = null;
	#generation = 0;
	#closed = false;
	#status: GoogleDriveSyncStatus;

	constructor(profileId: number, dependencies: RequiredControllerDependencies) {
		this.nativeProfileId = toGoogleDriveProfileId(profileId);
		this.profileId = profileId;
		this.#dependencies = dependencies;
		this.#status = this.#blankStatus();
	}

	#timedPhase<T>(bucket: string, work: () => Promise<T>): Promise<T> {
		const step = CYCLE_STEP_BY_BUCKET[bucket];
		// Restored rather than cleared: these also run outside a sync cycle, such
		// as the inventory read behind a pairing-code export, and the step must
		// not be left showing once the work that set it has finished.
		const previousStep = this.#status.syncStep;
		if (step) this.#setSyncStep(step);
		const timings = this.#cycleTimings;
		const started = Date.now();
		return work().finally(() => {
			if (step) this.#setSyncStep(previousStep);
			if (!timings) return;
			const entry = timings.get(bucket) ?? { ms: 0, calls: 0 };
			entry.ms += Date.now() - started;
			entry.calls += 1;
			timings.set(bucket, entry);
		});
	}

	#countCycleEvent(bucket: string): void {
		const timings = this.#cycleTimings;
		if (!timings) return;
		const entry = timings.get(bucket) ?? { ms: 0, calls: 0 };
		entry.calls += 1;
		timings.set(bucket, entry);
	}

	invalidate(): void {
		this.#generation += 1;
		this.#packageCache.clear();
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.invalidate();
		// Invalidation makes the active operation abandon its result. Waiting for
		// the serialized gate keeps its SQLite/IndexedDB work from racing the
		// account switch that closes and replaces those profile-scoped stores.
		await this.#queue;
		const storePromise = this.#storePromise;
		this.#storePromise = null;
		if (storePromise) await (await storePromise).close();
		this.#listeners.clear();
	}

	subscribe(listener: GoogleDriveSyncStatusListener): () => void {
		this.#listeners.add(listener);
		listener(this.#status);
		return () => this.#listeners.delete(listener);
	}

	// Deliberately not enqueued. Every step here is a read, and serializing a
	// read behind the write queue meant the card could not describe the device
	// until any running cycle finished. On a cold device that is minutes, and it
	// is indistinguishable from a hang: the status is exactly what a user needs
	// while the cycle they are waiting on is still running.
	getStatus(): Promise<GoogleDriveSyncStatus> {
		return (async () => {
			try {
				const generation = this.#generation;
				const [configStatus, connection, store] = await this.#activeAwait(
					Promise.all([
						this.#dependencies.native.configStatus(),
						this.#dependencies.native.connectionStatus(this.nativeProfileId),
						this.#store(),
					]),
					generation,
				);
				// One snapshot that does not wait on the store's write queue. Reading
				// config, bootstrap and counters separately blocked the whole status
				// behind any running reconcile, which is exactly when the user is
				// looking at the card to find out what is happening.
				const snapshot = store.getStatusSnapshot
					? await this.#activeAwait(store.getStatusSnapshot(), generation)
					: null;
				const [config, bootstrap] = snapshot
					? [snapshot.config, snapshot.bootstrap]
					: await this.#activeAwait(
							Promise.all([store.getConfig(), store.getBootstrapState()]),
							generation,
						);
				const pending = snapshot
					? snapshot.pending
					: config.accountNamespace
						? await this.#activeAwait(
								store.getPendingCounts(config.accountNamespace),
								generation,
							)
						: { changes: 0, bytes: 0 };
				const runningPhase =
					this.#status.phase === "syncing" || this.#status.phase === "connecting"
						? this.#status.phase
						: undefined;
				this.#status = {
					...this.#statusFrom(
						configStatus,
						connection,
						config,
						bootstrap,
						pending,
						runningPhase,
					),
					// A concurrent read must not erase the step the running cycle is
					// reporting; that is the only progress the user can see.
					syncStep: runningPhase ? this.#status.syncStep : null,
				};
				this.#publish();
				return this.#status;
			} catch (error) {
				if (error instanceof GoogleDriveSyncCancelledError) return this.#status;
				this.#setError(error);
				return this.#status;
			}
		})();
	}

	connect(): Promise<GoogleDriveSyncStatus> {
		return this.#enqueue(async () => {
			const generation = ++this.#generation;
			this.#setPhase("connecting");
			try {
			const configStatus = await this.#activeAwait(
				this.#dependencies.native.configStatus(),
				generation,
			);
			if (!configStatus.configured || !configStatus.oauthSupported) {
				await this.#refreshStatus(generation, configStatus);
				return this.#status;
			}
			const store = await this.#activeAwait(this.#store(), generation);
			const sourceDeviceId = await this.#resolveLocalSourceDeviceId(store, generation);
			const connection = await this.#activeAwait(
				this.#dependencies.native.connect(this.nativeProfileId),
				generation,
			);
			let config = await this.#activeAwait(store.getConfig(), generation);
			let bootstrap = await this.#activeAwait(store.getBootstrapState(), generation);

			if (config.mediaPolicy !== "off") {
				config = await this.#activeAwait(
					store.updateConfig({ mediaPolicy: "off" }),
					generation,
				);
			}

			if (config.accountNamespace && !connection.vaultKey.present) {
				await this.#refreshStatus(generation, configStatus, connection);
				return this.#status;
			}

			if (!config.accountNamespace) {
				if (configStatus.platform.toLowerCase() !== "windows") {
					// OAuth and E2EE enrollment are separate on a secondary device. Keep
					// Drive connected and expose the pairing-code input without creating a
					// namespace, vault key, anchor, or upload on iOS.
					return this.#refreshStatus(generation, configStatus, connection);
				}
				const namespace = this.#dependencies.generateNamespace();
				const vault = connection.vaultKey.present
					? connection.vaultKey
					: await this.#activeAwait(
							this.#dependencies.native.vaultKeyCreate(this.nativeProfileId),
							generation,
						);
				if (!vault.present) {
					throw new GoogleDriveSyncControllerError("The encrypted sync key was not created");
				}
				// Persist authority before exposing the namespace as enabled. If the
				// process stops between these writes, reconnect safely repeats this step;
				// it can never upload an authority-less sync set.
				bootstrap = await this.#activeAwait(
					store.updateBootstrapState({
						authorityDeviceId: sourceDeviceId,
						authoritySequenceEnd: 0,
						authorityHeadDigest: null,
						bootstrapPending: false,
						anchorRequired: false,
						localBaselineSequence: null,
					}),
					generation,
				);
				config = await this.#activeAwait(
					store.updateConfig({
						enabled: true,
						accountNamespace: namespace,
						mediaPolicy: "off",
						lastError: null,
					}),
					generation,
				);
			} else if (!config.enabled) {
				config = await this.#activeAwait(
					store.updateConfig({ enabled: true, lastError: null }),
					generation,
				);
			}

			void bootstrap;
			// Key creation can change vault state after the OAuth response snapshot.
			// Re-read connection status inside the cycle instead of trusting it.
			await this.#cycle(generation, configStatus, undefined, sourceDeviceId);
			return this.#status;
		} catch (error) {
			if (error instanceof GoogleDriveSyncCancelledError) throw error;
			this.#setError(error);
			throw error;
		}
		});
	}

	syncNow(): Promise<GoogleDriveSyncStatus> {
		if (this.#coalescedSync) return this.#coalescedSync;
		const sync = this.#enqueue(async () => {
			const generation = this.#generation;
			this.#assertActive(generation);
			await this.#cycle(generation);
			return this.#status;
		});
		this.#coalescedSync = sync;
		void sync.finally(() => {
			if (this.#coalescedSync === sync) this.#coalescedSync = null;
		}).catch(() => undefined);
		return sync;
	}

	exportPairingCode(): Promise<GoogleDrivePairingCode> {
		return this.#enqueue(async () => {
			const generation = this.#generation;
			this.#assertActive(generation);
			const store = await this.#activeAwait(this.#store(), generation);
			const [config, bootstrap, connection] = await this.#activeAwait(
				Promise.all([
					store.getConfig(),
					store.getBootstrapState(),
					this.#dependencies.native.connectionStatus(this.nativeProfileId),
				]),
				generation,
			);
			if (!config.accountNamespace || !connection.connected || !connection.vaultKey.present) {
				throw new GoogleDriveSyncControllerError(
					translate("data_backup.drive_sync.errors.pair_needs_first_sync", {
						defaultValue: "Connect and finish the first encrypted sync before creating a pairing code.",
					}),
				);
			}
			if (
				bootstrap.authorityDeviceId === null ||
				bootstrap.bootstrapPending ||
				!bootstrap.anchorRequired
			) {
				throw new GoogleDriveSyncControllerError(
					"The immutable sync anchor is not ready for pairing yet.",
				);
			}
			const sourceDeviceId = await this.#resolveLocalSourceDeviceId(store, generation);
			const inventory = await this.#loadInventory(
				config.accountNamespace,
				generation,
			);
			if (!inventory.anchor || !anchorMatchesBootstrap(inventory.anchor, bootstrap)) {
				throw new GoogleDriveSyncControllerError(
					"The remote sync anchor does not match this device; pairing was stopped.",
				);
			}
			this.#assertAuthorityCutoff(
				inventory.packages.filter(
					(remote) =>
						remote.syncPackage.sourceDeviceId === bootstrap.authorityDeviceId,
				),
				bootstrap,
			);
			await this.#assertRemoteHistoryPresent(
				store,
				config.accountNamespace,
				sourceDeviceId,
				inventory,
				generation,
			);
			const vaultKey = await this.#activeAwait(
				this.#dependencies.native.vaultKeyExportForPairing(this.nativeProfileId, true),
				generation,
			);
			if (vaultKey.fingerprint !== connection.vaultKey.fingerprint) {
				throw new GoogleDriveSyncControllerError(
					"The exported encryption-key fingerprint changed unexpectedly.",
				);
			}
			const pairingCode = await encodeGoogleDriveSyncPairingCode({
				kind: "free-grind.sync.pairing",
				version: GOOGLE_DRIVE_SYNC_WIRE_VERSION,
				profileId: String(this.profileId),
				accountNamespace: config.accountNamespace,
				vaultKey,
				bootstrapAuthorityDeviceId: bootstrap.authorityDeviceId,
				bootstrapSequenceEnd: bootstrap.authoritySequenceEnd,
				bootstrapHeadDigest: bootstrap.authorityHeadDigest,
				observedSourceHeads: observedSourceHeads(inventory.packages),
			});
			return {
				pairingCode,
				fingerprint: vaultKey.fingerprint,
				expiresAt: null,
			};
		});
	}

	importPairingCode(pairingCode: string): Promise<GoogleDriveSyncStatus> {
		return this.#enqueue(async () => {
			const generation = ++this.#generation;
			this.#assertActive(generation);
			const pairing = await decodeGoogleDriveSyncPairingCode(pairingCode);
			if (pairing.profileId !== String(this.profileId)) {
				throw new GoogleDriveSyncControllerError(
					translate("data_backup.drive_sync.errors.pair_other_profile", {
						defaultValue: "This pairing code belongs to a different GrindFlop profile.",
					}),
				);
			}
			const store = await this.#activeAwait(this.#store(), generation);
			const [config, bootstrap, connection] = await this.#activeAwait(
				Promise.all([
					store.getConfig(),
					store.getBootstrapState(),
					this.#dependencies.native.connectionStatus(this.nativeProfileId),
				]),
				generation,
			);
			if (!connection.connected) {
				throw new GoogleDriveSyncControllerError(
					translate("data_backup.drive_sync.errors.pair_connect_first", {
						defaultValue: "Connect this device to the same Google account before importing the pairing code.",
					}),
				);
			}
			if (config.accountNamespace && config.accountNamespace !== pairing.accountNamespace) {
				throw new GoogleDriveSyncControllerError(
					translate("data_backup.drive_sync.errors.pair_other_set", {
						defaultValue: "This profile is already enrolled in a different encrypted sync set.",
					}),
				);
			}
			if (
				bootstrap.authorityDeviceId !== null &&
				(bootstrap.authorityDeviceId !== pairing.bootstrapAuthorityDeviceId ||
					bootstrap.authoritySequenceEnd !== pairing.bootstrapSequenceEnd ||
					bootstrap.authorityHeadDigest !== pairing.bootstrapHeadDigest)
			) {
				throw new GoogleDriveSyncControllerError(
					"The pairing bootstrap identity does not match this profile's saved state.",
				);
			}
			const isNewEnrollment = bootstrap.authorityDeviceId === null;
			const isPendingRetry = bootstrap.bootstrapPending;
			const sourceDeviceId = await this.#resolveLocalSourceDeviceId(store, generation);

			const keyExisted = connection.vaultKey.present;
			let importedKey = false;
			try {
				const vault = await this.#activeAwait(
					this.#dependencies.native.vaultKeyImport(
						this.nativeProfileId,
						pairing.vaultKey.key,
					),
					generation,
				);
				importedKey = !keyExisted;
				if (!vault.present || vault.fingerprint !== pairing.vaultKey.fingerprint) {
					throw new GoogleDriveSyncControllerError(
						"The imported encryption-key fingerprint does not match the pairing code.",
					);
				}

				const inventory = await this.#loadInventory(
					pairing.accountNamespace,
					generation,
				);
				const anchor = inventory.anchor;
				if (
					!anchor ||
					anchor.bootstrapAuthorityDeviceId !== pairing.bootstrapAuthorityDeviceId ||
					anchor.bootstrapSequenceEnd !== pairing.bootstrapSequenceEnd ||
					anchor.bootstrapHeadDigest !== pairing.bootstrapHeadDigest
				) {
					throw new GoogleDriveSyncControllerError(
						"The pairing code does not match the immutable anchor in Google Drive.",
					);
				}
				this.#assertAuthorityCutoff(
					inventory.packages.filter(
						(remote) =>
							remote.syncPackage.sourceDeviceId ===
							pairing.bootstrapAuthorityDeviceId,
					),
					{
						authorityDeviceId: pairing.bootstrapAuthorityDeviceId,
						authoritySequenceEnd: pairing.bootstrapSequenceEnd,
						authorityHeadDigest: pairing.bootstrapHeadDigest,
						bootstrapPending: false,
						anchorRequired: true,
						localBaselineSequence: null,
					},
				);
				this.#assertPairingSourceHeads(
					inventory.packages,
					pairing.observedSourceHeads,
				);
				// Persist the exporter's observation before enabling the namespace. If
				// Drive changes after the check or the process stops during bootstrap,
				// every later cycle still enforces these immutable rollback floors.
				await this.#activeAwait(
					store.commitInboundHeads(
						pairing.accountNamespace,
						pairing.observedSourceHeads,
					),
					generation,
				);

				if (isNewEnrollment) {
					// Snapshot pre-pairing local entities exactly once. A retry must retain
					// this persisted cutoff; expanding it could let bootstrap supersede edits
					// made after the first pairing attempt.
					await this.#activeAwait(
						store.reconcileCurrentData({
							accountNamespace: pairing.accountNamespace,
							sourceDeviceId,
							includeMedia: false,
							contactScope: this.#dependencies.contactScope(),
						}),
						generation,
					);
					const localBaselineSequence = await this.#activeAwait(
						store.getLocalOriginSequence(
							pairing.accountNamespace,
							sourceDeviceId,
						),
						generation,
					);
					await this.#activeAwait(
						store.updateBootstrapState({
							authorityDeviceId: pairing.bootstrapAuthorityDeviceId,
							authoritySequenceEnd: pairing.bootstrapSequenceEnd,
							authorityHeadDigest: pairing.bootstrapHeadDigest,
							bootstrapPending: true,
							anchorRequired: true,
							localBaselineSequence,
						}),
						generation,
					);
				} else if (isPendingRetry) {
					if (bootstrap.localBaselineSequence === null || !bootstrap.anchorRequired) {
						throw new GoogleDriveSyncControllerError(
							"The saved pairing bootstrap is incomplete; reset and pair again.",
						);
					}
				} else if (!bootstrap.anchorRequired) {
					throw new GoogleDriveSyncControllerError(
						"The saved pairing identity is incomplete; reset and pair again.",
					);
				}
				await this.#activeAwait(
					store.updateConfig({
						enabled: true,
						accountNamespace: pairing.accountNamespace,
						mediaPolicy: "off",
						lastError: null,
					}),
					generation,
				);
			} catch (error) {
				if (importedKey) {
					await this.#dependencies.native
						.vaultKeyDelete(this.nativeProfileId, true)
						.catch(() => undefined);
				}
				throw error;
			}

			await this.#cycle(generation, undefined, undefined, sourceDeviceId);
			return this.#status;
		});
	}

	setMediaPolicy(mediaPolicy: "off" | "wifi-only"): Promise<GoogleDriveSyncStatus> {
		return this.#enqueue(async () => {
			const generation = this.#generation;
			this.#assertActive(generation);
			if (mediaPolicy === "wifi-only") {
				throw new GoogleDriveSyncControllerError(
					"Media sync is not available until encrypted blob routing is implemented. Core data remains protected and syncable.",
				);
			}
			const store = await this.#activeAwait(this.#store(), generation);
			await this.#activeAwait(store.updateConfig({ mediaPolicy: "off" }), generation);
			return this.#refreshStatus(generation);
		});
	}

	disconnect(): Promise<GoogleDriveSyncStatus> {
		this.invalidate();
		return this.#enqueue(async () => {
			const generation = this.#generation;
			this.#assertActive(generation);
			const store = await this.#activeAwait(this.#store(), generation);
			await this.#activeAwait(store.updateConfig({ enabled: false }), generation);
			const vault = await this.#activeAwait(
				this.#dependencies.native.vaultKeyStatus(this.nativeProfileId),
				generation,
			);
			if (vault.present) {
				await this.#activeAwait(
					this.#dependencies.native.vaultKeyDelete(this.nativeProfileId, true),
					generation,
				);
			}
			await this.#activeAwait(
				this.#dependencies.native.disconnect(this.nativeProfileId),
				generation,
			);
			return this.#refreshStatus(generation);
		});
	}

	resetCloudData(): Promise<GoogleDriveSyncStatus> {
		this.invalidate();
		return this.#enqueue(async () => {
			const generation = this.#generation;
			this.#assertActive(generation);
			const store = await this.#activeAwait(this.#store(), generation);
			const config = await this.#activeAwait(store.getConfig(), generation);
			if (config.accountNamespace) {
				await this.#deleteAndVerifyRemoteNamespace(
					config.accountNamespace,
					generation,
				);
				// Only after the remote namespace is verifiably gone. A failed or
				// interrupted delete throws above and leaves the local ledger intact
				// so the reset can be retried against real history.
				await this.#activeAwait(
					store.clearAccountState(config.accountNamespace),
					generation,
				);
			}
			await this.#activeAwait(
				store.updateConfig({
					enabled: false,
					accountNamespace: null,
					mediaPolicy: "off",
					lastSuccessfulSyncAt: null,
					lastError: null,
				}),
				generation,
			);
			await this.#activeAwait(
				store.updateBootstrapState({
					authorityDeviceId: null,
					authoritySequenceEnd: 0,
					authorityHeadDigest: null,
					bootstrapPending: false,
					anchorRequired: false,
					localBaselineSequence: null,
				}),
				generation,
			);
			const vault = await this.#activeAwait(
				this.#dependencies.native.vaultKeyStatus(this.nativeProfileId),
				generation,
			);
			if (vault.present) {
				await this.#activeAwait(
					this.#dependencies.native.vaultKeyDelete(this.nativeProfileId, true),
					generation,
				);
			}
			// Leave the UI in the ordinary disconnected state. In particular, a
			// Windows authority can now press Connect to create a fresh random
			// namespace and key instead of being stranded on the pairing screen.
			await this.#activeAwait(
				this.#dependencies.native.disconnect(this.nativeProfileId),
				generation,
			);
			return this.#refreshStatus(generation);
		});
	}

	async #deleteAndVerifyRemoteNamespace(
		accountNamespace: string,
		generation: number,
	): Promise<void> {
		let consecutiveEmptyObservations = 0;
		for (let pass = 0; pass < MAX_RESET_DELETE_PASSES; pass += 1) {
			const files = await this.#listExactFiles(accountNamespace, generation);
			if (files.length === 0) {
				consecutiveEmptyObservations += 1;
				if (
					consecutiveEmptyObservations >= REQUIRED_RESET_EMPTY_OBSERVATIONS
				) {
					return;
				}
			} else {
				consecutiveEmptyObservations = 0;
				const packages = files
					.filter((file) => file.kind === "package")
					.sort(compareFileIds);
				const anchors = files
					.filter((file) => file.kind === "anchor")
					.sort(compareFileIds);
				// The anchor is the revocation barrier. Removing it first makes any
				// newly starting sync fail closed before upload; packages from a sync
				// that was already in flight are caught by the following quiet sweeps.
				for (const file of [...anchors, ...packages]) {
					this.#assertActive(generation);
					await this.#activeAwait(
						this.#dependencies.native.deleteAppData(
							this.nativeProfileId,
							file.metadata.id,
							true,
						),
						generation,
					);
				}
			}

			if (pass + 1 < MAX_RESET_DELETE_PASSES) {
				await this.#activeAwait(
					this.#dependencies.sleep(RESET_QUIET_CHECK_DELAY_MS),
					generation,
				);
			}
		}

		// A device that already passed its pre-upload anchor check can publish a
		// package just after this device deletes the anchor. There is no atomic
		// multi-device delete in Drive appDataFolder, so never claim success or
		// destroy the last local key while the namespace fails to stay empty.
		throw new GoogleDriveSyncControllerError(
			"Cloud deletion could not reach a stable empty state. Another paired device may still be uploading. This device kept its sync identity and encryption key; close or disconnect every other device, then retry.",
		);
	}

	async #resolveLocalSourceDeviceId(
		store: GoogleDriveSyncControllerStore,
		generation: number,
	): Promise<string> {
		const [boundDeviceId, hasPriorSyncState] = await this.#activeAwait(
			Promise.all([
				store.getLocalSourceDeviceId(),
				store.hasPriorLocalSyncState(),
			]),
			generation,
		);
		const candidate = this.#dependencies.deviceId(
			boundDeviceId,
			boundDeviceId === null && !hasPriorSyncState,
		);
		this.#assertActive(generation);
		if (candidate === null) {
			throw new GoogleDriveSyncControllerError(
				"This enrolled sync profile lost its browser device id. Sync stopped before creating a replacement identity.",
			);
		}
		const persisted = await this.#activeAwait(
			store.bindLocalSourceDeviceId(candidate),
			generation,
		);
		if (boundDeviceId !== null && persisted !== boundDeviceId) {
			throw new GoogleDriveSyncControllerError(
				"The browser and Google Drive sync store device ids conflict.",
			);
		}
		return persisted;
	}

	async #cycle(
		generation: number,
		knownConfigStatus?: GoogleDriveConfigStatus,
		knownConnection?: GoogleDriveConnectionStatus,
		knownSourceDeviceId?: string,
	): Promise<CycleResult> {
		this.#assertActive(generation);
		try {
			const configStatus =
				knownConfigStatus ??
				(await this.#activeAwait(this.#dependencies.native.configStatus(), generation));
			if (!configStatus.configured || !configStatus.oauthSupported) {
				await this.#refreshStatus(generation, configStatus);
				return { remoteMutations: 0 };
			}
			const connection =
				knownConnection ??
				(await this.#activeAwait(
					this.#dependencies.native.connectionStatus(this.nativeProfileId),
					generation,
				));
			const store = await this.#activeAwait(this.#store(), generation);
			const [config, initialBootstrap] = await this.#activeAwait(
				Promise.all([store.getConfig(), store.getBootstrapState()]),
				generation,
			);
			if (!config.enabled || !config.accountNamespace || !connection.connected) {
				await this.#refreshStatus(generation, configStatus, connection);
				return { remoteMutations: 0 };
			}
			if (!connection.vaultKey.present) {
				await this.#refreshStatus(generation, configStatus, connection);
				return { remoteMutations: 0 };
			}
			// Only now is there real work to do. Announcing the syncing phase any
			// earlier makes an unenrolled device look busy, and the card disables
			// its setup actions while busy - including the connect button that is
			// the only way to finish enrolling it.
			this.#setPhase("syncing");
			const sourceDeviceId =
				knownSourceDeviceId ??
				(await this.#resolveLocalSourceDeviceId(store, generation));
			if (config.mediaPolicy !== "off") {
				await this.#activeAwait(store.updateConfig({ mediaPolicy: "off" }), generation);
			}

			const accountNamespace = config.accountNamespace;
			const cycleStartedAt = Date.now();
			this.#cycleTimings = new Map();

			// This ordering is the data-loss boundary: offline local state enters the
			// durable outbox before any remote winner can mutate the domain stores.
			await this.#activeAwait(
				this.#timedPhase("reconcile", () =>
					store.reconcileCurrentData({
						accountNamespace,
						sourceDeviceId,
						includeMedia: false,
						contactScope: this.#dependencies.contactScope(),
					}),
				),
				generation,
			);

			let inventory = await this.#loadInventory(accountNamespace, generation);
			let bootstrap = initialBootstrap;
			if (bootstrap.anchorRequired && !inventory.anchor) {
				throw new GoogleDriveSyncControllerError(
					"The required encrypted sync anchor is missing from Google Drive. Nothing was uploaded or deleted; reset/re-pair explicitly to recover.",
				);
			}

			// Recover the narrow crash window where the first authority uploaded its
			// anchor but had not yet persisted the same immutable head locally.
			if (
				inventory.anchor &&
				bootstrap.authorityDeviceId === sourceDeviceId &&
				bootstrap.authoritySequenceEnd === 0 &&
				bootstrap.authorityHeadDigest === null &&
				inventory.anchor.bootstrapAuthorityDeviceId === sourceDeviceId
			) {
				bootstrap = await this.#activeAwait(
					store.updateBootstrapState({
						authoritySequenceEnd: inventory.anchor.bootstrapSequenceEnd,
						authorityHeadDigest: inventory.anchor.bootstrapHeadDigest,
						anchorRequired: true,
					}),
					generation,
				);
			}
			if (inventory.anchor && !anchorMatchesBootstrap(inventory.anchor, bootstrap)) {
				throw new GoogleDriveSyncControllerError(
					"The immutable Google Drive sync anchor conflicts with this profile's bootstrap identity.",
				);
			}
			if (inventory.anchor) {
				this.#assertAuthorityCutoff(
					inventory.packages.filter(
						(remote) =>
							remote.syncPackage.sourceDeviceId === bootstrap.authorityDeviceId,
					),
					bootstrap,
				);
			}
			await this.#assertRemoteHistoryPresent(
				store,
				accountNamespace,
				sourceDeviceId,
				inventory,
				generation,
			);

			let remoteMutations = await this.#applyInventory(
				store,
				accountNamespace,
				sourceDeviceId,
				bootstrap,
				inventory,
				generation,
			);

			// A full domain scan is the most expensive step of a cycle, so it runs
			// again only when the apply above actually journaled remote work. When
			// nothing was applied the domain is unchanged since the reconcile that
			// opened this cycle, and a concurrent local edit is still picked up by
			// the next cycle's leading reconcile, which always runs.
			if (remoteMutations > 0) {
				await this.#activeAwait(
					this.#timedPhase("reconcile", () =>
						store.reconcileCurrentData({
							accountNamespace,
							sourceDeviceId,
							includeMedia: false,
							contactScope: this.#dependencies.contactScope(),
						}),
					),
					generation,
				);
			}

			// Re-read immediately before staging/uploading. A stale local sync database
			// must not append a fork if Drive contains a same-device successor this
			// installation cannot prove came from its own pending ledger.
			bootstrap = await this.#activeAwait(store.getBootstrapState(), generation);
			inventory = await this.#loadInventory(accountNamespace, generation);
			if (bootstrap.anchorRequired) {
				if (!inventory.anchor || !anchorMatchesBootstrap(inventory.anchor, bootstrap)) {
					throw new GoogleDriveSyncControllerError(
						"The immutable sync anchor disappeared or changed before upload.",
					);
				}
			} else if (inventory.anchor && !anchorMatchesBootstrap(inventory.anchor, bootstrap)) {
				throw new GoogleDriveSyncControllerError(
					"The immutable sync anchor changed before first enrollment completed.",
				);
			}
			if (inventory.anchor) {
				this.#assertAuthorityCutoff(
					inventory.packages.filter(
						(remote) =>
							remote.syncPackage.sourceDeviceId === bootstrap.authorityDeviceId,
					),
					bootstrap,
				);
			}
			await this.#assertRemoteHistoryPresent(
				store,
				accountNamespace,
				sourceDeviceId,
				inventory,
				generation,
			);

			while (
				await this.#activeAwait(
					store.createNextOutboundPackage(accountNamespace, sourceDeviceId),
					generation,
				)
			) {
				// The store enforces contiguous runs and the strict plaintext limit.
			}
			await this.#uploadPendingPackages(
				store,
				accountNamespace,
				sourceDeviceId,
				bootstrap.anchorRequired ? bootstrap : null,
				generation,
			);

			bootstrap = await this.#activeAwait(store.getBootstrapState(), generation);
			if (
				bootstrap.authorityDeviceId === sourceDeviceId &&
				!bootstrap.anchorRequired
			) {
				const head = await this.#activeAwait(
					store.getOutboundHead(accountNamespace, sourceDeviceId),
					generation,
				);
				const desiredAnchor: GoogleDriveSyncAnchorV1 = {
					kind: GOOGLE_DRIVE_SYNC_ANCHOR_KIND,
					version: GOOGLE_DRIVE_SYNC_WIRE_VERSION,
					accountNamespace,
					bootstrapAuthorityDeviceId: sourceDeviceId,
					bootstrapSequenceEnd: head?.sequenceEnd ?? 0,
					bootstrapHeadDigest: head?.contentDigest ?? null,
					createdAtMs: this.#dependencies.now(),
				};
				await this.#ensureAnchor(desiredAnchor, generation);
				bootstrap = await this.#activeAwait(
					store.updateBootstrapState({
						authoritySequenceEnd: desiredAnchor.bootstrapSequenceEnd,
						authorityHeadDigest: desiredAnchor.bootstrapHeadDigest,
						anchorRequired: true,
					}),
					generation,
				);
			}

			// Final pull closes races with another enrolled device that uploaded while
			// this device was staging its own immutable packages.
			inventory = await this.#loadInventory(accountNamespace, generation);
			if (!inventory.anchor || !anchorMatchesBootstrap(inventory.anchor, bootstrap)) {
				throw new GoogleDriveSyncControllerError(
					"The immutable sync anchor disappeared or changed during synchronization.",
				);
			}
			this.#assertAuthorityCutoff(
				inventory.packages.filter(
					(remote) =>
						remote.syncPackage.sourceDeviceId === bootstrap.authorityDeviceId,
				),
				bootstrap,
			);
			await this.#assertRemoteHistoryPresent(
				store,
				accountNamespace,
				sourceDeviceId,
				inventory,
				generation,
			);
			const mutationsBeforeFinalApply = remoteMutations;
			remoteMutations += await this.#applyInventory(
				store,
				accountNamespace,
				sourceDeviceId,
				bootstrap,
				inventory,
				generation,
			);
			// A conditional apply may deliberately preserve a concurrent local write.
			// Journal it now, above every observed remote Lamport clock, so it cannot be
			// forgotten merely because this app is force-quit before the next cycle.
			// Only a final apply can create that case; with nothing applied there is
			// no preserved write to promote and the scan would be pure cost.
			if (remoteMutations > mutationsBeforeFinalApply) {
				await this.#activeAwait(
					this.#timedPhase("reconcile", () =>
						store.reconcileCurrentData({
							accountNamespace,
							sourceDeviceId,
							includeMedia: false,
							contactScope: this.#dependencies.contactScope(),
						}),
					),
					generation,
				);
			}
			if (remoteMutations > 0) {
				await this.#activeAwait(
					Promise.resolve(this.#dependencies.onRemoteApplied(this.profileId)),
					generation,
				);
			}
			await this.#activeAwait(
				store.updateConfig({
					lastSuccessfulSyncAt: this.#dependencies.now(),
					lastError: null,
					mediaPolicy: "off",
				}),
				generation,
			);
			const timings = this.#cycleTimings;
			this.#cycleTimings = null;
			if (timings) {
				await store
					.recordCycleTimings?.(
						JSON.stringify({
							finishedAtMs: Date.now(),
							totalMs: Date.now() - cycleStartedAt,
							phases: Object.fromEntries(timings),
						}),
					)
					.catch(() => undefined);
			}
			await this.#refreshStatus(generation, configStatus, connection);
			return { remoteMutations };
		} catch (error) {
			if (error instanceof GoogleDriveSyncCancelledError) throw error;
			const store = await this.#store().catch(() => null);
			if (store) {
				await store
					.updateConfig({ lastError: asStatusError(error).message })
					.catch(() => undefined);
			}
			this.#setError(error);
			throw error;
		}
	}

	#applyInventory(
		store: GoogleDriveSyncControllerStore,
		accountNamespace: string,
		localDeviceId: string,
		initialBootstrap: GoogleDriveSyncBootstrapState,
		inventory: RemoteInventory,
		generation: number,
	): Promise<number> {
		return this.#timedPhase("apply", () =>
			this.#applyInventoryUntimed(store, accountNamespace, localDeviceId, initialBootstrap, inventory, generation),
		);
	}

	async #applyInventoryUntimed(
		store: GoogleDriveSyncControllerStore,
		accountNamespace: string,
		localDeviceId: string,
		initialBootstrap: GoogleDriveSyncBootstrapState,
		inventory: RemoteInventory,
		generation: number,
	): Promise<number> {
		let remoteMutations = 0;
		let bootstrap = initialBootstrap;
		const packages = inventory.packages.filter(
			(remote) => remote.syncPackage.sourceDeviceId !== localDeviceId,
		);
		// Receipts let an already-applied package be passed over on its header,
		// which is the same check applyIncomingPackage makes, without loading its
		// body. A store that cannot list them gets every package, as before.
		const appliedDigests = store.listAppliedPackageDigests
			? new Map(
					await this.#activeAwait(
						store.listAppliedPackageDigests(accountNamespace),
						generation,
					),
				)
			: null;

		if (bootstrap.bootstrapPending) {
			const baseline = bootstrap.localBaselineSequence;
			const authority = bootstrap.authorityDeviceId;
			if (baseline === null || authority === null || !inventory.anchor) {
				throw new GoogleDriveSyncControllerError("The pending bootstrap state is incomplete");
			}
			const authorityPackages = packages.filter(
				(remote) => remote.syncPackage.sourceDeviceId === authority,
			);
			this.#assertAuthorityCutoff(authorityPackages, bootstrap);
			for (const remote of authorityPackages) {
				if (remote.syncPackage.sequenceRange.end > bootstrap.authoritySequenceEnd) break;
				// The cancellations below need the operations even when the package
				// was applied before, so this path always loads the body. It runs once,
				// while a device is being paired.
				const body = await this.#loadPackageBody(remote, accountNamespace, generation);
				const result = await this.#applyPackage(
					store,
					accountNamespace,
					body,
					generation,
					{
						localSourceDeviceId: localDeviceId,
						localBaselineSequence: baseline,
					},
				);
				remoteMutations += result.appliedOperations;
				appliedDigests?.set(remote.syncPackage.packageId, remote.syncPackage.contentDigest);

				// Apply/receipt comes first. If the process stops before supersession,
				// replaying the already-applied package repeats these bounded, idempotent
				// cancellations without ever reclassifying the old phone baseline as new.
				for (const operation of body.syncPackage.operations) {
					this.#assertActive(generation);
					await this.#activeAwait(
						store.supersedeUnuploadedEntityOperations({
							accountNamespace,
							sourceDeviceId: localDeviceId,
							section: operation.section,
							entityType: operation.entityType,
							entityId: operation.entityId,
							supersededByOperationId: operation.operationId,
							maxOriginSequence: baseline,
							atMs: this.#dependencies.now(),
						}),
						generation,
					);
				}
			}
			bootstrap = await this.#activeAwait(
				store.updateBootstrapState({
					bootstrapPending: false,
					localBaselineSequence: null,
				}),
				generation,
			);
		}

		for (const remote of packages) {
			this.#assertActive(generation);
			if (
				initialBootstrap.bootstrapPending &&
				remote.syncPackage.sourceDeviceId === bootstrap.authorityDeviceId &&
				remote.syncPackage.sequenceRange.end <= bootstrap.authoritySequenceEnd
			) {
				continue;
			}
			const appliedDigest = appliedDigests?.get(remote.syncPackage.packageId);
			if (appliedDigest !== undefined) {
				if (appliedDigest !== remote.syncPackage.contentDigest) {
					throw new SyncProtocolError(
						"identifier-collision",
						`Package ID ${remote.syncPackage.packageId} identifies different content`,
					);
				}
				this.#countCycleEvent("packageAlreadyApplied");
				continue;
			}
			const body = await this.#loadPackageBody(remote, accountNamespace, generation);
			const result = await this.#applyPackage(
				store,
				accountNamespace,
				body,
				generation,
			);
			remoteMutations += result.appliedOperations;
			appliedDigests?.set(remote.syncPackage.packageId, remote.syncPackage.contentDigest);
		}
		return remoteMutations;
	}

	#assertAuthorityCutoff(
		authorityPackages: readonly RemotePackage[],
		bootstrap: GoogleDriveSyncBootstrapState,
	): void {
		if (bootstrap.authoritySequenceEnd === 0) {
			if (bootstrap.authorityHeadDigest !== null) {
				throw new GoogleDriveSyncControllerError("The empty authority cutoff has a digest");
			}
			return;
		}
		const head = authorityPackages.find(
			(remote) =>
				remote.syncPackage.sequenceRange.end === bootstrap.authoritySequenceEnd &&
				remote.syncPackage.contentDigest === bootstrap.authorityHeadDigest,
		);
		if (!head) {
			throw new GoogleDriveSyncControllerError(
				"Google Drive does not contain the exact authority package named by the pairing cutoff.",
			);
		}
	}

	#assertPairingSourceHeads(
		packages: readonly RemotePackage[],
		expectedHeads: readonly GoogleDriveSyncPairingSourceHeadV1[],
	): void {
		for (const expected of expectedHeads) {
			const present = packages.some(
				(remote) =>
					remote.syncPackage.sourceDeviceId === expected.sourceDeviceId &&
					remote.syncPackage.sequenceRange.end === expected.sequenceEnd &&
					remote.syncPackage.contentDigest === expected.contentDigest,
			);
			if (!present) {
				throw new GoogleDriveSyncControllerError(
					"Google Drive is missing immutable history observed by the device that created this pairing code. Pairing stopped to prevent accepting a remote rollback.",
				);
			}
		}
	}

	async #assertRemoteHistoryPresent(
		store: GoogleDriveSyncControllerStore,
		accountNamespace: string,
		localDeviceId: string,
		inventory: RemoteInventory,
		generation: number,
	): Promise<void> {
		const [durableHead, pending, inboundHeads, bootstrap] = await this.#activeAwait(
			Promise.all([
				store.getOutboundHead(accountNamespace, localDeviceId),
				store.listPendingOutboundPackages(accountNamespace, localDeviceId),
				store.listInboundHeads(accountNamespace),
				store.getBootstrapState(),
			]),
			generation,
		);
		const orderedPending = [...pending].sort(
			(left, right) =>
				left.syncPackage.sequenceRange.start - right.syncPackage.sequenceRange.start,
		);
		let previousLocalDigest = durableHead?.contentDigest ?? null;
		let previousLocalEnd = durableHead?.sequenceEnd ?? 0;
		for (const outbound of orderedPending) {
			const syncPackage = outbound.syncPackage;
			if (
				syncPackage.accountNamespace !== accountNamespace ||
				syncPackage.sourceDeviceId !== localDeviceId ||
				syncPackage.sequenceRange.start <= previousLocalEnd ||
				syncPackage.previousPackageDigest !== previousLocalDigest
			) {
				throw new GoogleDriveSyncControllerError(
					"The durable pending package ledger does not continue this device's confirmed history. Upload stopped before creating a broken chain.",
				);
			}
			previousLocalEnd = syncPackage.sequenceRange.end;
			previousLocalDigest = syncPackage.contentDigest;
		}
		const localRemote = inventory.packages.filter(
			(remote) => remote.syncPackage.sourceDeviceId === localDeviceId,
		);
		let unconfirmedRemote: readonly RemotePackage[];
		if (durableHead) {
			const headIndex = localRemote.findIndex(
				(remote) =>
					remote.syncPackage.sequenceRange.end === durableHead.sequenceEnd &&
					remote.syncPackage.contentDigest === durableHead.contentDigest,
			);
			if (headIndex < 0) {
				throw new GoogleDriveSyncControllerError(
					"A previously confirmed immutable package is missing from Google Drive. Upload stopped to prevent a rollback or broken history chain.",
				);
			}
			unconfirmedRemote = localRemote.slice(headIndex + 1);
		} else {
			unconfirmedRemote = localRemote;
		}

		let forked = unconfirmedRemote.length > orderedPending.length;
		for (let index = 0; !forked && index < unconfirmedRemote.length; index += 1) {
			const remote = unconfirmedRemote[index];
			const local = orderedPending[index];
			// Headers rule most out; the byte comparison needs the body, and this is
			// only reached after an upload whose confirmation was lost.
			forked =
				remote.syncPackage.packageId !== local.syncPackage.packageId ||
				remote.syncPackage.contentDigest !== local.syncPackage.contentDigest ||
				!sameLocalPackage(
					await this.#loadPackageBody(remote, accountNamespace, generation),
					local,
				);
		}
		if (forked) {
			throw new GoogleDriveSyncControllerError(
				"Google Drive contains same-device history that is not present in this installation's durable pending ledger. Upload stopped to prevent a fork after local sync-state loss or rollback.",
			);
		}
		if (bootstrap.bootstrapPending && unconfirmedRemote.length > 0) {
			throw new GoogleDriveSyncControllerError(
				"This secondary device already published local history before its authoritative bootstrap completed. Sync stopped so the laptop baseline cannot be weakened; reset and pair this device again.",
			);
		}

		for (const inbound of inboundHeads) {
			const present = inventory.packages.some(
				(remote) =>
					remote.syncPackage.sourceDeviceId === inbound.sourceDeviceId &&
					remote.syncPackage.sequenceRange.end === inbound.sequenceEnd &&
					remote.syncPackage.contentDigest === inbound.contentDigest,
			);
			if (!present) {
				throw new GoogleDriveSyncControllerError(
					"Previously applied immutable history is missing from Google Drive. Sync stopped to prevent accepting a remote rollback or deleted source history.",
				);
			}
		}

		// A create response may have been lost after Drive committed the file. Only
		// after validating the complete local ledger and every remote match do we
		// confirm the exact prefix locally; this prevents a later supersession or
		// upload pass from treating immutable remote history as disposable.
		for (let index = 0; index < unconfirmedRemote.length; index += 1) {
			await this.#activeAwait(
				store.markOutboundPackageUploaded(
					orderedPending[index].syncPackage.packageId,
					unconfirmedRemote[index].metadata.id,
					this.#dependencies.now(),
				),
				generation,
			);
		}
	}

	async #applyPackage(
		store: GoogleDriveSyncControllerStore,
		accountNamespace: string,
		remote: VerifiedRemotePackage,
		generation: number,
		bootstrapAuthority?: Readonly<{
			localSourceDeviceId: string;
			localBaselineSequence: number;
		}>,
	): Promise<ApplySyncPackageResult> {
		return this.#activeAwait(
			store.applyIncomingPackage(remote.syncPackage, {
				expectedAccountNamespace: accountNamespace,
				expectedSourceDeviceId: remote.syncPackage.sourceDeviceId,
				bootstrapAuthority,
				now: this.#dependencies.now,
			}),
			generation,
		);
	}

	#uploadPendingPackages(
		store: GoogleDriveSyncControllerStore,
		accountNamespace: string,
		sourceDeviceId: string,
		requiredAnchor: GoogleDriveSyncBootstrapState | null,
		generation: number,
	): Promise<void> {
		return this.#timedPhase("upload", () =>
			this.#uploadPendingPackagesUntimed(store, accountNamespace, sourceDeviceId, requiredAnchor, generation),
		);
	}

	async #uploadPendingPackagesUntimed(
		store: GoogleDriveSyncControllerStore,
		accountNamespace: string,
		sourceDeviceId: string,
		requiredAnchor: GoogleDriveSyncBootstrapState | null,
		generation: number,
	): Promise<void> {
		const pending = await this.#activeAwait(
			store.listPendingOutboundPackages(accountNamespace, sourceDeviceId),
			generation,
		);
		if (pending.length === 0) return;
		let exactFiles = await this.#listExactFiles(accountNamespace, generation);
		for (const outbound of pending) {
			this.#assertActive(generation);
			if (requiredAnchor) {
				await this.#assertRequiredAnchorPresent(
					accountNamespace,
					requiredAnchor,
					"before",
					generation,
				);
			}
			const filename = await googleDriveSyncPackageFilename({
				accountNamespace,
				sourceDeviceId,
				packageId: outbound.syncPackage.packageId,
				contentDigest: outbound.syncPackage.contentDigest,
			});
			const existing = exactFiles.filter(
				(file) => file.kind === "package" && file.metadata.name === filename,
			);
			if (existing.length > 0) {
				await this.#verifyExistingOutbound(existing, outbound, accountNamespace, generation);
				if (requiredAnchor) {
					await this.#assertRequiredAnchorPresent(
						accountNamespace,
						requiredAnchor,
						"while confirming",
						generation,
					);
				}
				await this.#activeAwait(
					store.markOutboundPackageUploaded(
						outbound.syncPackage.packageId,
						existing[0].metadata.id,
						this.#dependencies.now(),
					),
					generation,
				);
				continue;
			}

			const aad = await googleDriveSyncAuthenticatedData(
				"package",
				accountNamespace,
				filename,
			);
			const encrypted = await this.#activeAwait(
				this.#dependencies.native.encrypt(
					this.nativeProfileId,
					encodeGoogleDriveSyncUtf8Base64Url(outbound.serialized),
					aad,
				),
				generation,
			);
			const encodedEnvelope = encodeGoogleDriveSyncBase64Url(
				encodeGoogleDriveSyncEncryptedEnvelope(encrypted),
			);
			try {
				if (requiredAnchor) {
					await this.#assertRequiredAnchorPresent(
						accountNamespace,
						requiredAnchor,
						"immediately before",
						generation,
					);
				}
				const created = await this.#activeAwait(
					this.#dependencies.native.createAppData(
						this.nativeProfileId,
						filename,
						encodedEnvelope,
					),
					generation,
				);
				if (created.name !== filename) {
					throw new GoogleDriveSyncControllerError(
						"Google Drive returned a different immutable package name.",
					);
				}
				if (requiredAnchor) {
					try {
						await this.#assertRequiredAnchorPresent(
							accountNamespace,
							requiredAnchor,
							"immediately after",
							generation,
						);
					} catch (validationError) {
						// Drive returned this exact file id from this create attempt, so it
						// is safe to clean up without touching pre-existing immutable history.
						// Cleanup is best effort: the anchor validation failure remains the
						// authoritative error and the package is never marked as uploaded.
						await this.#dependencies.native
							.deleteAppData(this.nativeProfileId, created.id, true)
							.catch(() => undefined);
						throw validationError;
					}
				}
				await this.#activeAwait(
					store.markOutboundPackageUploaded(
						outbound.syncPackage.packageId,
						created.id,
						this.#dependencies.now(),
					),
					generation,
				);
				exactFiles = [...exactFiles, { kind: "package", metadata: created }];
			} catch (error) {
				if (!isTransientRemoteReadError(error)) throw error;
				// A create may have reached Drive even if its response was lost. Never
				// create again blindly: re-list and verify the deterministic immutable name.
				exactFiles = await this.#listExactFiles(accountNamespace, generation);
				const recovered = exactFiles.filter(
					(file) => file.kind === "package" && file.metadata.name === filename,
				);
				if (recovered.length === 0) throw error;
				await this.#verifyExistingOutbound(
					recovered,
					outbound,
					accountNamespace,
					generation,
				);
				if (requiredAnchor) {
					try {
						await this.#assertRequiredAnchorPresent(
							accountNamespace,
							requiredAnchor,
							"after recovering",
							generation,
						);
					} catch (validationError) {
						if (
							validationError instanceof GoogleDriveSyncAnchorValidationError &&
							validationError.reason === "absent"
						) {
							// The anchor is the namespace revocation barrier. Every recovered
							// candidate was authenticated above as this exact durable pending
							// package, so delete all deterministic duplicates best-effort. A
							// cleanup failure must not replace the authoritative anchor error,
							// and the package must remain pending locally for an explicit retry.
							await Promise.all(
								recovered.map((file) =>
									this.#dependencies.native
										.deleteAppData(this.nativeProfileId, file.metadata.id, true)
										.catch(() => undefined),
								),
							);
						}
						// A present but changed/conflicting anchor may describe another
						// immutable history. Never delete recovered files in that case.
						throw validationError;
					}
				}
				await this.#activeAwait(
					store.markOutboundPackageUploaded(
						outbound.syncPackage.packageId,
						recovered[0].metadata.id,
						this.#dependencies.now(),
					),
					generation,
				);
			}
		}
	}

	async #assertRequiredAnchorPresent(
		accountNamespace: string,
		requiredAnchor: GoogleDriveSyncBootstrapState,
		when: string,
		generation: number,
	): Promise<void> {
		const anchorFiles = (
			await this.#listExactFiles(accountNamespace, generation)
		).filter((file) => file.kind === "anchor");
		if (anchorFiles.length === 0) {
			throw new GoogleDriveSyncAnchorValidationError(
				`The immutable sync anchor disappeared ${when} an upload. The package was not accepted as confirmed history.`,
				"absent",
			);
		}

		let verifiedAnchor: GoogleDriveSyncAnchorV1 | null = null;
		for (const file of anchorFiles) {
			const candidate = await this.#downloadAnchor(
				file.metadata,
				accountNamespace,
				generation,
			);
			if (
				!anchorMatchesBootstrap(candidate, requiredAnchor) ||
				(verifiedAnchor !== null && !sameAnchor(verifiedAnchor, candidate))
			) {
				throw new GoogleDriveSyncAnchorValidationError(
					`The immutable sync anchor changed ${when} an upload. Upload stopped before confirming a forked history.`,
					"changed",
				);
			}
			verifiedAnchor = candidate;
		}
	}

	async #verifyExistingOutbound(
		files: readonly ClassifiedRemoteFile[],
		outbound: OutboundGoogleDriveSyncPackage,
		accountNamespace: string,
		generation: number,
	): Promise<void> {
		for (const file of files) {
			const remote = await this.#downloadPackage(file.metadata, accountNamespace, generation);
			if (
				remote.serialized !== outbound.serialized ||
				remote.syncPackage.packageId !== outbound.syncPackage.packageId ||
				remote.syncPackage.contentDigest !== outbound.syncPackage.contentDigest
			) {
				throw new GoogleDriveSyncControllerError(
					"A deterministic Drive filename contains different package content.",
				);
			}
		}
	}

	async #ensureAnchor(
		desired: GoogleDriveSyncAnchorV1,
		generation: number,
	): Promise<void> {
		const filename = await googleDriveSyncAnchorFilename(desired.accountNamespace);
		const files = await this.#listExactFiles(desired.accountNamespace, generation);
		const existing = files.filter(
			(file) => file.kind === "anchor" && file.metadata.name === filename,
		);
		if (existing.length > 0) {
			for (const file of existing) {
				const anchor = await this.#downloadAnchor(
					file.metadata,
					desired.accountNamespace,
					generation,
				);
				if (!sameAnchor(anchor, desired)) {
					throw new GoogleDriveSyncControllerError(
						"The immutable Google Drive sync anchor already exists with different content.",
					);
				}
			}
			return;
		}
		const aad = await googleDriveSyncAuthenticatedData(
			"anchor",
			desired.accountNamespace,
			filename,
		);
		const encrypted = await this.#activeAwait(
			this.#dependencies.native.encrypt(
				this.nativeProfileId,
				encodeGoogleDriveSyncBase64Url(encodeGoogleDriveSyncAnchor(desired)),
				aad,
			),
			generation,
		);
		const body = encodeGoogleDriveSyncBase64Url(
			encodeGoogleDriveSyncEncryptedEnvelope(encrypted),
		);
		try {
			const created = await this.#activeAwait(
				this.#dependencies.native.createAppData(this.nativeProfileId, filename, body),
				generation,
			);
			if (created.name !== filename) {
				throw new GoogleDriveSyncControllerError(
					"Google Drive returned a different immutable anchor name.",
				);
			}
		} catch (error) {
			if (!isTransientRemoteReadError(error)) throw error;
			const recovered = (
				await this.#listExactFiles(desired.accountNamespace, generation)
			).filter((file) => file.kind === "anchor" && file.metadata.name === filename);
			if (recovered.length === 0) throw error;
			for (const file of recovered) {
				const anchor = await this.#downloadAnchor(
					file.metadata,
					desired.accountNamespace,
					generation,
				);
				if (!sameAnchor(anchor, desired)) throw error;
			}
		}
	}

	#loadInventory(
		accountNamespace: string,
		generation: number,
	): Promise<RemoteInventory> {
		return this.#timedPhase("inventory", () =>
			this.#loadInventoryUntimed(accountNamespace, generation),
		);
	}

	async #loadInventoryUntimed(
		accountNamespace: string,
		generation: number,
	): Promise<RemoteInventory> {
		const exact = await this.#listExactFiles(accountNamespace, generation);
		// Headers of bodies kept from an earlier run, read without the bodies. A
		// header is only trusted once it reproduces the file's authenticated name,
		// and a body is verified in full before anything is applied from it.
		const persistedKeys = exact
			.filter((file) => file.kind === "package")
			.map((file) => remotePackageCacheKey(accountNamespace, file.metadata))
			.filter((key) => !this.#packageCache.has(key));
		let persisted: ReadonlyMap<string, CachedRemotePackageHeader> = new Map();
		if (persistedKeys.length > 0) {
			try {
				const store = await this.#activeAwait(this.#store(), generation);
				persisted =
					(await this.#activeAwait(
						Promise.resolve(
							store.readCachedRemotePackageHeaders?.(accountNamespace, persistedKeys),
						),
						generation,
					)) ?? new Map();
			} catch (error) {
				if (error instanceof GoogleDriveSyncCancelledError) throw error;
				// A cache is an optimisation; losing it only costs a download.
				persisted = new Map();
			}
		}
		let downloadedAny = false;
		const anchors: Array<Readonly<{
			file: ClassifiedRemoteFile;
			value: GoogleDriveSyncAnchorV1;
		}>> = [];
		const packages: RemotePackage[] = [];
		const seenPackageKeys = new Set<string>();
		for (const file of exact) {
			this.#assertActive(generation);
			if (file.kind === "anchor") {
				// Anchors are never cached. They are small and they are the freshness
				// signal the rollback, conflict and race checks depend on.
				anchors.push({
					file,
					value: await this.#downloadAnchor(
						file.metadata,
						accountNamespace,
						generation,
					),
				});
			} else {
				const cacheKey = remotePackageCacheKey(accountNamespace, file.metadata);
				seenPackageKeys.add(cacheKey);
				const cached = this.#packageCache.get(cacheKey);
				if (cached) {
					this.#countCycleEvent("packageCacheHit");
					packages.push(cached);
					continue;
				}
				const storedHeader = persisted.get(cacheKey);
				if (storedHeader !== undefined) {
					const restored = await this.#restoreHeader(
						storedHeader,
						file.metadata,
						cacheKey,
						accountNamespace,
					);
					if (restored) {
						this.#countCycleEvent("packageCacheRestored");
						this.#packageCache.set(cacheKey, restored);
						packages.push(restored);
						continue;
					}
					// A header that does not match its file is discarded, never trusted.
					this.#countCycleEvent("packageCacheRejected");
				}
				this.#countCycleEvent("packageDownload");
				const downloaded = await this.#downloadPackage(
					file.metadata,
					accountNamespace,
					generation,
				);
				const remote: RemotePackage = {
					metadata: file.metadata,
					cacheKey,
					syncPackage: headerOf(downloaded.syncPackage),
				};
				this.#packageCache.set(cacheKey, remote);
				packages.push(remote);
				// Saved as soon as it verifies, so even a first sync of the whole
				// history holds one body at a time.
				await this.#persistPackageBody(accountNamespace, cacheKey, downloaded.serialized, generation);
				downloadedAny = true;
			}
		}

		// Keep the cache bounded by the history that still exists remotely. The
		// listing above is always fetched fresh, so new and deleted remote packages
		// are still detected; only already-verified immutable packages are reused.
		for (const key of this.#packageCache.keys()) {
			if (!seenPackageKeys.has(key)) this.#packageCache.delete(key);
		}

		if (downloadedAny || persistedKeys.length > 0) {
			try {
				const store = await this.#activeAwait(this.#store(), generation);
				await store.pruneCachedRemotePackages?.(accountNamespace, [
					...seenPackageKeys,
				]);
			} catch (error) {
				if (error instanceof GoogleDriveSyncCancelledError) throw error;
				// Failing to prune the cache must not fail the sync itself.
			}
		}

		let anchor: GoogleDriveSyncAnchorV1 | null = null;
		for (const candidate of anchors) {
			if (candidate.value.accountNamespace !== accountNamespace) {
				throw new GoogleDriveSyncControllerError(
					"A remote anchor decrypted to a different sync account.",
				);
			}
			if (anchor && !sameAnchor(anchor, candidate.value)) {
				throw new GoogleDriveSyncControllerError(
					"Google Drive contains conflicting immutable sync anchors.",
				);
			}
			anchor = candidate.value;
		}

		const uniquePackages = new Map<string, RemotePackage>();
		const packageIds = new Map<string, string>();
		for (const remote of packages) {
			const key = remote.metadata.name;
			const existing = uniquePackages.get(key);
			// The content digest covers the whole body, so equal digests mean equal content.
			if (existing && !sameHeader(existing.syncPackage, remote.syncPackage)) {
				throw new GoogleDriveSyncControllerError(
					"Duplicate immutable package names contain different content.",
				);
			}
			const existingDigest = packageIds.get(remote.syncPackage.packageId);
			if (existingDigest && existingDigest !== remote.syncPackage.contentDigest) {
				throw new GoogleDriveSyncControllerError(
					"A remote package identifier was reused for different content.",
				);
			}
			packageIds.set(remote.syncPackage.packageId, remote.syncPackage.contentDigest);
			uniquePackages.set(key, existing ?? remote);
		}
		const deduplicated = Array.from(uniquePackages.values()).sort(compareRemotePackages);
		this.#verifyRemoteChains(deduplicated);
		return {
			allExactFiles: exact,
			anchor,
			anchorFiles: anchors.map((candidate) => candidate.file),
			packages: deduplicated,
		};
	}

	#verifyRemoteChains(packages: readonly RemotePackage[]): void {
		const bySource = new Map<string, RemotePackage[]>();
		for (const remote of packages) {
			const group = bySource.get(remote.syncPackage.sourceDeviceId) ?? [];
			group.push(remote);
			bySource.set(remote.syncPackage.sourceDeviceId, group);
		}
		for (const group of bySource.values()) {
			group.sort(
				(left, right) =>
					left.syncPackage.sequenceRange.start - right.syncPackage.sequenceRange.start,
			);
			let previousDigest: string | null = null;
			let previousEnd = 0;
			for (const remote of group) {
				const pkg = remote.syncPackage;
				if (pkg.sequenceRange.start <= previousEnd) {
					throw new SyncProtocolError(
						"sequence-gap",
						"Remote immutable packages overlap within one source chain",
					);
				}
				if (pkg.previousPackageDigest !== previousDigest) {
					throw new SyncProtocolError(
						"chain-mismatch",
						"Remote immutable packages do not form a complete digest chain",
					);
				}
				previousDigest = pkg.contentDigest;
				previousEnd = pkg.sequenceRange.end;
			}
		}
	}

	async #listExactFiles(
		accountNamespace: string,
		generation: number,
	): Promise<ClassifiedRemoteFile[]> {
		const result: ClassifiedRemoteFile[] = [];
		let pageToken: string | null = null;
		const seenPageTokens = new Set<string>();
		do {
			const page = await this.#readWithRetry(
				() => this.#dependencies.native.listAppData(this.nativeProfileId, pageToken),
				generation,
			);
			for (const metadata of page.files) {
				const kind = await classifyGoogleDriveSyncFilename(
					accountNamespace,
					metadata.name,
				);
				if (kind) result.push({ metadata, kind });
			}
			pageToken = page.nextPageToken;
			if (pageToken) {
				if (seenPageTokens.has(pageToken)) {
					throw new GoogleDriveSyncControllerError(
						"Google Drive returned a repeated pagination token.",
					);
				}
				seenPageTokens.add(pageToken);
			}
		} while (pageToken);
		return result;
	}

	async #downloadAnchor(
		metadata: GoogleDriveFileMetadata,
		accountNamespace: string,
		generation: number,
	): Promise<GoogleDriveSyncAnchorV1> {
		const plaintext = await this.#downloadAndDecrypt(
			metadata,
			"anchor",
			accountNamespace,
			generation,
		);
		return decodeGoogleDriveSyncAnchor(
			decodeGoogleDriveSyncBase64Url(plaintext, MAX_GOOGLE_DRIVE_SYNC_ANCHOR_BYTES),
		);
	}

	/** A stored header, if it has the right shape and reproduces the file's authenticated name. */
	async #restoreHeader(
		stored: CachedRemotePackageHeader,
		metadata: GoogleDriveFileMetadata,
		cacheKey: string,
		accountNamespace: string,
	): Promise<RemotePackage | null> {
		const header = parseCachedHeader(stored);
		if (!header || header.accountNamespace !== accountNamespace) return null;
		try {
			const expectedFilename = await googleDriveSyncPackageFilename({
				accountNamespace,
				sourceDeviceId: header.sourceDeviceId,
				packageId: header.packageId,
				contentDigest: header.contentDigest,
			});
			if (expectedFilename !== metadata.name) return null;
		} catch {
			return null;
		}
		return { metadata, cacheKey, syncPackage: header };
	}

	/**
	 * The verified body behind an inventory entry: the stored copy when it still
	 * verifies and matches the header the inventory was checked with, otherwise
	 * a fresh download. Callers hold it only as long as they need it.
	 */
	async #loadPackageBody(
		remote: RemotePackage,
		accountNamespace: string,
		generation: number,
	): Promise<VerifiedRemotePackage> {
		try {
			const store = await this.#activeAwait(this.#store(), generation);
			const stored = await this.#activeAwait(
				Promise.resolve(store.readCachedRemotePackages?.(accountNamespace, [remote.cacheKey])),
				generation,
			);
			const body = stored?.get(remote.cacheKey);
			if (body !== undefined) {
				const verified = await this.#verifyPackageBody(body, remote.metadata, accountNamespace);
				if (sameHeader(headerOf(verified.syncPackage), remote.syncPackage)) {
					this.#countCycleEvent("packageBodyRestored");
					return verified;
				}
			}
		} catch (error) {
			if (error instanceof GoogleDriveSyncCancelledError) throw error;
			// A stored body that no longer verifies is replaced by a download below.
		}
		this.#countCycleEvent("packageDownload");
		const downloaded = await this.#downloadPackage(remote.metadata, accountNamespace, generation);
		if (!sameHeader(headerOf(downloaded.syncPackage), remote.syncPackage)) {
			// The inventory's chain checks ran against a header this content does
			// not have. Forget it so the next load rebuilds it from verified content.
			this.#packageCache.delete(remote.cacheKey);
			await this.#persistPackageBody(accountNamespace, remote.cacheKey, downloaded.serialized, generation);
			throw new GoogleDriveSyncControllerError(
				"A cached package header did not match the package's verified content. Sync stopped; it will retry from verified content.",
			);
		}
		await this.#persistPackageBody(accountNamespace, remote.cacheKey, downloaded.serialized, generation);
		return downloaded;
	}

	async #persistPackageBody(
		accountNamespace: string,
		cacheKey: string,
		serialized: string,
		generation: number,
	): Promise<void> {
		try {
			const store = await this.#activeAwait(this.#store(), generation);
			await store.writeCachedRemotePackages?.(accountNamespace, [{ cacheKey, serialized }]);
		} catch (error) {
			if (error instanceof GoogleDriveSyncCancelledError) throw error;
			// Failing to persist the cache must not fail the sync itself.
		}
	}

	async #downloadPackage(
		metadata: GoogleDriveFileMetadata,
		accountNamespace: string,
		generation: number,
	): Promise<VerifiedRemotePackage> {
		const plaintext = await this.#downloadAndDecrypt(
			metadata,
			"package",
			accountNamespace,
			generation,
		);
		const serialized = decodeGoogleDriveSyncUtf8Base64Url(
			plaintext,
			MAX_GOOGLE_DRIVE_SYNC_PLAINTEXT_PACKAGE_BYTES,
		);
		return this.#verifyPackageBody(serialized, metadata, accountNamespace);
	}

	/**
	 * Every check a freshly downloaded package passes. A cached body runs the
	 * same path, so reuse skips the network and the decrypt but never the
	 * content digest or the authenticated filename that identifies it.
	 */
	async #verifyPackageBody(
		serialized: string,
		metadata: GoogleDriveFileMetadata,
		accountNamespace: string,
	): Promise<VerifiedRemotePackage> {
		const syncPackage = await parseAndVerifySyncPackage(serialized);
		if (syncPackage.accountNamespace !== accountNamespace) {
			throw new SyncProtocolError(
				"identity-mismatch",
				"A remote package decrypted to a different sync account",
			);
		}
		const expectedFilename = await googleDriveSyncPackageFilename({
			accountNamespace,
			sourceDeviceId: syncPackage.sourceDeviceId,
			packageId: syncPackage.packageId,
			contentDigest: syncPackage.contentDigest,
		});
		if (metadata.name !== expectedFilename) {
			throw new SyncProtocolError(
				"identity-mismatch",
				"A remote package's immutable filename does not match its verified identity",
			);
		}
		return { metadata, syncPackage, serialized };
	}

	async #downloadAndDecrypt(
		metadata: GoogleDriveFileMetadata,
		kind: "anchor" | "package",
		accountNamespace: string,
		generation: number,
	): Promise<string> {
		const download = await this.#readWithRetry(
			() =>
				this.#dependencies.native.downloadAppData(
					this.nativeProfileId,
					metadata.id,
				),
			generation,
		);
		const envelope = decodeGoogleDriveSyncEncryptedEnvelope(
			decodeGoogleDriveSyncBase64Url(download.dataBase64),
		);
		const aad = await googleDriveSyncAuthenticatedData(
			kind,
			accountNamespace,
			metadata.name,
		);
		return this.#activeAwait(
			this.#dependencies.native.decrypt(this.nativeProfileId, envelope, aad),
			generation,
		);
	}

	async #readWithRetry<T>(
		read: () => Promise<T>,
		generation: number,
	): Promise<T> {
		for (let attempt = 1; attempt <= MAX_REMOTE_READ_ATTEMPTS; attempt += 1) {
			try {
				return await this.#activeAwait(read(), generation);
			} catch (error) {
				if (
					error instanceof GoogleDriveSyncCancelledError ||
					attempt >= MAX_REMOTE_READ_ATTEMPTS ||
					!isTransientRemoteReadError(error)
				) {
					throw error;
				}
				await this.#activeAwait(
					this.#dependencies.sleep(
						REMOTE_READ_RETRY_DELAYS_MS[attempt - 1] ?? 350,
					),
					generation,
				);
			}
		}
		throw new GoogleDriveSyncControllerError("The remote read retry loop failed");
	}

	async #refreshStatus(
		generation: number,
		knownConfigStatus?: GoogleDriveConfigStatus,
		knownConnection?: GoogleDriveConnectionStatus,
	): Promise<GoogleDriveSyncStatus> {
		const [configStatus, connection, store] = await this.#activeAwait(
			Promise.all([
				knownConfigStatus ?? this.#dependencies.native.configStatus(),
				knownConnection ??
					this.#dependencies.native.connectionStatus(this.nativeProfileId),
				this.#store(),
			]),
			generation,
		);
		const [config, bootstrap] = await this.#activeAwait(
			Promise.all([store.getConfig(), store.getBootstrapState()]),
			generation,
		);
		const pending = config.accountNamespace
			? await this.#activeAwait(
					store.getPendingCounts(config.accountNamespace),
					generation,
				)
			: { changes: 0, bytes: 0 };
		this.#status = this.#statusFrom(
			configStatus,
			connection,
			config,
			bootstrap,
			pending,
		);
		this.#publish();
		return this.#status;
	}

	#statusFrom(
		configStatus: GoogleDriveConfigStatus,
		connection: GoogleDriveConnectionStatus,
		config: GoogleDriveSyncStoreConfig,
		bootstrap: GoogleDriveSyncBootstrapState,
		pending: GoogleDriveSyncPendingCounts,
		phaseOverride?: "syncing" | "connecting",
	): GoogleDriveSyncStatus {
		const reason = unavailableReason(configStatus);
		const available = reason === undefined;
		const vaultState = connection.vaultKey.present && config.accountNamespace
			? "ready"
			: config.accountNamespace
				? "awaiting-key"
				: "none";
		let phase: GoogleDriveSyncStatus["phase"];
		if (phaseOverride) phase = phaseOverride;
		else if (!connection.connected) phase = "disconnected";
		else if (!connection.vaultKey.present || !config.accountNamespace) phase = "pairing";
		else phase = bootstrap.bootstrapPending ? "pairing" : "paired";
		return {
			phase,
			available,
			unavailableReason: reason,
			googleConnected: connection.connected,
			vaultState,
			vaultFingerprint: connection.vaultKey.fingerprint,
			googleAccountEmail: connection.googleAccountEmail,
			deviceName: this.#dependencies.deviceName(),
			lastSuccessfulSyncAt: config.lastSuccessfulSyncAt,
			pendingChanges: pending.changes,
			pendingBytes: pending.bytes,
			mediaPolicy: "off",
			syncStep: null,
			determined: true,
			error: config.lastError ? { message: config.lastError } : null,
		};
	}

	#blankStatus(): GoogleDriveSyncStatus {
		return {
			// Not a checked disconnection: nothing has been determined yet. Saying
			// "disconnected" here made the card offer an inert connect button and
			// claim a state it had not verified.
			phase: "loading",
			determined: false,
			available: false,
			unavailableReason: translate("data_backup.drive_sync.errors.status_not_loaded", {
				defaultValue: "Google Drive sync status has not been loaded yet.",
			}),
			googleConnected: false,
			vaultState: "none",
			vaultFingerprint: null,
			googleAccountEmail: null,
			deviceName: this.#dependencies.deviceName(),
			lastSuccessfulSyncAt: null,
			pendingChanges: 0,
			pendingBytes: 0,
			mediaPolicy: "off",
			syncStep: null,
			error: null,
		};
	}

	#setPhase(phase: "connecting" | "syncing"): void {
		this.#status = { ...this.#status, phase, error: null };
		this.#publish();
	}

	#setSyncStep(syncStep: GoogleDriveSyncStep | null): void {
		if (this.#status.syncStep === syncStep) return;
		this.#status = { ...this.#status, syncStep };
		this.#publish();
	}

	#setError(error: unknown): void {
		this.#status = { ...this.#status, phase: "error", error: asStatusError(error) };
		this.#publish();
	}

	#publish(): void {
		for (const listener of this.#listeners) listener(this.#status);
	}

	#store(): Promise<GoogleDriveSyncControllerStore> {
		if (this.#closed) return Promise.reject(new GoogleDriveSyncCancelledError());
		this.#storePromise ??= this.#dependencies.storeFactory(this.profileId);
		return this.#storePromise;
	}

	#assertActive(generation: number): void {
		if (
			this.#closed ||
			generation !== this.#generation ||
			!this.#dependencies.isActiveProfile(this.profileId)
		) {
			throw new GoogleDriveSyncCancelledError();
		}
	}

	async #activeAwait<T>(promise: Promise<T>, generation: number): Promise<T> {
		try {
			const result = await promise;
			this.#assertActive(generation);
			return result;
		} catch (error) {
			// A rejection completing after a user switch belongs to the abandoned
			// generation. Treat it as cancellation, never as an old-profile sync error.
			this.#assertActive(generation);
			throw error;
		}
	}

	#enqueue<T>(action: () => Promise<T>): Promise<T> {
		const previous = this.#queue;
		let release = (): void => undefined;
		this.#queue = new Promise<void>((resolve) => {
			release = resolve;
		});
		return previous
			.then(() => {
				if (this.#closed) throw new GoogleDriveSyncCancelledError();
				return action();
			})
			.finally(release);
	}
}

/**
 * Adapter/manager that lazily owns exactly one serialized controller per
 * profile. Lifecycle code may call invalidateProfile before switching users.
 */
export class GoogleDriveSyncControllerManager implements GoogleDriveSyncAdapter {
	readonly #dependencies: RequiredControllerDependencies;
	readonly #controllers = new Map<number, GoogleDriveSyncProfileController>();

	constructor(dependencies: GoogleDriveSyncControllerDependencies = {}) {
		this.#dependencies = dependenciesWithDefaults(dependencies);
	}

	invalidateProfile(profileId?: number): void {
		if (profileId === undefined) {
			for (const controller of this.#controllers.values()) controller.invalidate();
			return;
		}
		this.#controllers.get(profileId)?.invalidate();
	}

	async closeProfile(profileId: number): Promise<void> {
		const controller = this.#controllers.get(profileId);
		if (!controller) return;
		this.#controllers.delete(profileId);
		await controller.close();
	}

	async closeProfilesExcept(profileId: number | null): Promise<void> {
		const closing: Promise<void>[] = [];
		for (const [candidateProfileId, controller] of this.#controllers) {
			if (candidateProfileId === profileId) continue;
			this.#controllers.delete(candidateProfileId);
			closing.push(controller.close());
		}
		await Promise.all(closing);
	}

	async closeAllProfiles(): Promise<void> {
		await this.closeProfilesExcept(null);
	}

	getStatus(input: GoogleDriveSyncProfileInput): Promise<GoogleDriveSyncStatus> {
		return this.#controller(input.profileId).getStatus();
	}

	connect(input: GoogleDriveSyncProfileInput): Promise<GoogleDriveSyncStatus> {
		return this.#controller(input.profileId).connect();
	}

	exportPairingCode(input: GoogleDriveSyncProfileInput): Promise<GoogleDrivePairingCode> {
		return this.#controller(input.profileId).exportPairingCode();
	}

	importPairingCode(input: GoogleDrivePairingCodeInput): Promise<GoogleDriveSyncStatus> {
		return this.#controller(input.profileId).importPairingCode(input.pairingCode);
	}

	syncNow(input: GoogleDriveSyncProfileInput): Promise<GoogleDriveSyncStatus> {
		return this.#controller(input.profileId).syncNow();
	}

	setMediaPolicy(input: GoogleDriveMediaPolicyInput): Promise<GoogleDriveSyncStatus> {
		return this.#controller(input.profileId).setMediaPolicy(input.mediaPolicy);
	}

	disconnectDevice(input: GoogleDriveSyncProfileInput): Promise<GoogleDriveSyncStatus> {
		return this.#controller(input.profileId).disconnect();
	}

	resetCloudData(input: GoogleDriveSyncProfileInput): Promise<GoogleDriveSyncStatus> {
		return this.#controller(input.profileId).resetCloudData();
	}

	subscribe(
		input: GoogleDriveSyncProfileInput,
		listener: GoogleDriveSyncStatusListener,
	): () => void {
		return this.#controller(input.profileId).subscribe(listener);
	}

	#controller(profileId: number): GoogleDriveSyncProfileController {
		let controller = this.#controllers.get(profileId);
		if (!controller) {
			controller = new GoogleDriveSyncProfileController(
				profileId,
				this.#dependencies,
			);
			this.#controllers.set(profileId, controller);
		}
		return controller;
	}
}

export function createGoogleDriveSyncControllerAdapter(
	dependencies: GoogleDriveSyncControllerDependencies = {},
): GoogleDriveSyncControllerManager {
	return new GoogleDriveSyncControllerManager(dependencies);
}
