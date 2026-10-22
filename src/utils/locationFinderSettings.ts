/**
 * Whether profiles offer the location finder at all. Device-local and on by
 * default, so nothing changes for anyone who never touches the setting.
 */
export const LOCATION_FINDER_ENABLED_KEY = "fg-location-finder-enabled";

export function isLocationFinderEnabled(): boolean {
	try {
		return window.localStorage.getItem(LOCATION_FINDER_ENABLED_KEY) !== "false";
	} catch {
		return true;
	}
}

export function setLocationFinderEnabled(enabled: boolean): void {
	try {
		window.localStorage.setItem(LOCATION_FINDER_ENABLED_KEY, String(enabled));
	} catch {
		// Storage unavailable: the finder simply stays at its default.
	}
}

/**
 * About how long a run takes, from the target's distance. Mirrors the
 * finder's own round count — two to six rounds of three points — at roughly
 * six seconds a point (the five-second wait plus two requests), plus the
 * ten seconds it waits before putting the location back.
 */
export function estimateLocationFinderSeconds(distanceMeters: number | null | undefined): number | null {
	if (distanceMeters == null || !Number.isFinite(distanceMeters) || distanceMeters <= 0) {
		return null;
	}
	const rounds = Math.max(2, Math.min(Math.ceil(Math.log(distanceMeters / 15) / Math.log(3)), 6));
	return rounds * 3 * 6 + 10;
}
