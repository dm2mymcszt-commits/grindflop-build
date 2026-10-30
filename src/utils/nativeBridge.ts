/**
 * The iOS build's script message handler (NativeBridge.swift), reached as
 * window.webkit.messageHandlers.fgNative. Its presence alone says the build
 * has the native half; everywhere else this is null.
 */

type NativeBridge = { postMessage: (message: unknown) => void };

type NativeBridgeWindow = Window & {
	webkit?: { messageHandlers?: Record<string, NativeBridge | undefined> };
};

export function getNativeBridge(): NativeBridge | null {
	if (typeof window === "undefined") return null;
	return (window as NativeBridgeWindow).webkit?.messageHandlers?.fgNative ?? null;
}

/** Posts to the native side when there is one; a no-op everywhere else. */
export function postToNative(message: { type: string } & Record<string, unknown>): void {
	try {
		getNativeBridge()?.postMessage(message);
	} catch {
		// Nothing listening.
	}
}
