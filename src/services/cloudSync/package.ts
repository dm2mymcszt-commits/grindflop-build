import { canonicalJson, equalHexDigest, sha256Hex } from "./canonicalJson";
import { SyncProtocolError } from "./errors";
import { createOperationId } from "./identity";
import {
	MAX_SYNC_PACKAGE_BYTES,
	SYNC_PACKAGE_KIND,
	SYNC_PROTOCOL_VERSION,
	deepFreeze,
	syncPackageSchema,
	syncOperationSchema,
	type ImmutableSyncOperation,
	type JsonValue,
	type MutableSyncPackage,
	type SyncPackage,
	type SyncSection,
	type UnsignedSyncPackage,
} from "./types";

export type CreateSyncPackageInput = Readonly<{
	packageId?: string;
	accountNamespace: string;
	sourceDeviceId: string;
	createdAtMs?: number;
	previousPackageDigest?: string | null;
	operations: readonly ImmutableSyncOperation[];
}>;

function asJsonValue(value: unknown): JsonValue {
	return value as JsonValue;
}

function encodedByteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function packageDigestInput(
	syncPackage: UnsignedSyncPackage | MutableSyncPackage,
): JsonValue {
	const {
		kind,
		protocolVersion,
		packageId,
		accountNamespace,
		sourceDeviceId,
		sequenceRange,
		createdAtMs,
		previousPackageDigest,
		operationCount,
		sections,
		operations,
	} = syncPackage;
	return asJsonValue({
		kind,
		protocolVersion,
		packageId,
		accountNamespace,
		sourceDeviceId,
		sequenceRange,
		createdAtMs,
		previousPackageDigest,
		operationCount,
		sections,
		operations,
	});
}

function assertPackageSemantics(
	syncPackage: MutableSyncPackage | UnsignedSyncPackage,
): void {
	if (syncPackage.protocolVersion !== SYNC_PROTOCOL_VERSION) {
		throw new SyncProtocolError(
			"unsupported-version",
			`Unsupported sync protocol version: ${String(syncPackage.protocolVersion)}`,
		);
	}
	if (syncPackage.operationCount !== syncPackage.operations.length) {
		throw new SyncProtocolError(
			"invalid-package",
			"Package operationCount does not match its operations",
		);
	}

	const expectedSections = Array.from(
		new Set(syncPackage.operations.map((operation) => operation.section)),
	).sort();
	if (
		expectedSections.length !== syncPackage.sections.length ||
		expectedSections.some(
			(section, index) => section !== syncPackage.sections[index],
		)
	) {
		throw new SyncProtocolError(
			"invalid-package",
			"Package sections must be the sorted set represented by its operations",
		);
	}

	const operationIds = new Set<string>();
	for (let index = 0; index < syncPackage.operations.length; index += 1) {
		const operation = syncPackage.operations[index];
		if (
			operation.accountNamespace !== syncPackage.accountNamespace ||
			operation.sourceDeviceId !== syncPackage.sourceDeviceId
		) {
			throw new SyncProtocolError(
				"identity-mismatch",
				"Every operation must belong to the package account and source device",
			);
		}
		const expectedSequence = syncPackage.sequenceRange.start + index;
		if (operation.originSequence !== expectedSequence) {
			throw new SyncProtocolError(
				"sequence-gap",
				`Expected operation sequence ${expectedSequence}, received ${operation.originSequence}`,
			);
		}
		if (operationIds.has(operation.operationId)) {
			throw new SyncProtocolError(
				"identifier-collision",
				`Duplicate operation ID: ${operation.operationId}`,
			);
		}
		operationIds.add(operation.operationId);
	}

	const expectedEnd =
		syncPackage.sequenceRange.start + syncPackage.operations.length - 1;
	if (syncPackage.sequenceRange.end !== expectedEnd) {
		throw new SyncProtocolError(
			"sequence-gap",
			"Package sequence range does not match its contiguous operations",
		);
	}
}

