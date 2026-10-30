import z from "zod";

export const SYNC_PROTOCOL_VERSION = 1 as const;
export const SYNC_PACKAGE_KIND = "free-grind.sync.package" as const;

export const MAX_SYNC_PACKAGE_OPERATIONS = 5_000;
export const MAX_SYNC_PACKAGE_BYTES = 16 * 1024 * 1024;

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SAFE_TOKEN_PATTERN = /^[a-z][a-z0-9_-]*$/;
const SHA_256_PATTERN = /^[a-f0-9]{64}$/;
const FORBIDDEN_OBJECT_KEYS = new Set([
	"__proto__",
	"constructor",
	"prototype",
]);
const MAX_JSON_DEPTH = 32;
const MAX_JSON_COLLECTION_LENGTH = 25_000;
const MAX_JSON_STRING_LENGTH = 8 * 1024 * 1024;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
	| JsonPrimitive
	| readonly JsonValue[]
	| { readonly [key: string]: JsonValue };

function isPlainObject(value: object): value is Record<string, unknown> {
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function isJsonValueAtDepth(value: unknown, depth: number): value is JsonValue {
	if (value === null || typeof value === "boolean") {
		return true;
	}
	if (typeof value === "string") {
		return value.length <= MAX_JSON_STRING_LENGTH;
	}
	if (typeof value === "number") {
		return Number.isFinite(value);
	}
	if (typeof value !== "object" || depth >= MAX_JSON_DEPTH) {
		return false;
	}
	if (Array.isArray(value)) {
		return (
			value.length <= MAX_JSON_COLLECTION_LENGTH &&
			value.every((item) => isJsonValueAtDepth(item, depth + 1))
		);
	}
	if (!isPlainObject(value)) {
		return false;
	}
	const entries = Object.entries(value);
	return (
		entries.length <= MAX_JSON_COLLECTION_LENGTH &&
		entries.every(
			([key, item]) =>
				!FORBIDDEN_OBJECT_KEYS.has(key) &&
				key.length <= 512 &&
				isJsonValueAtDepth(item, depth + 1),
		)
	);
}

export function isJsonValue(value: unknown): value is JsonValue {
	return isJsonValueAtDepth(value, 0);
}

export const opaqueIdSchema = z
	.string()
	.min(1)
	.max(128)
	.regex(OPAQUE_ID_PATTERN);

export const accountNamespaceSchema = opaqueIdSchema;
export const deviceIdSchema = opaqueIdSchema;
export const operationIdSchema = opaqueIdSchema;
export const packageIdSchema = opaqueIdSchema;

export const syncSectionSchema = z.enum([
	"core",
	"contact-index",
	"interest-views",
	"preferences",
	"media",
]);

export type SyncSection = z.infer<typeof syncSectionSchema>;

export const entityTypeSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(SAFE_TOKEN_PATTERN);

export const entityIdSchema = z
	.string()
	.min(1)
	.max(512)
	.refine(
		(value) => value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value),
		{
			message:
				"Entity IDs cannot contain surrounding whitespace or control characters",
		},
	);

export const positiveSafeIntegerSchema = z
	.number()
	.int()
	.positive()
	.max(Number.MAX_SAFE_INTEGER);

export const nonNegativeSafeIntegerSchema = z
	.number()
	.int()
	.nonnegative()
	.max(Number.MAX_SAFE_INTEGER);

export const sha256HexSchema = z.string().regex(SHA_256_PATTERN);

export const syncRevisionSchema = z
	.object({
		logicalClock: positiveSafeIntegerSchema,
		deviceId: deviceIdSchema,
	})
	.strict();

export type SyncRevision = z.infer<typeof syncRevisionSchema>;

const operationIdentityShape = {
	operationId: operationIdSchema,
	accountNamespace: accountNamespaceSchema,
	sourceDeviceId: deviceIdSchema,
	originSequence: positiveSafeIntegerSchema,
	revision: syncRevisionSchema,
	section: syncSectionSchema,
	entityType: entityTypeSchema,
	entityId: entityIdSchema,
	createdAtMs: nonNegativeSafeIntegerSchema,
};

