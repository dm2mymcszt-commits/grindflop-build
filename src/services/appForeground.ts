/**
 * Whether the user has the app in front of them.
 *
 * On a phone the page's own visibility says so. A desktop window is another
 * matter: minimised, or behind another window, its page often goes on
 * reporting "visible". There the window's focus is followed as well, so a
 * window nobody is looking at counts as away.
 */

import { getCurrentWindow } from "@tauri-apps/api/window";
import { platform } from "@tauri-apps/plugin-os";
import { appLog } from "../utils/logger";
import { isTauriRuntime } from "./tauriWebSocket";

let windowFocused = true;
let followingWindowFocus = false;
const returnListeners = new Set<() => void>();

// A phone has no window to ask, and asking there is an error, so this has to
// be the desktop and not merely "inside Tauri".
function isDesktopRuntime(): boolean {
	if (!isTauriRuntime()) return false;
	try {
		const os = platform();
		return os === "windows" || os === "macos" || os === "linux";
	} catch {
		return false;
	}
}

function isPageVisible(): boolean {
	return typeof document === "undefined" || document.visibilityState === "visible";
}

export function isAppForeground(): boolean {
	return isPageVisible() && windowFocused;
}

function announceReturn(): void {
	for (const listener of returnListeners) {
		try {
			listener();
		} catch (error) {
			appLog.warn("[foreground] a return listener failed", error);
		}
	}
}

if (typeof document !== "undefined") {
	document.addEventListener("visibilitychange", () => {
		if (isAppForeground()) {
			announceReturn();
		}
	});
}

/**
 * Starts following the desktop window's focus. Does nothing anywhere else,
 * and nothing the second time it is called.
 */
export function followWindowFocus(): void {
	if (followingWindowFocus || !isDesktopRuntime()) return;
	followingWindowFocus = true;

	const appWindow = getCurrentWindow();
	let heardChange = false;

	void appWindow
		.onFocusChanged(({ payload: focused }) => {
			heardChange = true;
			const cameBack = focused && !windowFocused;
			windowFocused = focused;
			if (cameBack && isPageVisible()) {
				announceReturn();
			}
		})
		.catch((error) => {
			// Without the events the window counts as focused, which is how
			// the app behaved before any of this existed.
			followingWindowFocus = false;
			appLog.warn("[foreground] cannot follow the window focus", error);
		});

	void appWindow
		.isFocused()
		.then((focused) => {
			// A change heard while this was on its way is the newer of the two.
			if (!heardChange) {
				windowFocused = focused;
			}
		})
		.catch((error) => {
			appLog.warn("[foreground] cannot read the window focus", error);
		});
}

/**
 * Calls `listener` every time the user comes back to the app: the window
 * regains focus, or the page becomes visible again. Returns the way to stop.
 */
export function onReturnToForeground(listener: () => void): () => void {
	returnListeners.add(listener);
	return () => {
		returnListeners.delete(listener);
	};
}
