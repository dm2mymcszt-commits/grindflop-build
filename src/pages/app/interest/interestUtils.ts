import type { TFunction } from "i18next";
import { formatRelativeTime } from "../../../utils/relativeTime";
import type { StoredInterestView } from "../../../services/interestViewsStore";
import { validateMediaHash } from "../../../utils/media";

export type InterestTab = "views" | "taps";

export type InterestItem = {
	profileId: string;
	displayName: string | null;
	imageHash: string | null;
	timestamp: number | null;
	tapType: number | null;
	viewCount: number | null;
	canOpenProfile: boolean;
	/**
	 * Whether `timestamp` is a real view time the server reported, as opposed to
	 * a stand-in so the row still has something to sort and display by.
	 *
	 * Only ever false for a cached row the server never gave a timestamp for:
	 * fromStoredView falls back to the row's `updatedAt`, which is when the
	 * cache was last written, not when anyone looked at us. That value used to
	 * flow back through toStoredView into the store's `viewTimestamps` history,
	 * so a viewer with no server timestamp grew a precise-looking "viewed you
	 * at 21:47" entry that was really a database write. undefined means exact.
	 */
	hasExactTimestamp?: boolean;
	isFromCache?: boolean;
	isMutual?: boolean;
	onlineUntil?: number | null;
	/**
	 * The distance Grindr listed with this view, straight from the response.
	 * Never written to the viewer store (toStoredView leaves it out): it moves
	 * whenever either of you moves, and storing it would rewrite every row on
	 * every sweep. The Stats distance log records it once per view instead.
	 */
	distanceMeters?: number | null;
};

export const PREVIEW_ID_PREFIX = "preview:";

export function fromStoredView(row: StoredInterestView): InterestItem {
	return {
		profileId: row.profileId,
		displayName: row.displayName,
		imageHash: row.imageHash,
		timestamp: row.timestamp ?? row.updatedAt,
		hasExactTimestamp: row.timestamp != null,
		tapType: null,
		// Floored by the row's own view history: rows written before the store
		// started enforcing this can hold a count below the number of views
		// actually recorded for them, and would otherwise keep rendering it
		// until some later poll happens to rewrite the row.
		viewCount:
			Math.max(row.viewCount ?? 0, row.viewTimestamps?.length ?? 0) || row.viewCount,
		canOpenProfile: !row.profileId.startsWith(PREVIEW_ID_PREFIX),
		isFromCache: true,
	};
}

export function toStoredView(item: InterestItem): Omit<StoredInterestView, "updatedAt"> {
	return {
		profileId: item.profileId,
		displayName: item.displayName ?? "",
		imageHash: item.imageHash,
		// Write back only genuine view times. A stand-in read out of the cache
		// must not be persisted as though the server had reported it — the
		// store treats every timestamp it receives as an observed view and
		// accumulates it into that profile's exact-times history.
		timestamp: item.hasExactTimestamp === false ? null : item.timestamp,
		viewCount: item.viewCount,
	};
}

function isPlaceholderName(name: string, profileId: string): boolean {
	return name === `Profile ${profileId}`;
}

function mergeViewItem(
	cached: InterestItem | null,
	incoming: InterestItem,
): InterestItem {
	if (!cached) {
		return incoming;
	}

	const incomingLooksPlaceholder = isPlaceholderName(
		incoming.displayName ?? "",
		incoming.profileId,
	);

	const isIncomingPreview = incoming.profileId.startsWith(PREVIEW_ID_PREFIX);
	const isCachedPreview = cached.profileId.startsWith(PREVIEW_ID_PREFIX);

	return {
		// Prefer real ID over preview ID
		profileId: isIncomingPreview && !isCachedPreview ? cached.profileId : incoming.profileId,
		displayName:
			incomingLooksPlaceholder && !isPlaceholderName(cached.displayName ?? "", cached.profileId)
				? cached.displayName
				: incoming.displayName,
		imageHash: incoming.imageHash ?? cached.imageHash,
		timestamp: incoming.timestamp ?? cached.timestamp,
		// Exactness travels with whichever timestamp actually won above.
		hasExactTimestamp:
			incoming.timestamp != null
				? incoming.hasExactTimestamp !== false
				: cached.hasExactTimestamp !== false,
		tapType: incoming.tapType ?? cached.tapType,
		// Highest wins, not "incoming if present". The list response and the
		// cached row are two partial views of the same monotonic number, and
		// preferring the incoming one let a smaller figure from the list
		// discard the larger count the store had already established — the
		// same regression the store itself was fixed for.
		viewCount: Math.max(incoming.viewCount ?? 0, cached.viewCount ?? 0) || null,
		canOpenProfile: incoming.canOpenProfile || cached.canOpenProfile,
		isFromCache: incoming.isFromCache ?? cached.isFromCache,
		isMutual: incoming.isMutual ?? cached.isMutual,
		onlineUntil: incoming.onlineUntil ?? cached.onlineUntil,
		distanceMeters: incoming.distanceMeters ?? cached.distanceMeters,
	};
}