const upsertMutationSchema = z
	.object({
		kind: z.literal("upsert"),
		value: z.custom<JsonValue>(isJsonValue, {
			message: "Sync payloads must be bounded, safe JSON values",
		}),
	})
	.strict();

const deleteMutationSchema = z
	.object({
		kind: z.literal("delete"),
	})
	.strict();

export const syncUpsertOperationSchema = z
	.object({
		...operationIdentityShape,
		mutation: upsertMutationSchema,
	})
	.strict()
	.refine(
		(operation) => operation.revision.deviceId === operation.sourceDeviceId,
		{
			message: "Revision and source device IDs must match",
			path: ["revision", "deviceId"],
		},
	);

export const syncDeleteOperationSchema = z
	.object({
		...operationIdentityShape,
		mutation: deleteMutationSchema,
	})
	.strict()
	.refine(
		(operation) => operation.revision.deviceId === operation.sourceDeviceId,
		{
			message: "Revision and source device IDs must match",
			path: ["revision", "deviceId"],
		},
	);

export const syncOperationSchema = z.union([
	syncUpsertOperationSchema,
	syncDeleteOperationSchema,
]);

export type MutableSyncUpsertOperation = z.infer<typeof syncUpsertOperationSchema>;
export type MutableSyncDeleteOperation = z.infer<typeof syncDeleteOperationSchema>;
export type MutableSyncOperation = z.infer<typeof syncOperationSchema>;

export const syncSequenceRangeSchema = z
	.object({
		start: positiveSafeIntegerSchema,
		end: positiveSafeIntegerSchema,
	})
	.strict();

const syncPackageBaseShape = {
	kind: z.literal(SYNC_PACKAGE_KIND),
	protocolVersion: z.literal(SYNC_PROTOCOL_VERSION),
	packageId: packageIdSchema,
	accountNamespace: accountNamespaceSchema,
	sourceDeviceId: deviceIdSchema,
	sequenceRange: syncSequenceRangeSchema,
	createdAtMs: nonNegativeSafeIntegerSchema,
	previousPackageDigest: sha256HexSchema.nullable(),
	operationCount: z.number().int().min(1).max(MAX_SYNC_PACKAGE_OPERATIONS),
	sections: z
		.array(syncSectionSchema)
		.min(1)
		.max(syncSectionSchema.options.length),
	operations: z
		.array(syncOperationSchema)
		.min(1)
		.max(MAX_SYNC_PACKAGE_OPERATIONS),
};

export const unsignedSyncPackageSchema = z
	.object(syncPackageBaseShape)
	.strict();

export const syncPackageSchema = z
	.object({
		...syncPackageBaseShape,
		contentDigest: sha256HexSchema,
	})
	.strict();

export type UnsignedSyncPackage = z.infer<typeof unsignedSyncPackageSchema>;
export type MutableSyncPackage = z.infer<typeof syncPackageSchema>;

export type DeepReadonly<T> = T extends JsonPrimitive
	? T
	: T extends readonly (infer Item)[]
		? readonly DeepReadonly<Item>[]
		: T extends object
			? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
			: T;

export type SyncUpsertOperation = DeepReadonly<MutableSyncUpsertOperation>;
export type SyncDeleteOperation = DeepReadonly<MutableSyncDeleteOperation>;
export type SyncOperation = DeepReadonly<MutableSyncOperation>;
/** SyncOperation is immutable; this alias highlights storage/application boundaries. */
export type ImmutableSyncOperation = SyncOperation;
export type SyncPackage = DeepReadonly<MutableSyncPackage>;

export function deepFreeze<T>(value: T): DeepReadonly<T> {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		for (const child of Object.values(value)) {
			deepFreeze(child);
		}
		Object.freeze(value);
	}
	return value as DeepReadonly<T>;
}
