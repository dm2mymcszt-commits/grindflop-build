import type { TFunction } from "i18next";
import { deriveOtherProfileIdFromConversationId } from "../../../../services/conversationArchive";
import type { UnitsPreset } from "../../../../utils/units";
import type { GrindrStats } from "../statsGrindr";
import { personName, type PersonInfo, type StatsContext } from "../statsData";
import {
	addLocalDays,
	buildBuckets,
	coverageByDay,
	DAY_MS,
	inPeriod,
	listDayKeys,
	startOfLocalDay,
	type StatsPeriod,
	type TimeBucket,
	type ViewEvent,
} from "../statsCompute";
import { formatBucket } from "../statsFormat";

export type SectionProps = {
	context: StatsContext;
	period: StatsPeriod;
	grindr: GrindrStats;
	locale: string;
	unitsPreset: UnitsPreset;
};

/** Viewer rows are deleted 30 days after their last view, so nothing older is complete. */
export const VIEWER_RETENTION_MS = 30 * DAY_MS;

export function viewsIn(
	context: StatsContext,
	range: { start: number | null; end: number },
): ViewEvent[] {
	return context.views.filter((view) => inPeriod(view.timestamp, range));
}

/** Whether the viewer store can still hold every view in a range. */
export function viewerRangeComplete(
	context: StatsContext,
	range: { start: number | null },
): boolean {
	return (
		range.start != null && range.start >= context.loadedAt - VIEWER_RETENTION_MS
	);
}

/**
 * The first day a chart for this period should show. For all time that is the
 * oldest data of the kinds given, so a chart never opens on empty years.
 */
export function chartStart(
	period: StatsPeriod,
	candidates: (number | null | undefined)[],
): number {
	if (period.start != null) return period.start;
	const known = candidates.filter(
		(value): value is number => value != null && Number.isFinite(value),
	);
	return startOfLocalDay(
		known.length > 0 ? Math.min(...known) : addLocalDays(period.end, -29),
	);
}

export type ChartAxis = {
	buckets: TimeBucket[];
	labels: string[];
	fullLabels: string[];
	labelEvery: number;
};

export function chartAxis(
	start: number,
	end: number,
	locale: string,
): ChartAxis {
	const buckets = buildBuckets(start, end);
	const short = buckets.length <= 7;
	return {
		buckets,
		labels: buckets.map((bucket) => formatBucket(bucket, short, locale)),
		fullLabels: buckets.map((bucket) => formatBucket(bucket, false, locale)),
		labelEvery:
			buckets.length <= 8
				? 1
				: buckets.length <= 16
					? 2
					: Math.ceil(buckets.length / 6),
	};
}

export function periodLabel(t: TFunction, period: StatsPeriod): string {
	if (period.key === "7d")
		return t("stats.period.last_7", { defaultValue: "Last 7 days" });
	if (period.key === "30d")
		return t("stats.period.last_30", { defaultValue: "Last 30 days" });
	return t("stats.period.all_time", { defaultValue: "All time" });
}

export function viewerWarning(t: TFunction): string {
	return t("stats.viewer_warning", {
		defaultValue:
			"Viewer entries are deleted after 30 days and each one keeps at most 100 view times. If someone views you twice between two scans, that counts as one view.",
	});
}

export function coverageForRange(
	context: StatsContext,
	start: number,
	end: number,
) {
	return coverageByDay(
		context.coverageHours,
		listDayKeys(start, end),
		context.trackingStart,
		end,
	);
}

export function sumValues(values: readonly number[]): number {
	return values.reduce((total, value) => total + value, 0);
}

/**
 * Who a chat was with. A chat deleted from this device keeps its messages but
 * not its profile id or name; the id is still inside the conversation id.
 */
export function conversationPerson(
	context: StatsContext,
	conversationId: string,
): PersonInfo | null {
	const contact = context.contactsByConversation.get(conversationId);
	const profileId =
		contact?.profileId ??
		deriveOtherProfileIdFromConversationId(conversationId, context.me);
	if (!profileId) return null;
	const known = personName(context, profileId);
	return {
		profileId,
		name: contact?.name?.trim() || known.name,
		imageHash: contact?.imageHash ?? known.imageHash,
	};
}
