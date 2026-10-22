/**
 * The decisions behind the Stats logs (services/statsLog.ts), kept free of
 * storage so they can be tested on their own: what kind of reason a block
 * had, whether a location change is a real move, and what changed about the
 * profile photos.
 */

import { decodeGeohash } from "./geohash";

export type StatsBlockReasonKind =
	| "age"
	| "no_age"
	| "distance"
	| "right_now"
	| "looking_for"
	| "social_link"
	| "name_keyword"
	| "bio_keyword"
	| "message_keyword"
	| "keyword"
	| "first_message"
	| "first_media"
	| "left_on_seen"
	| "faceless"
	| "explicit_media"
	| "rule"
	| "counter_block"
	| "other";

/**
 * Why an automatic block happened. Most blockers only have the sentence they
 * already show in the notification, so `label` alone is enough: the kind is
 * read from it. Callers that know more (an automation rule) pass it directly.
 */
export type StatsBlockReason = {
	label?: string | null;
	kind?: StatsBlockReasonKind;
	detail?: string | null;
	ruleId?: string | null;
	ruleName?: string | null;
};

export type ClassifiedBlockReason = {
	kind: StatsBlockReasonKind;
	detail: string | null;
};

function unquote(value: string | undefined): string | null {
	const trimmed = value?.trim().replace(/^"(.*)"$/, "$1").trim();
	return trimmed ? trimmed : null;
}

/**
 * Reads the kind of reason out of the sentences the auto-blockers already
 * produce. They are written in a few places with small differences — "Age
 * limit (30)" and "Age Limit (30)", keywords with and without quotes, a
 * "Scanner: " prefix — so matching ignores case, quotes and that prefix.
 * Anything unrecognised is "other", with the sentence kept in the log.
 */
export function classifyBlockReason(label: string | null | undefined): ClassifiedBlockReason {
	const text = (label ?? "").trim().replace(/^scanner:\s*/i, "");
	let match: RegExpMatchArray | null;

	if (/^no age set$/i.test(text)) return { kind: "no_age", detail: null };
	if ((match = text.match(/^age limit\s*\((\d+)\)/i))) return { kind: "age", detail: match[1] };
	if ((match = text.match(/^distance limit(?:\s*\((.+)\))?$/i))) {
		return { kind: "distance", detail: unquote(match[1]) };
	}
	if (/right now/i.test(text)) return { kind: "right_now", detail: null };
	if (/looking for/i.test(text)) return { kind: "looking_for", detail: null };
	if ((match = text.match(/^name keyword:\s*(.*)$/i))) {
		return { kind: "name_keyword", detail: unquote(match[1]) };
	}
	if ((match = text.match(/^bio keyword:\s*(.*)$/i))) {
		return { kind: "bio_keyword", detail: unquote(match[1]) };
	}
	if ((match = text.match(/^message keyword:\s*(.*)$/i))) {
		return { kind: "message_keyword", detail: unquote(match[1]) };
	}
	if (/^keyword match$/i.test(text)) return { kind: "keyword", detail: null };
	// After the keyword branches on purpose: "Bio keyword: twitter" is a
	// keyword block, not a social-link one.
	if (/^has an x \/ twitter account$/i.test(text)) return { kind: "social_link", detail: null };
	if (/^first message was media/i.test(text)) return { kind: "first_media", detail: null };
	if ((match = text.match(/^first message:\s*(.*)$/i))) {
		return { kind: "first_message", detail: unquote(match[1]) };
	}
	if ((match = text.match(/^left on seen for\s*(\d+)\s*min/i))) {
		return { kind: "left_on_seen", detail: match[1] };
	}
	if (/^faceless/i.test(text)) return { kind: "faceless", detail: null };
	if ((match = text.match(/^explicit (?:photo|video|profile photo|album)(?::\s*(.*))?$/i))) {
		return { kind: "explicit_media", detail: unquote(match[1]) };
	}
	return { kind: "other", detail: null };
}

export function resolveBlockReason(reason: StatsBlockReason): ClassifiedBlockReason {
	if (reason.kind) {
		return { kind: reason.kind, detail: reason.detail ?? null };
	}
	return classifyBlockReason(reason.label);
}

/**
 * Two locations closer than this are the same place. Grindr measures
 * distance from where you are, so moving a few hundred metres changes
 * nothing worth a new entry, while GPS jitter and the boundary between two
 * geohash cells would otherwise log a "move" on every refresh.
 */
