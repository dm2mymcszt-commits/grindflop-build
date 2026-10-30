/**
 * Before/after proof for Google Drive sync speed. Pure: the runs come from
 * services/syncSpeedLog.ts, and nothing here touches storage or the UI.
 *
 * "v1" is the original sync engine, "v2" its rewrite. Both write the same kind
 * of row, so the two can be compared on the same device and the same data.
 */

export type SyncSpeedEngine = "v1" | "v2";
/** A full sync, or the wait until the sync card could show the status. */
export type SyncSpeedKind = "sync" | "status";
export type SyncSpeedTrigger =
	| "auto"
	| "manual"
	| "connect"
	| "pairing"
	| "open"
	| "imported";
export type SyncSpeedOutcome = "ok" | "error" | "cancelled";

export interface SyncSpeedPhase {
	ms: number;
	calls: number;
}

export interface SyncSpeedRun {
	id?: number;
	profileId: number;
	engine: SyncSpeedEngine;
	kind: SyncSpeedKind;
	trigger: SyncSpeedTrigger;
	startedAtMs: number;
	/** Time spent queued behind other sync work before this run could start. */
	waitedMs: number | null;
	totalMs: number;
	outcome: SyncSpeedOutcome;
	error: string | null;
	/** Saved rows the run had to look at to find what changed. */
	rowsChecked: number | null;
	/** Of those, rows that had changed since the last sync. */
	changesFound: number | null;
	changesSent: number | null;
	changesReceived: number | null;
	/** Files the run listed in Google Drive. */
	driveFiles: number | null;
	bytesUp: number | null;
	phases: Record<string, SyncSpeedPhase> | null;
	appVersion: string | null;
	platform: string | null;
}

export interface SyncSpeedEngineSummary {
	engine: SyncSpeedEngine;
	/** Completed syncs, everyday and catch-up. */
	syncRuns: number;
	failedRuns: number;
	/** Everyday syncs only (see isEverydaySync): what "typical" means. */
	everydayRuns: number;
	medianMs: number | null;
	fastestMs: number | null;
	slowestMs: number | null;
	medianWaitMs: number | null;
	medianRowsChecked: number | null;
	/** Syncs right after connecting or pairing, which carry a whole backlog. */
	catchUpRuns: number;
	longestCatchUpMs: number | null;
	statusRuns: number;
	medianStatusMs: number | null;
	firstAtMs: number | null;
	lastAtMs: number | null;
}

/**
 * Automatic syncs, Sync now, and the old engine's remembered run. A sync
 * right after connecting or pairing is a catch-up: its time depends on how
 * long the device was away, not on the engine, and one of them (27 minutes
 * on the PC on 2026-10-30) made "typical" meaningless when mixed in.
 */
export function isEverydaySync(run: SyncSpeedRun): boolean {
	return run.trigger === "auto" || run.trigger === "manual" || run.trigger === "imported";
}

export interface SyncSpeedSummary {
	v1: SyncSpeedEngineSummary;
	v2: SyncSpeedEngineSummary;
	/** How many times faster v2's typical sync is than v1's; null until both ran. */
	syncSpeedUp: number | null;
	/** Same for the wait until the card shows the status. */
	statusSpeedUp: number | null;
}

export function median(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1
		? sorted[middle]
		: (sorted[middle - 1] + sorted[middle]) / 2;
}

function summarizeEngine(
	runs: readonly SyncSpeedRun[],
	engine: SyncSpeedEngine,
): SyncSpeedEngineSummary {
	const own = runs.filter((run) => run.engine === engine);
	const syncs = own.filter((run) => run.kind === "sync");
	const completed = syncs.filter((run) => run.outcome === "ok");
	const failed = syncs.filter((run) => run.outcome === "error");
	const everyday = completed.filter(isEverydaySync);
	const catchUps = completed.filter((run) => !isEverydaySync(run));
	const statuses = own.filter(
		(run) => run.kind === "status" && run.outcome === "ok",
	);
	const durations = everyday.map((run) => run.totalMs);
	const waits = everyday
		.map((run) => run.waitedMs)
		.filter((value): value is number => value != null);
	const rows = everyday
		.map((run) => run.rowsChecked)
		.filter((value): value is number => value != null);
	const catchUpDurations = catchUps.map((run) => run.totalMs);
	const times = own.map((run) => run.startedAtMs);
	return {
		engine,
		syncRuns: completed.length,
		failedRuns: failed.length,
		everydayRuns: everyday.length,
		medianMs: median(durations),
		fastestMs: durations.length ? Math.min(...durations) : null,
		slowestMs: durations.length ? Math.max(...durations) : null,
		medianWaitMs: median(waits),
		medianRowsChecked: median(rows),
		catchUpRuns: catchUps.length,
		longestCatchUpMs: catchUpDurations.length ? Math.max(...catchUpDurations) : null,
		statusRuns: statuses.length,
		medianStatusMs: median(statuses.map((run) => run.totalMs)),
		firstAtMs: times.length ? Math.min(...times) : null,
		lastAtMs: times.length ? Math.max(...times) : null,
	};
}

