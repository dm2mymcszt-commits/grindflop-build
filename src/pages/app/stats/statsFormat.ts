import { dayKeyToTimestamp, type TimeBucket } from "./statsCompute";
import { translate } from "../../../utils/translate";

export function formatNumber(value: number, locale?: string): string {
	return new Intl.NumberFormat(locale).format(Math.round(value));
}

/** "40 s", "4 min", "2 h 10 min", "3 days". */
export function formatDuration(ms: number | null | undefined): string {
	if (ms == null || !Number.isFinite(ms)) return "–";
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds} s`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes} min`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	if (hours < 24) return rest > 0 ? `${hours} h ${rest} min` : `${hours} h`;
	const days = Math.round(hours / 24);
	return `${days} day${days === 1 ? "" : "s"}`;
}

export function formatDay(timestamp: number, locale?: string): string {
	return new Intl.DateTimeFormat(locale, {
		weekday: "short",
		day: "numeric",
		month: "short",
	}).format(timestamp);
}

export function formatDayKey(key: string, locale?: string): string {
	return formatDay(dayKeyToTimestamp(key), locale);
}

export function formatShortDate(timestamp: number, locale?: string): string {
	return new Intl.DateTimeFormat(locale, {
		day: "numeric",
		month: "short",
	}).format(timestamp);
}

export function formatTime(timestamp: number, locale?: string): string {
	return new Intl.DateTimeFormat(locale, {
		hour: "2-digit",
		minute: "2-digit",
	}).format(timestamp);
}

export function formatWeekday(weekday: number, locale?: string): string {
	// 4 Jan 1970 was a Sunday, matching SQLite's %w (0 = Sunday).
	return new Intl.DateTimeFormat(locale, { weekday: "long" }).format(
		new Date(1970, 0, 4 + weekday),
	);
}

export function formatHour(hour: number, locale?: string): string {
	return new Intl.DateTimeFormat(locale, {
		hour: "2-digit",
		minute: "2-digit",
	}).format(new Date(1970, 0, 1, hour, 0));
}

/** A bar's label: a day, a week's first day, or a month. */
export function formatBucket(
	bucket: TimeBucket,
	short: boolean,
	locale?: string,
): string {
	if (bucket.unit === "month") {
		return new Intl.DateTimeFormat(locale, {
			month: "short",
			year: short ? undefined : "numeric",
		}).format(bucket.start);
	}
	if (bucket.unit === "week") return formatShortDate(bucket.start, locale);
	if (short) {
		return new Intl.DateTimeFormat(locale, { weekday: "short" }).format(
			bucket.start,
		);
	}
	return formatDay(bucket.start, locale);
}

export function formatAgo(
	timestamp: number | null | undefined,
	now: number,
): string {
	if (timestamp == null) return translate("stats.ago.never", { defaultValue: "never" });
	const minutes = Math.round((now - timestamp) / 60_000);
	if (minutes < 1) return translate("stats.ago.just_now", { defaultValue: "just now" });
	if (minutes < 60) return translate("stats.ago.minutes", { defaultValue: "{{n}} min ago", n: minutes });
	const hours = Math.round(minutes / 60);
	if (hours < 48) return translate("stats.ago.hours", { defaultValue: "{{n}} h ago", n: hours });
	return translate("stats.ago.days", { defaultValue: "{{n}} days ago", n: Math.round(hours / 24) });
}
