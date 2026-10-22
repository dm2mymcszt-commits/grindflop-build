import { isTauri } from "@tauri-apps/api/core";
import type { ContactIndexSyncScope } from "./chatContactIndex";
import { getActiveChatContactIndexUser } from "./chatContactIndex";
import { getActiveChatDbUser } from "./chatDb";
import {
	getActiveInterestViewsAccount,
	getInterestViewsAccountForUser,
} from "./interestViewsStore";
import {
	registerGoogleDriveSyncAdapter,
	type GoogleDriveSyncStatus,
} from "./googleDriveSync";
import { createGoogleDriveSyncControllerAdapter } from "./googleDriveSyncController";
import { reloadPastContacts } from "./pastContacts";
import { SAVED_PHRASES_UPDATED_EVENT } from "./savedPhrases";
import { loadSeenCache } from "./seenStore";
import { loadStatsSettingsCache } from "./statsLog";
import { loadAutomationRulesCache } from "../utils/automationRules";
import { loadAutomationCache } from "../utils/autoblock";
import { appLog } from "../utils/logger";
import { loadPrivacyCache } from "../utils/privacy";

export const GOOGLE_DRIVE_SYNC_DATA_APPLIED_EVENT =
	"fg:google-drive-sync-data-applied";

export interface GoogleDriveSyncDataAppliedDetail {
	profileId: number;
}

export interface GoogleDriveRemoteApplyRefreshDependencies {
	isProfileReady: (profileId: number) => boolean;
	loadCaches: readonly (() => Promise<void>)[];
	dispatchApplied: (profileId: number) => void;
	reportCacheError: (error: unknown, loaderIndex: number) => void;
}

let readyProfileId: number | null = null;

const AUTO_SYNC_PAUSED_STORAGE_KEY = "fg:google-drive-auto-sync-paused";
const autoSyncPausedListeners = new Set<(paused: boolean) => void>();
let autoSyncPaused = readPersistedAutoSyncPaused();

function readPersistedAutoSyncPaused(): boolean {
	try {
		return globalThis.localStorage?.getItem(AUTO_SYNC_PAUSED_STORAGE_KEY) === "1";
	} catch {
		return false;
	}
}

/**
 * Device-local pause for background catch-up. A long cycle otherwise keeps
 * the serialized controller queue busy, which delays explicit user actions
 * such as revealing a pairing code. This is deliberately an app-global
 * browser preference: it is never scanned, journaled or uploaded.
 */
const CONTACT_SCOPE_STORAGE_KEY = "fg:google-drive-contact-scope";
const contactScopeListeners = new Set<(scope: ContactIndexSyncScope) => void>();
let contactScope: ContactIndexSyncScope = readPersistedContactScope();

function readPersistedContactScope(): ContactIndexSyncScope {
	try {
		const stored = globalThis.localStorage?.getItem(CONTACT_SCOPE_STORAGE_KEY);
		if (
			stored === "conversations" ||
			stored === "conversations-and-recent" ||
			stored === "everything"
		) {
			return stored;
		}
	} catch {
		// A blocked store falls through to the default.
	}
	return "conversations";
}

/**
 * How much of the contact index this device contributes. Profiles that were
 * only browsed dominate that table, so the default keeps sync to people the
 * user has actually messaged.
 */
export function getGoogleDriveContactScope(): ContactIndexSyncScope {
	return contactScope;
}

export function setGoogleDriveContactScope(scope: ContactIndexSyncScope): void {
	if (contactScope === scope) return;
	contactScope = scope;
	try {
		globalThis.localStorage?.setItem(CONTACT_SCOPE_STORAGE_KEY, scope);
	} catch {
		// The in-memory value still applies for this session.
	}
	for (const listener of contactScopeListeners) listener(scope);
}

export function subscribeGoogleDriveContactScope(
	listener: (scope: ContactIndexSyncScope) => void,
): () => void {
	contactScopeListeners.add(listener);
	return () => contactScopeListeners.delete(listener);
}

export function isGoogleDriveAutoSyncPaused(): boolean {
	return autoSyncPaused;
}

export function setGoogleDriveAutoSyncPaused(paused: boolean): void {
	if (autoSyncPaused === paused) return;
	autoSyncPaused = paused;
	try {
		if (paused) {
			globalThis.localStorage?.setItem(AUTO_SYNC_PAUSED_STORAGE_KEY, "1");
		} else {
			globalThis.localStorage?.removeItem(AUTO_SYNC_PAUSED_STORAGE_KEY);
		}
	} catch {
		// A private/blocked store still honours the in-memory pause.
	}
	for (const listener of autoSyncPausedListeners) listener(paused);
}

export function subscribeGoogleDriveAutoSyncPaused(
	listener: (paused: boolean) => void,
): () => void {
	autoSyncPausedListeners.add(listener);
	return () => autoSyncPausedListeners.delete(listener);
}

