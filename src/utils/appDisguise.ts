/**
 * App Disguise: the home screen icon swapped for a decoy (a calculator, a
 * notes pad, a weather app), so the app does not stand out on someone's
 * phone. iPhone only, done with iOS's own alternate icons
 * (AppIconSwitch.swift). iOS announces each change with an alert of its own,
 * and never changes the name shown under the icon.
 *
 * iOS is the one that knows which icon is on, so nothing is stored here: the
 * page asks, and the native side answers with an APP_ICON_EVENT.
 */

import { getNativeBridge, postToNative } from "./nativeBridge";

export type AppDisguiseId = "default" | "calculator" | "notes" | "weather";

export const APP_DISGUISE_IDS: readonly AppDisguiseId[] = ["default", "calculator", "notes", "weather"];

/** What iOS calls each decoy: its key under CFBundleAlternateIcons in Info.plist. */
const NATIVE_ICON_NAMES: Record<Exclude<AppDisguiseId, "default">, string> = {
	calculator: "Calculator",
	notes: "Notes",
	weather: "Weather",
};

export const APP_ICON_EVENT = "fg:app-icon";

export type AppDisguiseState = {
	/** Whether this device lets the app swap its icon at all. */
	supported: boolean;
	current: AppDisguiseId;
	/** The change that was just asked for did not happen. */
	failed: boolean;
};

/** The name to hand iOS for a disguise; null stands for the app's own icon. */
export function nativeIconName(id: AppDisguiseId): string | null {
	return id === "default" ? null : NATIVE_ICON_NAMES[id];
}

/** The disguise an iOS icon name stands for. Anything unknown is the app's own icon. */
export function disguiseForNativeIcon(name: unknown): AppDisguiseId {
	for (const id of APP_DISGUISE_IDS) {
		if (id !== "default" && NATIVE_ICON_NAMES[id] === name) {
			return id;
		}
	}
	return "default";
}

/** Reads what the native side reported; null when it is not a report at all. */
export function parseAppIconReport(detail: unknown): AppDisguiseState | null {
	if (!detail || typeof detail !== "object") {
		return null;
	}
	const report = detail as Record<string, unknown>;
	if (typeof report.supported !== "boolean") {
		return null;
	}
	return {
		supported: report.supported,
		current: disguiseForNativeIcon(report.current),
		failed: report.failed === true,
	};
}

/**
 * Whether there is a native side to ask (the iPhone app). It may still answer
 * that icons cannot be swapped, or, on a build older than this, not answer.
 */
export function mayHaveAppDisguise(): boolean {
	return getNativeBridge() != null;
}

/** Asks which icon is on. The answer arrives as an APP_ICON_EVENT. */
export function requestAppDisguiseState(): void {
	postToNative({ type: "getAppIcon" });
}

/** Asks for another icon. What came of it arrives as an APP_ICON_EVENT. */
export function setAppDisguise(id: AppDisguiseId): void {
	postToNative({ type: "setAppIcon", name: nativeIconName(id) });
}

/** Calls `listener` with every report from the native side, until the returned function is called. */
export function onAppDisguiseState(listener: (state: AppDisguiseState) => void): () => void {
	const handle = (event: Event) => {
		const state = parseAppIconReport((event as CustomEvent<unknown>).detail);
		if (state) {
			listener(state);
		}
	};
	window.addEventListener(APP_ICON_EVENT, handle);
	return () => window.removeEventListener(APP_ICON_EVENT, handle);
}
