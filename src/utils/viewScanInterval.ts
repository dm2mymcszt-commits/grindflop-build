/**
 * How often the views list is fetched, from the Settings slider. Shared by the
 * background sweep and the open Interest page, so both keep the same pace.
 */

/**
 * Must match the default the Settings slider falls back to, otherwise the
 * sweep silently runs on a different cadence than the one the UI displays.
 */
const DEFAULT_SCAN_INTERVAL_SECONDS = 30;
/** Matches the Settings slider bounds. */
const MIN_SCAN_INTERVAL_SECONDS = 10;
const MAX_SCAN_INTERVAL_SECONDS = 300;

export function readViewScanIntervalSeconds(): number {
	const raw = window.localStorage.getItem("fg-view-scanner-interval");
	const parsed = Number.parseInt(raw ?? "", 10);
	if (!Number.isFinite(parsed)) return DEFAULT_SCAN_INTERVAL_SECONDS;
	return Math.min(MAX_SCAN_INTERVAL_SECONDS, Math.max(MIN_SCAN_INTERVAL_SECONDS, parsed));
}