function makePackageId(): string {
	return createOperationId().replace(/^op-/, "pkg-");
}

export async function createSyncPackage(
	input: CreateSyncPackageInput,
): Promise<SyncPackage> {
	if (input.operations.length === 0) {
		throw new SyncProtocolError(
			"invalid-package",
			"A sync package cannot be empty",
		);
	}
	const operations = input.operations.map((operation) =>
		syncOperationSchema.parse(operation),
	);
	const sections = Array.from(
		new Set(operations.map((operation) => operation.section)),
	).sort() as SyncSection[];
	const unsigned: UnsignedSyncPackage = {
		kind: SYNC_PACKAGE_KIND,
		protocolVersion: SYNC_PROTOCOL_VERSION,
		packageId: input.packageId ?? makePackageId(),
		accountNamespace: input.accountNamespace,
		sourceDeviceId: input.sourceDeviceId,
		sequenceRange: {
			start: operations[0]?.originSequence ?? 0,
			end: operations[operations.length - 1]?.originSequence ?? 0,
		},
		createdAtMs: input.createdAtMs ?? Date.now(),
		previousPackageDigest: input.previousPackageDigest ?? null,
		operationCount: operations.length,
		sections,
		operations,
	};

	try {
		const parsedUnsigned = syncPackageSchema
			.omit({ contentDigest: true })
			.parse(unsigned);
		assertPackageSemantics(parsedUnsigned);
		const contentDigest = await sha256Hex(
			canonicalJson(packageDigestInput(parsedUnsigned)),
		);
		const parsed = syncPackageSchema.parse({
			...parsedUnsigned,
			contentDigest,
		});
		if (
			encodedByteLength(canonicalJson(asJsonValue(parsed))) >
			MAX_SYNC_PACKAGE_BYTES
		) {
			throw new SyncProtocolError(
				"invalid-package",
				`Sync package exceeds the ${MAX_SYNC_PACKAGE_BYTES}-byte limit`,
			);
		}
		return deepFreeze(parsed);
	} catch (error) {
		if (error instanceof SyncProtocolError) {
			throw error;
		}
		throw new SyncProtocolError(
			"invalid-package",
			"Cannot create an invalid sync package",
			error,
		);
	}
}

export async function verifySyncPackage(input: unknown): Promise<SyncPackage> {
	let parsed: MutableSyncPackage;
	try {
		parsed = syncPackageSchema.parse(input);
	} catch (error) {
		throw new SyncProtocolError(
			"invalid-package",
			"Sync package schema validation failed",
			error,
		);
	}

	assertPackageSemantics(parsed);
	const expectedDigest = await sha256Hex(
		canonicalJson(packageDigestInput(parsed)),
	);
	if (!equalHexDigest(parsed.contentDigest, expectedDigest)) {
		throw new SyncProtocolError(
			"integrity-failed",
			"Sync package content digest is invalid",
		);
	}
	return deepFreeze(parsed);
}

export async function parseAndVerifySyncPackage(
	serialized: string,
): Promise<SyncPackage> {
	if (encodedByteLength(serialized) > MAX_SYNC_PACKAGE_BYTES) {
		throw new SyncProtocolError(
			"invalid-package",
			`Sync package exceeds the ${MAX_SYNC_PACKAGE_BYTES}-byte limit`,
		);
	}
	let value: unknown;
	try {
		value = JSON.parse(serialized) as unknown;
	} catch (error) {
		throw new SyncProtocolError(
			"invalid-package",
			"Sync package is not valid JSON",
			error,
		);
	}
	return verifySyncPackage(value);
}

export function serializeSyncPackage(syncPackage: SyncPackage): string {
	return canonicalJson(asJsonValue(syncPackage));
}

export async function fingerprintOperation(
	operation: ImmutableSyncOperation,
): Promise<string> {
	return sha256Hex(canonicalJson(asJsonValue(operation)));
}