export const SAME_PLACE_METERS = 500;

function centerOf(geohash: string): { lat: number; lon: number } | null {
	try {
		const { lat, lon } = decodeGeohash(geohash);
		return { lat: (lat[0] + lat[1]) / 2, lon: (lon[0] + lon[1]) / 2 };
	} catch {
		return null;
	}
}

export function geohashCenter(geohash: string): { lat: number; lon: number } | null {
	return centerOf(geohash);
}

function distanceMeters(
	a: { lat: number; lon: number },
	b: { lat: number; lon: number },
): number {
	const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
	const dLat = toRadians(b.lat - a.lat);
	const dLon = toRadians(b.lon - a.lon);
	const h =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * Math.sin(dLon / 2) ** 2;
	return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function isSameStatsPlace(previousGeohash: string, nextGeohash: string): boolean {
	if (previousGeohash === nextGeohash) return true;
	const previous = centerOf(previousGeohash);
	const next = centerOf(nextGeohash);
	if (!previous || !next) return false;
	return distanceMeters(previous, next) < SAME_PLACE_METERS;
}

const HOUR_MS = 60 * 60 * 1000;

/** The start of the hour a moment falls in — the coverage log's unit. */
export function statsHourStart(timestamp: number): number {
	return Math.floor(timestamp / HOUR_MS) * HOUR_MS;
}

/**
 * Opening the same profile again within this window is one visit, not
 * several — flicking back and forth through a grid would otherwise count
 * every pass.
 */
export const PROFILE_OPEN_COLLAPSE_MS = 10 * 60 * 1000;

/**
 * A distance is only kept for a view this recent when it is first seen. The
 * list gives each viewer's distance as it is now, so for an old view it says
 * little about where they were when they looked; the observed time is kept
 * too, so the page can be stricter still.
 */
export const VIEW_DISTANCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Below this, a view time is in seconds rather than milliseconds. */
const SECONDS_THRESHOLD = 100_000_000_000;

export type ViewDistanceCandidate = {
	profileId: string;
	timestamp?: number | null;
	distanceMeters?: number | null;
	/** False when the timestamp is a stand-in rather than a real view time. */
	hasExactTimestamp?: boolean;
};

export type LoggableViewDistance = {
	id: string;
	profileId: string;
	viewTimestamp: number;
	distanceMeters: number;
};

export function selectLoggableViewDistances(
	candidates: readonly ViewDistanceCandidate[],
	now: number,
	previewIdPrefix: string,
): LoggableViewDistance[] {
	const selected = new Map<string, LoggableViewDistance>();
	for (const candidate of candidates) {
		if (!candidate.profileId || candidate.profileId.startsWith(previewIdPrefix)) continue;
		if (candidate.hasExactTimestamp === false) continue;
		const distance = candidate.distanceMeters;
		if (distance == null || !Number.isFinite(distance) || distance < 0) continue;
		const raw = candidate.timestamp;
		if (raw == null || !Number.isFinite(raw) || raw <= 0) continue;
		const viewTimestamp = raw < SECONDS_THRESHOLD ? raw * 1000 : raw;
		if (now - viewTimestamp > VIEW_DISTANCE_MAX_AGE_MS) continue;
		const id = `${candidate.profileId}:${viewTimestamp}`;
		selected.set(id, {
			id,
			profileId: candidate.profileId,
			viewTimestamp,
			distanceMeters: distance,
		});
	}
	return [...selected.values()];
}

/**
 * What a photo save changed, in the terms the Stats page compares views
 * around: a new main photo matters on its own, separately from adding,
 * removing or reordering the others.
 */
export function describePhotoChange(
	previous: readonly string[],
	next: readonly string[],
): string[] {
	const changes: string[] = [];
	if ((previous[0] ?? null) !== (next[0] ?? null)) changes.push("mainPhoto");
	if (next.some((hash) => !previous.includes(hash))) changes.push("photoAdded");
	if (previous.some((hash) => !next.includes(hash))) changes.push("photoRemoved");
	if (
		changes.length === 0 &&
		previous.length === next.length &&
		previous.some((hash, index) => hash !== next[index])
	) {
		changes.push("photoOrder");
	}
	return changes;
}
