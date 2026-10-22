import Database from "@tauri-apps/plugin-sql";
import type { ContactIndexSyncScope } from "./chatContactIndex";
import {
	MAX_SYNC_PACKAGE_OPERATIONS,
	MAX_SYNC_PACKAGE_BYTES,
	SyncProtocolError,
	accountNamespaceSchema,
	applySyncPackageIdempotently,
	canonicalJson,
	createSyncOperation,
	createSyncPackage,
	deviceIdSchema,
	entityIdSchema,
	entityTypeSchema,
	parseAndVerifySyncPackage,
	nonNegativeSafeIntegerSchema,
	positiveSafeIntegerSchema,
	selectWinningOperation,
	sha256HexSchema,
	sha256Hex,
	operationIdSchema,
	syncOperationSchema,
	syncSectionSchema,
	verifySyncPackage,
	type AppliedOperationReceipt,
	type AppliedPackageReceipt,
	type ApplySyncPackageResult,
	type ImmutableSyncOperation,
	type JsonValue,
	type SyncApplyStore,
	type SyncApplyTransaction,
	type SyncPackage,
	type SyncSection,
} from "./cloudSync";
import {
	applyGoogleDriveSyncOperationConditionally,
	scanGoogleDriveSyncEntities,
	type GoogleDriveSyncEntity,
} from "./googleDriveSyncData";
import type { GoogleDriveMediaPolicy } from "./googleDriveSync";

const STORE_SCHEMA_VERSION = 4;
const SQLITE_BUSY_TIMEOUT_MS = 5_000;
const SQLITE_LOCK_RETRY_DELAYS_MS = [30, 80, 180, 350] as const;
/**
 * Plaintext package ceiling. AES-GCM adds a tag and the JSON envelope stores
 * ciphertext as base64url, so 3 MiB expands to roughly 4 MiB before Drive's
 * 5 MiB native multipart limit is checked.
 */
export const GOOGLE_DRIVE_SYNC_TARGET_PACKAGE_BYTES = 3 * 1024 * 1024;
const CORE_SCAN_SECTIONS: readonly SyncSection[] = [
	"core",
	"contact-index",
	"interest-views",
	"preferences",
];

/** Minimal common surface implemented by Tauri SQL and the Bun test adapter. */
export interface GoogleDriveSyncSqlDatabase {
	readonly path?: string;
	execute(
		query: string,
		bindValues?: unknown[],
	): Promise<{ rowsAffected?: number; lastInsertId?: number }>;
	select<T>(query: string, bindValues?: unknown[]): Promise<T>;
	close?(databasePath?: string): Promise<unknown>;
}

export type GoogleDriveSyncDatabaseFactory = (
	databaseUrl: string,
) => Promise<GoogleDriveSyncSqlDatabase>;

export type GoogleDriveSyncStoreConfig = Readonly<{
	enabled: boolean;
	accountNamespace: string | null;
	mediaPolicy: GoogleDriveMediaPolicy;
	lastSuccessfulSyncAt: number | null;
	lastError: string | null;
}>;

export type GoogleDriveSyncStoreConfigPatch = Partial<GoogleDriveSyncStoreConfig>;

export type GoogleDriveSyncBootstrapState = Readonly<{
	authorityDeviceId: string | null;
	authoritySequenceEnd: number;
	authorityHeadDigest: string | null;
	bootstrapPending: boolean;
	anchorRequired: boolean;
	localBaselineSequence: number | null;
}>;

export type GoogleDriveSyncBootstrapStatePatch = Partial<GoogleDriveSyncBootstrapState>;

export type GoogleDriveSyncOutboundHead = Readonly<{
	sequenceEnd: number;
	contentDigest: string;
}>;

export type GoogleDriveSyncInboundHead = Readonly<{
	sourceDeviceId: string;
	sequenceEnd: number;
	contentDigest: string;
}>;

export type GoogleDriveSyncPendingCounts = Readonly<{
	changes: number;
	bytes: number;
}>;

export type GoogleDriveSyncStatusSnapshot = Readonly<{
	config: GoogleDriveSyncStoreConfig;
	bootstrap: GoogleDriveSyncBootstrapState;
	pending: GoogleDriveSyncPendingCounts;
}>;

export type ReconcileGoogleDriveSyncInput = Readonly<{
	accountNamespace: string;
	sourceDeviceId: string;
	includeMedia: boolean;
	contactScope?: ContactIndexSyncScope;
}>;

export type ReconcileGoogleDriveSyncScanInput = Readonly<{
	accountNamespace: string;
	sourceDeviceId: string;
	scannedSections: readonly SyncSection[];
	/**
	 * Sections where a scanned entity's absence means it was deleted. A section
	 * scanned through a filter must be excluded: its unscanned rows still exist,
	 * and inferring deletions from them would tombstone tens of thousands of
	 * live rows on every other device. Defaults to scannedSections.
	 */
	deletionSections?: readonly SyncSection[];
	scan: (onEntity: (entity: GoogleDriveSyncEntity) => Promise<void>) => Promise<void>;
}>;

export type ReconcileGoogleDriveSyncResult = Readonly<{
	createdUpserts: number;
	createdTombstones: number;
	unchangedEntities: number;
	firstSequence: number | null;
	lastSequence: number | null;
}>;

/**
 * A cached package's identity and chain fields as stored, unverified. Values
 * are `unknown` because nothing has checked them yet: a row whose body is not
 * a package reads back as nulls.
 */
export type CachedRemotePackageHeader = Readonly<{
	packageId: unknown;
	accountNamespace: unknown;
	sourceDeviceId: unknown;
	sequenceStart: unknown;
	sequenceEnd: unknown;
	contentDigest: unknown;
	previousPackageDigest: unknown;
}>;

export type OutboundGoogleDriveSyncPackage = Readonly<{
	syncPackage: SyncPackage;
	serialized: string;
	createdAtMs: number;
	uploadedAtMs: number | null;
	remoteFileId: string | null;
}>;

export type IncomingGoogleDriveSyncPackageOptions = Readonly<{
	expectedAccountNamespace: string;
	expectedSourceDeviceId?: string;
	bootstrapAuthority?: Readonly<{
		localSourceDeviceId: string;
		localBaselineSequence: number;
	}>;
	now?: () => number;
}>;

type CounterState = {
	originSequence: number;
	logicalClock: number;
};

type ShadowSummaryRow = {
	section: string;
	entity_type: string;
	entity_id: string;
	mutation_kind: string;
	value_digest: string | null;
};

type OperationJsonRow = {
	operation_json: string;
	estimated_bytes?: number;
};

type CachedRemotePackageHeaderRow = {
	cache_key: string;
	package_id: unknown;
	account_namespace: unknown;
	source_device_id: unknown;
	sequence_start: unknown;
	sequence_end: unknown;
	content_digest: unknown;
	previous_package_digest: unknown;
};

/**
 * Outbox rows read per page by the shadow repairs. The outbox holds every
 * unsuperseded local change this device ever made; read in one query it was
 * over 50 MB of JSON in the webview.
 */
const OUTBOX_REPAIR_PAGE_SIZE = 250;

type ConfigRow = {
	enabled: number | boolean;
	account_namespace: string | null;
	media_policy: string;
	last_successful_sync_at: number | null;
	last_error: string | null;
};

type LocalIdentityRow = {
	source_device_id: string;
};

type PriorLocalSyncStateRow = {
	has_prior_state: number | boolean;
};

type BootstrapStateRow = {
	authority_device_id: string | null;
	authority_sequence_end: number;
	authority_head_digest: string | null;
	bootstrap_pending: number | boolean;
	anchor_required: number | boolean;
	local_baseline_sequence: number | null;
};

type CountRow = {
	changes: number | null;
	bytes: number | null;
};

type CounterRow = {
	counter_sequence: number | null;
	outbox_sequence: number | null;
	counter_clock: number | null;
	outbox_clock: number | null;
	shadow_clock: number | null;
	observed_clock: number | null;
};

type PackageRow = {
	package_json: string;
	created_at_ms: number;
	uploaded_at_ms: number | null;
	remote_file_id: string | null;
};

type PackageHeadRow = {
	sequence_end: number;
	content_digest: string;
};

type InboundHeadRow = PackageHeadRow & {
	source_device_id: string;
};

type AppliedOperationRow = {
	operation_id: string;
	account_namespace: string;
	source_device_id: string;
	origin_sequence: number;
	fingerprint: string;
	applied_at_ms: number;
};

type AppliedPackageRow = {
	package_id: string;
	account_namespace: string;
	source_device_id: string;
	sequence_start: number;
	sequence_end: number;
	content_digest: string;
	previous_package_digest: string | null;
	applied_at_ms: number;
};

export type GoogleDriveSyncStoreOptions = Readonly<{
	databaseFactory?: GoogleDriveSyncDatabaseFactory;
	applyOperation?: (
		operation: ImmutableSyncOperation,
		expectedOperation?: ImmutableSyncOperation,
	) => Promise<boolean | void>;
}>;

function defaultDatabaseFactory(databaseUrl: string): Promise<GoogleDriveSyncSqlDatabase> {
	return Database.load(databaseUrl) as unknown as Promise<GoogleDriveSyncSqlDatabase>;
}

function assertProfileId(profileId: number): void {
	if (!Number.isSafeInteger(profileId) || profileId <= 0) {
		throw new Error("Google Drive sync requires a positive, safe profile ID");
	}
}

export function googleDriveSyncDatabaseUrl(profileId: number): string {
	assertProfileId(profileId);
	return `sqlite:google-drive-sync-${profileId}.sqlite3`;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isSqliteLockedError(error: unknown): boolean {
	const message =
		error instanceof Error
			? error.message
			: typeof error === "string"
				? error
				: JSON.stringify(error);
	return /database is locked|database table is locked|\(code:\s*(5|517)\)/i.test(message ?? "");
}

function asSafeNonNegativeInteger(value: number | null | undefined): number {
	const normalized = value ?? 0;
	if (!Number.isSafeInteger(normalized) || normalized < 0) {
		throw new Error("The Google Drive sync store contains an invalid counter");
	}
	return normalized;
}

function assertOptionalTimestamp(value: number | null): void {
	if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
		throw new Error("A sync timestamp must be a non-negative safe integer");
	}
}

function assertMediaPolicy(value: string): asserts value is GoogleDriveMediaPolicy {
	if (value !== "off" && value !== "wifi-only") {
		throw new Error(`Unsupported Google Drive media policy: ${value}`);
	}
}

function storedBoolean(value: number | boolean, field: string): boolean {
	if (value === true || value === 1) return true;
	if (value === false || value === 0) return false;
	throw new Error(`The persisted ${field} flag is invalid`);
}

function validateBootstrapState(
	state: GoogleDriveSyncBootstrapState,
): GoogleDriveSyncBootstrapState {
	if (typeof state.bootstrapPending !== "boolean" || typeof state.anchorRequired !== "boolean") {
		throw new Error("Bootstrap progress flags must be boolean values");
	}
	if (state.authorityDeviceId !== null) {
		deviceIdSchema.parse(state.authorityDeviceId);
	}
	nonNegativeSafeIntegerSchema.parse(state.authoritySequenceEnd);
	if (state.authorityHeadDigest !== null) {
		sha256HexSchema.parse(state.authorityHeadDigest);
	}
	if ((state.authoritySequenceEnd === 0) !== (state.authorityHeadDigest === null)) {
		throw new Error(
			"The bootstrap authority digest must be null exactly when its sequence is zero",
		);
	}
	if (state.localBaselineSequence !== null) {
		nonNegativeSafeIntegerSchema.parse(state.localBaselineSequence);
	}
	if (state.authorityDeviceId === null) {
		if (
			state.authoritySequenceEnd !== 0 ||
			state.authorityHeadDigest !== null ||
			state.bootstrapPending ||
			state.anchorRequired ||
			state.localBaselineSequence !== null
		) {
			throw new Error("Bootstrap progress requires an authority device");
		}
	}
	if (state.bootstrapPending && state.authorityDeviceId === null) {
		throw new Error("A pending bootstrap requires an authority device");
	}
	if (state.bootstrapPending !== (state.localBaselineSequence !== null)) {
		throw new Error(
			"The local baseline sequence must exist exactly while bootstrap is pending",
		);
	}
	if (state.anchorRequired && state.authorityDeviceId === null) {
		throw new Error("A required bootstrap anchor needs an authority device");
	}
	return Object.freeze({ ...state });
}