export function asObject(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null) {
		return null;
	}
	return value as Record<string, unknown>;
}

function toStringId(value: unknown): string | null {
	if (typeof value === "string" && value.trim().length > 0) {
		return value;
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		return String(value);
	}
	return null;
}

export function toNumber(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string" && value.trim().length > 0) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) {
			return parsed;
		}
	}
	return null;
}

function getItemDisplayName(entry: Record<string, unknown>): string | null {
	const value = entry.displayName;
	if (typeof value === "string" && value.trim().length > 0) {
		return value;
	}
	return null;
}

function getItemImageHash(entry: Record<string, unknown>): string | null {
	const candidates = [entry.profileImageMediaHash, entry.photoHash, entry.mediaHash];
	for (const candidate of candidates) {
		if (typeof candidate === "string" && validateMediaHash(candidate)) {
			return candidate;
		}
	}
	return null;
}

function getItemTimestamp(entry: Record<string, unknown>): number | null {
	return (
		toNumber(entry.timestamp) ??
		toNumber(entry.sentOn) ??
		toNumber(entry.readOn) ??
		toNumber(entry.lastViewedAt) ??
		toNumber(entry.lastViewed) ??
		toNumber(entry.seen)
	);
}

function getViewEntryRecord(entry: unknown): Record<string, unknown> | null {
	const obj = asObject(entry);
	if (!obj) {
		return null;
	}

	const nestedCandidates = [obj.profile, obj.preview, obj.viewer, obj.user];
	for (const candidate of nestedCandidates) {
		const nested = asObject(candidate);
		if (nested) {
			return {
				...obj,
				...nested,
			};
		}
	}

	return obj;
}

function getViewProfileId(entry: Record<string, unknown>): string | null {
	return (
		toStringId(entry.profileId) ??
		toStringId(entry.viewerProfileId) ??
		toStringId(entry.id)
	);
}

function getPreviewSyntheticId(
	entry: Record<string, unknown>,
	index: number,
): string {
	const hash = typeof entry.profileImageMediaHash === "string" ? entry.profileImageMediaHash : "nohash";
	if (hash !== "nohash") {
		// Keep preview IDs stable across refreshes for the same hash.
		return `${PREVIEW_ID_PREFIX}${hash}`;
	}
	const seen = toNumber(entry.lastViewed) ?? toNumber(entry.seen) ?? toNumber(entry.timestamp) ?? 0;
	return `${PREVIEW_ID_PREFIX}${hash}:${seen}:${index}`;
}