export function googleDriveSyncStoresMatch(profileId: number): boolean {
	return (
		getActiveChatDbUser() === profileId &&
		getActiveChatContactIndexUser() === profileId &&
		getActiveInterestViewsAccount() === getInterestViewsAccountForUser(profileId)
	);
}

export function isGoogleDriveSyncProfileReady(profileId: number): boolean {
	return readyProfileId === profileId && googleDriveSyncStoresMatch(profileId);
}

function dispatchRemoteApply(profileId: number): void {
	if (typeof window === "undefined") return;
	window.dispatchEvent(
		new CustomEvent<GoogleDriveSyncDataAppliedDetail>(
			GOOGLE_DRIVE_SYNC_DATA_APPLIED_EVENT,
			{ detail: { profileId } },
		),
	);
	// Existing chat surfaces already use this event to re-read the DB-backed
	// phrase list. The generic event covers the rest of the synced data.
	window.dispatchEvent(new Event(SAVED_PHRASES_UPDATED_EVENT));
}

const defaultRemoteApplyDependencies: GoogleDriveRemoteApplyRefreshDependencies = {
	isProfileReady: isGoogleDriveSyncProfileReady,
	loadCaches: [
		loadAutomationCache,
		loadAutomationRulesCache,
		loadPrivacyCache,
		loadSeenCache,
		loadStatsSettingsCache,
		reloadPastContacts,
	],
	dispatchApplied: dispatchRemoteApply,
	reportCacheError: (error, loaderIndex) => {
		appLog.warn("[GoogleDriveSync] post-apply cache reload failed", {
			loaderIndex,
			error,
		});
	},
};

/**
 * Refresh process-local caches after unseen remote operations are durably
 * applied. Cache/UI refresh failures never invalidate the completed sync, and
 * a profile switch during an awaited loader suppresses all UI notification.
 */
export async function refreshAfterGoogleDriveRemoteApply(
	profileId: number,
	dependencies: GoogleDriveRemoteApplyRefreshDependencies =
		defaultRemoteApplyDependencies,
): Promise<boolean> {
	if (!dependencies.isProfileReady(profileId)) return false;
	const results = await Promise.allSettled(
		dependencies.loadCaches.map((load) => Promise.resolve().then(load)),
	);
	results.forEach((result, index) => {
		if (result.status === "rejected") {
			try {
				dependencies.reportCacheError(result.reason, index);
			} catch {
				// Diagnostics must never change a completed sync's outcome.
			}
		}
	});
	if (!dependencies.isProfileReady(profileId)) return false;
	try {
		dependencies.dispatchApplied(profileId);
	} catch (error) {
		try {
			dependencies.reportCacheError(error, dependencies.loadCaches.length);
		} catch {
			// Diagnostics must never change a completed sync's outcome.
		}
	}
	return true;
}

const controllerManager = createGoogleDriveSyncControllerAdapter({
	contactScope: getGoogleDriveContactScope,
	isActiveProfile: isGoogleDriveSyncProfileReady,
	onRemoteApplied: async (profileId) => {
		await refreshAfterGoogleDriveRemoteApply(profileId);
	},
});

let installCount = 0;
let unregisterAdapter: (() => void) | null = null;

/** Register the one process-wide native adapter, with StrictMode-safe cleanup. */
export function installGoogleDriveSyncRuntime(): () => void {
	if (!isTauri()) return () => undefined;
	installCount += 1;
	if (installCount === 1) {
		unregisterAdapter = registerGoogleDriveSyncAdapter(controllerManager);
	}
	let disposed = false;
	return () => {
		if (disposed) return;
		disposed = true;
		installCount = Math.max(0, installCount - 1);
		if (installCount === 0) {
			unregisterAdapter?.();
			unregisterAdapter = null;
		}
	};
}

export function setGoogleDriveSyncReadyProfile(profileId: number | null): void {
	const previousProfileId = readyProfileId;
	readyProfileId = profileId;
	if (previousProfileId !== null && previousProfileId !== profileId) {
		controllerManager.invalidateProfile(previousProfileId);
	}
}

export function invalidateGoogleDriveSyncProfile(profileId: number): void {
	if (readyProfileId === profileId) readyProfileId = null;
	controllerManager.invalidateProfile(profileId);
}

export async function closeGoogleDriveSyncProfilesExcept(
	profileId: number | null,
): Promise<void> {
	await controllerManager.closeProfilesExcept(profileId);
}

export async function runReadyGoogleDriveSync(
	profileId: number,
): Promise<GoogleDriveSyncStatus | null> {
	if (!isTauri()) return null;
	if (!isGoogleDriveSyncProfileReady(profileId)) return null;
	return controllerManager.syncNow({ profileId });
}
