import { useEffect, useLayoutEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../contexts/useAuth";
import {
	GOOGLE_DRIVE_SYNC_DATA_APPLIED_EVENT,
	googleDriveSyncStoresMatch,
	installGoogleDriveSyncRuntime,
	isGoogleDriveAutoSyncPaused,
	runReadyGoogleDriveSync,
	setGoogleDriveSyncReadyProfile,
	type GoogleDriveSyncDataAppliedDetail,
} from "../services/googleDriveSyncRuntime";
import { appLog } from "../utils/logger";

const AUTOMATIC_SYNC_INTERVAL_MS = 5 * 60 * 1_000;
const AUTOMATIC_SYNC_BURST_GUARD_MS = 10_000;

/**
 * Owns native adapter registration and best-effort catch-up while the child
 * app process is alive. iOS suspends these timers in the background, so a cold
 * launch/foreground transition remains the supported post-force-quit path.
 */
export function GoogleDriveSyncLifecycleBridge() {
	const { userId, isLoading, settingsReady } = useAuth();
	const queryClient = useQueryClient();
	const lastAutomaticSyncAtRef = useRef(0);
	const profileReady =
		userId !== null &&
		!isLoading &&
		settingsReady &&
		googleDriveSyncStoresMatch(userId);

	useEffect(() => installGoogleDriveSyncRuntime(), []);

	// Layout phase closes the readiness gate before passive account-change
	// effects can touch a newly selected profile's stores.
	useLayoutEffect(() => {
		setGoogleDriveSyncReadyProfile(profileReady ? userId : null);
		return () => setGoogleDriveSyncReadyProfile(null);
	}, [profileReady, userId]);

	useEffect(() => {
		if (!profileReady || userId === null) return;
		let disposed = false;

		const requestSync = (bypassBurstGuard = false) => {
			if (disposed) return;
			// Explicit user actions share the controller's serialized queue, so a
			// paused device must not keep enqueueing background catch-up work.
			if (isGoogleDriveAutoSyncPaused()) return;
			const now = Date.now();
			if (
				!bypassBurstGuard &&
				now - lastAutomaticSyncAtRef.current < AUTOMATIC_SYNC_BURST_GUARD_MS
			) {
				return;
			}
			lastAutomaticSyncAtRef.current = now;
			void runReadyGoogleDriveSync(userId).catch((error) => {
				if (!disposed) {
					appLog.warn("[GoogleDriveSync] automatic catch-up failed", error);
				}
			});
		};

		const onVisible = () => {
			if (document.visibilityState === "visible") requestSync();
		};
		const onPageShow = () => requestSync();

		requestSync(true);
		document.addEventListener("visibilitychange", onVisible);
		window.addEventListener("focus", onPageShow);
		window.addEventListener("pageshow", onPageShow);
		window.addEventListener("online", onPageShow);
		// This is intentionally not visibility-gated: the user's Windows app
		// commonly stays backgrounded while it receives new chat data.
		const interval = window.setInterval(
			() => requestSync(true),
			AUTOMATIC_SYNC_INTERVAL_MS,
		);

		return () => {
			disposed = true;
			document.removeEventListener("visibilitychange", onVisible);
			window.removeEventListener("focus", onPageShow);
			window.removeEventListener("pageshow", onPageShow);
			window.removeEventListener("online", onPageShow);
			window.clearInterval(interval);
		};
	}, [profileReady, userId]);

	useEffect(() => {
		const onRemoteApplied = (event: Event) => {
			const detail = (event as CustomEvent<GoogleDriveSyncDataAppliedDetail>).detail;
			if (!profileReady || userId === null || detail?.profileId !== userId) return;
			void queryClient.invalidateQueries({
				queryKey: ["interest", "list"],
				exact: true,
			});
		};
		window.addEventListener(
			GOOGLE_DRIVE_SYNC_DATA_APPLIED_EVENT,
			onRemoteApplied,
		);
		return () => {
			window.removeEventListener(
				GOOGLE_DRIVE_SYNC_DATA_APPLIED_EVENT,
				onRemoteApplied,
			);
		};
	}, [profileReady, queryClient, userId]);

	return null;
}