function ratio(before: number | null, after: number | null): number | null {
	if (before == null || after == null) return null;
	// A sub-millisecond run would otherwise turn into an absurd or infinite ratio.
	return before / Math.max(after, 1);
}

export function summarizeSyncSpeed(runs: readonly SyncSpeedRun[]): SyncSpeedSummary {
	const v1 = summarizeEngine(runs, "v1");
	const v2 = summarizeEngine(runs, "v2");
	return {
		v1,
		v2,
		syncSpeedUp: ratio(v1.medianMs, v2.medianMs),
		statusSpeedUp: ratio(v1.medianStatusMs, v2.medianStatusMs),
	};
}

function formatNumber(value: number, maximumFractionDigits: number): string {
	return new Intl.NumberFormat(undefined, { maximumFractionDigits }).format(value);
}

/** "350 ms", "4.2 s", "38 s", "4 min 12 s", "1 h 3 min". */
export function formatSyncDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "—";
	if (ms < 1_000) return `${Math.round(ms)} ms`;
	if (ms < 10_000) return `${formatNumber(ms / 1_000, 1)} s`;
	const totalSeconds = Math.round(ms / 1_000);
	if (totalSeconds < 60) return `${totalSeconds} s`;
	const totalMinutes = Math.floor(totalSeconds / 60);
	if (totalMinutes < 60) {
		const seconds = totalSeconds % 60;
		return seconds ? `${totalMinutes} min ${seconds} s` : `${totalMinutes} min`;
	}
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return minutes ? `${hours} h ${minutes} min` : `${hours} h`;
}

/** "48×", "3.5×". Below 10 keeps one decimal so small gains stay visible. */
export function formatSpeedUp(value: number): string {
	return `${formatNumber(value, value < 10 ? 1 : 0)}×`;
}

export type SyncSpeedLabel = (
	key: string,
	defaultValue: string,
	values?: Record<string, string | number>,
) => string;

function engineLines(
	summary: SyncSpeedEngineSummary,
	name: string,
	label: SyncSpeedLabel,
): string[] {
	if (summary.syncRuns === 0 && summary.failedRuns === 0 && summary.statusRuns === 0) {
		return [
			`${name}: ${label("data_backup.drive_sync.speed.no_runs", "No runs yet")}`,
		];
	}
	const lines = [
		`${name}: ${label(
			"data_backup.drive_sync.speed.runs",
			"{{ok}} completed · {{failed}} failed",
			{ ok: summary.syncRuns, failed: summary.failedRuns },
		)}`,
	];
	if (summary.medianMs != null) {
		lines.push(
			`  ${label("data_backup.drive_sync.speed.typical", "Typical everyday sync")}: ${formatSyncDuration(summary.medianMs)}` +
				` (${label("data_backup.drive_sync.speed.range", "{{fastest}} to {{slowest}}", {
					fastest: formatSyncDuration(summary.fastestMs ?? 0),
					slowest: formatSyncDuration(summary.slowestMs ?? 0),
				})})`,
		);
	}
	if (summary.longestCatchUpMs != null) {
		lines.push(
			`  ${label(
				"data_backup.drive_sync.speed.catch_up_line",
				"Catch-up after reconnecting: {{duration}} at most ({{count}})",
				{
					duration: formatSyncDuration(summary.longestCatchUpMs),
					count: summary.catchUpRuns,
				},
			)}`,
		);
	}
	if (summary.medianRowsChecked != null) {
		lines.push(
			`  ${label("data_backup.drive_sync.speed.rows_per_sync", "{{count}} rows checked per sync", { count: formatNumber(summary.medianRowsChecked, 0) })}`,
		);
	}
	if (summary.medianStatusMs != null) {
		lines.push(
			`  ${label("data_backup.drive_sync.speed.status_line", "Status ready in {{duration}}", { duration: formatSyncDuration(summary.medianStatusMs) })}`,
		);
	}
	return lines;
}