function shadowKey(section: SyncSection, entityType: string, entityId: string): string {
	return [section, entityType, entityId].map((part) => `${part.length}:${part}`).join("");
}

function parseOperation(serialized: string): ImmutableSyncOperation {
	return syncOperationSchema.parse(JSON.parse(serialized)) as ImmutableSyncOperation;
}

function serializedOperation(operation: ImmutableSyncOperation): string {
	return canonicalJson(operation as unknown as JsonValue);
}

async function operationValueDigest(operation: ImmutableSyncOperation): Promise<string | null> {
	return operation.mutation.kind === "upsert"
		? sha256Hex(canonicalJson(operation.mutation.value))
		: null;
}

/**
 * Durable, per-profile reconciliation state for the transport-neutral sync
 * engine. This deliberately does not perform OAuth or any Drive HTTP calls.
 *
 * Tauri SQL uses a connection pool without transaction session affinity, so
 * every write is serialized and individually idempotent instead of relying on
 * manual BEGIN/COMMIT. Ordering is chosen so a crash can only cause a replay:
 * local operations land in the outbox before the shadow is advanced, and
 * incoming domain mutations land before their receipt is recorded.
 */
export class GoogleDriveSyncStore implements SyncApplyStore {
	readonly profileId: number;
	readonly databaseUrl: string;

