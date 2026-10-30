import { describe, expect, test } from "bun:test";
import { backgroundExecutionResponse, backgroundExecutionStatus, parseBackgroundExecutionState } from "../src/utils/backgroundExecution";

describe("native background execution acknowledgement", () => {
	test("JSON numbers from Objective-C are reported as a malformed reply, not a timeout", () => {
		const reply = { supported: 1, enabled: 0, failure: "" };
		expect(parseBackgroundExecutionState(reply)).toBeNull();
		const state = backgroundExecutionResponse(reply);
		expect(state.enabled).toBe(false);
		expect(state.failure).toBe("invalid-native-response");
		expect(state.detail).toBe("supported=number; enabled=number; failure=string");
		expect(backgroundExecutionStatus(state, false, false)).toBe("background_execution_invalid_response");
	});
	test("a missing native response is not reported as an unsupported installation", () => {
		expect(backgroundExecutionStatus(null, true, false)).toBe("background_execution_pending");
		expect(backgroundExecutionStatus(null, false, true)).toBe("background_execution_no_response");
	});
	test("unreadable and missing permissions have different explanations", () => {
		for (const [failure, message] of [
			["entitlement-read", "background_execution_entitlement_read"],
			["entitlement-missing", "background_execution_entitlement_missing"],
			["security-api", "background_execution_security_api"],
			["runningboard-api", "background_execution_system_api"],
			["webkit-api", "background_execution_webkit_api"],
		]) {
			const state = parseBackgroundExecutionState({ supported: false, enabled: false, failure,
				detail: "failed check", systemVersion: "17.0" });
			expect(backgroundExecutionStatus(state, false, false)).toBe(message);
			expect(state?.detail).toBe("failed check");
		}
	});
	test("a timed out request does not display a cached enabled state", () => {
		const state = parseBackgroundExecutionState({ supported: true, enabled: true, failure: "" });
		expect(backgroundExecutionStatus(state, false, true)).toBe("background_execution_no_response");
	});
	test("missing and old native reports cannot turn the setting on", () => {
		for (const report of [
			null,
			{},
			{ enabled: true },
			{ supported: true, enabled: "true", failure: "" },
		]) {
			expect(parseBackgroundExecutionState(report)).toBeNull();
		}
	});
	test("a denied or revoked assertion cannot be shown as running", () => {
		for (const failure of ["denied", "revoked", "unsupported", "unavailable"]) {
			expect(
				parseBackgroundExecutionState({
					supported: true,
					enabled: true,
					failure,
				})?.enabled,
			).toBe(false);
		}
		expect(
			parseBackgroundExecutionState({
				supported: false,
				enabled: true,
				failure: "",
			})?.enabled,
		).toBe(false);
	});
	test("a successful native acquisition and a subsequent release are reflected", () => {
		expect(
			parseBackgroundExecutionState({
				supported: true,
				enabled: true,
				failure: "",
			})?.enabled,
		).toBe(true);
		expect(
			parseBackgroundExecutionState({
				supported: true,
				enabled: false,
				failure: "",
			})?.enabled,
		).toBe(false);
	});
});
