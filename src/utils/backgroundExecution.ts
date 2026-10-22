import { getNativeBridge, postToNative } from "./nativeBridge";

export const BACKGROUND_EXECUTION_EVENT = "fg:background";
export type BackgroundExecutionState = {
	supported: boolean;
	enabled: boolean;
	failure: string;
	detail: string;
	systemVersion: string;
};

export function parseBackgroundExecutionState(
	value: unknown,
): BackgroundExecutionState | null {
	if (!value || typeof value !== "object") return null;
	const state = value as Record<string, unknown>;
	if (
		typeof state.supported !== "boolean" ||
		typeof state.enabled !== "boolean" ||
		typeof state.failure !== "string"
	)
		return null;
	// Never show an unsupported or failed request as enabled.
	return {
		supported: state.supported,
		enabled: state.supported && state.enabled && !state.failure,
		failure: state.failure,
		detail: typeof state.detail === "string" ? state.detail : "",
		systemVersion: typeof state.systemVersion === "string" ? state.systemVersion : "",
	};
}

export function backgroundExecutionStatus(
	state: BackgroundExecutionState | null,
	pending: boolean,
	timedOut: boolean,
): string {
	if (pending) return "background_execution_pending";
	if (timedOut) return "background_execution_no_response";
	if (!state) return "background_execution_pending";
	const reasons: Record<string, string> = {
		"security-api": "background_execution_security_api",
		"entitlement-read": "background_execution_entitlement_read",
		"entitlement-missing": "background_execution_entitlement_missing",
		"runningboard-api": "background_execution_system_api",
		"webkit-api": "background_execution_webkit_api",
		webview: "background_execution_webview",
		denied: "background_execution_denied",
		sound: "background_execution_sound",
		"invalid-native-response": "background_execution_invalid_response",
	};
	if (state.failure) return reasons[state.failure] ?? "background_execution_failed";
	if (!state.supported) return "background_execution_unavailable";
	return state.enabled ? "background_execution_enabled" : "background_execution_disabled";
}

/** A received but malformed reply must never be described as no reply. */
export function backgroundExecutionResponse(value: unknown): BackgroundExecutionState {
	const parsed = parseBackgroundExecutionState(value);
	if (parsed) return parsed;
	const fields = value && typeof value === "object" ? value as Record<string, unknown> : {};
	return {
		supported: false,
		enabled: false,
		failure: "invalid-native-response",
		detail: ["supported", "enabled", "failure"].map((key) => `${key}=${typeof fields[key]}`).join("; "),
		systemVersion: "",
	};
}

export function mayHaveBackgroundExecution(): boolean {
	return getNativeBridge() != null;
}

export function cachedBackgroundExecutionState(): BackgroundExecutionState | null {
	if (typeof window === "undefined") return null;
	return parseBackgroundExecutionState(
		(window as Window & { __FG_BACKGROUND__?: unknown }).__FG_BACKGROUND__,
	);
}

export function requestBackgroundExecutionState(): void {
	postToNative({ type: "getBackgroundExecution" });
}

export function setBackgroundExecution(enabled: boolean): void {
	postToNative({ type: "setBackgroundExecution", enabled });
}