	readonly #db: GoogleDriveSyncSqlDatabase;
	readonly #applyDomainOperation: (
		operation: ImmutableSyncOperation,
		expectedOperation?: ImmutableSyncOperation,
	) => Promise<boolean | void>;
	#writeQueue: Promise<void> = Promise.resolve();
	#closed = false;

	private constructor(
		profileId: number,
		databaseUrl: string,
		db: GoogleDriveSyncSqlDatabase,
		applyOperation: (
			operation: ImmutableSyncOperation,
			expectedOperation?: ImmutableSyncOperation,
		) => Promise<boolean | void>,
	) {
		this.profileId = profileId;
		this.databaseUrl = databaseUrl;
		this.#db = db;
		this.#applyDomainOperation = applyOperation;
	}

	static async open(
		profileId: number,
		options: GoogleDriveSyncStoreOptions = {},
	): Promise<GoogleDriveSyncStore> {
		const databaseUrl = googleDriveSyncDatabaseUrl(profileId);
		const db = await (options.databaseFactory ?? defaultDatabaseFactory)(databaseUrl);
		const store = new GoogleDriveSyncStore(
			profileId,
			databaseUrl,
			db,
			options.applyOperation ??
				((operation, expectedOperation) =>
					applyGoogleDriveSyncOperationConditionally(
						profileId,
						operation,
						expectedOperation,
					)),
		);
		try {
			await store.#initialize();
			// After initialize, so this runs outside its write lock. Self-healing
			// and best effort: a device that has been reset more than once carries
			// every earlier vault's rows, and nothing else ever removes them.
			// Housekeeping must never stop the store from opening, but silently
			// swallowing its failure left no way to tell a prune that did nothing
			// from one that never ran, so the outcome is recorded either way.
			let outcome: Record<string, unknown> = { stage: "start" };
			try {
				const config = await store.getConfig();
				outcome = { stage: "config", hasNamespace: config.accountNamespace !== null };
				if (config.accountNamespace) {
					const removed = await store.pruneForeignAccountState(
						config.accountNamespace,
					);
					outcome = { stage: "pruned", removed };
					if (removed) {
						await store.compact();
						outcome = { stage: "compacted", removed };
					}
				}
			} catch (error) {
				outcome = {
					...outcome,
					failed: true,
					error: error instanceof Error ? error.message : String(error),
				};
			}
			await store
				.recordMaintenanceOutcome(JSON.stringify({ ...outcome, atMs: Date.now() }))
				.catch(() => undefined);
			return store;
		} catch (error) {
			await db.close?.(db.path).catch(() => undefined);
			throw error;
		}
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.#writeQueue;
		await this.#db.close?.(this.#db.path);
	}

	async getConfig(): Promise<GoogleDriveSyncStoreConfig> {
		return this.#afterWrites(async () => {
			const rows = await this.#db.select<ConfigRow[]>(
				`SELECT enabled, account_namespace, media_policy,
					last_successful_sync_at, last_error
				 FROM sync_config WHERE singleton_id = 1`,
			);
			const row = rows[0];
			if (!row) throw new Error("The Google Drive sync configuration is missing");
			assertMediaPolicy(row.media_policy);
			return Object.freeze({
				enabled: Boolean(row.enabled),
				accountNamespace: row.account_namespace,
				mediaPolicy: row.media_policy,
				lastSuccessfulSyncAt: row.last_successful_sync_at,
				lastError: row.last_error,
			});
		});
	}

	async getLocalSourceDeviceId(): Promise<string | null> {
		return this.#afterWrites(async () => {
			const rows = await this.#db.select<LocalIdentityRow[]>(
				"SELECT source_device_id FROM sync_local_identity WHERE singleton_id = 1",
			);
			const sourceDeviceId = rows[0]?.source_device_id ?? null;
			if (sourceDeviceId !== null) deviceIdSchema.parse(sourceDeviceId);
			return sourceDeviceId;
		});
	}

	/**
	 * True when an unbound pre-v4 store already contains enrollment or protocol
	 * state. The controller uses this to forbid minting a replacement browser id.
	 */
	async hasPriorLocalSyncState(): Promise<boolean> {
		return this.#afterWrites(async () => {
			const rows = await this.#db.select<PriorLocalSyncStateRow[]>(`
				SELECT (
					EXISTS (SELECT 1 FROM sync_config
						WHERE singleton_id = 1 AND account_namespace IS NOT NULL) OR
					EXISTS (SELECT 1 FROM sync_bootstrap_state
						WHERE singleton_id = 1 AND authority_device_id IS NOT NULL) OR
					EXISTS (SELECT 1 FROM sync_counters) OR
					EXISTS (SELECT 1 FROM sync_account_clocks) OR
					EXISTS (SELECT 1 FROM sync_entity_shadow) OR
					EXISTS (SELECT 1 FROM sync_outbound_operations) OR
					EXISTS (SELECT 1 FROM sync_outbound_packages) OR
					EXISTS (SELECT 1 FROM sync_applied_operations) OR
					EXISTS (SELECT 1 FROM sync_applied_packages) OR
					EXISTS (SELECT 1 FROM sync_remote_head_commitments)
				) AS has_prior_state
			`);
			return storedBoolean(rows[0]?.has_prior_state ?? 0, "prior sync state");
		});
	}

	/**
	 * Atomically establishes the immutable local source identity. INSERT OR
	 * IGNORE plus a re-read makes concurrent open connections converge on one
	 * winner; a different winner or legacy local source fails closed.
	 */
	async bindLocalSourceDeviceId(sourceDeviceId: string): Promise<string> {
		deviceIdSchema.parse(sourceDeviceId);
		return this.#serializedWrite("bind-local-source-device", async () => {
			const legacySourceIds = await this.#legacyLocalSourceIdsUnlocked();
			if (
				legacySourceIds.length > 1 ||
				(legacySourceIds.length === 1 && legacySourceIds[0] !== sourceDeviceId)
			) {
				throw new Error(
					"The Google Drive sync store contains a different local source identity",
				);
			}
			await this.#db.execute(
				`INSERT OR IGNORE INTO sync_local_identity(singleton_id, source_device_id)
				 VALUES (1, ?)`,
				[sourceDeviceId],
			);
			const rows = await this.#db.select<LocalIdentityRow[]>(
				"SELECT source_device_id FROM sync_local_identity WHERE singleton_id = 1",
			);
			const bound = rows[0]?.source_device_id;
			if (!bound) {
				throw new Error("The Google Drive sync store did not retain its local source id");
			}
			deviceIdSchema.parse(bound);
			if (bound !== sourceDeviceId) {
				throw new Error(
					"The browser and Google Drive sync store device ids conflict",
				);
			}
			return bound;
		});
	}

	/**
	 * Diagnostic only. Phase durations for the most recent cycle go into the
	 * existing key/value meta table, so slow-cycle analysis needs no schema
	 * change and nothing user facing.
	 */
	/** Diagnostic only: what the open-path housekeeping did, or why it did not. */
	async recordMaintenanceOutcome(outcomeJson: string): Promise<void> {
		if (outcomeJson.length > 4_096) return;
		await this.#serializedWrite("record-maintenance-outcome", async () => {
			await this.#db.execute(
				"INSERT INTO sync_meta(key, value) VALUES ('last_maintenance', ?) " +
					"ON CONFLICT(key) DO UPDATE SET value = excluded.value",
				[outcomeJson],
			);
		});
	}

	async recordCycleTimings(timingsJson: string): Promise<void> {
		if (timingsJson.length > 8_192) return;
		await this.#serializedWrite("record-cycle-timings", async () => {
			await this.#db.execute(
				"INSERT INTO sync_meta(key, value) VALUES ('last_cycle_timings', ?) " +
					"ON CONFLICT(key) DO UPDATE SET value = excluded.value",
				[timingsJson],
			);
		});
	}

	async updateConfig(
		patch: GoogleDriveSyncStoreConfigPatch,
	): Promise<GoogleDriveSyncStoreConfig> {
		return this.#serializedWrite("update-config", async () => {
			const current = await this.#readConfigUnlocked();
			const next: GoogleDriveSyncStoreConfig = { ...current, ...patch };
			if (next.accountNamespace !== null) {
				accountNamespaceSchema.parse(next.accountNamespace);
			}
			assertMediaPolicy(next.mediaPolicy);
			assertOptionalTimestamp(next.lastSuccessfulSyncAt);
			if (next.lastError !== null && next.lastError.length > 8_192) {
				throw new Error("The persisted sync error exceeds the safe size limit");
			}
			await this.#db.execute(
				`UPDATE sync_config
				 SET enabled = ?, account_namespace = ?, media_policy = ?,
					 last_successful_sync_at = ?, last_error = ?
				 WHERE singleton_id = 1`,
				[
					next.enabled ? 1 : 0,
					next.accountNamespace,
					next.mediaPolicy,
					next.lastSuccessfulSyncAt,
					next.lastError,
				],
			);
			return Object.freeze({ ...next });
		});
	}

	async getBootstrapState(): Promise<GoogleDriveSyncBootstrapState> {
		return this.#afterWrites(async () =>
			validateBootstrapState(await this.#readBootstrapStateUnlocked()),
		);
	}

	async updateBootstrapState(
		patch: GoogleDriveSyncBootstrapStatePatch,
	): Promise<GoogleDriveSyncBootstrapState> {
		return this.#serializedWrite("update-bootstrap-state", async () => {
			const current = await this.#readBootstrapStateUnlocked();
			const next = validateBootstrapState({ ...current, ...patch });
			await this.#db.execute(
				`UPDATE sync_bootstrap_state
				 SET authority_device_id = ?, authority_sequence_end = ?,
					 authority_head_digest = ?, bootstrap_pending = ?,
					 anchor_required = ?, local_baseline_sequence = ?
				 WHERE singleton_id = 1`,
				[
					next.authorityDeviceId,
					next.authoritySequenceEnd,
					next.authorityHeadDigest,
					next.bootstrapPending ? 1 : 0,
					next.anchorRequired ? 1 : 0,
					next.localBaselineSequence,
				],
			);
			return next;
		});
	}

	/** The latest package this device has confirmed present in Drive. */
	async getOutboundHead(
		accountNamespace: string,
		sourceDeviceId: string,
	): Promise<GoogleDriveSyncOutboundHead | null> {
		accountNamespaceSchema.parse(accountNamespace);
		deviceIdSchema.parse(sourceDeviceId);
		return this.#afterWrites(async () => {
			const rows = await this.#db.select<PackageHeadRow[]>(
				`SELECT sequence_end, content_digest FROM sync_outbound_packages
				 WHERE account_namespace = ? AND source_device_id = ?
				   AND uploaded_at_ms IS NOT NULL
				 ORDER BY sequence_end DESC LIMIT 1`,
				[accountNamespace, sourceDeviceId],
			);
			const head = rows[0];
			if (!head) return null;
			positiveSafeIntegerSchema.parse(head.sequence_end);
			sha256HexSchema.parse(head.content_digest);
			return Object.freeze({
				sequenceEnd: head.sequence_end,
				contentDigest: head.content_digest,
			});
		});
	}

	/** Highest origin sequence durably reserved by this local source device. */
	async getLocalOriginSequence(
		accountNamespace: string,
		sourceDeviceId: string,
	): Promise<number> {
		accountNamespaceSchema.parse(accountNamespace);
		deviceIdSchema.parse(sourceDeviceId);
		return this.#afterWrites(async () =>
			(await this.#recoverCounter(accountNamespace, sourceDeviceId)).originSequence,
		);
	}

	/** Scan all portable domain stores and append only changed entities. */
	async reconcileCurrentData(
		input: ReconcileGoogleDriveSyncInput,
	): Promise<ReconcileGoogleDriveSyncResult> {
		const contactScope = input.contactScope ?? "everything";
		return this.reconcileWithScanner({
			accountNamespace: input.accountNamespace,
			sourceDeviceId: input.sourceDeviceId,
			scannedSections: input.includeMedia
				? [...CORE_SCAN_SECTIONS, "media"]
				: CORE_SCAN_SECTIONS,
			deletionSections:
				contactScope === "everything"
					? undefined
					: (input.includeMedia
							? [...CORE_SCAN_SECTIONS, "media"]
							: CORE_SCAN_SECTIONS
						).filter(
							(section): section is SyncSection => section !== "contact-index",
						),
			scan: (onEntity) =>
				scanGoogleDriveSyncEntities(
					this.profileId,
					input.includeMedia,
					onEntity,
					contactScope,
				),
		});
	}

	/**
	 * Testable reconciliation primitive. Tombstones are inferred only after the
	 * scanner resolves successfully; an interrupted/failed scan cannot turn its
	 * unseen suffix into deletions.
	 */
	async reconcileWithScanner(
		input: ReconcileGoogleDriveSyncScanInput,
	): Promise<ReconcileGoogleDriveSyncResult> {
		accountNamespaceSchema.parse(input.accountNamespace);
		deviceIdSchema.parse(input.sourceDeviceId);
		const scannedSections = Array.from(new Set(input.scannedSections));
		if (scannedSections.length === 0) {
			throw new Error("A completed sync scan must cover at least one section");
		}
		for (const section of scannedSections) syncSectionSchema.parse(section);
		const deletionSections = Array.from(
			new Set(input.deletionSections ?? scannedSections),
		);
		for (const section of deletionSections) {
			syncSectionSchema.parse(section);
			if (!scannedSections.includes(section)) {
				throw new Error(
					"A deletion section must also be scanned in the same reconciliation",
				);
			}
		}

		return this.#serializedWrite("reconcile-domain-scan", async () => {
			await this.#repairOutboxShadow(input.accountNamespace, input.sourceDeviceId);
			const state = await this.#recoverCounter(input.accountNamespace, input.sourceDeviceId);
			const shadow = await this.#loadShadowSummaries(input.accountNamespace, scannedSections);
			const seen = new Set<string>();
			let createdUpserts = 0;
			let createdTombstones = 0;
			let unchangedEntities = 0;
			let firstSequence: number | null = null;
			let lastSequence: number | null = null;

			await input.scan(async (entity) => {
				this.#validateScannedEntity(entity, scannedSections);
				const key = shadowKey(entity.section, entity.entityType, entity.entityId);
				if (seen.has(key)) {
					throw new Error(
						`A completed sync scan returned duplicate entity ${entity.entityType}/${entity.entityId}`,
					);
				}
				seen.add(key);
				const digest = await sha256Hex(canonicalJson(entity.value));
				const existing = shadow.get(key);
				if (existing?.mutation_kind === "upsert" && existing.value_digest === digest) {
					unchangedEntities += 1;
					return;
				}

				const operation = await this.#appendLocalOperationUnlocked(
					input.accountNamespace,
					input.sourceDeviceId,
					state,
					entity.section,
					entity.entityType,
					entity.entityId,
					{ kind: "upsert", value: entity.value },
				);
				createdUpserts += 1;
				firstSequence ??= operation.originSequence;
				lastSequence = operation.originSequence;
				shadow.set(key, {
					section: entity.section,
					entity_type: entity.entityType,
					entity_id: entity.entityId,
					mutation_kind: "upsert",
					value_digest: digest,
				});
			});

			// This loop is deliberately reached only after the complete scan succeeds.
			for (const [key, previous] of shadow) {
				if (
					previous.mutation_kind !== "upsert" ||
					seen.has(key) ||
					!deletionSections.includes(previous.section as SyncSection)
				) {
					continue;
				}
				const operation = await this.#appendLocalOperationUnlocked(
					input.accountNamespace,
					input.sourceDeviceId,
					state,
					previous.section as SyncSection,
					previous.entity_type,
					previous.entity_id,
					{ kind: "delete" },
				);
				createdTombstones += 1;
				firstSequence ??= operation.originSequence;
				lastSequence = operation.originSequence;
				previous.mutation_kind = "delete";
				previous.value_digest = null;
			}

			return Object.freeze({
				createdUpserts,
				createdTombstones,
				unchangedEntities,
				firstSequence,
				lastSequence,
			});
		});
	}

	/**
	 * Drop every trace of one sync account after its vault has been destroyed.
	 * Reset already deletes the remote namespace, the encryption key and the
	 * configuration, but previously left the journal, shadow and receipts
	 * behind. Those rows are unreadable without the deleted key, and a device
	 * that re-paired inherited them as pending work: after a reset intended to
	 * shrink a vault, a phone still tried to publish the old, unfiltered
	 * baseline. The device's own source identity is deliberately preserved.
	 */
	/** Namespace-scoped tables, in the order a teardown should clear them. */
	static readonly #ACCOUNT_SCOPED_TABLES = [
		"sync_outbound_operations",
		"sync_outbound_packages",
		"sync_entity_shadow",
		"sync_applied_operations",
		"sync_applied_packages",
		"sync_remote_head_commitments",
		"sync_counters",
		"sync_account_clocks",
		"sync_remote_package_cache",
	] as const;

	/**
	 * Drop state belonging to vaults this device is no longer enrolled in.
	 * Resetting a vault clears its own rows, but a device that has been reset
	 * more than once still carried every earlier vault: unreadable without the
	 * deleted keys, unreachable because every query filters on the live
	 * namespace, and heavy enough to dominate the database. Returns whether
	 * anything was removed so the caller can decide to reclaim the space.
	 */
	async pruneForeignAccountState(liveNamespace: string): Promise<boolean> {
		accountNamespaceSchema.parse(liveNamespace);
		return this.#serializedWrite("prune-foreign-account-state", async () => {
			let removedAny = false;
			for (const table of GoogleDriveSyncStore.#ACCOUNT_SCOPED_TABLES) {
				const rows = await this.#db.select<Array<{ count: number }>>(
					`SELECT COUNT(*) AS count FROM ${table} WHERE account_namespace != ?`,
					[liveNamespace],
				);
				if ((rows[0]?.count ?? 0) === 0) continue;
				removedAny = true;
				await this.#db.execute(
					`DELETE FROM ${table} WHERE account_namespace != ?`,
					[liveNamespace],
				);
			}
			return removedAny;
		});
	}

	/**
	 * Return freed pages to the filesystem. Deleting rows alone leaves the file
	 * at its high-water mark, so a database that has been mostly emptied still
	 * costs what it did before.
	 */
	async compact(): Promise<void> {
		await this.#serializedWrite("compact", async () => {
			await this.#db.execute("VACUUM");
		});
	}

	async clearAccountState(accountNamespace: string): Promise<void> {
		accountNamespaceSchema.parse(accountNamespace);
		await this.#serializedWrite("clear-account-state", async () => {
			for (const table of GoogleDriveSyncStore.#ACCOUNT_SCOPED_TABLES) {
				await this.#db.execute(
					`DELETE FROM ${table} WHERE account_namespace = ?`,
					[accountNamespace],
				);
			}
		});
	}

	/**
	 * Everything the status display needs, read without waiting on the write
	 * queue. Those reads are otherwise blocked for as long as a reconcile holds
	 * it, which on a large profile is minutes, and the card then cannot say what
	 * the device is doing precisely while the user is waiting to find out. WAL
	 * gives a committed snapshot; momentarily stale counters are the right trade
	 * for a read whose only consumer is the UI.
	 */
	async getStatusSnapshot(): Promise<GoogleDriveSyncStatusSnapshot> {
		this.#assertOpen();
		const config = await this.#readConfigUnlocked();
		const bootstrap = validateBootstrapState(
			await this.#readBootstrapStateUnlocked(),
		);
		const pending = config.accountNamespace
			? await this.#readPendingCountsUnlocked(config.accountNamespace)
			: Object.freeze({ changes: 0, bytes: 0 });
		return Object.freeze({ config, bootstrap, pending });
	}

	/**
	 * Verified remote packages, kept across restarts. Packages are immutable and
	 * content addressed, so a cached body is reusable for as long as the same
	 * file exists remotely. Without this every fresh process re-downloads and
	 * re-decrypts the whole history before it can do anything, which is what
	 * made revealing a pairing code slow on a cold start. Callers still verify
	 * what they read back; this only replaces the network and the decrypt.
	 */
	async readCachedRemotePackages(
		accountNamespace: string,
		cacheKeys: readonly string[],
	): Promise<ReadonlyMap<string, string>> {
		accountNamespaceSchema.parse(accountNamespace);
		const found = new Map<string, string>();
		const unique = [...new Set(cacheKeys)];
		for (let start = 0; start < unique.length; start += 400) {
			const chunk = unique.slice(start, start + 400);
			if (chunk.length === 0) continue;
			const placeholders = chunk.map(() => "?").join(", ");
			const rows = await this.#db.select<
				Array<{ cache_key: string; serialized: string }>
			>(
				`SELECT cache_key, serialized FROM sync_remote_package_cache
				 WHERE account_namespace = ? AND cache_key IN (${placeholders})`,
				[accountNamespace, ...chunk],
			);
			for (const row of rows) found.set(row.cache_key, row.serialized);
		}
		return found;
	}

	/**
	 * The identity and chain fields of cached packages, read inside SQLite so the
	 * bodies never cross into the webview. The whole cache runs to hundreds of
	 * megabytes, and reading it all back at every launch is what got the page
	 * killed on iOS. Fields are returned exactly as stored: callers must still
	 * check them against the authenticated filename, and a body is verified in
	 * full before it is applied.
	 */
	async readCachedRemotePackageHeaders(
		accountNamespace: string,
		cacheKeys: readonly string[],
	): Promise<ReadonlyMap<string, CachedRemotePackageHeader>> {
		accountNamespaceSchema.parse(accountNamespace);
		const found = new Map<string, CachedRemotePackageHeader>();
		const unique = [...new Set(cacheKeys)];
		for (let start = 0; start < unique.length; start += 400) {
			const chunk = unique.slice(start, start + 400);
			if (chunk.length === 0) continue;
			const placeholders = chunk.map(() => "?").join(", ");
			const rows = await this.#db.select<CachedRemotePackageHeaderRow[]>(
				`SELECT cache_key,
						json_extract(serialized, '$.packageId') AS package_id,
						json_extract(serialized, '$.accountNamespace') AS account_namespace,
						json_extract(serialized, '$.sourceDeviceId') AS source_device_id,
						json_extract(serialized, '$.sequenceRange.start') AS sequence_start,
						json_extract(serialized, '$.sequenceRange.end') AS sequence_end,
						json_extract(serialized, '$.contentDigest') AS content_digest,
						json_extract(serialized, '$.previousPackageDigest') AS previous_package_digest
				 FROM sync_remote_package_cache
				 WHERE account_namespace = ? AND cache_key IN (${placeholders})
				   AND json_valid(serialized)`,
				[accountNamespace, ...chunk],
			);
			for (const row of rows) {
				found.set(row.cache_key, {
					packageId: row.package_id,
					accountNamespace: row.account_namespace,
					sourceDeviceId: row.source_device_id,
					sequenceStart: row.sequence_start,
					sequenceEnd: row.sequence_end,
					contentDigest: row.content_digest,
					previousPackageDigest: row.previous_package_digest,
				});
			}
		}
		return found;
	}

	/** Package id → content digest for every package this device has applied. */
	async listAppliedPackageDigests(
		accountNamespace: string,
	): Promise<ReadonlyMap<string, string>> {
		accountNamespaceSchema.parse(accountNamespace);
		return this.#afterWrites(async () => {
			const rows = await this.#db.select<Array<{ package_id: string; content_digest: string }>>(
				"SELECT package_id, content_digest FROM sync_applied_packages WHERE account_namespace = ?",
				[accountNamespace],
			);
			return new Map(rows.map((row) => [row.package_id, row.content_digest]));
		});
	}

	async writeCachedRemotePackages(
		accountNamespace: string,
		entries: readonly Readonly<{ cacheKey: string; serialized: string }>[],
	): Promise<void> {
		accountNamespaceSchema.parse(accountNamespace);
		if (entries.length === 0) return;
		const now = Date.now();
		await this.#serializedWrite("cache-remote-packages", async () => {
			for (const entry of entries) {
				await this.#db.execute(
					`INSERT INTO sync_remote_package_cache
						(cache_key, account_namespace, serialized, cached_at_ms)
					 VALUES (?, ?, ?, ?)
					 ON CONFLICT(cache_key) DO UPDATE SET
						serialized = excluded.serialized,
						cached_at_ms = excluded.cached_at_ms`,
					[entry.cacheKey, accountNamespace, entry.serialized, now],
				);
			}
		});
	}

	/** Drop cached bodies for files the latest listing no longer reports. */
	async pruneCachedRemotePackages(
		accountNamespace: string,
		liveCacheKeys: readonly string[],
	): Promise<void> {
		accountNamespaceSchema.parse(accountNamespace);
		await this.#serializedWrite("prune-remote-package-cache", async () => {
			if (liveCacheKeys.length === 0) {
				await this.#db.execute(
					"DELETE FROM sync_remote_package_cache WHERE account_namespace = ?",
					[accountNamespace],
				);
				return;
			}
			const rows = await this.#db.select<Array<{ cache_key: string }>>(
				"SELECT cache_key FROM sync_remote_package_cache WHERE account_namespace = ?",
				[accountNamespace],
			);
			const live = new Set(liveCacheKeys);
			const stale = rows
				.map((row) => row.cache_key)
				.filter((key) => !live.has(key));
			for (let start = 0; start < stale.length; start += 400) {
				const chunk = stale.slice(start, start + 400);
				if (chunk.length === 0) continue;
				const placeholders = chunk.map(() => "?").join(", ");
				await this.#db.execute(
					`DELETE FROM sync_remote_package_cache WHERE cache_key IN (${placeholders})`,
					chunk,
				);
			}
		});
	}

	async getPendingCounts(accountNamespace: string): Promise<GoogleDriveSyncPendingCounts> {
		accountNamespaceSchema.parse(accountNamespace);
		return this.#afterWrites(() =>
			this.#readPendingCountsUnlocked(accountNamespace),
		);
	}

	async #readPendingCountsUnlocked(
		accountNamespace: string,
	): Promise<GoogleDriveSyncPendingCounts> {
		{
			const rows = await this.#db.select<CountRow[]>(
				`SELECT COUNT(*) AS changes,
						COALESCE(SUM(o.estimated_bytes), 0) AS bytes
				 FROM sync_outbound_operations o
				 LEFT JOIN sync_outbound_packages p ON p.package_id = o.package_id
				 WHERE o.account_namespace = ?
				   AND o.superseded_at_ms IS NULL
				   AND (o.package_id IS NULL OR p.uploaded_at_ms IS NULL)`,
				[accountNamespace],
			);
			const row = rows[0] ?? { changes: 0, bytes: 0 };
			return Object.freeze({
				changes: asSafeNonNegativeInteger(row.changes),
				bytes: asSafeNonNegativeInteger(row.bytes),
			});
		}
	}

	async listUnpackagedOperations(
		accountNamespace: string,
		sourceDeviceId: string,
		limit = MAX_SYNC_PACKAGE_OPERATIONS,
	): Promise<readonly ImmutableSyncOperation[]> {
		accountNamespaceSchema.parse(accountNamespace);
		deviceIdSchema.parse(sourceDeviceId);
		if (!Number.isSafeInteger(limit) || limit <= 0) {
			throw new Error("The outbound operation limit must be positive");
		}
		return this.#afterWrites(async () => {
			const rows = await this.#db.select<OperationJsonRow[]>(
				`SELECT operation_json FROM sync_outbound_operations
				 WHERE account_namespace = ? AND source_device_id = ?
				   AND package_id IS NULL AND superseded_at_ms IS NULL
				 ORDER BY origin_sequence ASC LIMIT ?`,
				[accountNamespace, sourceDeviceId, Math.min(limit, MAX_SYNC_PACKAGE_OPERATIONS)],
			);
			return Object.freeze(rows.map((row) => parseOperation(row.operation_json)));
		});
	}

	/**
	 * Returns still-unuploaded local history for one entity. Superseded entries
	 * remain in the immutable sequence chain but are omitted by default.
	 */
	async listUnuploadedEntityOperations(input: {
		accountNamespace: string;
		sourceDeviceId: string;
		section: SyncSection;
		entityType: string;
		entityId: string;
		includeSuperseded?: boolean;
	}): Promise<readonly ImmutableSyncOperation[]> {
		accountNamespaceSchema.parse(input.accountNamespace);
		deviceIdSchema.parse(input.sourceDeviceId);
		syncSectionSchema.parse(input.section);
		entityTypeSchema.parse(input.entityType);
		entityIdSchema.parse(input.entityId);
		return this.#afterWrites(async () => {
			const rows = await this.#db.select<OperationJsonRow[]>(
				`SELECT o.operation_json FROM sync_outbound_operations o
				 LEFT JOIN sync_outbound_packages p ON p.package_id = o.package_id
				 WHERE o.account_namespace = ? AND o.source_device_id = ?
				   AND o.section = ? AND o.entity_type = ? AND o.entity_id = ?
				   AND (o.package_id IS NULL OR p.uploaded_at_ms IS NULL)
				   ${input.includeSuperseded ? "" : "AND o.superseded_at_ms IS NULL"}
				 ORDER BY o.origin_sequence ASC`,
				[
					input.accountNamespace,
					input.sourceDeviceId,
					input.section,
					input.entityType,
					input.entityId,
				],
			);
			return Object.freeze(rows.map((row) => parseOperation(row.operation_json)));
		});
	}

	/**
	 * Marks this device's not-yet-uploaded operations for one entity as losing to
	 * a known authoritative bootstrap operation. Records are retained (and may
	 * leave deliberate sequence gaps) for counter recovery and diagnostics, but
	 * are excluded from packages, pending counts, and shadow/conflict decisions.
	 *
	 * Bootstrap ordering is important: reconcile local rows first, persist that
	 * scan's local origin-sequence cutoff, then call this for the entities the
	 * authoritative snapshot wins. Operations above the cutoff are later edits
	 * and are never canceled. Local-only entities remain untouched and pending.
	 */
	async supersedeUnuploadedEntityOperations(input: {
		accountNamespace: string;
		sourceDeviceId: string;
		section: SyncSection;
		entityType: string;
		entityId: string;
		supersededByOperationId: string;
		maxOriginSequence: number;
		atMs?: number;
	}): Promise<number> {
		accountNamespaceSchema.parse(input.accountNamespace);
		deviceIdSchema.parse(input.sourceDeviceId);
		syncSectionSchema.parse(input.section);
		entityTypeSchema.parse(input.entityType);
		entityIdSchema.parse(input.entityId);
		operationIdSchema.parse(input.supersededByOperationId);
		nonNegativeSafeIntegerSchema.parse(input.maxOriginSequence);
		const atMs = input.atMs ?? Date.now();
		assertOptionalTimestamp(atMs);

		return this.#serializedWrite("supersede-bootstrap-operations", async () => {
			const candidates = await this.#db.select<Array<{ operation_id: string }>>(
				`SELECT o.operation_id FROM sync_outbound_operations o
				 LEFT JOIN sync_outbound_packages p ON p.package_id = o.package_id
				 WHERE o.account_namespace = ? AND o.source_device_id = ?
					 AND o.section = ? AND o.entity_type = ? AND o.entity_id = ?
				   AND o.origin_sequence <= ?
				   AND o.superseded_at_ms IS NULL
				   AND (o.package_id IS NULL OR p.uploaded_at_ms IS NULL)`,
				[
					input.accountNamespace,
					input.sourceDeviceId,
					input.section,
					input.entityType,
					input.entityId,
					input.maxOriginSequence,
				],
			);
			if (candidates.length === 0) return 0;

			// An immutable package cannot be edited in place. If a candidate was
			// already staged, discard that package and every unuploaded successor in
			// its digest chain; the remaining operations are repackaged below the next
			// time the controller drains the outbox. An uploaded successor would make
			// cancellation impossible and is rejected explicitly.
			const packaged = await this.#db.select<Array<{ sequence_start: number | null }>>(
				`SELECT MIN(p.sequence_start) AS sequence_start
				 FROM sync_outbound_packages p
				 JOIN sync_outbound_operations o ON o.package_id = p.package_id
				 WHERE o.operation_id IN (${candidates.map(() => "?").join(", ")})`,
				candidates.map((row) => row.operation_id),
			);
			const firstAffectedSequence = packaged[0]?.sequence_start;
			if (firstAffectedSequence != null) {
				const uploadedSuccessors = await this.#db.select<Array<{ count: number }>>(
					`SELECT COUNT(*) AS count FROM sync_outbound_packages
					 WHERE account_namespace = ? AND source_device_id = ?
					   AND sequence_start >= ? AND uploaded_at_ms IS NOT NULL`,
					[input.accountNamespace, input.sourceDeviceId, firstAffectedSequence],
				);
				if ((uploadedSuccessors[0]?.count ?? 0) > 0) {
					throw new Error(
						"Cannot supersede an operation whose package chain was already uploaded",
					);
				}
				await this.#db.execute(
					`DELETE FROM sync_outbound_packages
					 WHERE account_namespace = ? AND source_device_id = ?
					   AND sequence_start >= ? AND uploaded_at_ms IS NULL`,
					[input.accountNamespace, input.sourceDeviceId, firstAffectedSequence],
				);
				await this.#clearDanglingPackageAssignments();
			}
			// Remove the candidate shadow first. If this write or the following
			// UPDATE is interrupted, the candidate is still unsuperseded and normal
			// outbox repair restores it. Doing these writes in the opposite order can
			// strand a superseded operation as the winning shadow forever.
			await this.#db.execute(
				`DELETE FROM sync_entity_shadow
				 WHERE account_namespace = ? AND section = ? AND entity_type = ?
				   AND entity_id = ?
				   AND winning_operation_id IN (${candidates.map(() => "?").join(", ")})`,
				[
					input.accountNamespace,
					input.section,
					input.entityType,
					input.entityId,
					...candidates.map((row) => row.operation_id),
				],
			);
			await this.#db.execute(
				`UPDATE sync_outbound_operations
				 SET superseded_at_ms = ?, superseded_by_operation_id = ?
				 WHERE operation_id IN (${candidates.map(() => "?").join(", ")})`,
				[atMs, input.supersededByOperationId, ...candidates.map((row) => row.operation_id)],
			);
			return candidates.length;
		});
	}

	/** Creates and durably stages the next immutable contiguous package. */
	async createNextOutboundPackage(
		accountNamespace: string,
		sourceDeviceId: string,
		maxOperations = MAX_SYNC_PACKAGE_OPERATIONS,
	): Promise<OutboundGoogleDriveSyncPackage | null> {
		accountNamespaceSchema.parse(accountNamespace);
		deviceIdSchema.parse(sourceDeviceId);
		if (!Number.isSafeInteger(maxOperations) || maxOperations <= 0) {
			throw new Error("The package operation limit must be positive");
		}

		return this.#serializedWrite("create-outbound-package", async () => {
			await this.#repairPackageAssignments();
			const operationRows = await this.#db.select<OperationJsonRow[]>(
				`SELECT operation_json, estimated_bytes FROM sync_outbound_operations
				 WHERE account_namespace = ? AND source_device_id = ?
				   AND package_id IS NULL AND superseded_at_ms IS NULL
				 ORDER BY origin_sequence ASC LIMIT ?`,
				[
					accountNamespace,
					sourceDeviceId,
					Math.min(maxOperations, MAX_SYNC_PACKAGE_OPERATIONS),
				],
			);
			if (operationRows.length === 0) return null;
			const packagePayloadBudget =
				Math.min(GOOGLE_DRIVE_SYNC_TARGET_PACKAGE_BYTES, MAX_SYNC_PACKAGE_BYTES) -
				128 * 1024;
			let estimatedPayloadBytes = 0;
			const availableOperations: ImmutableSyncOperation[] = [];
			for (const row of operationRows) {
				const estimatedBytes = asSafeNonNegativeInteger(row.estimated_bytes);
				if (
					availableOperations.length > 0 &&
					estimatedPayloadBytes + estimatedBytes > packagePayloadBudget
				) {
					break;
				}
				availableOperations.push(parseOperation(row.operation_json));
				estimatedPayloadBytes += estimatedBytes;
			}
			// A locally superseded sequence is a deliberate gap. A package remains
			// internally contiguous, while the digest chain (not adjacent sequence
			// numbers) proves that no actual package was omitted.
			const firstGap = availableOperations.findIndex(
				(operation, index) =>
					index > 0 &&
					operation.originSequence !== availableOperations[index - 1].originSequence + 1,
			);
			let operations = availableOperations.slice(
				0,
				firstGap === -1 ? availableOperations.length : firstGap,
			);
			const headRows = await this.#db.select<PackageHeadRow[]>(
				`SELECT sequence_end, content_digest FROM sync_outbound_packages
				 WHERE account_namespace = ? AND source_device_id = ?
				 ORDER BY sequence_end DESC LIMIT 1`,
				[accountNamespace, sourceDeviceId],
			);
			const head = headRows[0];
			const minimumStart = head ? head.sequence_end + 1 : 1;
			if ((operations[0]?.originSequence ?? 0) < minimumStart) {
				throw new Error(
					`The local sync outbox moved backwards: expected at least ${minimumStart}, found ${operations[0]?.originSequence ?? "nothing"}`,
				);
			}
			for (let index = 1; index < operations.length; index += 1) {
				if (operations[index].originSequence !== operations[index - 1].originSequence + 1) {
					throw new Error("The local sync outbox contains a sequence gap");
				}
			}

			let syncPackage: SyncPackage;
			let serialized: string;
			for (;;) {
				syncPackage = await createSyncPackage({
					accountNamespace,
					sourceDeviceId,
					previousPackageDigest: head?.content_digest ?? null,
					operations,
				});
				serialized = canonicalJson(syncPackage as unknown as JsonValue);
				if (
					new TextEncoder().encode(serialized).byteLength <=
					GOOGLE_DRIVE_SYNC_TARGET_PACKAGE_BYTES
				) {
					break;
				}
				if (operations.length === 1) {
					throw new Error(
						"A single sync operation exceeds the 3 MiB transport-package limit",
					);
				}
				operations = operations.slice(0, -1);
			}
			// Package first, then association. A crash in between is repaired on open
			// or before the next package is made, so an operation is never orphaned.
			await this.#db.execute(
				`INSERT INTO sync_outbound_packages (
					package_id, account_namespace, source_device_id,
					sequence_start, sequence_end, content_digest,
					previous_package_digest, package_json, created_at_ms
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					syncPackage.packageId,
					accountNamespace,
					sourceDeviceId,
					syncPackage.sequenceRange.start,
					syncPackage.sequenceRange.end,
					syncPackage.contentDigest,
					syncPackage.previousPackageDigest,
					serialized,
					syncPackage.createdAtMs,
				],
			);
			await this.#db.execute(
				`UPDATE sync_outbound_operations SET package_id = ?
				 WHERE account_namespace = ? AND source_device_id = ?
				   AND origin_sequence BETWEEN ? AND ? AND package_id IS NULL
				   AND superseded_at_ms IS NULL`,
				[
					syncPackage.packageId,
					accountNamespace,
					sourceDeviceId,
					syncPackage.sequenceRange.start,
					syncPackage.sequenceRange.end,
				],
			);
			return Object.freeze({
				syncPackage,
				serialized,
				createdAtMs: syncPackage.createdAtMs,
				uploadedAtMs: null,
				remoteFileId: null,
			});
		});
	}

	async listPendingOutboundPackages(
		accountNamespace: string,
		sourceDeviceId: string,
	): Promise<readonly OutboundGoogleDriveSyncPackage[]> {
		accountNamespaceSchema.parse(accountNamespace);
		deviceIdSchema.parse(sourceDeviceId);
		return this.#afterWrites(async () => {
			const rows = await this.#db.select<PackageRow[]>(
				`SELECT package_json, created_at_ms, uploaded_at_ms, remote_file_id
				 FROM sync_outbound_packages
				 WHERE account_namespace = ? AND source_device_id = ?
				   AND uploaded_at_ms IS NULL
				 ORDER BY sequence_start ASC`,
				[accountNamespace, sourceDeviceId],
			);
			return Object.freeze(
				await Promise.all(
					rows.map(async (row) => ({
						syncPackage: await parseAndVerifySyncPackage(row.package_json),
						serialized: row.package_json,
						createdAtMs: row.created_at_ms,
						uploadedAtMs: row.uploaded_at_ms,
						remoteFileId: row.remote_file_id,
					})),
				),
			);
		});
	}

	async markOutboundPackageUploaded(
		packageId: string,
		remoteFileId: string,
		uploadedAtMs = Date.now(),
	): Promise<void> {
		if (!packageId || !remoteFileId) {
			throw new Error("An uploaded sync package requires local and remote IDs");
		}
		assertOptionalTimestamp(uploadedAtMs);
		await this.#serializedWrite("mark-package-uploaded", async () => {
			const result = await this.#db.execute(
				`UPDATE sync_outbound_packages
				 SET remote_file_id = ?, uploaded_at_ms = ?
				 WHERE package_id = ?`,
				[remoteFileId, uploadedAtMs, packageId],
			);
			if (result.rowsAffected === 0) {
				throw new Error(`Unknown outbound sync package: ${packageId}`);
			}
		});
	}

	/**
	 * Verifies chain position from durable receipts, then applies through the
	 * shared protocol helper. Package verification is intentionally repeated by
	 * the helper before any mutation is attempted.
	 */
	async applyIncomingPackage(
		input: unknown,
		options: IncomingGoogleDriveSyncPackageOptions,
	): Promise<ApplySyncPackageResult> {
		accountNamespaceSchema.parse(options.expectedAccountNamespace);
		if (options.bootstrapAuthority) {
			deviceIdSchema.parse(options.bootstrapAuthority.localSourceDeviceId);
			nonNegativeSafeIntegerSchema.parse(
				options.bootstrapAuthority.localBaselineSequence,
			);
		}
		const syncPackage = await verifySyncPackage(input);
		if (options.expectedSourceDeviceId !== undefined) {
			deviceIdSchema.parse(options.expectedSourceDeviceId);
		}
		if (
			options.bootstrapAuthority &&
			syncPackage.sourceDeviceId === options.bootstrapAuthority.localSourceDeviceId
		) {
			throw new SyncProtocolError(
				"identity-mismatch",
				"A bootstrap authority package must come from a different source device",
			);
		}
		const cursor = await this.getInboundCursor(
			options.expectedAccountNamespace,
			syncPackage.sourceDeviceId,
		);
		const existingReceipt = await this.#afterWrites(() =>
			this.#getAppliedPackage(options.expectedAccountNamespace, syncPackage.packageId),
		);
		if (!existingReceipt && syncPackage.sequenceRange.start < cursor.nextSequence) {
			throw new SyncProtocolError(
				"sequence-gap",
				"An incoming source-device package overlaps already applied history",
			);
		}
		const applyStore: SyncApplyStore = {
			transaction: (accountNamespace, action) =>
				this.#applyTransaction(
					accountNamespace,
					action,
					options.bootstrapAuthority,
				),
		};
		return applySyncPackageIdempotently(syncPackage, applyStore, {
			expectedAccountNamespace: options.expectedAccountNamespace,
			expectedSourceDeviceId: options.expectedSourceDeviceId,
			expectedPreviousPackageDigest: cursor.previousPackageDigest,
			// Deliberate gaps represent locally superseded, never-transported
			// operations. The previous digest still enforces an unbroken package chain.
			now: options.now,
		});
	}

	async getInboundCursor(
		accountNamespace: string,
		sourceDeviceId: string,
	): Promise<Readonly<{ nextSequence: number; previousPackageDigest: string | null }>> {
		accountNamespaceSchema.parse(accountNamespace);
		deviceIdSchema.parse(sourceDeviceId);
		return this.#afterWrites(async () => {
			const rows = await this.#db.select<PackageHeadRow[]>(
				`SELECT sequence_end, content_digest FROM sync_applied_packages
				 WHERE account_namespace = ? AND source_device_id = ?
				 ORDER BY sequence_end DESC LIMIT 1`,
				[accountNamespace, sourceDeviceId],
			);
			const head = rows[0];
			return Object.freeze({
				nextSequence: head ? head.sequence_end + 1 : 1,
				previousPackageDigest: head?.content_digest ?? null,
			});
		});
	}

	/**
	 * Durably retain remote heads observed by a trusted pairing exporter. These
	 * are rollback floors, not apply receipts: the controller must still download
	 * and apply every package before recording normal receipts.
	 */
	async commitInboundHeads(
		accountNamespace: string,
		heads: readonly GoogleDriveSyncInboundHead[],
	): Promise<readonly GoogleDriveSyncInboundHead[]> {
		accountNamespaceSchema.parse(accountNamespace);
		const parsed = heads.map((head) => {
			deviceIdSchema.parse(head.sourceDeviceId);
			positiveSafeIntegerSchema.parse(head.sequenceEnd);
			sha256HexSchema.parse(head.contentDigest);
			return Object.freeze({ ...head });
		});
		const inputSources = new Set<string>();
		for (const head of parsed) {
			if (inputSources.has(head.sourceDeviceId)) {
				throw new Error("A remote-head commitment contains a duplicate source device");
			}
			inputSources.add(head.sourceDeviceId);
		}

		return this.#serializedWrite("commit-inbound-heads", async () => {
			const current = new Map(
				(await this.#readInboundHeadsUnlocked(accountNamespace)).map((head) => [
					head.sourceDeviceId,
					head,
				]),
			);
			for (const head of parsed) {
				const existing = current.get(head.sourceDeviceId);
				if (
					existing?.sequenceEnd === head.sequenceEnd &&
					existing.contentDigest !== head.contentDigest
				) {
					throw new Error(
						"A remote-head commitment conflicts with durable history at the same sequence",
					);
				}
				if (existing && existing.sequenceEnd >= head.sequenceEnd) continue;
				await this.#db.execute(
					`INSERT INTO sync_remote_head_commitments (
						account_namespace, source_device_id, sequence_end, content_digest
					 ) VALUES (?, ?, ?, ?)
					 ON CONFLICT(account_namespace, source_device_id) DO UPDATE SET
						sequence_end = excluded.sequence_end,
						content_digest = excluded.content_digest`,
					[
						accountNamespace,
						head.sourceDeviceId,
						head.sequenceEnd,
						head.contentDigest,
					],
				);
				current.set(head.sourceDeviceId, head);
			}
			return this.#readInboundHeadsUnlocked(accountNamespace);
		});
	}

	/** Latest applied or pairing-committed package for every remote source. */
	async listInboundHeads(
		accountNamespace: string,
	): Promise<readonly GoogleDriveSyncInboundHead[]> {
		accountNamespaceSchema.parse(accountNamespace);
		return this.#afterWrites(() => this.#readInboundHeadsUnlocked(accountNamespace));
	}

	async #readInboundHeadsUnlocked(
		accountNamespace: string,
	): Promise<readonly GoogleDriveSyncInboundHead[]> {
		const rows = await this.#db.select<InboundHeadRow[]>(
			`SELECT source_device_id, sequence_end, content_digest
			 FROM sync_remote_head_commitments
			 WHERE account_namespace = ?
			 UNION ALL
			 SELECT p.source_device_id, p.sequence_end, p.content_digest
			 FROM sync_applied_packages p
			 WHERE p.account_namespace = ?
			   AND NOT EXISTS (
				 SELECT 1 FROM sync_applied_packages newer
				 WHERE newer.account_namespace = p.account_namespace
				   AND newer.source_device_id = p.source_device_id
				   AND newer.sequence_end > p.sequence_end
			   )
			 ORDER BY source_device_id ASC`,
			[accountNamespace, accountNamespace],
		);
		const bySource = new Map<string, GoogleDriveSyncInboundHead>();
		for (const row of rows) {
			deviceIdSchema.parse(row.source_device_id);
			positiveSafeIntegerSchema.parse(row.sequence_end);
			sha256HexSchema.parse(row.content_digest);
			const existing = bySource.get(row.source_device_id);
			if (
				existing?.sequenceEnd === row.sequence_end &&
				existing.contentDigest !== row.content_digest
			) {
				throw new Error(
					"Durable remote-head records conflict at the same source sequence",
				);
			}
			if (!existing || row.sequence_end > existing.sequenceEnd) {
				bySource.set(
					row.source_device_id,
					Object.freeze({
						sourceDeviceId: row.source_device_id,
						sequenceEnd: row.sequence_end,
						contentDigest: row.content_digest,
					}),
				);
			}
		}
		return Object.freeze(
			Array.from(bySource.values()).sort((left, right) =>
				left.sourceDeviceId < right.sourceDeviceId
					? -1
					: left.sourceDeviceId > right.sourceDeviceId
						? 1
						: 0,
			),
		);
	}

	async transaction<T>(
		accountNamespace: string,
		action: (transaction: SyncApplyTransaction) => Promise<T>,
	): Promise<T> {
		return this.#applyTransaction(accountNamespace, action);
	}

	async #applyTransaction<T>(
		accountNamespace: string,
		action: (transaction: SyncApplyTransaction) => Promise<T>,
		bootstrapAuthority?: IncomingGoogleDriveSyncPackageOptions["bootstrapAuthority"],
	): Promise<T> {
		accountNamespaceSchema.parse(accountNamespace);
		return this.#serializedWrite("apply-incoming-package", async () => {
			const transaction: SyncApplyTransaction = {
				getAppliedOperation: (operationId) =>
					this.#getAppliedOperation(accountNamespace, operationId),
				applyOperation: (operation) =>
					this.#applyIncomingOperation(
						accountNamespace,
						operation,
						bootstrapAuthority,
					),
				recordAppliedOperation: (receipt) =>
					this.#recordAppliedOperation(accountNamespace, receipt),
				getAppliedOperations: (operationIds) =>
					this.#getAppliedOperations(accountNamespace, operationIds),
				recordAppliedOperations: (receipts) =>
					this.#recordAppliedOperations(accountNamespace, receipts),
				getAppliedPackage: (packageId) =>
					this.#getAppliedPackage(accountNamespace, packageId),
				recordAppliedPackage: (receipt) =>
					this.#recordAppliedPackage(accountNamespace, receipt),
			};
			return action(transaction);
		});
	}

	async #initialize(): Promise<void> {
		await this.#serializedWrite("initialize", async () => {
			await this.#db.execute("PRAGMA journal_mode = WAL");
			await this.#db.execute("PRAGMA synchronous = NORMAL");
			await this.#db.execute(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
			await this.#db.execute(`
				CREATE TABLE IF NOT EXISTS sync_meta (
					key TEXT PRIMARY KEY,
					value TEXT NOT NULL
				)
			`);
			await this.#db.execute(`
				CREATE TABLE IF NOT EXISTS sync_config (
					singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
					enabled INTEGER NOT NULL DEFAULT 0,
					account_namespace TEXT,
					media_policy TEXT NOT NULL DEFAULT 'off'
						CHECK (media_policy IN ('off', 'wifi-only')),
					last_successful_sync_at INTEGER,
					last_error TEXT
				)
			`);
			await this.#db.execute(`
				CREATE TABLE IF NOT EXISTS sync_local_identity (
					singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
					source_device_id TEXT NOT NULL
				)
			`);
			await this.#db.execute(`
				CREATE TABLE IF NOT EXISTS sync_bootstrap_state (
					singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
					authority_device_id TEXT,
					authority_sequence_end INTEGER NOT NULL DEFAULT 0
						CHECK (authority_sequence_end >= 0),
					authority_head_digest TEXT,
					bootstrap_pending INTEGER NOT NULL DEFAULT 0
						CHECK (bootstrap_pending IN (0, 1)),
					anchor_required INTEGER NOT NULL DEFAULT 0
						CHECK (anchor_required IN (0, 1)),
					local_baseline_sequence INTEGER
						CHECK (local_baseline_sequence IS NULL OR local_baseline_sequence >= 0),
					CHECK (
						(authority_sequence_end = 0 AND authority_head_digest IS NULL) OR
						(authority_sequence_end > 0 AND authority_head_digest IS NOT NULL)
					),
					CHECK (
						authority_device_id IS NOT NULL OR (
							authority_sequence_end = 0 AND authority_head_digest IS NULL AND
							bootstrap_pending = 0 AND anchor_required = 0 AND
							local_baseline_sequence IS NULL
						)
					),
					CHECK (
						(bootstrap_pending = 1 AND authority_device_id IS NOT NULL AND
							local_baseline_sequence IS NOT NULL) OR
						(bootstrap_pending = 0 AND local_baseline_sequence IS NULL)
					),
					CHECK (anchor_required = 0 OR authority_device_id IS NOT NULL)
				)
			`);
			await this.#db.execute(`
				CREATE TABLE IF NOT EXISTS sync_counters (
					account_namespace TEXT NOT NULL,
					source_device_id TEXT NOT NULL,
					origin_sequence INTEGER NOT NULL,
					logical_clock INTEGER NOT NULL,
					PRIMARY KEY (account_namespace, source_device_id)
				)
			`);
			await this.#db.execute(`
				CREATE TABLE IF NOT EXISTS sync_account_clocks (
					account_namespace TEXT PRIMARY KEY,
					observed_logical_clock INTEGER NOT NULL
				)
			`);
			await this.#db.execute(`
				CREATE TABLE IF NOT EXISTS sync_entity_shadow (
					account_namespace TEXT NOT NULL,
					section TEXT NOT NULL,
					entity_type TEXT NOT NULL,
					entity_id TEXT NOT NULL,
					winning_operation_id TEXT NOT NULL,
					winning_operation_json TEXT NOT NULL,
					mutation_kind TEXT NOT NULL CHECK (mutation_kind IN ('upsert', 'delete')),
					value_digest TEXT,
					logical_clock INTEGER NOT NULL,
					revision_device_id TEXT NOT NULL,
					updated_at_ms INTEGER NOT NULL,
					PRIMARY KEY (account_namespace, section, entity_type, entity_id)
				)
			`);
			await this.#db.execute(
				"CREATE INDEX IF NOT EXISTS idx_sync_shadow_clock ON sync_entity_shadow(account_namespace, logical_clock)",
			);
			await this.#db.execute(`
				CREATE TABLE IF NOT EXISTS sync_outbound_operations (
					operation_id TEXT PRIMARY KEY,
					account_namespace TEXT NOT NULL,
					source_device_id TEXT NOT NULL,
					origin_sequence INTEGER NOT NULL,
					logical_clock INTEGER NOT NULL,
					section TEXT NOT NULL,
					entity_type TEXT NOT NULL,
					entity_id TEXT NOT NULL,
					operation_json TEXT NOT NULL,
					estimated_bytes INTEGER NOT NULL,
					package_id TEXT,
					superseded_at_ms INTEGER,
					superseded_by_operation_id TEXT,
					created_at_ms INTEGER NOT NULL,
					UNIQUE (account_namespace, source_device_id, origin_sequence)
				)
			`);
			const outboxColumns = await this.#db.select<Array<{ name: string }>>(
				"PRAGMA table_info(sync_outbound_operations)",
			);
			const outboxColumnNames = new Set(outboxColumns.map((column) => column.name));
			if (!outboxColumnNames.has("superseded_at_ms")) {
				await this.#db.execute(
					"ALTER TABLE sync_outbound_operations ADD COLUMN superseded_at_ms INTEGER",
				);
			}
			if (!outboxColumnNames.has("superseded_by_operation_id")) {
				await this.#db.execute(
					"ALTER TABLE sync_outbound_operations ADD COLUMN superseded_by_operation_id TEXT",
				);
			}
			await this.#db.execute(
				"CREATE INDEX IF NOT EXISTS idx_sync_outbox_pending ON sync_outbound_operations(account_namespace, source_device_id, package_id, origin_sequence)",
			);
			await this.#db.execute(`
				CREATE TABLE IF NOT EXISTS sync_outbound_packages (
					package_id TEXT PRIMARY KEY,
					account_namespace TEXT NOT NULL,
					source_device_id TEXT NOT NULL,
					sequence_start INTEGER NOT NULL,
					sequence_end INTEGER NOT NULL,
					content_digest TEXT NOT NULL,
					previous_package_digest TEXT,
					package_json TEXT NOT NULL,
					created_at_ms INTEGER NOT NULL,
					remote_file_id TEXT,
					uploaded_at_ms INTEGER,
					UNIQUE (account_namespace, source_device_id, sequence_start, sequence_end)
				)
			`);
			await this.#db.execute(
				"CREATE INDEX IF NOT EXISTS idx_sync_packages_pending ON sync_outbound_packages(account_namespace, source_device_id, uploaded_at_ms, sequence_start)",
			);
			await this.#db.execute(`
				CREATE TABLE IF NOT EXISTS sync_applied_operations (
					operation_id TEXT PRIMARY KEY,
					account_namespace TEXT NOT NULL,
					source_device_id TEXT NOT NULL,
					origin_sequence INTEGER NOT NULL,
					fingerprint TEXT NOT NULL,
					applied_at_ms INTEGER NOT NULL
				)
			`);
			await this.#db.execute(`
				CREATE TABLE IF NOT EXISTS sync_applied_packages (
					package_id TEXT PRIMARY KEY,
					account_namespace TEXT NOT NULL,
					source_device_id TEXT NOT NULL,
					sequence_start INTEGER NOT NULL,
					sequence_end INTEGER NOT NULL,
					content_digest TEXT NOT NULL,
					previous_package_digest TEXT,
					applied_at_ms INTEGER NOT NULL,
					UNIQUE (account_namespace, source_device_id, sequence_start, sequence_end)
				)
			`);
			await this.#db.execute(
				"CREATE INDEX IF NOT EXISTS idx_sync_applied_source ON sync_applied_packages(account_namespace, source_device_id, sequence_end)",
			);
			await this.#db.execute(`
				CREATE TABLE IF NOT EXISTS sync_remote_package_cache (
					cache_key TEXT PRIMARY KEY,
					account_namespace TEXT NOT NULL,
					serialized TEXT NOT NULL,
					cached_at_ms INTEGER NOT NULL
				)
			`);
			await this.#db.execute(`
				CREATE TABLE IF NOT EXISTS sync_remote_head_commitments (
					account_namespace TEXT NOT NULL,
					source_device_id TEXT NOT NULL,
					sequence_end INTEGER NOT NULL CHECK (sequence_end > 0),
					content_digest TEXT NOT NULL,
					PRIMARY KEY (account_namespace, source_device_id)
				)
			`);

			// Pre-v4 stores did not bind their browser source id. Exactly one local
			// outbound/counter source is safe to recover; zero remains unbound for a
			// genuinely fresh enrollment and multiple sources require manual recovery.
			const legacySourceIds = await this.#legacyLocalSourceIdsUnlocked();
			if (legacySourceIds.length === 1) {
				await this.#db.execute(
					`INSERT OR IGNORE INTO sync_local_identity(singleton_id, source_device_id)
					 VALUES (1, ?)`,
					[legacySourceIds[0]],
				);
			}

			await this.#db.execute(
				"INSERT OR IGNORE INTO sync_meta(key, value) VALUES ('schema_version', ?)",
				[String(STORE_SCHEMA_VERSION)],
			);
			await this.#db.execute(
				"INSERT OR IGNORE INTO sync_meta(key, value) VALUES ('profile_id', ?)",
				[String(this.profileId)],
			);
			await this.#db.execute("INSERT OR IGNORE INTO sync_config(singleton_id) VALUES (1)");
			await this.#db.execute(
				"INSERT OR IGNORE INTO sync_bootstrap_state(singleton_id) VALUES (1)",
			);
			// Versions 2 through 4 are additive migrations. All new tables are created
			// before advancing the marker, so interruption safely retries on open.
			await this.#db.execute(
				"UPDATE sync_meta SET value = ? WHERE key = 'schema_version' AND value IN ('1', '2', '3')",
				[String(STORE_SCHEMA_VERSION)],
			);
			const meta = await this.#db.select<Array<{ key: string; value: string }>>(
				"SELECT key, value FROM sync_meta WHERE key IN ('schema_version', 'profile_id')",
			);
			const values = new Map(meta.map((row) => [row.key, row.value]));
			if (values.get("schema_version") !== String(STORE_SCHEMA_VERSION)) {
				throw new Error("This Google Drive sync database uses an unsupported schema");
			}
			if (values.get("profile_id") !== String(this.profileId)) {
				throw new Error("Refusing to open a sync database for a different profile");
			}

			await this.#repairPackageAssignments();
			await this.#purgeSupersededShadows();
			await this.#repairAllOutboxShadows();
			await this.#repairAllCounters();
		});
	}

	async #legacyLocalSourceIdsUnlocked(): Promise<readonly string[]> {
		const rows = await this.#db.select<LocalIdentityRow[]>(`
			SELECT source_device_id FROM sync_counters
			UNION
			SELECT source_device_id FROM sync_outbound_operations
			UNION
			SELECT source_device_id FROM sync_outbound_packages
			ORDER BY source_device_id ASC
		`);
		for (const row of rows) deviceIdSchema.parse(row.source_device_id);
		return rows.map((row) => row.source_device_id);
	}

	async #readConfigUnlocked(): Promise<GoogleDriveSyncStoreConfig> {
		const rows = await this.#db.select<ConfigRow[]>(
			`SELECT enabled, account_namespace, media_policy,
				last_successful_sync_at, last_error
			 FROM sync_config WHERE singleton_id = 1`,
		);
		const row = rows[0];
		if (!row) throw new Error("The Google Drive sync configuration is missing");
		assertMediaPolicy(row.media_policy);
		return {
			enabled: Boolean(row.enabled),
			accountNamespace: row.account_namespace,
			mediaPolicy: row.media_policy,
			lastSuccessfulSyncAt: row.last_successful_sync_at,
			lastError: row.last_error,
		};
	}

	async #readBootstrapStateUnlocked(): Promise<GoogleDriveSyncBootstrapState> {
		const rows = await this.#db.select<BootstrapStateRow[]>(
			`SELECT authority_device_id, authority_sequence_end,
				authority_head_digest, bootstrap_pending, anchor_required,
				local_baseline_sequence
			 FROM sync_bootstrap_state WHERE singleton_id = 1`,
		);
		const row = rows[0];
		if (!row) throw new Error("The Google Drive bootstrap state is missing");
		return {
			authorityDeviceId: row.authority_device_id,
			authoritySequenceEnd: row.authority_sequence_end,
			authorityHeadDigest: row.authority_head_digest,
			bootstrapPending: storedBoolean(row.bootstrap_pending, "bootstrap pending"),
			anchorRequired: storedBoolean(row.anchor_required, "anchor required"),
			localBaselineSequence: row.local_baseline_sequence,
		};
	}

	#validateScannedEntity(
		entity: GoogleDriveSyncEntity,
		scannedSections: readonly SyncSection[],
	): void {
		syncSectionSchema.parse(entity.section);
		entityTypeSchema.parse(entity.entityType);
		entityIdSchema.parse(entity.entityId);
		if (!scannedSections.includes(entity.section)) {
			throw new Error(
				`The scanner returned ${entity.section} data outside its completed section set`,
			);
		}
		// canonicalJson also rejects values outside the bounded JSON contract at
		// operation construction time; serializing here catches unsupported values
		// before a sequence is reserved in the durable outbox.
		canonicalJson(entity.value);
	}

	async #appendLocalOperationUnlocked(
		accountNamespace: string,
		sourceDeviceId: string,
		state: CounterState,
		section: SyncSection,
		entityType: string,
		entityId: string,
		mutation: Readonly<{ kind: "upsert"; value: JsonValue }> | Readonly<{ kind: "delete" }>,
	): Promise<ImmutableSyncOperation> {
		if (
			state.originSequence >= Number.MAX_SAFE_INTEGER ||
			state.logicalClock >= Number.MAX_SAFE_INTEGER
		) {
			throw new Error("The local sync sequence space is exhausted");
		}
		const operation = createSyncOperation({
			accountNamespace,
			sourceDeviceId,
			sequence: {
				originSequence: state.originSequence + 1,
				logicalClock: state.logicalClock + 1,
			},
			section,
			entityType,
			entityId,
			mutation,
		});
		const serialized = serializedOperation(operation);
		const estimatedBytes = new TextEncoder().encode(serialized).byteLength;

		// Safety invariant: never expose a newer shadow without the corresponding
		// durable outbox record. Counter persistence follows both and is recoverable
		// from MAX(origin_sequence) after a crash.
		await this.#db.execute(
			`INSERT INTO sync_outbound_operations (
				operation_id, account_namespace, source_device_id, origin_sequence,
				logical_clock, section, entity_type, entity_id, operation_json,
				estimated_bytes, created_at_ms
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				operation.operationId,
				accountNamespace,
				sourceDeviceId,
				operation.originSequence,
				operation.revision.logicalClock,
				operation.section,
				operation.entityType,
				operation.entityId,
				serialized,
				estimatedBytes,
				operation.createdAtMs,
			],
		);
		await this.#writeShadow(operation);
		state.originSequence = operation.originSequence;
		state.logicalClock = operation.revision.logicalClock;
		await this.#persistCounter(accountNamespace, sourceDeviceId, state);
		return operation;
	}

	async #loadShadowSummaries(
		accountNamespace: string,
		sections: readonly SyncSection[],
	): Promise<Map<string, ShadowSummaryRow>> {
		const placeholders = sections.map(() => "?").join(", ");
		const rows = await this.#db.select<ShadowSummaryRow[]>(
			`SELECT section, entity_type, entity_id, mutation_kind, value_digest
			 FROM sync_entity_shadow
			 WHERE account_namespace = ? AND section IN (${placeholders})`,
			[accountNamespace, ...sections],
		);
		return new Map(
			rows.map((row) => [
				shadowKey(row.section as SyncSection, row.entity_type, row.entity_id),
				row,
			]),
		);
	}

	async #getShadowOperation(
		operation: ImmutableSyncOperation,
	): Promise<ImmutableSyncOperation | undefined> {
		const rows = await this.#db.select<OperationJsonRow[]>(
			`SELECT winning_operation_json AS operation_json
			 FROM sync_entity_shadow
			 WHERE account_namespace = ? AND section = ?
			   AND entity_type = ? AND entity_id = ?`,
			[
				operation.accountNamespace,
				operation.section,
				operation.entityType,
				operation.entityId,
			],
		);
		return rows[0] ? parseOperation(rows[0].operation_json) : undefined;
	}

	async #writeShadow(operation: ImmutableSyncOperation): Promise<void> {
		const serialized = serializedOperation(operation);
		await this.#db.execute(
			`INSERT INTO sync_entity_shadow (
				account_namespace, section, entity_type, entity_id,
				winning_operation_id, winning_operation_json, mutation_kind,
				value_digest, logical_clock, revision_device_id, updated_at_ms
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(account_namespace, section, entity_type, entity_id)
			DO UPDATE SET
				winning_operation_id = excluded.winning_operation_id,
				winning_operation_json = excluded.winning_operation_json,
				mutation_kind = excluded.mutation_kind,
				value_digest = excluded.value_digest,
				logical_clock = excluded.logical_clock,
				revision_device_id = excluded.revision_device_id,
				updated_at_ms = excluded.updated_at_ms`,
			[
				operation.accountNamespace,
				operation.section,
				operation.entityType,
				operation.entityId,
				operation.operationId,
				serialized,
				operation.mutation.kind,
				await operationValueDigest(operation),
				operation.revision.logicalClock,
				operation.revision.deviceId,
				Date.now(),
			],
		);
	}

	async #repairOutboxShadow(accountNamespace: string, sourceDeviceId: string): Promise<void> {
		let afterSequence = -1;
		for (;;) {
			const rows = await this.#db.select<Array<OperationJsonRow & { origin_sequence: number }>>(
				`SELECT operation_json, origin_sequence FROM sync_outbound_operations
				 WHERE account_namespace = ? AND source_device_id = ?
				   AND superseded_at_ms IS NULL AND origin_sequence > ?
				 ORDER BY origin_sequence ASC LIMIT ?`,
				[accountNamespace, sourceDeviceId, afterSequence, OUTBOX_REPAIR_PAGE_SIZE],
			);
			for (const row of rows) {
				await this.#writeShadowIfWinning(parseOperation(row.operation_json));
			}
			if (rows.length < OUTBOX_REPAIR_PAGE_SIZE) return;
			afterSequence = rows[rows.length - 1].origin_sequence;
		}
	}

	async #repairAllOutboxShadows(): Promise<void> {
		const bootstrap = await this.#readBootstrapStateUnlocked();
		// Same order as a single query would give, one page at a time.
		let after: [string, string, number] | null = null;
		for (;;) {
			const rows: Array<
				OperationJsonRow & {
					account_namespace: string;
					source_device_id: string;
					origin_sequence: number;
				}
			> = await this.#db.select(
				`SELECT operation_json, account_namespace, source_device_id, origin_sequence
				 FROM sync_outbound_operations
				 WHERE superseded_at_ms IS NULL
				   ${after ? "AND (account_namespace, source_device_id, origin_sequence) > (?, ?, ?)" : ""}
				 ORDER BY account_namespace, source_device_id, origin_sequence
				 LIMIT ?`,
				after ? [...after, OUTBOX_REPAIR_PAGE_SIZE] : [OUTBOX_REPAIR_PAGE_SIZE],
			);
			for (const row of rows) {
				const operation = parseOperation(row.operation_json);
				if (bootstrap.bootstrapPending && bootstrap.authorityDeviceId) {
					const previous = await this.#getShadowOperation(operation);
					if (previous?.sourceDeviceId === bootstrap.authorityDeviceId) {
						// Applying an authority baseline and superseding its old local outbox
						// entries are deliberately separate durable steps. Preserve the applied
						// authority shadow across a crash between them, even when ordinary LWW
						// ordering would temporarily prefer an unsuperseded baseline entry.
						continue;
					}
				}
				await this.#writeShadowIfWinning(operation);
			}
			if (rows.length < OUTBOX_REPAIR_PAGE_SIZE) return;
			const last = rows[rows.length - 1];
			after = [last.account_namespace, last.source_device_id, last.origin_sequence];
		}
	}

	/** Repairs databases interrupted by the older update-before-shadow-delete order. */
	async #purgeSupersededShadows(): Promise<void> {
		await this.#db.execute(`
			DELETE FROM sync_entity_shadow
			WHERE winning_operation_id IN (
				SELECT operation_id FROM sync_outbound_operations
				WHERE superseded_at_ms IS NOT NULL
			)
		`);
	}

	async #writeShadowIfWinning(operation: ImmutableSyncOperation): Promise<boolean> {
		const previous = await this.#getShadowOperation(operation);
		if (previous && selectWinningOperation(previous, operation) === previous) {
			return false;
		}
		await this.#writeShadow(operation);
		return true;
	}

	async #recoverCounter(accountNamespace: string, sourceDeviceId: string): Promise<CounterState> {
		const rows = await this.#db.select<CounterRow[]>(
			`SELECT
				(SELECT origin_sequence FROM sync_counters
				 WHERE account_namespace = ? AND source_device_id = ?) AS counter_sequence,
				(SELECT MAX(origin_sequence) FROM sync_outbound_operations
				 WHERE account_namespace = ? AND source_device_id = ?) AS outbox_sequence,
				(SELECT logical_clock FROM sync_counters
				 WHERE account_namespace = ? AND source_device_id = ?) AS counter_clock,
				(SELECT MAX(logical_clock) FROM sync_outbound_operations
				 WHERE account_namespace = ?) AS outbox_clock,
				(SELECT MAX(logical_clock) FROM sync_entity_shadow
				 WHERE account_namespace = ?) AS shadow_clock,
				(SELECT observed_logical_clock FROM sync_account_clocks
				 WHERE account_namespace = ?) AS observed_clock`,
			[
				accountNamespace,
				sourceDeviceId,
				accountNamespace,
				sourceDeviceId,
				accountNamespace,
				sourceDeviceId,
				accountNamespace,
				accountNamespace,
				accountNamespace,
			],
		);
		const row = rows[0] ?? {
			counter_sequence: 0,
			outbox_sequence: 0,
			counter_clock: 0,
			outbox_clock: 0,
			shadow_clock: 0,
			observed_clock: 0,
		};
		return {
			originSequence: Math.max(
				asSafeNonNegativeInteger(row.counter_sequence),
				asSafeNonNegativeInteger(row.outbox_sequence),
			),
			logicalClock: Math.max(
				asSafeNonNegativeInteger(row.counter_clock),
				asSafeNonNegativeInteger(row.outbox_clock),
				asSafeNonNegativeInteger(row.shadow_clock),
				asSafeNonNegativeInteger(row.observed_clock),
			),
		};
	}

	async #persistCounter(
		accountNamespace: string,
		sourceDeviceId: string,
		state: CounterState,
	): Promise<void> {
		await this.#db.execute(
			`INSERT INTO sync_counters (
				account_namespace, source_device_id, origin_sequence, logical_clock
			) VALUES (?, ?, ?, ?)
			ON CONFLICT(account_namespace, source_device_id) DO UPDATE SET
				origin_sequence = MAX(sync_counters.origin_sequence, excluded.origin_sequence),
				logical_clock = MAX(sync_counters.logical_clock, excluded.logical_clock)`,
			[accountNamespace, sourceDeviceId, state.originSequence, state.logicalClock],
		);
	}

	async #repairAllCounters(): Promise<void> {
		const scopes = await this.#db.select<
			Array<{ account_namespace: string; source_device_id: string }>
		>(
			`SELECT DISTINCT account_namespace, source_device_id
			 FROM sync_outbound_operations`,
		);
		for (const scope of scopes) {
			const state = await this.#recoverCounter(
				scope.account_namespace,
				scope.source_device_id,
			);
			await this.#persistCounter(scope.account_namespace, scope.source_device_id, state);
		}
	}

	async #repairPackageAssignments(): Promise<void> {
		await this.#clearDanglingPackageAssignments();
		await this.#db.execute(`
			UPDATE sync_outbound_operations
			SET package_id = (
				SELECT p.package_id FROM sync_outbound_packages p
				WHERE p.account_namespace = sync_outbound_operations.account_namespace
				  AND p.source_device_id = sync_outbound_operations.source_device_id
				  AND sync_outbound_operations.origin_sequence
					  BETWEEN p.sequence_start AND p.sequence_end
				ORDER BY p.sequence_start ASC LIMIT 1
			)
			WHERE package_id IS NULL AND superseded_at_ms IS NULL AND EXISTS (
				SELECT 1 FROM sync_outbound_packages p
				WHERE p.account_namespace = sync_outbound_operations.account_namespace
				  AND p.source_device_id = sync_outbound_operations.source_device_id
				  AND sync_outbound_operations.origin_sequence
					  BETWEEN p.sequence_start AND p.sequence_end
			)
		`);
	}

	async #clearDanglingPackageAssignments(): Promise<void> {
		await this.#db.execute(`
			UPDATE sync_outbound_operations SET package_id = NULL
			WHERE package_id IS NOT NULL AND NOT EXISTS (
				SELECT 1 FROM sync_outbound_packages p
				WHERE p.package_id = sync_outbound_operations.package_id
			)
		`);
	}

	async #observeLogicalClock(accountNamespace: string, logicalClock: number): Promise<void> {
		positiveSafeIntegerSchema.parse(logicalClock);
		await this.#db.execute(
			`INSERT INTO sync_account_clocks(account_namespace, observed_logical_clock)
			 VALUES (?, ?)
			 ON CONFLICT(account_namespace) DO UPDATE SET
			 observed_logical_clock = MAX(
				sync_account_clocks.observed_logical_clock,
				excluded.observed_logical_clock
			 )`,
			[accountNamespace, logicalClock],
		);
	}

	async #applyIncomingOperation(
		accountNamespace: string,
		operation: ImmutableSyncOperation,
		bootstrapAuthority?: IncomingGoogleDriveSyncPackageOptions["bootstrapAuthority"],
	): Promise<void> {
		if (operation.accountNamespace !== accountNamespace) {
			throw new Error("Refusing to apply an operation for a different account");
		}
		await this.#observeLogicalClock(accountNamespace, operation.revision.logicalClock);
		const previous = await this.#getShadowOperation(operation);
		let forceBootstrapAuthority = false;
		if (
			bootstrapAuthority &&
			previous?.sourceDeviceId === bootstrapAuthority.localSourceDeviceId
		) {
			if (previous.originSequence > bootstrapAuthority.localBaselineSequence) {
				// The local domain value was edited after the persisted bootstrap cutoff.
				// Preserve it, but make the authority operation the durable comparison
				// point. Reconciliation then journals the preserved value with a Lamport
				// clock above the authority history observed above.
				await this.#writeShadow(operation);
				return;
			}
			forceBootstrapAuthority = true;
		}

		if (
			!forceBootstrapAuthority &&
			previous &&
			selectWinningOperation(previous, operation) === previous
		) {
			return;
		}

		// This callback mutates another per-profile store, so it cannot share a
		// SQLite transaction with our receipt. Its contract is intentionally
		// idempotent: a crash here or before the shadow/receipt write replays the
		// same upsert/delete on the next package attempt.
		const domainApplied = await this.#applyDomainOperation(operation, previous);
		if (domainApplied !== false) {
			await this.#writeShadow(operation);
		}
	}

	/**
	 * Bulk receipt read. SQLite caps bound parameters, so ids are queried in
	 * chunks; the result is still one map for the whole package.
	 */
	async #getAppliedOperations(
		accountNamespace: string,
		operationIds: readonly string[],
	): Promise<ReadonlyMap<string, AppliedOperationReceipt>> {
		const found = new Map<string, AppliedOperationReceipt>();
		const unique = [...new Set(operationIds)];
		for (let start = 0; start < unique.length; start += 400) {
			const chunk = unique.slice(start, start + 400);
			if (chunk.length === 0) continue;
			const placeholders = chunk.map(() => "?").join(", ");
			const rows = await this.#db.select<AppliedOperationRow[]>(
				`SELECT operation_id, account_namespace, source_device_id,
					origin_sequence, fingerprint, applied_at_ms
				 FROM sync_applied_operations WHERE operation_id IN (${placeholders})`,
				chunk as unknown[],
			);
			for (const row of rows) {
				if (row.account_namespace !== accountNamespace) {
					throw new Error("An applied operation ID belongs to a different account");
				}
				found.set(
					row.operation_id,
					Object.freeze({
						operationId: row.operation_id,
						accountNamespace: row.account_namespace,
						sourceDeviceId: row.source_device_id,
						originSequence: row.origin_sequence,
						fingerprint: row.fingerprint,
						appliedAtMs: row.applied_at_ms,
					}),
				);
			}
		}
		return found;
	}

	/** Bulk receipt write, in multi-row statements rather than one per row. */
	async #recordAppliedOperations(
		accountNamespace: string,
		receipts: readonly AppliedOperationReceipt[],
	): Promise<void> {
		for (const receipt of receipts) {
			if (receipt.accountNamespace !== accountNamespace) {
				throw new Error("Refusing to record a receipt for a different account");
			}
		}
		for (let start = 0; start < receipts.length; start += 100) {
			const chunk = receipts.slice(start, start + 100);
			if (chunk.length === 0) continue;
			const values = chunk.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
			const parameters: unknown[] = [];
			for (const receipt of chunk) {
				parameters.push(
					receipt.operationId,
					receipt.accountNamespace,
					receipt.sourceDeviceId,
					receipt.originSequence,
					receipt.fingerprint,
					receipt.appliedAtMs,
				);
			}
			await this.#db.execute(
				`INSERT INTO sync_applied_operations (
					operation_id, account_namespace, source_device_id,
					origin_sequence, fingerprint, applied_at_ms
				) VALUES ${values}`,
				parameters,
			);
		}
	}

	async #getAppliedOperation(
		accountNamespace: string,
		operationId: string,
	): Promise<AppliedOperationReceipt | undefined> {
		const rows = await this.#db.select<AppliedOperationRow[]>(
			`SELECT operation_id, account_namespace, source_device_id,
				origin_sequence, fingerprint, applied_at_ms
			 FROM sync_applied_operations WHERE operation_id = ?`,
			[operationId],
		);
		const row = rows[0];
		if (!row) return undefined;
		if (row.account_namespace !== accountNamespace) {
			throw new Error("An applied operation ID belongs to a different account");
		}
		return Object.freeze({
			operationId: row.operation_id,
			accountNamespace: row.account_namespace,
			sourceDeviceId: row.source_device_id,
			originSequence: row.origin_sequence,
			fingerprint: row.fingerprint,
			appliedAtMs: row.applied_at_ms,
		});
	}

	async #recordAppliedOperation(
		accountNamespace: string,
		receipt: AppliedOperationReceipt,
	): Promise<void> {
		if (receipt.accountNamespace !== accountNamespace) {
			throw new Error("Refusing to record a receipt for a different account");
		}
		await this.#db.execute(
			`INSERT INTO sync_applied_operations (
				operation_id, account_namespace, source_device_id,
				origin_sequence, fingerprint, applied_at_ms
			) VALUES (?, ?, ?, ?, ?, ?)`,
			[
				receipt.operationId,
				receipt.accountNamespace,
				receipt.sourceDeviceId,
				receipt.originSequence,
				receipt.fingerprint,
				receipt.appliedAtMs,
			],
		);
	}

	async #getAppliedPackage(
		accountNamespace: string,
		packageId: string,
	): Promise<AppliedPackageReceipt | undefined> {
		const rows = await this.#db.select<AppliedPackageRow[]>(
			`SELECT package_id, account_namespace, source_device_id,
				sequence_start, sequence_end, content_digest,
				previous_package_digest, applied_at_ms
			 FROM sync_applied_packages WHERE package_id = ?`,
			[packageId],
		);
		const row = rows[0];
		if (!row) return undefined;
		if (row.account_namespace !== accountNamespace) {
			throw new Error("An applied package ID belongs to a different account");
		}
		return Object.freeze({
			packageId: row.package_id,
			accountNamespace: row.account_namespace,
			sourceDeviceId: row.source_device_id,
			sequenceStart: row.sequence_start,
			sequenceEnd: row.sequence_end,
			contentDigest: row.content_digest,
			previousPackageDigest: row.previous_package_digest,
			appliedAtMs: row.applied_at_ms,
		});
	}

	async #recordAppliedPackage(
		accountNamespace: string,
		receipt: AppliedPackageReceipt,
	): Promise<void> {
		if (receipt.accountNamespace !== accountNamespace) {
			throw new Error("Refusing to record a package for a different account");
		}
		await this.#db.execute(
			`INSERT INTO sync_applied_packages (
				package_id, account_namespace, source_device_id,
				sequence_start, sequence_end, content_digest,
				previous_package_digest, applied_at_ms
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				receipt.packageId,
				receipt.accountNamespace,
				receipt.sourceDeviceId,
				receipt.sequenceStart,
				receipt.sequenceEnd,
				receipt.contentDigest,
				receipt.previousPackageDigest,
				receipt.appliedAtMs,
			],
		);
	}

	async #serializedWrite<T>(label: string, action: () => Promise<T>): Promise<T> {
		this.#assertOpen();
		const previous = this.#writeQueue;
		let release = (): void => undefined;
		this.#writeQueue = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			const maxAttempts = SQLITE_LOCK_RETRY_DELAYS_MS.length + 1;
			for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
				try {
					return await action();
				} catch (error) {
					if (!isSqliteLockedError(error) || attempt >= maxAttempts) throw error;
					await sleep(SQLITE_LOCK_RETRY_DELAYS_MS[attempt - 1] ?? 400);
				}
			}
			throw new Error(`The serialized sync write did not complete: ${label}`);
		} finally {
			release();
		}
	}

	async #afterWrites<T>(action: () => Promise<T>): Promise<T> {
		this.#assertOpen();
		await this.#writeQueue;
		return action();
	}

	#assertOpen(): void {
		if (this.#closed) throw new Error("The Google Drive sync store is closed");
	}
}

export function openGoogleDriveSyncStore(
	profileId: number,
	options: GoogleDriveSyncStoreOptions = {},
): Promise<GoogleDriveSyncStore> {
	return GoogleDriveSyncStore.open(profileId, options);
}
