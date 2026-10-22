import { canonicalJson } from "./canonicalJson";
import { SyncProtocolError } from "./errors";
import type { ImmutableSyncOperation, JsonValue, SyncRevision } from "./types";

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

/** Lamport counter first, then stable device identity. Never uses wall-clock time. */
export function compareSyncRevisions(
	left: SyncRevision,
	right: SyncRevision,
): number {
	if (left.logicalClock !== right.logicalClock) {
		return left.logicalClock < right.logicalClock ? -1 : 1;
	}
	return compareText(left.deviceId, right.deviceId);
}

/**
 * Total deterministic ordering for concurrent operations. A delete wins the
 * otherwise impossible exact-revision tie so stale data cannot be resurrected.
 */
export function compareSyncOperations(
	left: ImmutableSyncOperation,
	right: ImmutableSyncOperation,
): number {
	const revisionComparison = compareSyncRevisions(
		left.revision,
		right.revision,
	);
	if (revisionComparison !== 0) {
		return revisionComparison;
	}
	if (left.originSequence !== right.originSequence) {
		return left.originSequence < right.originSequence ? -1 : 1;
	}
	if (left.mutation.kind !== right.mutation.kind) {
		return left.mutation.kind === "delete" ? 1 : -1;
	}
	return compareText(left.operationId, right.operationId);
}

export function syncEntityKey(operation: ImmutableSyncOperation): string {
	return [
		operation.accountNamespace,
		operation.section,
		operation.entityType,
		operation.entityId,
	]
		.map((part) => `${part.length}:${part}`)
		.join("");
}

function assertSameEntity(
	left: ImmutableSyncOperation,
	right: ImmutableSyncOperation,
): void {
	if (syncEntityKey(left) !== syncEntityKey(right)) {
		throw new SyncProtocolError(
			"identity-mismatch",
			"Conflict resolution requires operations for the same account entity",
		);
	}
}

/** Last-writer-wins helper with a reproducible logical-clock tie break. */
export function selectWinningOperation(
	left: ImmutableSyncOperation,
	right: ImmutableSyncOperation,
): ImmutableSyncOperation {
	assertSameEntity(left, right);
	return compareSyncOperations(left, right) >= 0 ? left : right;
}

/** Deduplicates immutable/append-only entities and rejects operation-ID reuse. */
export function unionOperationsById(
	left: readonly ImmutableSyncOperation[],
	right: readonly ImmutableSyncOperation[],
): ImmutableSyncOperation[] {
	const byId = new Map<string, ImmutableSyncOperation>();
	const combined = [...left, ...right];
	const accountNamespace = combined[0]?.accountNamespace;
	for (const operation of combined) {
		if (
			accountNamespace !== undefined &&
			operation.accountNamespace !== accountNamespace
		) {
			throw new SyncProtocolError(
				"identity-mismatch",
				"Cannot union operations from different account namespaces",
			);
		}
		const existing = byId.get(operation.operationId);
		if (
			existing &&
			canonicalJson(existing as unknown as JsonValue) !==
				canonicalJson(operation as unknown as JsonValue)
		) {
			throw new SyncProtocolError(
				"identifier-collision",
				`Operation ID ${operation.operationId} identifies different content`,
			);
		}
		byId.set(operation.operationId, existing ?? operation);
	}
	return Array.from(byId.values()).sort((a, b) => {
		const deviceComparison = compareText(a.sourceDeviceId, b.sourceDeviceId);
		return (
			deviceComparison ||
			a.originSequence - b.originSequence ||
			compareText(a.operationId, b.operationId)
		);
	});
}

export function maxCounter(
	left: number | null,
	right: number | null,
): number | null {
	if (left === null) return right;
	if (right === null) return left;
	return Math.max(left, right);
}

export function minCounter(
	left: number | null,
	right: number | null,
): number | null {
	if (left === null) return right;
	if (right === null) return left;
	return Math.min(left, right);
}

export function unionStableIds(
	left: readonly string[],
	right: readonly string[],
): string[] {
	return Array.from(new Set([...left, ...right])).sort(compareText);
}
