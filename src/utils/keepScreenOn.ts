/**
 * Whether the app keeps the screen from dimming and locking while it is open.
 * Kept on the device, and off unless the user turns it on.
 */
export const KEEP_SCREEN_ON_KEY = "fg-keep-screen-on";

/** Sent on `window` when the setting changes, so the lock follows at once. */
export const KEEP_SCREEN_ON_CHANGED_EVENT = "fg:keep-screen-on-changed";

/**
 * The lock comes from the browser engine, not from the platform: the Windows
 * and phone webviews have it, the Linux desktop one does not. So the engine
 * is asked, and the setting is only offered where the answer is yes.
 */
export function isKeepScreenOnSupported(): boolean {
	return typeof navigator !== "undefined" && "wakeLock" in navigator;
}

export function isKeepScreenOnEnabled(): boolean {
	try {
		return window.localStorage.getItem(KEEP_SCREEN_ON_KEY) === "true";
	} catch {
		return false;
	}
}

export function setKeepScreenOnEnabled(enabled: boolean): void {
	try {
		window.localStorage.setItem(KEEP_SCREEN_ON_KEY, String(enabled));
	} catch {
		// Storage unavailable: the setting simply stays off.
	}
	window.dispatchEvent(new Event(KEEP_SCREEN_ON_CHANGED_EVENT));
}
