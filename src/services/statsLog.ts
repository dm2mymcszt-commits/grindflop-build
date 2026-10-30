/**
 * Stats logs: the few facts the Stats page needs that nothing else in the
 * app keeps — why a block happened, where the account was, when a device
 * was actually recording views, how far away each viewer was, what changed
 * on your own profile, and whose profile you opened.
 *
 * Every writer here rides on something that is already happening (a block,
 * a location change, a view sweep, a profile save, a profile open). There
 * are no timers and no requests of its own. Nothing is recorded while Stats
 * is switched off, and a failed write is logged and dropped rather than
 * thrown into the action it was recording.
 *
 * The rows live in the active account's chat database and sync through
 * Google Drive with it. Ids start with the writing device's id, so two
 * devices never overwrite each other's rows; when both record the same
 * event (both ran the scanner and blocked the same person), the page
 * collapses them when it counts. Viewer distances are the exception: they
 * are keyed by Grindr's own view time, so both devices write the same row.
 */

import { getDeviceId, getDeviceName } from "./backupPeers";
import * as chatDb from "./chatDb";
import { appLog } from "../utils/logger";
import {
	geohashCenter,
	isSameStatsPlace,
	PROFILE_OPEN_COLLAPSE_MS,
	resolveBlockReason,
	selectLoggableViewDistances,
	statsHourStart,
	type StatsBlockReason,
	type ViewDistanceCandidate,
} from "../utils/statsLogRules";

export type { StatsBlockReason } from "../utils/statsLogRules";

// ---------------------------------------------------------------------------
// The Stats switch
// ---------------------------------------------------------------------------

/** Per account and synced, so switching Stats on once covers every device. */
const STATS_SETTING_KEY = "stats";
export const STATS_SETTINGS_UPDATED_EVENT = "fg:stats-settings-updated";

type StatsSettings = { enabled: boolean };

let settings: StatsSettings = { enabled: false };
let settingsAccount: number | null = null;

function dispatchSettingsUpdated(): void {
	if (typeof window === "undefined") return;
	window.dispatchEvent(new Event(STATS_SETTINGS_UPDATED_EVENT));
}

/** Runs on sign-in, on account switch, and after Google Drive applies changes. */
export async function loadStatsSettingsCache(): Promise<void> {
	const account = chatDb.getActiveChatDbUser();
	try {
		const stored = await chatDb.getSetting<Partial<StatsSettings>>(STATS_SETTING_KEY);
		settings = { enabled: stored?.enabled === true };
	} catch {
		settings = { enabled: false };
	}
	// Nothing remembered about another account's hours or visits applies here.
	if (account !== settingsAccount) {
		settingsAccount = account;
		recordedHours.clear();
		recentOpens.clear();
		loggedViewDistances.clear();
	}
	dispatchSettingsUpdated();
}

export function isStatsEnabled(): boolean {
	return settings.enabled;
}

