import { platform } from "@tauri-apps/plugin-os";
import { isTauriRuntime } from "./tauriWebSocket";
import { appLog } from "../utils/logger";

/**
 * Identity and sync bookkeeping for incremental backups.
 *
 * Both keys live in localStorage and are on the backup denylist, which is the
 * whole point: they describe *this device* and its relationships, so they must
 * never travel inside an export. If they did, a restored install would claim
 * the exporting device's identity and inherit its watermarks, and the next
 * delta would silently skip everything.
 */
const DEVICE_ID_KEY = "fg-device-id";
const PEERS_KEY = "fg-backup-peers";

export type BackupPeer = {
	deviceId: string;
	deviceName: string;
	/**
	 * High-water mark for data this peer has confirmed receiving from us.
	 *
	 * Deliberately *not* advanced when we write a file: an export the user
	 * generates and then never transfers would strand every row it covered,
	 * permanently invisible to every later delta. Instead it moves only when
	 * that peer sends something back carrying an acknowledgement, which is
	 * proof the earlier file actually landed.
	 *
	 * Null means a full export — either they're new, or nothing we've sent has
	 * been confirmed yet. That is the correct default: they hold none of our
	 * history that we can prove.
	 */
	lastExportAt: number | null;
	/** When we last imported one of their files. Display only. */
	lastImportAt: number | null;
	/**
	 * The `exportedAt` of the newest file of theirs we've actually imported.
	 *
	 * Sent back inside our next export as an acknowledgement, which is what
	 * lets *them* advance their own watermark. Confirmed receipt is the only
	 * safe trigger for that: advancing on export alone would strand every row
	 * in a file the user generated but never transferred.
	 */
	theirDataIHaveUpTo: number | null;
};

function readJson<T>(key: string): T | null {
	try {
		const raw = window.localStorage.getItem(key);
		return raw ? (JSON.parse(raw) as T) : null;
	} catch (error) {
		appLog.warn("[backupPeers] failed to read", key, error);
		return null;
	}
}

function writeJson(key: string, value: unknown): void {
	try {
		window.localStorage.setItem(key, JSON.stringify(value));
	} catch (error) {
		appLog.warn("[backupPeers] failed to write", key, error);
	}
}

