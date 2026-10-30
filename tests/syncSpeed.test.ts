import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
	importLegacySyncSpeedRun,
	listSyncSpeedRuns,
	recordSyncSpeedRun,
	setSyncSpeedDatabaseFactoryForTests,
	type SyncSpeedDatabase,
} from "../src/services/syncSpeedLog";
import {
	buildSyncSpeedReport,
	describePhases,
	formatSpeedUp,
	formatSyncDuration,
	legacyCycleTimingsToRun,
	median,
	summarizeSyncSpeed,
	type SyncSpeedRun,
} from "../src/utils/syncSpeedSummary";

const PROFILE = 920000003;

function run(overrides: Partial<SyncSpeedRun> = {}): SyncSpeedRun {
	return {
		profileId: PROFILE,
		engine: "v1",
		kind: "sync",
		trigger: "auto",
		startedAtMs: 1_000,
		waitedMs: 0,
		totalMs: 1_000,
		outcome: "ok",
		error: null,
		rowsChecked: null,
		changesFound: null,
		changesSent: null,
		changesReceived: null,
		driveFiles: null,
		bytesUp: null,
		phases: null,
		appVersion: null,
		platform: "windows",
		...overrides,
	};
}

const plainLabel = (
	_key: string,
	defaultValue: string,
	values?: Record<string, string | number>,
) =>
	defaultValue.replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
		String(values?.[name] ?? ""),
	);

describe("sync speed summary", () => {
	test("median handles odd, even and empty lists", () => {
		expect(median([])).toBeNull();
		expect(median([5, 1, 3])).toBe(3);
		expect(median([4, 1, 3, 2])).toBe(2.5);
	});

	test("compares the typical old sync with the typical new sync", () => {
		const summary = summarizeSyncSpeed([
			run({ totalMs: 240_000 }),
			run({ totalMs: 250_000 }),
			run({ totalMs: 260_000 }),
			// A failed run must not make the old engine look faster or slower.
			run({ totalMs: 5_000, outcome: "error", error: "auth" }),
			run({ engine: "v2", totalMs: 4_000 }),
			run({ engine: "v2", totalMs: 6_000 }),
			run({ engine: "v1", kind: "status", trigger: "open", totalMs: 30_000 }),
			run({ engine: "v2", kind: "status", trigger: "open", totalMs: 300 }),
		]);
		expect(summary.v1.syncRuns).toBe(3);
		expect(summary.v1.failedRuns).toBe(1);
		expect(summary.v1.medianMs).toBe(250_000);
		expect(summary.v1.fastestMs).toBe(240_000);
		expect(summary.v1.slowestMs).toBe(260_000);
		expect(summary.v2.medianMs).toBe(5_000);
		expect(summary.syncSpeedUp).toBe(50);
		expect(summary.statusSpeedUp).toBe(100);
	});

	test("no speed-up is claimed until both engines completed a sync", () => {
		const summary = summarizeSyncSpeed([
			run({ totalMs: 240_000 }),
			run({ engine: "v2", totalMs: 1_000, outcome: "error" }),
		]);
		expect(summary.syncSpeedUp).toBeNull();
	});

	test("formats durations the way the card shows them", () => {
		expect(formatSyncDuration(350)).toBe("350 ms");
		expect(formatSyncDuration(38_000)).toBe("38 s");
		expect(formatSyncDuration(252_253)).toBe("4 min 12 s");
		expect(formatSyncDuration(120_000)).toBe("2 min");
		expect(formatSyncDuration(3_780_000)).toBe("1 h 3 min");
		expect(formatSpeedUp(48.4)).toBe("48×");
	});

	test("turns the old engine's single remembered run into a history row", () => {
		// The real value on the PC, recorded 2026-10-17.
		const json = JSON.stringify({
			finishedAtMs: 1792259567445,
			totalMs: 252253,
			phases: { reconcile: { ms: 197889, calls: 1 }, upload: { ms: 30093, calls: 1 } },
		});
		const legacy = legacyCycleTimingsToRun(PROFILE, json, "windows");
		expect(legacy).not.toBeNull();
		expect(legacy?.engine).toBe("v1");
		expect(legacy?.trigger).toBe("imported");
		expect(legacy?.totalMs).toBe(252253);
		expect(legacy?.startedAtMs).toBe(1792259567445 - 252253);
		expect(legacy?.phases?.reconcile).toEqual({ ms: 197889, calls: 1 });
		expect(legacyCycleTimingsToRun(PROFILE, null, null)).toBeNull();
		expect(legacyCycleTimingsToRun(PROFILE, "{broken", null)).toBeNull();
		expect(legacyCycleTimingsToRun(PROFILE, '{"totalMs":5}', null)).toBeNull();
	});

	test("the copied report leads with the comparison", () => {
		const report = buildSyncSpeedReport(
			[
				run({ totalMs: 250_000, rowsChecked: 80_000 }),
				run({ engine: "v2", totalMs: 5_000, rowsChecked: 12, changesSent: 3 }),
			],
			plainLabel,
			"Windows PC",
		);
		const lines = report.split("\n");
		expect(lines[0]).toBe("GrindFlop sync speed");
		expect(lines[1]).toBe("Windows PC");
		expect(report).toContain("Old sync: 1 completed · 0 failed");
		expect(report).toContain("Typical everyday sync: 4 min 10 s");
		expect(report).toContain("New sync is 50× faster");
		expect(report).toContain("sent 3");
	});
});