export async function setStatsEnabled(enabled: boolean): Promise<void> {
	const previous = settings;
	settings = { enabled };
	dispatchSettingsUpdated();
	try {
		await chatDb.setSetting(STATS_SETTING_KEY, settings);
	} catch (error) {
		settings = previous;
		dispatchSettingsUpdated();
		throw error;
	}
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

function thisDevice(): { device_id: string; device_name: string } {
	return { device_id: getDeviceId(), device_name: getDeviceName() };
}

function write(table: chatDb.StatsLogTable, row: Record<string, unknown>): Promise<void> {
	return chatDb.insertStatsLogRow(table, row).catch((error) => {
		appLog.warn(`[stats-log] could not write to ${table}`, error);
	});
}

// ---------------------------------------------------------------------------
// Blocks and unblocks
// ---------------------------------------------------------------------------

export type StatsBlockSource =
	| "inbox_scan"
	| "inbox_filter"
	| "view_scan"
	| "live_chat"
	| "automation"
	| "counter_block"
	| "manual"
	| "multi_select"
	| "unblock_all";

/** What an automatic blocker passes along so its block is logged with a reason. */
export type StatsAutoBlockContext = {
	source: StatsBlockSource;
	reason?: StatsBlockReason | null;
};

export function logBlockEvent(input: {
	eventType: "block" | "unblock";
	profileId: string | null;
	method: "auto" | "manual";
	source: StatsBlockSource;
	reason?: StatsBlockReason | null;
}): void {
	if (!settings.enabled) return;
	try {
		const now = Date.now();
		const device = thisDevice();
		const reason = input.reason ?? null;
		const classified =
			input.eventType === "block" && input.method === "auto" && reason
				? resolveBlockReason(reason)
				: null;
		void write("stats_block_log", {
			id: `${device.device_id}:${now}:${input.eventType}:${input.profileId ?? "all"}`,
			event_type: input.eventType,
			profile_id: input.profileId,
			timestamp: now,
			method: input.method,
			source: input.source,
			reason_kind:
				classified?.kind ??
				(input.eventType === "block" && input.method === "auto" ? "other" : null),
			reason_detail: classified?.detail ?? null,
			reason_label: reason?.label ?? null,
			rule_id: reason?.ruleId ?? null,
			rule_name: reason?.ruleName ?? null,
			created_at: now,
			...device,
		});
	} catch (error) {
		appLog.warn("[stats-log] could not record a block", error);
	}
}

/** Shorthand for the automatic blockers, called once their block succeeded. */
export function logAutoBlock(profileId: string, context: StatsAutoBlockContext | undefined): void {
	logBlockEvent({
		eventType: "block",
		profileId,
		method: "auto",
		source: context?.source ?? "inbox_scan",
		reason: context?.reason ?? null,
	});
}

// ---------------------------------------------------------------------------
// Location
// ---------------------------------------------------------------------------

let locationQueue: Promise<void> = Promise.resolve();

/**
 * Records a new location for the account, when it is a real move. Compared
 * against the newest entry from any device, read fresh every time: a move
 * synced in from another device has to count, or returning to a place this
 * device already logged would be skipped.
 */
export function logLocationChange(input: {
	geohash: string | null | undefined;
	name: string | null | undefined;
	automatic: boolean;
}): void {
	if (!settings.enabled || !input.geohash) return;
	const geohash = input.geohash;
	const name = input.name?.trim() || null;
	locationQueue = locationQueue
		.then(async () => {
			if (!settings.enabled) return;
			const latest = await chatDb.getLatestStatsLocation();
			if (latest && isSameStatsPlace(latest.geohash, geohash)) return;
			const now = Date.now();
			const device = thisDevice();
			const center = geohashCenter(geohash);
			await write("stats_location_log", {
				id: `${device.device_id}:${now}`,
				timestamp: now,
				geohash,
				lat: center?.lat ?? null,
				lon: center?.lon ?? null,
				name,
				automatic: input.automatic ? 1 : 0,
				created_at: now,
				...device,
			});
		})
		.catch((error) => {
			appLog.warn("[stats-log] could not record a location change", error);
		});
}

// ---------------------------------------------------------------------------
// Recording coverage
// ---------------------------------------------------------------------------

/** Hours already written this session, as `${account}:${hourStart}`. */
const recordedHours = new Set<string>();

/**
 * Marks the current hour as one this device was recording views in. Called
 * after a successful views fetch, so an hour with no entry is an hour in
 * which views were not being collected here — which is what lets the page
 * tell "fewer views" apart from "the app was closed". One row per device
 * per hour, written once.
 */
export function markStatsRecording(source: "view_scan" | "interest_page"): void {
	if (!settings.enabled) return;
	try {
		const now = Date.now();
		const hourStart = statsHourStart(now);
		const key = `${chatDb.getActiveChatDbUser()}:${hourStart}`;
		if (recordedHours.has(key)) return;
		if (recordedHours.size > 48) recordedHours.clear();
		recordedHours.add(key);
		const device = thisDevice();
		void chatDb
			.insertStatsLogRow("stats_coverage_log", {
				id: `${device.device_id}:${hourStart}`,
				hour_start: hourStart,
				first_at: now,
				source,
				created_at: now,
				...device,
			})
			.catch((error) => {
				// Let the next sweep in this hour try again.
				recordedHours.delete(key);
				appLog.warn("[stats-log] could not record coverage", error);
			});
	} catch (error) {
		appLog.warn("[stats-log] could not record coverage", error);
	}
}

// ---------------------------------------------------------------------------
// Own profile edits
// ---------------------------------------------------------------------------

/** `fields` names what changed: profile field keys, or photo change kinds. */
export function logProfileEdit(fields: readonly string[]): void {
	if (!settings.enabled || fields.length === 0) return;
	try {
		const now = Date.now();
		const device = thisDevice();
		void write("stats_profile_edit_log", {
			id: `${device.device_id}:${now}`,
			timestamp: now,
			fields_json: JSON.stringify([...new Set(fields)].sort()),
			created_at: now,
			...device,
		});
	} catch (error) {
		appLog.warn("[stats-log] could not record a profile edit", error);
	}
}

// ---------------------------------------------------------------------------
// Profiles you open
// ---------------------------------------------------------------------------

/** Last logged open per `${account}:${profileId}`. */
const recentOpens = new Map<string, { at: number; viewRecorded: boolean }>();

export function logProfileOpen(
	profileId: string | null | undefined,
	input: {
		/** Whether Grindr was told about the visit (Settings → Privacy). */
		viewRecorded: boolean;
		surface: "profile_page" | "grid_popup";
	},
): void {
	if (!settings.enabled || !profileId) return;
	try {
		const now = Date.now();
		const key = `${chatDb.getActiveChatDbUser()}:${profileId}`;
		const last = recentOpens.get(key);
		// A repeat visit is skipped, unless this one told Grindr and the
		// earlier one did not: whether they could see you looked matters.
		if (
			last != null &&
			now - last.at < PROFILE_OPEN_COLLAPSE_MS &&
			(last.viewRecorded || !input.viewRecorded)
		) {
			return;
		}
		if (recentOpens.size > 500) {
			for (const [entry, open] of recentOpens) {
				if (now - open.at >= PROFILE_OPEN_COLLAPSE_MS) recentOpens.delete(entry);
			}
		}
		recentOpens.set(key, { at: now, viewRecorded: input.viewRecorded });
		const device = thisDevice();
		void write("stats_profile_open_log", {
			id: `${device.device_id}:${now}:${profileId}`,
			profile_id: profileId,
			timestamp: now,
			view_recorded: input.viewRecorded ? 1 : 0,
			surface: input.surface,
			created_at: now,
			...device,
		});
	} catch (error) {
		appLog.warn("[stats-log] could not record a profile open", error);
	}
}

// ---------------------------------------------------------------------------
// Viewer distance
// ---------------------------------------------------------------------------

/** View ids (`${account}:${profileId}:${viewTimestamp}`) already written this session. */
const loggedViewDistances = new Set<string>();
const MAX_REMEMBERED_VIEW_DISTANCES = 5_000;

/**
 * Records how far away each viewer was, once per view. Called with a views
 * response the app already fetched; a view already recorded — this session
 * or by another device — costs nothing, so a quiet sweep writes nothing.
 * Keyed by Grindr's own view time, so both devices write the same row.
 */
export function logViewerDistances(
	candidates: readonly ViewDistanceCandidate[],
	source: "views_list" | "profile",
	previewIdPrefix: string,
): void {
	if (!settings.enabled || candidates.length === 0) return;
	try {
		const now = Date.now();
		const account = chatDb.getActiveChatDbUser();
		const fresh = selectLoggableViewDistances(candidates, now, previewIdPrefix).filter(
			(view) => !loggedViewDistances.has(`${account}:${view.id}`),
		);
		if (fresh.length === 0) return;
		if (loggedViewDistances.size + fresh.length > MAX_REMEMBERED_VIEW_DISTANCES) {
			loggedViewDistances.clear();
		}
		for (const view of fresh) loggedViewDistances.add(`${account}:${view.id}`);
		const device = thisDevice();
		void chatDb
			.insertStatsLogRows(
				"stats_view_distance_log",
				fresh.map((view) => ({
					id: view.id,
					profile_id: view.profileId,
					view_timestamp: view.viewTimestamp,
					observed_at: now,
					distance_meters: view.distanceMeters,
					source,
					created_at: now,
					...device,
				})),
			)
			.catch((error) => {
				for (const view of fresh) loggedViewDistances.delete(`${account}:${view.id}`);
				appLog.warn("[stats-log] could not record viewer distances", error);
			});
	} catch (error) {
		appLog.warn("[stats-log] could not record viewer distances", error);
	}
}