export function normalizeViews(
	payload: unknown,
	previouslyCached: InterestItem[],
	_t?: any
): InterestItem[] {
	const root = asObject(payload);
	if (!root) return previouslyCached;
	const dataRoot = asObject(root.data);

	const profilesRaw = Array.isArray(root.profiles) ? root.profiles : Array.isArray(dataRoot?.profiles) ? dataRoot.profiles : [];
	const previewsRaw = Array.isArray(root.previews) ? root.previews : Array.isArray(dataRoot?.previews) ? dataRoot.previews : [];

	// 1. Helper map for quick access to known profiles (by hash)
	const hashToProfile = new Map<string, InterestItem>();
	for (const item of previouslyCached) {
		if (item.imageHash && !item.profileId.startsWith(PREVIEW_ID_PREFIX)) {
			hashToProfile.set(item.imageHash, item);
		}
	}

	// 2. Normalize raw data from server
	const incomingProfiles = profilesRaw.map((entry): InterestItem | null => {
		const obj = getViewEntryRecord(entry);
		if (!obj) return null;
		const profileId = getViewProfileId(obj);
		if (!profileId) return null;
		return {
			profileId,
			displayName: getItemDisplayName(obj),
			imageHash: getItemImageHash(obj),
			timestamp: getItemTimestamp(obj),
			tapType: null,
			viewCount: toNumber(asObject(obj.viewedCount)?.totalCount),
			canOpenProfile: true,
			isFromCache: false,
			onlineUntil: toNumber(obj.onlineUntil),
			distanceMeters: toNumber(obj.distance),
		};
	}).filter((it): it is InterestItem => it !== null);

	const incomingPreviews = previewsRaw.map((entry, index): InterestItem | null => {
		const obj = getViewEntryRecord(entry);
		if (!obj) return null;
		const imageHash = getItemImageHash(obj);

		// CHECK: Have we seen this hash before?
		const recoveredMatch = imageHash ? hashToProfile.get(imageHash) : null;

		const profileId = recoveredMatch ? recoveredMatch.profileId : (getViewProfileId(obj) ?? getPreviewSyntheticId(obj, index));

		return {
			profileId,
			displayName: recoveredMatch ? recoveredMatch.displayName : null,
			imageHash,
			timestamp: getItemTimestamp(obj),
			tapType: null,
			viewCount: toNumber(asObject(obj.viewedCount)?.totalCount),
			canOpenProfile: recoveredMatch ? true : (getViewProfileId(obj) !== null),
			isFromCache: !!recoveredMatch,
			onlineUntil: recoveredMatch ? recoveredMatch.onlineUntil : toNumber(obj.onlineUntil),
			distanceMeters: toNumber(obj.distance),
		};
	}).filter((it): it is InterestItem => it !== null);

	// 3. Merging
	const mergedMap = new Map<string, InterestItem>();

	// First, all items from cache (history)
	for (const item of previouslyCached) {
		mergedMap.set(item.profileId, item);
	}

	// Then fresh profiles/previews from server (overwrite old items with new timestamps)
	for (const incoming of [...incomingProfiles, ...incomingPreviews]) {
		const existing = mergedMap.get(incoming.profileId);
		mergedMap.set(incoming.profileId, mergeViewItem(existing ?? null, incoming));
	}

	return Array.from(mergedMap.values()).sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
}

export function normalizeTaps(payload: unknown, _t?: any): InterestItem[] {
	const root = asObject(payload);
	if (!root || !Array.isArray(root.profiles)) return [];

	const mergedMap = new Map<string, InterestItem>();

	for (const entry of root.profiles) {
		const obj = asObject(entry);
		if (!obj) continue;
		const profileId = toStringId(obj.profileId) ?? toStringId(obj.senderId);
		if (!profileId) continue;

		const incoming: InterestItem = {
			profileId,
			displayName: getItemDisplayName(obj),
			imageHash: getItemImageHash(obj),
			timestamp: getItemTimestamp(obj),
			tapType: toNumber(obj.tapType),
			viewCount: null,
			canOpenProfile: true,
			isMutual: obj.isMutual === true || obj.mutual === true,
			onlineUntil: toNumber(obj.onlineUntil),
		};

		const existing = mergedMap.get(profileId);
		// For taps, we prefer the one with the newer timestamp if duplicates exist
		if (!existing || (incoming.timestamp ?? 0) > (existing.timestamp ?? 0)) {
			mergedMap.set(profileId, incoming);
		}
	}

	return Array.from(mergedMap.values()).sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
}

export function formatTimestamp(
	timestamp: number | null,
	t: TFunction,
	now: number = Date.now(),
): string {
	const formatted = formatRelativeTime(timestamp, now);
	return formatted || t("interest_page.unknown_time");
}

export function tapLabel(tapType: number | null, t: TFunction): string {
	switch (tapType) {
		case 0:
			return t("interest_page.tap_labels.friendly");
		case 1:
			return t("interest_page.tap_labels.hot");
		case 2:
			return t("interest_page.tap_labels.looking");
		default:
			return t("interest_page.tap_labels.default");
	}
}

export function getTapEmoji(tapType: number | null): string {
	switch (tapType) {
		case 0:
			return "👋";
		case 1:
			return "🔥";
		case 2:
			return "😈";
		default:
			return "🔥";
	}
}

/**
 * How the Views tab orders its list. "recent" is the server/normalizer's own
 * newest-first order; "most_viewed" turns the tab into a leaderboard of the
 * people who keep coming back.
 */
export type InterestViewsSort = "recent" | "most_viewed";

