/**
 * Transport-neutral contract for the optional Google Drive sync engine.
 *
 * The React UI deliberately knows nothing about Tauri commands, OAuth SDKs,
 * Drive file names, or encryption-key storage. A native integration registers
 * an adapter at app startup; tests can register an in-memory adapter. Until an
 * adapter is installed, the settings surface remains visible but clearly
 * reports that sync is unavailable in this build.
 */

import { translate } from "../utils/translate";

export type GoogleDriveSyncPhase =
	/** Nothing has been determined yet; distinct from a checked disconnection. */
	| "loading"
	| "disconnected"
	| "connecting"
	| "pairing"
	| "paired"
	| "syncing"
	| "error";

/** Coarse step of the running cycle, for progress the user can read. */
export type GoogleDriveSyncStep =
	| "scanning"
	| "reading"
	| "applying"
	| "uploading";

export type GoogleDriveMediaPolicy = "off" | "wifi-only";
export type GoogleDriveVaultState = "none" | "awaiting-key" | "ready";

export interface GoogleDriveSyncError {
	message: string;
	requiresReauthentication?: boolean;
}

export interface GoogleDriveSyncStatus {
	phase: GoogleDriveSyncPhase;
	/**
	 * False until the device's real state has been read. The phase alone cannot
	 * carry this: a cycle overwrites it with "syncing", which would otherwise
	 * make placeholder values look established.
	 */
	determined: boolean;
	/** False when this platform/build has not installed a native adapter. */
	available: boolean;
	unavailableReason?: string;
	/** OAuth/account connection and E2EE key pairing are intentionally separate. */
	googleConnected: boolean;
	vaultState: GoogleDriveVaultState;
	vaultFingerprint: string | null;
	googleAccountEmail: string | null;
	deviceName: string | null;
	lastSuccessfulSyncAt: number | null;
	pendingChanges: number;
	pendingBytes: number;
	mediaPolicy: GoogleDriveMediaPolicy;
	/** Set only while a cycle is running, so the UI can show real progress. */
	syncStep: GoogleDriveSyncStep | null;
	error: GoogleDriveSyncError | null;
}

export interface GoogleDriveSyncProfileInput {
	profileId: number;
}

export interface GoogleDriveMediaPolicyInput extends GoogleDriveSyncProfileInput {
	mediaPolicy: GoogleDriveMediaPolicy;
}

export interface GoogleDrivePairingCodeInput extends GoogleDriveSyncProfileInput {
	pairingCode: string;
}

export interface GoogleDrivePairingCode {
	/** Sensitive key-transfer payload. Callers must not persist or log it. */
	pairingCode: string;
	/** Short non-secret identifier shown on both devices for verification. */
	fingerprint: string | null;
	/** Null for a recovery code that does not expire. */
	expiresAt: number | null;
}

export type GoogleDriveSyncStatusListener = (
	status: GoogleDriveSyncStatus,
) => void;

/**
 * Adapter implemented by the sync engine/native bridge. Every mutating method
 * returns its latest status so callers remain deterministic even when an
 * adapter cannot provide push notifications.
 */
export interface GoogleDriveSyncAdapter {
	getStatus(input: GoogleDriveSyncProfileInput): Promise<GoogleDriveSyncStatus>;
	connect(input: GoogleDriveSyncProfileInput): Promise<GoogleDriveSyncStatus>;
	exportPairingCode(
		input: GoogleDriveSyncProfileInput,
	): Promise<GoogleDrivePairingCode>;
	importPairingCode(
		input: GoogleDrivePairingCodeInput,
	): Promise<GoogleDriveSyncStatus>;
	syncNow(input: GoogleDriveSyncProfileInput): Promise<GoogleDriveSyncStatus>;
	setMediaPolicy(
		input: GoogleDriveMediaPolicyInput,
	): Promise<GoogleDriveSyncStatus>;
	disconnectDevice(
		input: GoogleDriveSyncProfileInput,
	): Promise<GoogleDriveSyncStatus>;
	resetCloudData(
		input: GoogleDriveSyncProfileInput,
	): Promise<GoogleDriveSyncStatus>;
	/** Optional because polling/fetch-after-action adapters are fully supported. */
	subscribe?(
		input: GoogleDriveSyncProfileInput,
		listener: GoogleDriveSyncStatusListener,
	): () => void;
}

const UNAVAILABLE_REASON =
	"Google Drive sync is not configured in this build yet.";

function unavailableStatus(): GoogleDriveSyncStatus {
	return {
		phase: "disconnected",
		available: false,
		unavailableReason: translate("data_backup.drive_sync.errors.not_configured", {
			defaultValue: UNAVAILABLE_REASON,
		}),
		syncStep: null,
		// A build with no adapter is a known answer, not a pending one.
		determined: true,
		googleConnected: false,
		vaultState: "none",
		vaultFingerprint: null,
		googleAccountEmail: null,
		deviceName: null,
		lastSuccessfulSyncAt: null,
		pendingChanges: 0,
		pendingBytes: 0,
		mediaPolicy: "off",
		error: null,
	};
}

