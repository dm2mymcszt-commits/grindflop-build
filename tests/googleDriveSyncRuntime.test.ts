import { describe, expect, test } from "bun:test";
import {
	refreshAfterGoogleDriveRemoteApply,
	type GoogleDriveRemoteApplyRefreshDependencies,
} from "../src/services/googleDriveSyncRuntime";

function dependencies(
	overrides: Partial<GoogleDriveRemoteApplyRefreshDependencies> = {},
): GoogleDriveRemoteApplyRefreshDependencies {
	return {
		isProfileReady: () => true,
		loadCaches: [],
		dispatchApplied: () => undefined,
		reportCacheError: () => undefined,
		...overrides,
	};
}

describe("Google Drive sync runtime", () => {
	test("an inactive profile performs no cache or UI work", async () => {
		const events: string[] = [];
		const refreshed = await refreshAfterGoogleDriveRemoteApply(
			42,
			dependencies({
				isProfileReady: () => false,
				loadCaches: [async () => void events.push("load")],
				dispatchApplied: () => events.push("dispatch"),
			}),
		);
		expect(refreshed).toBe(false);
		expect(events).toEqual([]);
	});

	test("cache failures are reported but do not hide a completed remote apply", async () => {
		const events: string[] = [];
		const failure = new Error("cache failed");
		const refreshed = await refreshAfterGoogleDriveRemoteApply(
			42,
			dependencies({
				loadCaches: [
					async () => void events.push("load:0"),
					async () => {
						events.push("load:1");
						throw failure;
					},
				],
				reportCacheError: (error, index) => {
					expect(error).toBe(failure);
					events.push(`error:${index}`);
				},
				dispatchApplied: (profileId) => events.push(`dispatch:${profileId}`),
			}),
		);
		expect(refreshed).toBe(true);
		expect(events.slice(0, 2).sort()).toEqual(["load:0", "load:1"]);
		expect(events.slice(2)).toEqual(["error:1", "dispatch:42"]);
	});

	test("a profile switch during cache reload suppresses stale UI notification", async () => {
		let ready = true;
		let finishLoad!: () => void;
		const loadStarted = new Promise<void>((resolve) => {
			finishLoad = resolve;
		});
		const dispatched: number[] = [];
		const refresh = refreshAfterGoogleDriveRemoteApply(
			42,
			dependencies({
				isProfileReady: () => ready,
				loadCaches: [() => loadStarted],
				dispatchApplied: (profileId) => dispatched.push(profileId),
			}),
		);
		ready = false;
		finishLoad();
		expect(await refresh).toBe(false);
		expect(dispatched).toEqual([]);
	});

	test("synchronous cache and event failures cannot fail the completed sync", async () => {
		const reported: number[] = [];
		const refreshed = await refreshAfterGoogleDriveRemoteApply(
			42,
			dependencies({
				loadCaches: [() => {
					throw new Error("sync loader failure");
				}],
				dispatchApplied: () => {
					throw new Error("listener failure");
				},
				reportCacheError: (_error, index) => void reported.push(index),
			}),
		);
		expect(refreshed).toBe(true);
		expect(reported).toEqual([0, 1]);
	});
});