export const INTEREST_VIEWS_SORT_KEY = "fg-interest-views-sort";

export function readStoredViewsSort(): InterestViewsSort {
	try {
		return window.localStorage.getItem(INTEREST_VIEWS_SORT_KEY) === "most_viewed"
			? "most_viewed"
			: "recent";
	} catch {
		return "recent";
	}
}

/**
 * The view count a row is ranked (and rendered) by. Mirrors the row's own
 * `viewCount || 1` display: a profile in the views list viewed us at least
 * once even when the server sent no count, so ranking must agree with the
 * number the user can see next to it.
 */
export function effectiveViewCount(item: InterestItem): number {
	return item.viewCount != null && item.viewCount > 0 ? item.viewCount : 1;
}

/**
 * Orders the views list for the given sort mode. "recent" is returned as-is —
 * normalizeViews already sorts newest-first, so re-sorting would only risk
 * disagreeing with it. Ranking ties break on recency, so among equally
 * persistent viewers the one who looked most recently sits higher.
 */
export function sortViewItems(
	items: InterestItem[],
	sort: InterestViewsSort,
): InterestItem[] {
	if (sort !== "most_viewed") {
		return items;
	}
	return [...items].sort((a, b) => {
		const byCount = effectiveViewCount(b) - effectiveViewCount(a);
		if (byCount !== 0) return byCount;
		return (b.timestamp ?? 0) - (a.timestamp ?? 0);
	});
}

/**
 * Time window the Views tab is scoped to. Applied before ranking, so "most
 * viewed" in a window means most-viewed among the people who actually showed
 * up in it, numbered 1..N rather than carrying ranks in from the full list.
 */
export type InterestViewsWindow = "all" | "day" | "week";

export const INTEREST_VIEWS_WINDOW_KEY = "fg-interest-views-window";

const VIEWS_WINDOW_MS: Record<Exclude<InterestViewsWindow, "all">, number> = {
	day: 24 * 60 * 60 * 1000,
	week: 7 * 24 * 60 * 60 * 1000,
};

export function readStoredViewsWindow(): InterestViewsWindow {
	try {
		const stored = window.localStorage.getItem(INTEREST_VIEWS_WINDOW_KEY);
		return stored === "day" || stored === "week" ? stored : "all";
	} catch {
		return "all";
	}
}

/**
 * Which total the Views counter reports.
 *
 * "grindr" is the server's own `totalViewers`, mirrored exactly as stock
 * Grindr shows it — which means it *drops* a viewer the moment you block
 * them, since Grindr removes blocked profiles from your viewers list. That is
 * faithful, but it under-reports how many people actually looked at you, and
 * the auto-blocker makes it drift fast.
 *
 * "real" adds back the viewers we can prove Grindr stopped counting because we
 * blocked them — they are still in the local recovery store, so no guessing is
 * involved. It only reaches as far back as that store does (30 days).
 */
export type InterestViewsCountMode = "grindr" | "real";

export const INTEREST_VIEWS_COUNT_MODE_KEY = "fg-interest-views-count-mode";

export function readStoredViewsCountMode(): InterestViewsCountMode {
	try {
		return window.localStorage.getItem(INTEREST_VIEWS_COUNT_MODE_KEY) === "real"
			? "real"
			: "grindr";
	} catch {
		return "grindr";
	}
}

/** all -> day -> week -> all. */
export function nextViewsWindow(current: InterestViewsWindow): InterestViewsWindow {
	if (current === "all") return "day";
	if (current === "day") return "week";
	return "all";
}

/**
 * Scopes the views list to a recency window, measured on when someone last
 * viewed us.
 *
 * Rows whose timestamp isn't a real server view time are dropped from a narrow
 * window rather than kept. Their stand-in is the moment the cache was written
 * (see `hasExactTimestamp`), which is always recent — so keeping them would
 * quietly file old viewers under "last 24 hours", which is the one thing a
 * window is supposed to rule out. They're still present under "all".
 */
export function filterViewsByWindow(
	items: InterestItem[],
	viewsWindow: InterestViewsWindow,
	now: number,
): InterestItem[] {
	if (viewsWindow === "all") {
		return items;
	}
	const maxAge = VIEWS_WINDOW_MS[viewsWindow];
	return items.filter((item) => {
		if (item.timestamp == null || item.hasExactTimestamp === false) {
			return false;
		}
		return now - item.timestamp <= maxAge;
	});
}