function formatStamp(ms: number): string {
	const date = new Date(ms);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Plain-text report for the Copy button: summary first, then each run. */
export function buildSyncSpeedReport(
	runs: readonly SyncSpeedRun[],
	label: SyncSpeedLabel,
	deviceName: string | null,
	maxRuns = 50,
): string {
	const summary = summarizeSyncSpeed(runs);
	const oldName = label("data_backup.drive_sync.speed.engine_v1", "Old sync");
	const newName = label("data_backup.drive_sync.speed.engine_v2", "New sync");
	const lines = [
		label("data_backup.drive_sync.speed.report_title", "GrindFlop sync speed"),
	];
	if (deviceName) lines.push(deviceName);
	lines.push("", ...engineLines(summary.v1, oldName, label));
	lines.push(...engineLines(summary.v2, newName, label));
	if (summary.syncSpeedUp != null) {
		lines.push(
			"",
			label(
				"data_backup.drive_sync.speed.speed_up",
				"New sync is {{factor}} faster",
				{ factor: formatSpeedUp(summary.syncSpeedUp) },
			),
		);
	}
	const sorted = [...runs].sort((a, b) => b.startedAtMs - a.startedAtMs).slice(0, maxRuns);
	if (sorted.length > 0) lines.push("");
	for (const run of sorted) {
		const parts = [
			formatStamp(run.startedAtMs),
			run.engine === "v1" ? oldName : newName,
			run.kind === "status"
				? label("data_backup.drive_sync.speed.kind_status", "card ready")
				: run.trigger,
			formatSyncDuration(run.totalMs),
			run.outcome,
		];
		if (run.rowsChecked != null) parts.push(`rows ${run.rowsChecked}`);
		if (run.changesSent != null) parts.push(`sent ${run.changesSent}`);
		if (run.changesReceived != null) parts.push(`received ${run.changesReceived}`);
		if (run.waitedMs) parts.push(`waited ${formatSyncDuration(run.waitedMs)}`);
		lines.push(parts.join(" · "));
		const phases = describePhases(run.phases);
		if (phases) lines.push(`    ${phases}`);
		if (run.outcome === "error" && run.error) lines.push(`    error: ${run.error}`);
	}
	return lines.join("\n");
}

/**
 * Where a run's time went, slowest step first, skipping anything under a
 * tenth of a second. Step names are the engine's own (reconcile, inventory,
 * apply, upload, ...): this is for diagnosing, not for display on the card.
 */
export function describePhases(
	phases: Readonly<Record<string, SyncSpeedPhase>> | null,
): string | null {
	if (!phases) return null;
	const parts = Object.entries(phases)
		.filter(([, phase]) => phase.ms >= 100)
		.sort(([, left], [, right]) => right.ms - left.ms)
		.map(([name, phase]) => `${name} ${formatSyncDuration(phase.ms)}`);
	return parts.length ? parts.join(", ") : null;
}

/**
 * The old engine kept only its last run, as `sync_meta.last_cycle_timings`
 * (`{finishedAtMs, totalMs, phases}`). Turned into a row so the history starts
 * with a real "before" measurement instead of waiting for the next sync.
 */
export function legacyCycleTimingsToRun(
	profileId: number,
	json: string | null,
	platform: string | null,
): SyncSpeedRun | null {
	if (!json) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const value = parsed as {
		engine?: unknown;
		finishedAtMs?: unknown;
		totalMs?: unknown;
		phases?: unknown;
	};
	// The old engine never wrote this field. A value that has it was written by
	// a newer engine and is not a "before" measurement.
	if (value.engine !== undefined && value.engine !== "v1") return null;
	if (
		typeof value.finishedAtMs !== "number" ||
		typeof value.totalMs !== "number" ||
		!Number.isFinite(value.finishedAtMs) ||
		!Number.isFinite(value.totalMs) ||
		value.totalMs < 0
	) {
		return null;
	}
	const phases: Record<string, SyncSpeedPhase> = {};
	if (value.phases && typeof value.phases === "object") {
		for (const [name, phase] of Object.entries(value.phases as Record<string, unknown>)) {
			const entry = phase as { ms?: unknown; calls?: unknown } | null;
			if (entry && typeof entry.ms === "number" && typeof entry.calls === "number") {
				phases[name] = { ms: entry.ms, calls: entry.calls };
			}
		}
	}
	return {
		profileId,
		engine: "v1",
		kind: "sync",
		trigger: "imported",
		startedAtMs: value.finishedAtMs - value.totalMs,
		waitedMs: null,
		totalMs: value.totalMs,
		outcome: "ok",
		error: null,
		rowsChecked: null,
		changesFound: null,
		changesSent: null,
		changesReceived: null,
		driveFiles: null,
		bytesUp: null,
		phases,
		appVersion: null,
		platform,
	};
}