export class GoogleDriveSyncUnavailableError extends Error {
	constructor(message = UNAVAILABLE_REASON) {
		super(message);
		this.name = "GoogleDriveSyncUnavailableError";
	}
}

const unavailableAdapter: GoogleDriveSyncAdapter = {
	getStatus: async () => unavailableStatus(),
	connect: async () => {
		throw new GoogleDriveSyncUnavailableError();
	},
	exportPairingCode: async () => {
		throw new GoogleDriveSyncUnavailableError();
	},
	importPairingCode: async () => {
		throw new GoogleDriveSyncUnavailableError();
	},
	syncNow: async () => {
		throw new GoogleDriveSyncUnavailableError();
	},
	setMediaPolicy: async () => {
		throw new GoogleDriveSyncUnavailableError();
	},
	disconnectDevice: async () => {
		throw new GoogleDriveSyncUnavailableError();
	},
	resetCloudData: async () => {
		throw new GoogleDriveSyncUnavailableError();
	},
};

let activeAdapter: GoogleDriveSyncAdapter = unavailableAdapter;
const adapterChangeListeners = new Set<() => void>();

/**
 * Install the platform adapter. The returned cleanup only unregisters the same
 * adapter, which keeps hot reload and test teardown from clobbering a newer one.
 */
export function registerGoogleDriveSyncAdapter(
	adapter: GoogleDriveSyncAdapter,
): () => void {
	activeAdapter = adapter;
	adapterChangeListeners.forEach((listener) => listener());

	return () => {
		if (activeAdapter !== adapter) return;
		activeAdapter = unavailableAdapter;
		adapterChangeListeners.forEach((listener) => listener());
	};
}

export function getGoogleDriveSyncStatus(
	input: GoogleDriveSyncProfileInput,
): Promise<GoogleDriveSyncStatus> {
	return activeAdapter.getStatus(input);
}

export function connectGoogleDriveSync(
	input: GoogleDriveSyncProfileInput,
): Promise<GoogleDriveSyncStatus> {
	return activeAdapter.connect(input);
}

export function exportGoogleDriveSyncPairingCode(
	input: GoogleDriveSyncProfileInput,
): Promise<GoogleDrivePairingCode> {
	return activeAdapter.exportPairingCode(input);
}

export function importGoogleDriveSyncPairingCode(
	input: GoogleDrivePairingCodeInput,
): Promise<GoogleDriveSyncStatus> {
	return activeAdapter.importPairingCode(input);
}

export function runGoogleDriveSyncNow(
	input: GoogleDriveSyncProfileInput,
): Promise<GoogleDriveSyncStatus> {
	return activeAdapter.syncNow(input);
}

export function setGoogleDriveSyncMediaPolicy(
	input: GoogleDriveMediaPolicyInput,
): Promise<GoogleDriveSyncStatus> {
	return activeAdapter.setMediaPolicy(input);
}

export function disconnectGoogleDriveSyncDevice(
	input: GoogleDriveSyncProfileInput,
): Promise<GoogleDriveSyncStatus> {
	return activeAdapter.disconnectDevice(input);
}

export function resetGoogleDriveSyncCloudData(
	input: GoogleDriveSyncProfileInput,
): Promise<GoogleDriveSyncStatus> {
	return activeAdapter.resetCloudData(input);
}

/**
 * Subscribe to status while also surviving a late adapter registration. When
 * the adapter changes, the listener is rebound and receives a fresh snapshot.
 */
export function subscribeGoogleDriveSyncStatus(
	input: GoogleDriveSyncProfileInput,
	listener: GoogleDriveSyncStatusListener,
): () => void {
	let disposed = false;
	let bindingGeneration = 0;
	let unsubscribeFromAdapter: (() => void) | undefined;

	const publishSnapshot = (
		adapter: GoogleDriveSyncAdapter,
		generation: number,
	) => {
		void adapter.getStatus(input).then(
			(status) => {
				if (!disposed && generation === bindingGeneration) listener(status);
			},
			() => {
				// The component's explicit refresh path owns load-error reporting.
			},
		);
	};

	const bind = () => {
		const generation = ++bindingGeneration;
		const adapter = activeAdapter;
		unsubscribeFromAdapter?.();
		unsubscribeFromAdapter = adapter.subscribe?.(input, (status) => {
			if (!disposed && generation === bindingGeneration) listener(status);
		});
		publishSnapshot(adapter, generation);
	};

	adapterChangeListeners.add(bind);
	bind();

	return () => {
		disposed = true;
		bindingGeneration += 1;
		adapterChangeListeners.delete(bind);
		unsubscribeFromAdapter?.();
	};
}
