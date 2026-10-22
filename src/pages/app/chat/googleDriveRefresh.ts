import type { GoogleDriveSyncDataAppliedDetail } from "../../../services/googleDriveSyncRuntime";

/** Profile gate shared by chat surfaces reacting to a completed cloud apply. */
export function shouldRefreshChatAfterGoogleDriveApply(
	detail: GoogleDriveSyncDataAppliedDetail | null | undefined,
	activeProfileId: number | null,
	settingsReady: boolean,
): boolean {
	return (
		settingsReady &&
		activeProfileId !== null &&
		Number.isSafeInteger(detail?.profileId) &&
		detail?.profileId === activeProfileId
	);
}
