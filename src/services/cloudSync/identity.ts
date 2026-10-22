import { SyncProtocolError } from "./errors";
import {
	accountNamespaceSchema,
	deepFreeze,
	deviceIdSchema,
	positiveSafeIntegerSchema,
	syncOperationSchema,
	type ImmutableSyncOperation,
	type JsonValue,
	type SyncSection,
} from "./types";

export type AllocatedSyncSequence = Readonly<{
	originSequence: number;
	logicalClock: number;
}>;

export interface SyncSequenceAllocator {
	/**
	 * Atomically reserves the next source sequence for one account/device scope.
	 * A durable implementation must persist this reservation before returning it.
	 */
	next(
		accountNamespace: string,
		deviceId: string,
		observedLogicalClock?: number,
	): Promise<AllocatedSyncSequence>;

	/** Advances only the Lamport clock after accepting remote operations. */
	observe(
		accountNamespace: string,
		deviceId: string,
		logicalClock: number,
	): Promise<void>;
}

type CounterState = {
	originSequence: number;
	logicalClock: number;
};

/**
 * Useful for deterministic tests and ephemeral previews. Production must back
 * the same interface with an atomic, durable per-account store.
 */
export class InMemorySyncSequenceAllocator implements SyncSequenceAllocator {
	readonly #state = new Map<string, CounterState>();
	#pending: Promise<void> = Promise.resolve();

	async next(
		accountNamespace: string,
		deviceId: string,
		observedLogicalClock = 0,
	): Promise<AllocatedSyncSequence> {
		accountNamespaceSchema.parse(accountNamespace);
		deviceIdSchema.parse(deviceId);
		if (observedLogicalClock !== 0) {
			positiveSafeIntegerSchema.parse(observedLogicalClock);
		}

		return this.#serialized(() => {
			const key = scopeKey(accountNamespace, deviceId);
			const previous = this.#state.get(key) ?? {
				originSequence: 0,
				logicalClock: 0,
			};
			if (
				previous.originSequence >= Number.MAX_SAFE_INTEGER ||
				Math.max(previous.logicalClock, observedLogicalClock) >=
					Number.MAX_SAFE_INTEGER
			) {
				throw new SyncProtocolError(
					"sequence-gap",
					"Sync sequence space is exhausted for this device identity",
				);
			}
			const allocated = {
				originSequence: previous.originSequence + 1,
				logicalClock: Math.max(previous.logicalClock, observedLogicalClock) + 1,
			};
			this.#state.set(key, allocated);
			return Object.freeze({ ...allocated });
		});
	}

	async observe(
		accountNamespace: string,
		deviceId: string,
		logicalClock: number,
	): Promise<void> {
		accountNamespaceSchema.parse(accountNamespace);
		deviceIdSchema.parse(deviceId);
		positiveSafeIntegerSchema.parse(logicalClock);

		await this.#serialized(() => {
			const key = scopeKey(accountNamespace, deviceId);
			const previous = this.#state.get(key) ?? {
				originSequence: 0,
				logicalClock: 0,
			};
			this.#state.set(key, {
				...previous,
				logicalClock: Math.max(previous.logicalClock, logicalClock),
			});
		});
	}

	async #serialized<T>(action: () => T): Promise<T> {
		const previous = this.#pending;
		let release = (): void => undefined;
		this.#pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return action();
		} finally {
			release();
		}
	}
}

function scopeKey(accountNamespace: string, deviceId: string): string {
	return `${accountNamespace.length}:${accountNamespace}${deviceId}`;
}

function randomUuid(): string {
	if (!globalThis.crypto) {
		throw new Error("Secure random generation is unavailable in this runtime");
	}
	if (typeof globalThis.crypto.randomUUID === "function") {
		return globalThis.crypto.randomUUID();
	}
	const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
	return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
		.slice(6, 8)
		.join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

export function createOperationId(): string {
	return `op-${randomUuid()}`;
}

export type CreateSyncOperationInput = Readonly<{
	operationId?: string;
	accountNamespace: string;
	sourceDeviceId: string;
	sequence: AllocatedSyncSequence;
	section: SyncSection;
	entityType: string;
	entityId: string;
	createdAtMs?: number;
	mutation:
		| Readonly<{ kind: "upsert"; value: JsonValue }>
		| Readonly<{ kind: "delete" }>;
}>;

export function createSyncOperation(
	input: CreateSyncOperationInput,
): ImmutableSyncOperation {
	const parsed = syncOperationSchema.parse({
		operationId: input.operationId ?? createOperationId(),
		accountNamespace: input.accountNamespace,
		sourceDeviceId: input.sourceDeviceId,
		originSequence: input.sequence.originSequence,
		revision: {
			logicalClock: input.sequence.logicalClock,
			deviceId: input.sourceDeviceId,
		},
		section: input.section,
		entityType: input.entityType,
		entityId: input.entityId,
		createdAtMs: input.createdAtMs ?? Date.now(),
		mutation: input.mutation,
	});
	return deepFreeze(parsed);
}
