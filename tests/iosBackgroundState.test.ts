import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseBackgroundExecutionState } from "../src/utils/backgroundExecution";

// Exercises the production Objective-C dictionary + Foundation JSON encoder,
// then the actual frontend parser. Handwritten JS fixtures missed JSON 0/1.
test.skipIf(process.platform !== "darwin")("native background reports reach the frontend as booleans", () => {
	const temporary = mkdtempSync(join(tmpdir(), "grindflop-background-state-"));
	try {
		const root = resolve(import.meta.dir, "..");
		const executable = join(temporary, "background-state");
		const compile = Bun.spawnSync([
			"xcrun", "clang", "-fobjc-arc", "-framework", "Foundation",
			join(root, "tests/ios_background_state.m"),
			join(root, "src-tauri/ios-keyboard-fix/ios/BackgroundRuntime/FGBackgroundState.m"),
			"-o", executable,
		]);
		if (compile.exitCode !== 0) throw new Error(compile.stderr.toString());
		const run = Bun.spawnSync([executable]);
		expect(run.exitCode).toBe(0);
		const { reports: payloads, legacy } = JSON.parse(run.stdout.toString());
		expect(legacy).toEqual({ supported: 1, enabled: 0, failure: "" });
		expect(parseBackgroundExecutionState(legacy)).toBeNull();
		expect(payloads).toHaveLength(4);
		const states = payloads.map((payload: unknown) => parseBackgroundExecutionState(payload));
		for (const state of states) expect(state).not.toBeNull();
		expect(states.map((state: { supported: boolean }) => state.supported)).toEqual([true, true, false, true]);
		expect(states.map((state: { enabled: boolean }) => state.enabled)).toEqual([false, true, false, false]);
		expect(states[2].failure).toBe("entitlement-missing");
		expect(states[3].detail).toBe("RunningBoard (1)");
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
}, 30_000);
