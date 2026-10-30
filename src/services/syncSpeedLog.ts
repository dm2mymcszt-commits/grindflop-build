import { isTauri } from "@tauri-apps/api/core";
import Database from "@tauri-apps/plugin-sql";
import { appLog } from "../utils/logger";
import type {
	SyncSpeedEngine,
	SyncSpeedKind,
	SyncSpeedOutcome,
	SyncSpeedPhase,
	SyncSpeedRun,
	SyncSpeedTrigger,
} from "../utils/syncSpeedSummary";

/**
 * Durable history of how long each Google Drive sync took on this device, for
 * the before/after comparison on the sync card.
 *
 * Its own file on purpose: the sync engine's database belongs to the engine
 * being replaced, and this history has to outlive it. Device-local, never
 * synced, never backed up. Writes are best effort and can never fail a sync.
 */

const DATABASE_URL = "sqlite:sync-speed.sqlite3";
/**
 * Kept per profile, engine and kind, so a busy new engine (one row every five
 * minutes on the PC) never pushes the old engine's "before" rows out.
 */
const KEEP_PER_GROUP = 1_000;

export const SYNC_SPEED_UPDATED_EVENT = "fg:sync-speed-updated";

export interface SyncSpeedDatabase {
	execute(query: string, bindValues?: unknown[]): Promise<unknown>;
	select<T>(query: string, bindValues?: unknown[]): Promise<T>;
}

type DatabaseFactory = () => Promise<SyncSpeedDatabase>;

const defaultFactory: DatabaseFactory = async () =>
	(await Database.load(DATABASE_URL)) as unknown as SyncSpeedDatabase;

let factory: DatabaseFactory = defaultFactory;
let enabledOverride: boolean | null = null;
let databasePromise: Promise<SyncSpeedDatabase> | null = null;
let writeChain: Promise<void> = Promise.resolve();

/** Tests only: an in-memory database, or null to restore the real one. */
export function setSyncSpeedDatabaseFactoryForTests(next: DatabaseFactory | null): void {
	factory = next ?? defaultFactory;
	enabledOverride = next ? true : null;
	databasePromise = null;
	writeChain = Promise.resolve();
}

function enabled(): boolean {
	return enabledOverride ?? isTauri();
}

function openDatabase(): Promise<SyncSpeedDatabase> {
	if (!databasePromise) {
		databasePromise = (async () => {
			const db = await factory();
			await db.execute(`
				CREATE TABLE IF NOT EXISTS sync_speed_runs (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					profile_id INTEGER NOT NULL,
					engine TEXT NOT NULL,
					kind TEXT NOT NULL,
					trigger TEXT NOT NULL,
					started_at_ms INTEGER NOT NULL,
					waited_ms INTEGER,
					total_ms INTEGER NOT NULL,
					outcome TEXT NOT NULL,
					error TEXT,
					rows_checked INTEGER,
					changes_found INTEGER,
					changes_sent INTEGER,
					changes_received INTEGER,
					drive_files INTEGER,
					bytes_up INTEGER,
					phases_json TEXT,
					app_version TEXT,
					platform TEXT
				)
			`);
			await db.execute(
				`CREATE INDEX IF NOT EXISTS sync_speed_runs_group
				 ON sync_speed_runs(profile_id, engine, kind, id)`,
			);
			return db;
		})().catch((error) => {
			databasePromise = null;
			throw error;
		});
	}
	return databasePromise;
}

function announce(profileId: number): void {
	if (typeof window === "undefined") return;
	window.dispatchEvent(
		new CustomEvent(SYNC_SPEED_UPDATED_EVENT, { detail: { profileId } }),
	);
}

function wholeOrNull(value: number | null): number | null {
	return value == null || !Number.isFinite(value) ? null : Math.round(value);
}

