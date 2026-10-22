import type { ImmutableSyncOperation, JsonValue, SyncSection } from "./cloudSync/types";
import { canonicalJson } from "./cloudSync/canonicalJson";
import * as chatDb from "./chatDb";
import * as contactIndex from "./chatContactIndex";
import type { ContactIndexSyncScope } from "./chatContactIndex";
import {
	compareAndApplyInterestViewRow,
	exportInterestViewRows,
	getInterestViewsAccountForUser,
	getActiveInterestViewsAccount,
	importInterestViewRows,
	interestViewsStore,
	type StoredInterestView,
} from "./interestViewsStore";

export type GoogleDriveSyncEntity = Readonly<{
	section: SyncSection;
	entityType: string;
	entityId: string;
	value: JsonValue;
}>;

type ChatEntitySpec = Readonly<{
	section: "core" | "media";
	entityType: string;
	table: string;
	primaryKey: string;
	pageSize: number;
	omitColumns?: readonly string[];
}>;

/**
 * Everything on a conversation row except the hide decision. `hidden` is the
 * only column there that is a local choice rather than a copy of server state,
 * and it needs its own entity: the conversation entity's value is the whole
 * row, so an inbox refresh — new unread count, new preview, new updated_at —
 * changes its digest and emits an operation carrying whatever `hidden` that
 * device happened to hold. The other device's routine churn would then
 * overwrite a hide it never knew about, and a device sitting on a backlog wins
 * that race outright, because operations are ordered by Lamport clock and a
 * backlog is exactly what advances one.
 *
 * Scanned on its own, `hidden` only produces an operation when it actually
 * changes, so a device that never hid anything never contests it.
 */
const CONVERSATION_NON_HIDDEN_COLUMNS = [
	"other_profile_id", "name", "participants_json", "last_activity_timestamp",
	"unread_count", "pinned", "muted", "favorite", "preview_json", "archived",
	"archived_reason", "archived_at", "block_state",
	"messages_synced_activity_timestamp", "last_seen_in_inbox_at",
	"created_at", "updated_at",
] as const;

const CHAT_ENTITY_SPECS: readonly ChatEntitySpec[] = [
	{ section: "core", entityType: "conversation", table: "conversations", primaryKey: "conversation_id", pageSize: 1_000 },
	{
		section: "core",
		entityType: "conversation-hidden",
		table: "conversations",
		primaryKey: "conversation_id",
		pageSize: 2_000,
		omitColumns: CONVERSATION_NON_HIDDEN_COLUMNS,
	},
	{ section: "core", entityType: "conversation-meta", table: "conversation_meta", primaryKey: "conversation_id", pageSize: 2_000 },
	{ section: "core", entityType: "message", table: "messages", primaryKey: "message_id", pageSize: 1_000 },
	{ section: "core", entityType: "setting", table: "settings", primaryKey: "key", pageSize: 500 },
	{ section: "core", entityType: "saved-phrase", table: "saved_phrases", primaryKey: "phrase", pageSize: 1_000 },
	{ section: "core", entityType: "saved-location", table: "saved_locations", primaryKey: "id", pageSize: 1_000 },
	{ section: "core", entityType: "block-event", table: "block_events", primaryKey: "id", pageSize: 1_000 },
	// Stats logs. Rows never change after they are written, so these only ever
	// add operations. Most are keyed by the device that wrote them; a distance
	// row is keyed by the view, which both devices describe identically.
	{ section: "core", entityType: "stats-block", table: "stats_block_log", primaryKey: "id", pageSize: 2_000 },
	{ section: "core", entityType: "stats-location", table: "stats_location_log", primaryKey: "id", pageSize: 2_000 },
	{ section: "core", entityType: "stats-coverage", table: "stats_coverage_log", primaryKey: "id", pageSize: 2_000 },
	{ section: "core", entityType: "stats-profile-edit", table: "stats_profile_edit_log", primaryKey: "id", pageSize: 2_000 },
	{ section: "core", entityType: "stats-profile-open", table: "stats_profile_open_log", primaryKey: "id", pageSize: 2_000 },
	{ section: "core", entityType: "stats-view-distance", table: "stats_view_distance_log", primaryKey: "id", pageSize: 2_000 },
	// What an earlier account knew about each person, written once when moving
	// to this account, so the other device shows the same history.
	{ section: "core", entityType: "past-contact", table: "past_contacts", primaryKey: "profile_id", pageSize: 2_000 },
	{ section: "core", entityType: "past-message", table: "past_messages", primaryKey: "message_id", pageSize: 1_000 },
	{ section: "core", entityType: "past-view", table: "past_views", primaryKey: "profile_id", pageSize: 500 },
	{
		section: "core",
		entityType: "album",
		table: "albums",
		primaryKey: "album_id",
		pageSize: 1_000,
		omitColumns: ["preview_cover_base64", "preview_cover_mime_type"],
	},
	{ section: "media", entityType: "chat-media", table: "media_files", primaryKey: "media_key", pageSize: 1 },
	{ section: "media", entityType: "album-media", table: "album_media", primaryKey: "content_id", pageSize: 1 },
	{
		section: "media",
		entityType: "album-preview",
		table: "albums",
		primaryKey: "album_id",
		pageSize: 20,
		omitColumns: [
			"owner_profile_id",
			"album_name",
			"conversation_id",
			"shared_via_message_id",
			"created_at",
			"updated_at",
		],
	},
	{ section: "media", entityType: "avatar", table: "avatars", primaryKey: "media_hash", pageSize: 20 },
];