function randomId(): string {
	try {
		return crypto.randomUUID();
	} catch {
		return `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
	}
}

/** Stable per-install id, minted on first use. */
export function getDeviceId(): string {
	try {
		const existing = window.localStorage.getItem(DEVICE_ID_KEY);
		if (existing) {
			return existing;
		}
	} catch {
		// Storage unavailable — fall through to an ephemeral id. Sync degrades
		// to full exports rather than failing outright.
	}
	const created = randomId();
	try {
		window.localStorage.setItem(DEVICE_ID_KEY, created);
	} catch (error) {
		appLog.warn("[backupPeers] could not persist device id", error);
	}
	return created;
}

/**
 * Stable per-install id for Google Drive sync.
 *
 * Automatic cloud sync cannot safely use getDeviceId's ephemeral fallback: a
 * new source id after storage loss would let one installation fork its own
 * immutable history. Prove that the chosen id can be written and read back
 * before returning it, and otherwise stop cloud sync.
 */
export function getGoogleDriveSyncDeviceId(): string {
	try {
		const storage = window.localStorage;
		const deviceId = storage.getItem(DEVICE_ID_KEY) || randomId();
		storage.setItem(DEVICE_ID_KEY, deviceId);
		if (storage.getItem(DEVICE_ID_KEY) !== deviceId) {
			throw new Error("Local storage did not retain the device id");
		}
		return deviceId;
	} catch (error) {
		appLog.warn("[backupPeers] cloud sync device id is not durable", error);
		throw new Error(
			"Google Drive sync requires durable local storage for this device id",
		);
	}
}

/**
 * Resolve the browser copy of the cloud source identity against its durable
 * per-profile store binding.
 *
 * Once a store binding exists it is authoritative: a missing browser value is
 * repaired from it, while a different browser value is never overwritten. An
 * unbound store may opt out of minting when it already contains pre-v4 sync
 * state, so losing localStorage cannot silently create a new source history.
 */
export function resolveGoogleDriveSyncDeviceId(
	boundDeviceId: string | null,
	allowCreate: boolean,
): string | null {
	if (boundDeviceId === null) {
		if (allowCreate) return getGoogleDriveSyncDeviceId();
		try {
			const storage = window.localStorage;
			const existing = storage.getItem(DEVICE_ID_KEY);
			if (existing === null) return null;
			storage.setItem(DEVICE_ID_KEY, existing);
			if (storage.getItem(DEVICE_ID_KEY) !== existing) {
				throw new Error("Local storage did not retain the device id");
			}
			return existing;
		} catch (error) {
			appLog.warn("[backupPeers] cloud sync device id is not durable", error);
			throw new Error(
				"Google Drive sync requires durable local storage for this device id",
			);
		}
	}

	let existing: string | null;
	try {
		existing = window.localStorage.getItem(DEVICE_ID_KEY);
	} catch (error) {
		appLog.warn("[backupPeers] cloud sync device id is not readable", error);
		throw new Error(
			"Google Drive sync requires durable local storage for this device id",
		);
	}
	if (existing !== null && existing !== boundDeviceId) {
		appLog.warn("[backupPeers] browser and bound cloud sync device ids conflict");
		throw new Error(
			"Google Drive sync stopped because the browser and bound device ids conflict",
		);
	}
	try {
		if (existing === null) {
			window.localStorage.setItem(DEVICE_ID_KEY, boundDeviceId);
		}
		if (window.localStorage.getItem(DEVICE_ID_KEY) !== boundDeviceId) {
			throw new Error("Local storage did not retain the bound device id");
		}
		return boundDeviceId;
	} catch (error) {
		appLog.warn("[backupPeers] bound cloud sync device id is not durable", error);
		throw new Error(
			"Google Drive sync requires durable local storage for this device id",
		);
	}
}

const PLATFORM_LABELS: Record<string, string> = {
	windows: "Windows PC",
	macos: "Mac",
	linux: "Linux PC",
	ios: "iPhone",
	android: "Android phone",
};

/** A human label so the export screen can say which device a file came from. */
export function getDeviceName(): string {
	if (!isTauriRuntime()) {
		return "Browser";
	}
	try {
		return PLATFORM_LABELS[platform()] ?? "This device";
	} catch {
		return "This device";
	}
}

export function listPeers(): BackupPeer[] {
	const peers = readJson<Record<string, BackupPeer>>(PEERS_KEY) ?? {};
	return Object.values(peers).sort(
		(a, b) => (b.lastImportAt ?? 0) - (a.lastImportAt ?? 0),
	);
}

export function getPeer(deviceId: string): BackupPeer | null {
	const peers = readJson<Record<string, BackupPeer>>(PEERS_KEY) ?? {};
	return peers[deviceId] ?? null;
}

function updatePeer(deviceId: string, apply: (peer: BackupPeer) => BackupPeer): void {
	const peers = readJson<Record<string, BackupPeer>>(PEERS_KEY) ?? {};
	const existing = peers[deviceId] ?? {
		deviceId,
		deviceName: "Unknown device",
		lastExportAt: null,
		lastImportAt: null,
		theirDataIHaveUpTo: null,
	};
	peers[deviceId] = apply(existing);
	writeJson(PEERS_KEY, peers);
}

/**
 * Called after importing a file, so this peer becomes a known sync partner.
 *
 * `theirExportedAt` is recorded as the acknowledgement we'll send back, and
 * `ackUpTo` is their acknowledgement of *us* — the newest export of ours they
 * confirmed importing. That second half is what lets our watermark advance on
 * proof of delivery rather than on the mere act of writing a file.
 */
export function recordPeerImport(
	deviceId: string,
	deviceName: string,
	theirExportedAt: number,
	ackUpTo?: number | null,
): void {
	if (!deviceId || deviceId === getDeviceId()) {
		return;
	}
	updatePeer(deviceId, (peer) => ({
		...peer,
		deviceName: deviceName || peer.deviceName,
		lastImportAt: Date.now(),
		theirDataIHaveUpTo: Math.max(peer.theirDataIHaveUpTo ?? 0, theirExportedAt || 0) || null,
		lastExportAt: ackUpTo
			? Math.max(peer.lastExportAt ?? 0, ackUpTo) || null
			: peer.lastExportAt,
	}));
}

/** What we tell this peer we've received from them, inside our next export. */
export function getAckForPeer(deviceId: string | null): number | null {
	return deviceId ? (getPeer(deviceId)?.theirDataIHaveUpTo ?? null) : null;
}

export function forgetPeer(deviceId: string): void {
	const peers = readJson<Record<string, BackupPeer>>(PEERS_KEY) ?? {};
	delete peers[deviceId];
	writeJson(PEERS_KEY, peers);
}

/** Keys that must never leave this device. Consumed by the backup denylist. */
export const DEVICE_LOCAL_KEYS = [DEVICE_ID_KEY, PEERS_KEY] as const;