function memoryDatabase(): SyncSpeedDatabase {
	const db = new Database(":memory:");
	return {
		async execute(query, bindValues = []) {
			db.query(query).run(...(bindValues as never[]));
		},
		async select<T>(query: string, bindValues: unknown[] = []) {
			return db.query(query).all(...(bindValues as never[])) as T;
		},
	};
}

describe("sync speed log", () => {
	afterEach(() => setSyncSpeedDatabaseFactoryForTests(null));

	test("keeps every run, newest first, per profile", async () => {
		const db = memoryDatabase();
		setSyncSpeedDatabaseFactoryForTests(async () => db);
		await recordSyncSpeedRun(run({ startedAtMs: 1_000, totalMs: 250_000, rowsChecked: 80_000 }));
		await recordSyncSpeedRun(run({ startedAtMs: 2_000, engine: "v2", totalMs: 4_000 }));
		await recordSyncSpeedRun(run({ profileId: 900000002, startedAtMs: 3_000 }));
		const runs = await listSyncSpeedRuns(PROFILE);
		expect(runs.map((entry) => entry.engine)).toEqual(["v2", "v1"]);
		expect(runs[1].rowsChecked).toBe(80_000);
		expect(runs[1].totalMs).toBe(250_000);
	});

	test("imports the old engine's remembered run only before live rows exist", async () => {
		const db = memoryDatabase();
		setSyncSpeedDatabaseFactoryForTests(async () => db);
		const legacy = run({ trigger: "imported", startedAtMs: 500, totalMs: 252_253 });
		await importLegacySyncSpeedRun(PROFILE, async () => legacy);
		// Same app run or a later one: never imported twice.
		await importLegacySyncSpeedRun(PROFILE, async () => legacy);
		await recordSyncSpeedRun(run({ startedAtMs: 1_000 }));
		// By now the remembered run is just the latest live run; skip it.
		await importLegacySyncSpeedRun(PROFILE, async () =>
			run({ trigger: "imported", startedAtMs: 900 }),
		);
		const runs = await listSyncSpeedRuns(PROFILE);
		expect(runs.filter((entry) => entry.trigger === "imported")).toHaveLength(1);
		expect(runs).toHaveLength(2);
	});

	test("a busy new engine never pushes out the old engine's rows", async () => {
		const db = memoryDatabase();
		setSyncSpeedDatabaseFactoryForTests(async () => db);
		await recordSyncSpeedRun(run({ startedAtMs: 1, totalMs: 250_000 }));
		for (let index = 0; index < 1_005; index += 1) {
			await recordSyncSpeedRun(run({ engine: "v2", startedAtMs: 10 + index }));
		}
		const runs = await listSyncSpeedRuns(PROFILE);
		expect(runs.filter((entry) => entry.engine === "v2")).toHaveLength(1_000);
		expect(runs.filter((entry) => entry.engine === "v1")).toHaveLength(1);
	});

	test("a failing database never throws into the sync", async () => {
		setSyncSpeedDatabaseFactoryForTests(async () => {
			throw new Error("disk full");
		});
		await expect(recordSyncSpeedRun(run())).resolves.toBeUndefined();
	});
});

describe("everyday syncs versus catch-ups", () => {
	test("a catch-up after reconnecting never counts as a typical sync", () => {
		// The PC on 2026-10-30: one everyday run, one 27-minute catch-up.
		const summary = summarizeSyncSpeed([
			run({ trigger: "imported", totalMs: 252_253 }),
			run({ trigger: "connect", totalMs: 1_653_645 }),
			run({ engine: "v2", trigger: "auto", totalMs: 5_000 }),
			run({ engine: "v2", trigger: "pairing", totalMs: 60_000 }),
		]);
		expect(summary.v1.medianMs).toBe(252_253);
		expect(summary.v1.everydayRuns).toBe(1);
		expect(summary.v1.catchUpRuns).toBe(1);
		expect(summary.v1.longestCatchUpMs).toBe(1_653_645);
		expect(summary.v2.medianMs).toBe(5_000);
		expect(summary.syncSpeedUp).toBeCloseTo(50.45, 1);
	});

	test("the report says where each run spent its time, and why one failed", () => {
		const report = buildSyncSpeedReport(
			[
				run({
					engine: "v2",
					totalMs: 3_000,
					phases: {
						reconcileChanges: { ms: 400, calls: 1 },
						inventory: { ms: 2_100, calls: 3 },
						apply: { ms: 5, calls: 1 },
					},
				}),
				run({
					startedAtMs: 500,
					totalMs: 90_000,
					outcome: "error",
					error: "Google authorization is no longer valid; reconnect this device",
				}),
			],
			plainLabel,
			null,
		);
		// The decimal separator follows the system locale (a comma on a French PC).
		expect(report).toMatch(/\n {4}inventory 2[.,]1 s, reconcileChanges 400 ms\n/);
		expect(report).not.toContain("apply");
		expect(report).toContain("    error: Google authorization is no longer valid");
	});

	test("phases under a tenth of a second are left out", () => {
		expect(describePhases(null)).toBeNull();
		expect(describePhases({ apply: { ms: 7, calls: 2 } })).toBeNull();
	});

	test("a remembered run written by the new engine is not a before measurement", () => {
		const json = JSON.stringify({ engine: "v2", finishedAtMs: 5_000, totalMs: 1_000, phases: {} });
		expect(legacyCycleTimingsToRun(PROFILE, json, "windows")).toBeNull();
		const old = JSON.stringify({ finishedAtMs: 5_000, totalMs: 1_000, phases: {} });
		expect(legacyCycleTimingsToRun(PROFILE, old, "windows")?.engine).toBe("v1");
	});
});