const CHAT_SPECS_BY_ENTITY = new Map(CHAT_ENTITY_SPECS.map((spec) => [spec.entityType, spec]));

const CONTACT_ENTITY_SPECS = [
	{
		section: "contact-index" as const,
		entityType: "contact-index",
		table: "chat_contact_index" as const,
		primaryKey: "profile_id",
	},
	{
		section: "contact-index" as const,
		entityType: "profile-nickname",
		table: "chat_local_profile_meta" as const,
		primaryKey: "profile_id",
	},
] as const;

const CONTACT_SPECS_BY_ENTITY: ReadonlyMap<
	string,
	(typeof CONTACT_ENTITY_SPECS)[number]
> = new Map(
	CONTACT_ENTITY_SPECS.map((spec) => [spec.entityType, spec]),
);

/**
 * Browser localStorage is shared by every signed-in Grindr profile. Even
 * seemingly harmless preferences can contain profile/conversation ids (for
 * example the auto-block whitelist and ghost exceptions), so none of these
 * global values may be published under an account-scoped Drive namespace.
 *
 * Portable settings live in the active profile's chat database and are
 * classified by CLOUD_SYNCABLE_DB_SETTING_KEYS below. Keeping this registry
 * empty also makes every future localStorage key device-local by default.
 */
export const CLOUD_SYNCABLE_LOCAL_STORAGE_KEYS = new Set<string>();

/**
 * Compatibility boundary for packages written by prerelease builds before
 * browser preferences were found to be app-global. These authenticated entity
 * ids remain parseable so an existing immutable history does not become
 * unusable after upgrading, but scan/apply deliberately never reads or mutates
 * the corresponding localStorage values.
 */
const LEGACY_CLOUD_SYNCABLE_LOCAL_STORAGE_KEYS = new Set([
	"fg-auto-block-whitelist",
	"fg-autoblock-counter-block",
	"fg-autoblock-skip-after-count",
	"fg-autoblock-skip-after-two",
	"fg-block-bio",
	"fg-block-chat",
	"fg-block-faceless-delay",
	"fg-block-faceless-no-media",
	"fg-block-first-media",
	"fg-block-grid",
	"fg-block-interest-views",
	"fg-block-looking-for-mode",
	"fg-block-looking-for",
	"fg-block-max-age",
	"fg-block-max-distance",
	"fg-block-media-delay-enabled",
	"fg-block-media-delay-minutes",
	"fg-block-message",
	"fg-block-min-age",
	"fg-block-name",
	"fg-block-no-age",
	"fg-block-right-now",
	"fg-block-seen-enabled",
	"fg-block-seen-time",
	"fg-forbidden-words",
	"fg-ghost-exceptions",
	"fg-ghost-mode",
	"fg-interest-default-tab",
	"fg-interest-views-count-mode",
	"fg-interest-views-sort",
	"fg-interest-views-window",
]);