async function insertRun(db: SyncSpeedDatabase, run: SyncSpeedRun): Promise<void> {
	await db.execute(
		`INSERT INTO sync_speed_runs (
			profile_id, engine, kind, trigger, started_at_ms, waited_ms, total_ms,
			outcome, error, rows_checked, changes_found, changes_sent,
			changes_received, drive_files, bytes_up, phases_json, app_version, platform
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			run.profileId,
			run.engine,
			run.kind,
			run.trigger,
			Math.round(run.startedAtMs),
			wholeOrNull(run.waitedMs),
			Math.max(0, Math.round(run.totalMs)),
			run.outcome,
			run.error ? run.error.slice(0, 500) : null,
			wholeOrNull(run.rowsChecked),
			wholeOrNull(run.changesFound),
			wholeOrNull(run.changesSent),
			wholeOrNull(run.changesReceived),
			wholeOrNull(run.driveFiles),
			wholeOrNull(run.bytesUp),
			run.phases ? JSON.stringify(run.phases) : null,
			run.appVersion,
			run.platform,
		],
	);
	await db.execute(
		`DELETE FROM sync_speed_runs
		 WHERE profile_id = ? AND engine = ? AND kind = ? AND id NOT IN (
			SELECT id FROM sync_speed_runs
			WHERE profile_id = ? AND engine = ? AND kind = ?
			ORDER BY id DESC LIMIT ?
		 )`,
		[
			run.profileId,
			run.engine,
			run.kind,
			run.profileId,
			run.engine,
			run.kind,
			KEEP_PER_GROUP,
		],
	);
}

function queueWrite(profileId: number, write: (db: SyncSpeedDatabase) => Promise<boolean>): Promise<void> {
	if (!enabled()) return Promise.resolve();
	writeChain = writeChain
		.then(async () => {
			const db = await openDatabase();
			if (await write(db)) announce(profileId);
		})
		.catch((error) => {
			appLog.warn("[SyncSpeed] could not record a sync run", error);
		});
	return writeChain;
}

/** Best effort, never throws: a failed write only loses that one row. */
export function recordSyncSpeedRun(run: SyncSpeedRun): Promise<void> {
	return queueWrite(run.profileId, async (db) => {
		await insertRun(db, run);
		return true;
	});
}

/**
 * Adds the old engine's single remembered run, but only while this profile has
 * no old-engine sync row yet. Once live rows exist, that remembered run is just
 * the latest of them and importing it would count it twice. Queued like any
 * write, so a caller that queues this before the first live row wins the race.
 */
export function importLegacySyncSpeedRun(
	profileId: number,
	load: () => Promise<SyncSpeedRun | null>,
): Promise<void> {
	return queueWrite(profileId, async (db) => {
		const existing = await db.select<Array<{ id: number }>>(
			`SELECT id FROM sync_speed_runs
			 WHERE profile_id = ? AND engine = 'v1' AND kind = 'sync'
			 LIMIT 1`,
			[profileId],
		);
		if (existing.length > 0) return false;
		const run = await load();
		if (!run || run.profileId !== profileId) return false;
		await insertRun(db, run);
		return true;
	});
}

interface SyncSpeedRow {
	id: number;
	profile_id: number;
	engine: string;
	kind: string;
	trigger: string;
	started_at_ms: number;
	waited_ms: number | null;
	total_ms: number;
	outcome: string;
	error: string | null;
	rows_checked: number | null;
	changes_found: number | null;
	changes_sent: number | null;
	changes_received: number | null;
	drive_files: number | null;
	bytes_up: number | null;
	phases_json: string | null;
	app_version: string | null;
	platform: string | null;
}

function parsePhases(json: string | null): Record<string, SyncSpeedPhase> | null {
	if (!json) return null;
	try {
		const parsed = JSON.parse(json) as unknown;
		return parsed && typeof parsed === "object"
			? (parsed as Record<string, SyncSpeedPhase>)
			: null;
	} catch {
		return null;
	}
}

function rowToRun(row: SyncSpeedRow): SyncSpeedRun {
	return {
		id: row.id,
		profileId: row.profile_id,
		engine: row.engine as SyncSpeedEngine,
		kind: row.kind as SyncSpeedKind,
		trigger: row.trigger as SyncSpeedTrigger,
		startedAtMs: row.started_at_ms,
		waitedMs: row.waited_ms,
		totalMs: row.total_ms,
		outcome: row.outcome as SyncSpeedOutcome,
		error: row.error,
		rowsChecked: row.rows_checked,
		changesFound: row.changes_found,
		changesSent: row.changes_sent,
		changesReceived: row.changes_received,
		driveFiles: row.drive_files,
		bytesUp: row.bytes_up,
		phases: parsePhases(row.phases_json),
		appVersion: row.app_version,
		platform: row.platform,
	};
}

/** Newest first. Waits for queued writes so a just-finished run is included. */
export async function listSyncSpeedRuns(profileId: number): Promise<SyncSpeedRun[]> {
	if (!enabled()) return [];
	await writeChain;
	const db = await openDatabase();
	const rows = await db.select<SyncSpeedRow[]>(
		`SELECT * FROM sync_speed_runs WHERE profile_id = ?
		 ORDER BY started_at_ms DESC, id DESC`,
		[profileId],
	);
	return rows.map(rowToRun);
}
