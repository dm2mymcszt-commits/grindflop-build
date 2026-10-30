/**
 * The Stats page's arithmetic, free of storage and React so every number it
 * shows can be tested. Times are epoch milliseconds; "days" are the device's
 * local calendar days, the same ones SQLite's 'localtime' modifier produces.
 */

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

// ---------------------------------------------------------------------------
// Periods and days
// ---------------------------------------------------------------------------

export type StatsPeriodKey = "7d" | "30d" | "all";

export type StatsPeriod = {
	key: StatsPeriodKey;
	/** Inclusive start, local midnight; null for all time. */
	start: number | null;
	/** Exclusive end: the moment the page loaded. */
	end: number;
	/** The same length of time just before `start`; null for all time. */
	previous: { start: number; end: number } | null;
};

export function startOfLocalDay(timestamp: number): number {
	const date = new Date(timestamp);
	date.setHours(0, 0, 0, 0);
	return date.getTime();
}

/** Calendar-day arithmetic, so a daylight-saving change never shifts a day. */
export function addLocalDays(timestamp: number, days: number): number {
	const date = new Date(timestamp);
	date.setDate(date.getDate() + days);
	return date.getTime();
}

export function localDayKey(timestamp: number): string {
	const date = new Date(timestamp);
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

export function dayKeyToTimestamp(key: string): number {
	const [year, month, day] = key.split("-").map(Number);
	return new Date(year, month - 1, day).getTime();
}

export function resolvePeriod(key: StatsPeriodKey, now: number): StatsPeriod {
	if (key === "all") return { key, start: null, end: now, previous: null };
	const days = key === "7d" ? 7 : 30;
	const start = addLocalDays(startOfLocalDay(now), -(days - 1));
	return {
		key,
		start,
		end: now,
		previous: { start: addLocalDays(start, -days), end: start },
	};
}

export function inPeriod(
	timestamp: number,
	period: { start: number | null; end: number },
): boolean {
	return (
		(period.start == null || timestamp >= period.start) &&
		timestamp < period.end
	);
}

/** Every local day from `start`'s day to `end`'s day, inclusive. */
export function listDayKeys(start: number, end: number): string[] {
	const keys: string[] = [];
	let cursor = startOfLocalDay(start);
	const last = startOfLocalDay(end);
	while (cursor <= last) {
		keys.push(localDayKey(cursor));
		cursor = addLocalDays(cursor, 1);
	}
	return keys;
}

export type TimeBucket = {
	/** First day key in the bucket. */
	key: string;
	start: number;
	end: number;
	days: string[];
	unit: "day" | "week" | "month";
};

/**
 * Splits a range into chart bars: days up to a month, weeks (starting
 * Monday) up to half a year, months beyond. Keeps an all-time chart readable
 * without ever mixing bars of different lengths.
 */
export function buildBuckets(start: number, end: number): TimeBucket[] {
	const days = listDayKeys(start, end);
	if (days.length <= 31) {
		return days.map((key) => {
			const dayStart = dayKeyToTimestamp(key);
			return {
				key,
				start: dayStart,
				end: addLocalDays(dayStart, 1),
				days: [key],
				unit: "day",
			};
		});
	}
	const unit: TimeBucket["unit"] = days.length <= 190 ? "week" : "month";
	const buckets: TimeBucket[] = [];
	for (const key of days) {
		const dayStart = dayKeyToTimestamp(key);
		const date = new Date(dayStart);
		const bucketStart =
			unit === "week"
				? addLocalDays(dayStart, -((date.getDay() + 6) % 7))
				: new Date(date.getFullYear(), date.getMonth(), 1).getTime();
		const last = buckets[buckets.length - 1];
		if (last && last.start === bucketStart) {
			last.days.push(key);
			continue;
		}
		const bucketEnd =
			unit === "week"
				? addLocalDays(bucketStart, 7)
				: new Date(date.getFullYear(), date.getMonth() + 1, 1).getTime();
		buckets.push({
			key: localDayKey(bucketStart),
			start: bucketStart,
			end: bucketEnd,
			days: [key],
			unit,
		});
	}
	return buckets;
}

export function sumBuckets(
	buckets: readonly TimeBucket[],
	perDay: ReadonlyMap<string, number>,
): number[] {
	return buckets.map((bucket) =>
		bucket.days.reduce((total, day) => total + (perDay.get(day) ?? 0), 0),
	);
}

export function countByDay(timestamps: Iterable<number>): Map<string, number> {
	const counts = new Map<string, number>();
	for (const timestamp of timestamps) {
		const key = localDayKey(timestamp);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return counts;
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

export function median(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1
		? sorted[middle]
		: (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Whole-number percentage, or null when there is nothing to divide by. */
export function percent(part: number, whole: number): number | null {
	return whole > 0 ? Math.round((part / whole) * 100) : null;
}

/** Change against an earlier value, rounded; null when there is no earlier value to compare. */
export function percentChange(
	current: number,
	previous: number | null,
): number | null {
	if (previous == null || previous === 0) return null;
	return Math.round(((current - previous) / previous) * 100);
}

export type Bucketed = { label: string; count: number };

/** Counts values into ranges given by their lower bounds, ascending. */
export function bucketize(
	values: readonly number[],
	ranges: readonly { label: string; min: number }[],
): Bucketed[] {
	const counts = ranges.map((range) => ({ label: range.label, count: 0 }));
	for (const value of values) {
		for (let index = ranges.length - 1; index >= 0; index -= 1) {
			if (value >= ranges[index].min) {
				counts[index].count += 1;
				break;
			}
		}
	}
	return counts;
}

// ---------------------------------------------------------------------------
// Viewers
// ---------------------------------------------------------------------------

/** The shape of a saved viewer this module needs (a StoredInterestView). */
export type ViewerRow = {
	profileId: string;
	displayName: string;
	imageHash: string | null;
	timestamp: number | null;
	viewCount: number | null;
	viewTimestamps?: number[];
	firstSeenAt?: number;
};

export type ViewEvent = { profileId: string; timestamp: number };

const SECONDS_THRESHOLD = 100_000_000_000;

export function normalizeTimestamp(
	value: number | null | undefined,
): number | null {
	if (value == null || !Number.isFinite(value) || value <= 0) return null;
	return value < SECONDS_THRESHOLD ? value * 1000 : value;
}

/**
 * Every recorded view, one per distinct time per viewer. A row saved before
 * view history existed still counts its one known view.
 */
export function flattenViews(rows: readonly ViewerRow[]): ViewEvent[] {
	const events: ViewEvent[] = [];
	for (const row of rows) {
		if (!row.profileId || row.profileId.startsWith("preview:")) continue;
		const times = new Set<number>();
		for (const raw of row.viewTimestamps?.length
			? row.viewTimestamps
			: [row.timestamp]) {
			const timestamp = normalizeTimestamp(raw);
			if (timestamp != null) times.add(timestamp);
		}
		for (const timestamp of times)
			events.push({ profileId: row.profileId, timestamp });
	}
	return events.sort((a, b) => a.timestamp - b.timestamp);
}

export function firstViewByProfile(
	events: readonly ViewEvent[],
): Map<string, number> {
	const first = new Map<string, number>();
	for (const event of events) {
		const known = first.get(event.profileId);
		if (known == null || event.timestamp < known)
			first.set(event.profileId, event.timestamp);
	}
	return first;
}

export type DayStreak = {
	length: number;
	endDay: string | null;
	ongoing: boolean;
};

/** The longest run of consecutive days in `dayKeys`; ongoing when it reaches today or yesterday. */
export function longestDayStreak(
	dayKeys: Iterable<string>,
	now: number,
): DayStreak {
	const days = [...new Set(dayKeys)].sort();
	let best: DayStreak = { length: 0, endDay: null, ongoing: false };
	let runLength = 0;
	let previous: number | null = null;
	for (const key of days) {
		const time = dayKeyToTimestamp(key);
		runLength =
			previous != null && localDayKey(addLocalDays(previous, 1)) === key
				? runLength + 1
				: 1;
		previous = time;
		if (runLength >= best.length)
			best = { length: runLength, endDay: key, ongoing: false };
	}
	if (best.endDay) {
		const today = localDayKey(now);
		const yesterday = localDayKey(addLocalDays(startOfLocalDay(now), -1));
		best.ongoing = best.endDay === today || best.endDay === yesterday;
	}
	return best;
}

// ---------------------------------------------------------------------------
// Recording coverage
// ---------------------------------------------------------------------------

export type DayCoverage = {
	day: string;
	/** Hours in the day any device was recording views. */
	hours: number;
	/** Hours that could have been recorded: 24, or the hours so far today. */
	possibleHours: number;
	state: "full" | "partial" | "none" | "before";
};

/** Share of a day that counts as recorded in full. */
export const FULL_DAY_SHARE = 0.8;
/** Below this share, a day is left out of before/after comparisons. */
export const COMPARABLE_DAY_SHARE = 0.5;

export function coverageByDay(
	hourStarts: readonly number[],
	days: readonly string[],
	trackingStart: number | null,
	now: number,
): DayCoverage[] {
	const hoursPerDay = new Map<string, Set<number>>();
	for (const hourStart of hourStarts) {
		const key = localDayKey(hourStart);
		let set = hoursPerDay.get(key);
		if (!set) {
			set = new Set();
			hoursPerDay.set(key, set);
		}
		set.add(hourStart);
	}
	const today = localDayKey(now);
	const trackingDay = trackingStart != null ? localDayKey(trackingStart) : null;
	return days.map((day) => {
		const hours = hoursPerDay.get(day)?.size ?? 0;
		const dayStart = dayKeyToTimestamp(day);
		const possibleHours =
			day === today
				? Math.max(1, Math.ceil((now - dayStart) / HOUR_MS))
				: Math.round((addLocalDays(dayStart, 1) - dayStart) / HOUR_MS);
		let state: DayCoverage["state"];
		if (hours === 0 && (trackingDay == null || day < trackingDay))
			state = "before";
		else if (hours === 0) state = "none";
		else if (hours / possibleHours >= FULL_DAY_SHARE) state = "full";
		else state = "partial";
		return { day, hours, possibleHours: possibleHours, state };
	});
}

export function isComparableDay(coverage: DayCoverage | undefined): boolean {
	return (
		coverage != null &&
		coverage.hours / coverage.possibleHours >= COMPARABLE_DAY_SHARE
	);
}

// ---------------------------------------------------------------------------
// Block log
// ---------------------------------------------------------------------------

export type BlockLogRow = {
	id: string;
	event_type: "block" | "unblock";
	profile_id: string | null;
	timestamp: number;
	method: "auto" | "manual";
	source: string;
	reason_kind: string | null;
	reason_detail: string | null;
	reason_label: string | null;
	rule_id: string | null;
	rule_name: string | null;
	device_id: string;
};

/** Two devices recording one block land within this of each other. */
export const DUPLICATE_BLOCK_WINDOW_MS = 30 * 60 * 1000;

/**
 * One row per real event. When two devices both ran a scanner, both blocked
 * the same person and both logged it; the second row, from another device
 * and close in time, is the same block.
 */
export function collapseBlockLog(rows: readonly BlockLogRow[]): BlockLogRow[] {
	const sorted = [...rows].sort((a, b) => a.timestamp - b.timestamp);
	const kept: BlockLogRow[] = [];
	const lastByKey = new Map<string, BlockLogRow>();
	for (const row of sorted) {
		if (row.profile_id) {
			const key = `${row.event_type}:${row.profile_id}`;
			const last = lastByKey.get(key);
			if (
				last &&
				last.device_id !== row.device_id &&
				row.timestamp - last.timestamp <= DUPLICATE_BLOCK_WINDOW_MS
			) {
				continue;
			}
			lastByKey.set(key, row);
		}
		kept.push(row);
	}
	return kept;
}

/**
 * Automatic blocks you undid yourself: a manual unblock of the same person
 * after the auto-block.
 */
export function findAutoBlockMistakes(
	rows: readonly BlockLogRow[],
): BlockLogRow[] {
	const sorted = [...rows].sort((a, b) => a.timestamp - b.timestamp);
	const mistakes: BlockLogRow[] = [];
	for (const [index, row] of sorted.entries()) {
		if (row.event_type !== "block" || row.method !== "auto" || !row.profile_id)
			continue;
		for (const later of sorted.slice(index + 1)) {
			if (later.profile_id !== row.profile_id) continue;
			if (later.event_type === "block") break;
			if (later.event_type === "unblock" && later.method === "manual") {
				mistakes.push(row);
			}
			break;
		}
	}
	return mistakes;
}

/**
 * Everyone who blocked you in a range, each once at their newest block:
 * blocking you twice is still one person, and the same block is sometimes
 * recorded twice a second apart.
 */
export function blockedYouIn<
	T extends { profileId: string | null; conversationId: string; timestamp: number },
>(rows: readonly T[], range: { start: number | null; end: number }): T[] {
	const newest = new Map<string, T>();
	for (const row of rows) {
		if (!inPeriod(row.timestamp, range)) continue;
		const key = row.profileId ?? row.conversationId;
		const kept = newest.get(key);
		if (!kept || row.timestamp > kept.timestamp) newest.set(key, row);
	}
	return [...newest.values()].sort((a, b) => b.timestamp - a.timestamp);
}

// ---------------------------------------------------------------------------
// Chats
// ---------------------------------------------------------------------------

export const MEDIA_TYPES = new Set([
	"Image",
	"ExpiringImage",
	"Video",
	"NonExpiringVideo",
	"PrivateVideo",
	"ExpiringVideo",
	"Album",
	"ExpiringAlbum",
]);

export type ConversationSummary = {
	conversationId: string;
	otherProfileId: string | null;
	name: string | null;
	blockState: string | null;
	favorite: boolean;
	firstSender: number;
	firstTs: number;
	firstType: string | null;
	firstText: string | null;
	lastSender: number;
	lastTs: number;
	total: number;
	mine: number;
	firstInTs: number | null;
	firstOutTs: number | null;
	firstInTextTs: number | null;
	firstAlbumInTs: number | null;
};

export const UNANSWERED_AFTER_MS = 48 * HOUR_MS;

/** How a first message reads for the openers list: lower case, trimmed, no end punctuation. */
export function normalizeOpener(
	text: string | null | undefined,
): string | null {
	const cleaned = (text ?? "")
		.toLowerCase()
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[\s.!?,;:~…]+$/u, "");
	return cleaned ? cleaned : null;
}

export type ChatSummary = {
	started: number;
	theyStarted: number;
	youStarted: number;
	/** Chats they started that you answered. */
	youAnsweredTheirs: number;
	/** Chats you started that they answered. */
	theyAnsweredYours: number;
	real: number;
	lengthBuckets: Bucketed[];
	lastFromThem: number;
	lastFromYou: number;
	/** Typical length of chats where both of you wrote. */
	medianAnsweredLength: number | null;
	unansweredYours: number;
	unansweredTheirs: number;
	/** First messages they sent that had text, grouped by that text. */
	openers: Bucketed[];
	openersTotal: number;
	/** Chats they opened with a photo, video or album before any text. */
	photoFirst: number;
	medianTimeToAlbum: number | null;
	albumsCounted: number;
	medianTimeToTheirReply: number | null;
};

export function summarizeChats(
	conversations: readonly ConversationSummary[],
	me: number,
	now: number,
): ChatSummary {
	const started = conversations.length;
	const theirs = conversations.filter((c) => c.firstSender !== me);
	const yours = conversations.filter((c) => c.firstSender === me);
	const both = conversations.filter((c) => c.mine > 0 && c.total - c.mine > 0);
	const openerCounts = new Map<string, number>();
	for (const chat of theirs) {
		const opener = normalizeOpener(chat.firstText);
		if (opener) openerCounts.set(opener, (openerCounts.get(opener) ?? 0) + 1);
	}
	const openers = [...openerCounts.entries()]
		.map(([label, count]) => ({ label, count }))
		.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
	const albumTimes = theirs
		.filter((c) => c.firstAlbumInTs != null)
		.map((c) => (c.firstAlbumInTs as number) - c.firstTs);
	const settled = conversations.filter(
		(c) => c.blockState == null && now - c.lastTs >= UNANSWERED_AFTER_MS,
	);
	return {
		started,
		theyStarted: theirs.length,
		youStarted: yours.length,
		youAnsweredTheirs: theirs.filter((c) => c.mine > 0).length,
		theyAnsweredYours: yours.filter((c) => c.total - c.mine > 0).length,
		real: both.length,
		lengthBuckets: bucketize(
			conversations.map((c) => c.total),
			[
				{ label: "1", min: 1 },
				{ label: "2-5", min: 2 },
				{ label: "6-20", min: 6 },
				{ label: "21+", min: 21 },
			],
		),
		lastFromThem: conversations.filter((c) => c.lastSender !== me).length,
		lastFromYou: conversations.filter((c) => c.lastSender === me).length,
		medianAnsweredLength: median(both.map((c) => c.total)),
		unansweredYours: settled.filter((c) => c.lastSender === me).length,
		unansweredTheirs: settled.filter((c) => c.lastSender !== me && c.mine === 0)
			.length,
		openers,
		openersTotal: theirs.length,
		photoFirst: theirs.filter(
			(c) =>
				c.firstType != null &&
				MEDIA_TYPES.has(c.firstType) &&
				(c.firstInTextTs == null || c.firstInTextTs > c.firstTs),
		).length,
		medianTimeToAlbum: median(albumTimes),
		albumsCounted: albumTimes.length,
		medianTimeToTheirReply: median(
			yours
				.filter((c) => c.firstInTs != null)
				.map((c) => (c.firstInTs as number) - c.firstTs),
		),
	};
}

export type ReplyGap = {
	conversationId: string;
	/** True when this account sent the reply. */
	mine: boolean;
	gapMs: number;
	timestamp: number;
};

/** A reply after this long is a new start, not an answer. */
export const MAX_REPLY_GAP_MS = 12 * HOUR_MS;

export const REPLY_TIME_RANGES = [
	{ label: "under_1m", min: 0 },
	{ label: "1_5m", min: 60_000 },
	{ label: "5_30m", min: 5 * 60_000 },
	{ label: "over_30m", min: 30 * 60_000 },
] as const;

export function summarizeReplies(gaps: readonly ReplyGap[]) {
	const valid = gaps.filter(
		(gap) => gap.gapMs >= 0 && gap.gapMs <= MAX_REPLY_GAP_MS,
	);
	const mine = valid.filter((gap) => gap.mine).map((gap) => gap.gapMs);
	const theirs = valid.filter((gap) => !gap.mine).map((gap) => gap.gapMs);
	return {
		mineMedian: median(mine),
		mineCount: mine.length,
		theirsMedian: median(theirs),
		theirsCount: theirs.length,
		mineBuckets: bucketize(mine, REPLY_TIME_RANGES),
	};
}

/** People whose typical reply to you is fastest, among those with enough replies to judge. */
export function rankFastestResponders(
	gaps: readonly ReplyGap[],
	minimumReplies: number,
): { conversationId: string; median: number; count: number }[] {
	const byConversation = new Map<string, number[]>();
	for (const gap of gaps) {
		if (gap.mine || gap.gapMs < 0 || gap.gapMs > MAX_REPLY_GAP_MS) continue;
		const list = byConversation.get(gap.conversationId) ?? [];
		list.push(gap.gapMs);
		byConversation.set(gap.conversationId, list);
	}
	return [...byConversation.entries()]
		.filter(([, list]) => list.length >= minimumReplies)
		.map(([conversationId, list]) => ({
			conversationId,
			median: median(list) as number,
			count: list.length,
		}))
		.sort((a, b) => a.median - b.median);
}

// ---------------------------------------------------------------------------
// Places
// ---------------------------------------------------------------------------

export type LocationEntry = {
	timestamp: number;
	geohash: string;
	name: string | null;
	lat: number | null;
	lon: number | null;
};

export type PlaceStats = {
	key: string;
	name: string | null;
	lat: number | null;
	lon: number | null;
	views: number;
	hours: number;
};

/** Where a location entry belongs: its name, or failing that its ~1 km area. */
export function placeKey(entry: LocationEntry): string {
	const name = entry.name?.trim().toLowerCase();
	return name ? `name:${name}` : `area:${entry.geohash.slice(0, 6)}`;
}

/**
 * Credits each view to the place that was active when it happened, and
 * counts the hours spent at each place within the range, so a short trip
 * compares fairly with home. Views before the first entry belong nowhere and
 * are returned separately.
 */
export function attributeViewsToPlaces(
	views: readonly number[],
	entries: readonly LocationEntry[],
	range: { start: number | null; end: number },
): { places: PlaceStats[]; unplacedViews: number } {
	const sorted = [...entries].sort((a, b) => a.timestamp - b.timestamp);
	const places = new Map<string, PlaceStats>();
	const placeFor = (entry: LocationEntry) => {
		const key = placeKey(entry);
		let place = places.get(key);
		if (!place) {
			place = {
				key,
				name: entry.name?.trim() || null,
				lat: entry.lat,
				lon: entry.lon,
				views: 0,
				hours: 0,
			};
			places.set(key, place);
		}
		return place;
	};
	for (const [index, entry] of sorted.entries()) {
		const from = Math.max(entry.timestamp, range.start ?? entry.timestamp);
		const to = Math.min(sorted[index + 1]?.timestamp ?? range.end, range.end);
		if (to > from) placeFor(entry).hours += (to - from) / HOUR_MS;
	}
	let unplacedViews = 0;
	for (const view of views) {
		if (!inPeriod(view, range)) continue;
		let active: LocationEntry | null = null;
		for (const entry of sorted) {
			if (entry.timestamp > view) break;
			active = entry;
		}
		if (active) placeFor(active).views += 1;
		else unplacedViews += 1;
	}
	return {
		places: [...places.values()].filter(
			(place) => place.hours > 0 || place.views > 0,
		),
		unplacedViews,
	};
}