/**
 * Per-account settings are also allowlisted. This intentionally duplicates
 * their stable storage keys at the cloud boundary so future settings default
 * to local-only until their ownership and merge policy are reviewed.
 */
export const CLOUD_SYNCABLE_DB_SETTING_KEYS = new Set([
	"automation",
	"automation_rules",
	"automation_seen_senders",
	"browseFilters",
	"chatHidePinned",
	"chatInboxFilters",
	"locationPreferences",
	"privacy",
	"recentGifs",
	"seenTimestamps",
	"stats",
]);

function toJsonValue(value: unknown): JsonValue {
	return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function encodeBytesBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBytesBase64Url(value: string): Uint8Array {
	const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
	const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
	const binary = atob(padded);
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function encodeSyncEntityId(primaryKey: unknown): string {
	const raw = String(primaryKey);
	const encoded = encodeBytesBase64Url(new TextEncoder().encode(raw));
	if (encoded.length > 500) {
		throw new Error("A sync entity key exceeds the portable key limit");
	}
	return `b64.${encoded}`;
}

export function decodeSyncEntityId(entityId: string): string {
	if (!entityId.startsWith("b64.")) {
		throw new Error("The sync entity key has an unsupported encoding");
	}
	return new TextDecoder("utf-8", { fatal: true }).decode(
		decodeBytesBase64Url(entityId.slice(4)),
	);
}

async function scanChatEntities(
	profileId: number,
	includeMedia: boolean,
	onEntity: (entity: GoogleDriveSyncEntity) => Promise<void>,
): Promise<void> {
	for (const spec of CHAT_ENTITY_SPECS) {
		if (spec.section === "media" && !includeMedia) continue;
		let after: string | null = null;
		for (;;) {
			assertActiveProfile(profileId);
			const rows = await chatDb.selectTablePageAfter(spec.table, after, spec.pageSize, {
				omitColumns: spec.omitColumns ? [...spec.omitColumns] : undefined,
			});
			if (rows.length === 0) break;
			for (const row of rows) {
				const key = row[spec.primaryKey];
				if (key == null) continue;
				// Always advance the keyset cursor, including for device-local
				// settings. Otherwise a full page containing only skipped settings
				// is fetched forever with the same `after` value.
				after = String(key);
				if (
					spec.entityType === "setting" &&
					!CLOUD_SYNCABLE_DB_SETTING_KEYS.has(String(key))
				) {
					continue;
				}
				await onEntity({
					section: spec.section,
					entityType: spec.entityType,
					entityId: encodeSyncEntityId(key),
					value: toJsonValue(row),
				});
				assertActiveProfile(profileId);
			}
			if (rows.length < spec.pageSize) break;
		}
	}
}

async function scanContactEntities(
	profileId: number,
	onEntity: (entity: GoogleDriveSyncEntity) => Promise<void>,
	contactScope: ContactIndexSyncScope = "everything",
): Promise<void> {
	for (const spec of CONTACT_ENTITY_SPECS) {
		let after: string | null = null;
		// The window is resolved once so paging cannot drift across the boundary
		// and return the same row twice or skip one.
		const recentSinceMs =
			Date.now() - contactIndex.CONTACT_INDEX_RECENT_WINDOW_MS;
		for (;;) {
			assertActiveProfile(profileId);
			const rows = await contactIndex.selectContactIndexPageAfter(
				spec.table,
				after,
				2_000,
				contactScope,
				recentSinceMs,
			);
			if (rows.length === 0) break;
			for (const row of rows) {
				const key = row[spec.primaryKey];
				if (key == null) continue;
				await onEntity({
					section: spec.section,
					entityType: spec.entityType,
					entityId: encodeSyncEntityId(key),
					value: toJsonValue(row),
				});
				assertActiveProfile(profileId);
				after = String(key);
			}
			if (rows.length < 2_000) break;
		}
	}
}

async function scanInterestEntities(
	profileId: number,
	onEntity: (entity: GoogleDriveSyncEntity) => Promise<void>,
): Promise<void> {
	const targetInterestAccount = captureActiveInterestAccount(profileId);
	// exportInterestViewRows captures its database name synchronously before
	// returning its promise. Re-check the same token after the read so rows from
	// the old account cannot be reconciled as the newly active account.
	const rows = (await exportInterestViewRows()) ?? [];
	assertInterestAccountStillActive(profileId, targetInterestAccount);
	for (const row of rows) {
		if (!row?.profileId) continue;
		await onEntity({
			section: "interest-views",
			entityType: "interest-view",
			entityId: encodeSyncEntityId(row.profileId),
			value: toJsonValue(row),
		});
		assertInterestAccountStillActive(profileId, targetInterestAccount);
	}
}

async function scanPreferenceEntities(
	profileId: number,
	_onEntity: (entity: GoogleDriveSyncEntity) => Promise<void>,
): Promise<void> {
	// Intentionally empty. localStorage is app-global, whereas every Drive
	// namespace is profile-scoped. Per-profile database settings are scanned by
	// scanChatEntities instead.
	assertActiveProfile(profileId);
}

export async function scanGoogleDriveSyncEntities(
	profileId: number,
	includeMedia: boolean,
	onEntity: (entity: GoogleDriveSyncEntity) => Promise<void>,
	contactScope: ContactIndexSyncScope = "everything",
): Promise<void> {
	assertActiveProfile(profileId);
	await scanChatEntities(profileId, includeMedia, onEntity);
	await scanContactEntities(profileId, onEntity, contactScope);
	await scanInterestEntities(profileId, onEntity);
	await scanPreferenceEntities(profileId, onEntity);
}

function assertActiveProfile(profileId: number): void {
	if (
		chatDb.getActiveChatDbUser() !== profileId ||
		contactIndex.getActiveChatContactIndexUser() !== profileId ||
		getActiveInterestViewsAccount() !== getInterestViewsAccountForUser(profileId)
	) {
		throw new Error("Cloud sync was cancelled because the active GrindFlop profile changed");
	}
}

function captureActiveInterestAccount(profileId: number): string {
	assertActiveProfile(profileId);
	return getActiveInterestViewsAccount();
}

function assertInterestAccountStillActive(
	profileId: number,
	expectedAccount: string,
): void {
	assertActiveProfile(profileId);
	if (getActiveInterestViewsAccount() !== expectedAccount) {
		throw new Error("Cloud sync was cancelled because the active GrindFlop profile changed");
	}
}

function requireRow(value: JsonValue): Record<string, unknown> {
	if (!value || Array.isArray(value) || typeof value !== "object") {
		throw new Error("A synchronized database entity must contain an object row");
	}
	return value as Record<string, unknown>;
}

function assertPrimaryKey(row: Record<string, unknown>, column: string, expected: string): void {
	if (String(row[column] ?? "") !== expected) {
		throw new Error("The synchronized row does not match its authenticated entity key");
	}
}

function chatUpsertOptions(
	chatSpec: ChatEntitySpec,
): chatDb.PortableTableUpsertOptions | undefined {
	switch (chatSpec.entityType) {
		case "album":
			return {
				skipColumns: chatSpec.omitColumns ? [...chatSpec.omitColumns] : undefined,
			};
		// `hidden` rides along so a conversation this device has never seen is
		// created with the right value, but no later conversation write may
		// touch it again — only the conversation-hidden entity owns it.
		case "conversation":
			return { insertOnlyColumns: ["hidden"] };
		// Owns `hidden` alone, and cannot create the row it lives on: the
		// conversation entity brings that, in either order.
		case "conversation-hidden":
			return {
				skipColumns: chatSpec.omitColumns ? [...chatSpec.omitColumns] : undefined,
				updateOnly: true,
			};
		case "conversation-meta":
			return { maxColumns: ["last_read_timestamp"] };
		case "chat-media":
			return { preserveExistingOnNullOrEmptyColumns: ["data_base64"] };
		case "album-media":
			return {
				preserveExistingOnNullOrEmptyColumns: ["data_base64", "thumb_data_base64"],
			};
		case "album-preview":
			return {
				skipColumns: chatSpec.omitColumns ? [...chatSpec.omitColumns] : undefined,
				preserveExistingOnNullOrEmptyColumns: ["preview_cover_base64"],
			};
		case "avatar":
			return { preserveExistingOnNullOrEmptyColumns: ["data_base64"] };
		default:
			return undefined;
	}
}

function sameOperationEntity(
	left: ImmutableSyncOperation,
	right: ImmutableSyncOperation,
): boolean {
	return (
		left.accountNamespace === right.accountNamespace &&
		left.section === right.section &&
		left.entityType === right.entityType &&
		left.entityId === right.entityId
	);
}

function operationMatchesCurrent(
	operation: ImmutableSyncOperation | undefined,
	current: JsonValue | null,
): boolean {
	if (!operation || operation.mutation.kind === "delete") return current === null;
	return (
		current !== null &&
		canonicalJson(current) === canonicalJson(operation.mutation.value)
	);
}

function rowAsJsonValue(row: Readonly<Record<string, unknown>> | null): JsonValue | null {
	return row === null ? null : toJsonValue(row);
}

/** Validates the entity/section/settings policy before any local store is touched. */
export function validateGoogleDriveSyncOperationBoundary(
	operation: ImmutableSyncOperation,
): void {
	const primaryKey = decodeSyncEntityId(operation.entityId);
	const chatSpec = CHAT_SPECS_BY_ENTITY.get(operation.entityType);
	if (chatSpec) {
		if (operation.section !== chatSpec.section) {
			throw new Error("The synchronized entity is in the wrong authenticated section");
		}
		if (
			chatSpec.entityType === "setting" &&
			!CLOUD_SYNCABLE_DB_SETTING_KEYS.has(primaryKey)
		) {
			throw new Error("The synchronized database setting is not in the portability registry");
		}
		return;
	}

	const contactSpec = CONTACT_SPECS_BY_ENTITY.get(operation.entityType);
	if (contactSpec) {
		if (operation.section !== contactSpec.section) {
			throw new Error("The synchronized contact entity is in the wrong authenticated section");
		}
		return;
	}

	if (operation.entityType === "interest-view") {
		if (operation.section !== "interest-views") {
			throw new Error("The synchronized viewed-profile entity is in the wrong section");
		}
		return;
	}

	if (operation.entityType === "preference") {
		if (
			operation.section !== "preferences" ||
			!LEGACY_CLOUD_SYNCABLE_LOCAL_STORAGE_KEYS.has(primaryKey)
		) {
			throw new Error("The synchronized preference is outside the portability registry");
		}
		return;
	}

	throw new Error(`Unsupported synchronized entity type: ${operation.entityType}`);
}

/**
 * Applies an incoming winner only while the portable domain row still equals
 * the durable reconciliation shadow that was used to select it. A concurrent
 * local edit is preserved and will be journaled with the already-observed
 * remote Lamport clock on the next reconciliation pass.
 *
 * `true` means the domain already reflects, or now reflects, the incoming
 * mutation and the caller may advance its shadow. `false` means local state
 * diverged and the incoming receipt may be recorded, but its shadow must not
 * replace the local winner.
 */
export async function applyGoogleDriveSyncOperationConditionally(
	profileId: number,
	operation: ImmutableSyncOperation,
	expectedOperation?: ImmutableSyncOperation,
): Promise<boolean> {
	validateGoogleDriveSyncOperationBoundary(operation);
	if (expectedOperation) {
		validateGoogleDriveSyncOperationBoundary(expectedOperation);
		if (!sameOperationEntity(operation, expectedOperation)) {
			throw new Error("The conditional sync shadow belongs to a different entity");
		}
	}
	assertActiveProfile(profileId);
	const primaryKey = decodeSyncEntityId(operation.entityId);
	const matchesIncoming = (current: JsonValue | null) =>
		operationMatchesCurrent(operation, current);
	const matchesExpected = (current: JsonValue | null) =>
		operationMatchesCurrent(expectedOperation, current);

	const chatSpec = CHAT_SPECS_BY_ENTITY.get(operation.entityType);
	if (chatSpec) {
		const mutation =
			operation.mutation.kind === "delete"
				? ({ kind: "delete" } as const)
				: (() => {
						const row = requireRow(operation.mutation.value);
						assertPrimaryKey(row, chatSpec.primaryKey, primaryKey);
						return {
							kind: "upsert" as const,
							row,
							options: chatUpsertOptions(chatSpec),
						};
					})();
		const result = await chatDb.compareAndApplyPortableTableRow(
			chatSpec.table,
			primaryKey,
			mutation,
			{
				omitColumns: chatSpec.omitColumns ? [...chatSpec.omitColumns] : undefined,
				matchesIncoming: (current) => matchesIncoming(rowAsJsonValue(current)),
				matchesExpected: (current) => matchesExpected(rowAsJsonValue(current)),
			},
		);
		assertActiveProfile(profileId);
		return result !== "changed";
	}

	const contactSpec = CONTACT_SPECS_BY_ENTITY.get(operation.entityType);
	if (contactSpec) {
		const mutation =
			operation.mutation.kind === "delete"
				? ({ kind: "delete" } as const)
				: (() => {
						const row = requireRow(operation.mutation.value);
						assertPrimaryKey(row, contactSpec.primaryKey, primaryKey);
						return {
							kind: "upsert" as const,
							row,
							options: { respectUpdatedAt: false },
						};
					})();
		const result = await contactIndex.compareAndApplyContactIndexRow(
			contactSpec.table as contactIndex.ContactIndexTableName,
			primaryKey,
			mutation,
			{
				matchesIncoming: (current) => matchesIncoming(rowAsJsonValue(current)),
				matchesExpected: (current) => matchesExpected(rowAsJsonValue(current)),
			},
		);
		assertActiveProfile(profileId);
		return result !== "changed";
	}

	if (operation.entityType === "interest-view") {
		const targetInterestAccount = captureActiveInterestAccount(profileId);
		const mutation =
			operation.mutation.kind === "delete"
				? ({ kind: "delete" } as const)
				: (() => {
						const row = requireRow(operation.mutation.value) as StoredInterestView;
						assertPrimaryKey(
							row as unknown as Record<string, unknown>,
							"profileId",
							primaryKey,
						);
						return { kind: "upsert" as const, row };
					})();
		const result = await compareAndApplyInterestViewRow(primaryKey, mutation, {
			matchesIncoming: (current) =>
				matchesIncoming(
					current === null ? null : toJsonValue(current),
				),
			matchesExpected: (current) =>
				matchesExpected(
					current === null ? null : toJsonValue(current),
				),
		});
		assertInterestAccountStillActive(profileId, targetInterestAccount);
		return result !== "changed";
	}

	if (operation.entityType === "preference") {
		if (!LEGACY_CLOUD_SYNCABLE_LOCAL_STORAGE_KEYS.has(primaryKey)) {
			throw new Error("The synchronized preference is not in the explicit portability registry");
		}
		// Legacy authenticated operations are consumed as successful no-ops. This
		// lets durable receipts/shadows advance without allowing a profile-scoped
		// cloud package to read or change app-global browser state.
		return true;
	}

	throw new Error(`Unsupported synchronized entity type: ${operation.entityType}`);
}

export async function applyGoogleDriveSyncOperation(
	profileId: number,
	operation: ImmutableSyncOperation,
): Promise<void> {
	validateGoogleDriveSyncOperationBoundary(operation);
	assertActiveProfile(profileId);
	const primaryKey = decodeSyncEntityId(operation.entityId);
	const chatSpec = CHAT_SPECS_BY_ENTITY.get(operation.entityType);
	if (chatSpec) {
		if (operation.section !== chatSpec.section) {
			throw new Error("The synchronized entity is in the wrong authenticated section");
		}
		if (
			chatSpec.entityType === "setting" &&
			!CLOUD_SYNCABLE_DB_SETTING_KEYS.has(primaryKey)
		) {
			throw new Error("The synchronized database setting is not in the portability registry");
		}
		if (operation.mutation.kind === "delete") {
			await chatDb.deletePortableTableRow(chatSpec.table, primaryKey);
			return;
		}
		const row = requireRow(operation.mutation.value);
		assertPrimaryKey(row, chatSpec.primaryKey, primaryKey);
		const options = chatUpsertOptions(chatSpec);
		await chatDb.upsertTableRows(chatSpec.table, [row], options);
		return;
	}

	const contactSpec = CONTACT_SPECS_BY_ENTITY.get(operation.entityType);
	if (contactSpec) {
		if (operation.section !== contactSpec.section) {
			throw new Error("The synchronized contact entity is in the wrong authenticated section");
		}
		if (operation.mutation.kind === "delete") {
			await contactIndex.deleteContactIndexRow(
				contactSpec.table as contactIndex.ContactIndexTableName,
				primaryKey,
			);
			return;
		}
		const row = requireRow(operation.mutation.value);
		assertPrimaryKey(row, contactSpec.primaryKey, primaryKey);
		await contactIndex.upsertContactIndexRows(
			contactSpec.table as contactIndex.ContactIndexTableName,
			[row],
			{ respectUpdatedAt: false },
		);
		return;
	}

	if (operation.entityType === "interest-view") {
		if (operation.section !== "interest-views") {
			throw new Error("The synchronized viewed-profile entity is in the wrong section");
		}
		const targetInterestAccount = captureActiveInterestAccount(profileId);
		if (operation.mutation.kind === "delete") {
			// deleteMany captures the active database name before its first await.
			// The post-write guard prevents the apply loop from continuing if the
			// user changed accounts while IndexedDB was completing the transaction.
			await interestViewsStore.deleteMany([primaryKey]);
			assertInterestAccountStillActive(profileId, targetInterestAccount);
			return;
		}
		const row = requireRow(operation.mutation.value) as StoredInterestView;
		assertPrimaryKey(row as unknown as Record<string, unknown>, "profileId", primaryKey);
		const imported = await importInterestViewRows([row]);
		assertInterestAccountStillActive(profileId, targetInterestAccount);
		if (!imported) throw new Error("The viewed-profile database rejected a synchronized row");
		return;
	}

	if (operation.entityType === "preference") {
		if (operation.section !== "preferences") {
			throw new Error("The synchronized preference is in the wrong section");
		}
		if (!LEGACY_CLOUD_SYNCABLE_LOCAL_STORAGE_KEYS.has(primaryKey)) {
			throw new Error("The synchronized preference is not in the explicit portability registry");
		}
		// See the conditional path above: preserve compatibility with old cloud
		// history while keeping app-global localStorage completely untouched.
		return;
	}

	throw new Error(`Unsupported synchronized entity type: ${operation.entityType}`);
}
