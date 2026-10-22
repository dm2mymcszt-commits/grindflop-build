/**
 * KeepScreenOnBridge — while "Keep Screen On" is turned on, holds a screen
 * wake lock for as long as the app is in front, so the display neither dims
 * nor locks.
 *
 * The browser takes the lock away by itself whenever the page is hidden
 * (minimised, another app in front, the phone locked by hand), and nothing
 * gives it back, so it is asked for again each time the page returns.
 */

import { useEffect, useState } from "react";
import {
	KEEP_SCREEN_ON_CHANGED_EVENT,
	isKeepScreenOnEnabled,
	isKeepScreenOnSupported,
} from "../utils/keepScreenOn";
import { appLog } from "../utils/logger";

export function KeepScreenOnBridge() {
	const [enabled, setEnabled] = useState(isKeepScreenOnEnabled);

	useEffect(() => {
		const onChanged = () => setEnabled(isKeepScreenOnEnabled());
		window.addEventListener(KEEP_SCREEN_ON_CHANGED_EVENT, onChanged);
		return () => window.removeEventListener(KEEP_SCREEN_ON_CHANGED_EVENT, onChanged);
	}, []);

	useEffect(() => {
		if (!enabled || !isKeepScreenOnSupported()) {
			return;
		}

		let cancelled = false;
		let asking = false;
		let sentinel: WakeLockSentinel | null = null;

		const acquire = async () => {
			// One request at a time, and none while a lock is still held.
			if (asking || (sentinel && !sentinel.released)) {
				return;
			}
			asking = true;
			try {
				const granted = await navigator.wakeLock.request("screen");
				if (cancelled) {
					await granted.release().catch(() => {});
					return;
				}
				sentinel = granted;
			} catch (error) {
				// Refused while the page is hidden or the battery is low. The
				// next return to the app asks again.
				appLog.debug("[keep-screen-on] wake lock request refused", error);
			} finally {
				asking = false;
			}
		};

		const onVisibility = () => {
			if (document.visibilityState === "visible") {
				void acquire();
			}
		};

		void acquire();
		document.addEventListener("visibilitychange", onVisibility);

		return () => {
			cancelled = true;
			document.removeEventListener("visibilitychange", onVisibility);
			void sentinel?.release().catch(() => {});
			sentinel = null;
		};
	}, [enabled]);

	return null;
}
