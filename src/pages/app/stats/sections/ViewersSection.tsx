import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatDistanceForUnits } from "../../../../utils/units";
import {
	addLocalDays,
	attributeViewsToPlaces,
	bucketize,
	countByDay,
	HOUR_MS,
	isComparableDay,
	localDayKey,
	median,
	percent,
	startOfLocalDay,
	sumBuckets,
} from "../statsCompute";
import { loadProfileEdits, loadViewDistances, personName } from "../statsData";
import {
	formatDay,
	formatDayKey,
	formatDuration,
	formatHour,
	formatNumber,
	formatShortDate,
	formatWeekday,
} from "../statsFormat";
import {
	BarChart,
	BarRows,
	HeatGrid,
	NotEnoughData,
	PeopleList,
	SectionError,
	SectionLoading,
	SERIES_COLORS,
	StatsCard,
	StatsGrid,
	StatTiles,
} from "../StatsUi";
import { useStatsResource } from "../useStatsResource";
import {
	chartAxis,
	chartStart,
	coverageForRange,
	periodLabel,
	viewerWarning,
	viewsIn,
	type SectionProps,
} from "./shared";

/** Distances noticed this long after the view are about where they are now, not then. */
const MAX_DISTANCE_LAG_MS = 2 * HOUR_MS;
/** Days either side of a profile change that are compared. */
const PROFILE_CHANGE_DAYS = 5;

const PROFILE_FIELD_LABELS: Record<string, string> = {
	mainPhoto: "New main photo",
	photoAdded: "Photo added",
	photoRemoved: "Photo removed",
	photoOrder: "Photos reordered",
	displayName: "Name",
	aboutMe: "Bio",
	showDistance: "Show distance",
	visitingMode: "Visiting mode",
};

export function ViewersSection({
	context,
	period,
	grindr,
	locale,
	unitsPreset,
}: SectionProps) {
	const { t } = useTranslation();
	const resource = useStatsResource(async () => {
		const [edits, distances] = await Promise.all([
			loadProfileEdits(),
			loadViewDistances(period),
		]);
		return { edits, distances };
	}, [period.key, period.end]);
	const [blockedIds, setBlockedIds] = useState<Set<string> | null>(null);
	useEffect(() => {
		let cancelled = false;
		grindr.blockedIds().then(
			(ids) => {
				if (!cancelled) setBlockedIds(ids);
			},
			() => undefined,
		);
		return () => {
			cancelled = true;
		};
	}, [grindr]);

	if (resource.status === "loading") return <SectionLoading />;
	if (resource.status === "error")
		return <SectionError error={resource.error} onRetry={resource.reload} />;
	const { edits, distances } = resource.data;

	const views = viewsIn(context, period);
	const viewers = new Map<string, number[]>();
	for (const view of views) {
		const list = viewers.get(view.profileId) ?? [];
		list.push(view.timestamp);
		viewers.set(view.profileId, list);
	}

	// Views per day, new against returning
	const start = chartStart(period, [context.views[0]?.timestamp]);
	const axis = chartAxis(start, period.end, locale);
	const newViews = views.filter(
		(view) => context.firstViews.get(view.profileId) === view.timestamp,
	);
	const newPerBucket = sumBuckets(
		axis.buckets,
		countByDay(newViews.map((view) => view.timestamp)),
	);
	const allPerBucket = sumBuckets(
		axis.buckets,
		countByDay(views.map((view) => view.timestamp)),
	);
	const returningPerBucket = allPerBucket.map(
		(total, index) => total - newPerBucket[index],
	);

	// Heatmap, Monday first
	const heat = Array.from({ length: 7 }, () =>
		Array.from({ length: 24 }, () => 0),
	);
	for (const view of views) {
		const date = new Date(view.timestamp);
		heat[(date.getDay() + 6) % 7][date.getHours()] += 1;
	}
	let busiest: { row: number; hour: number; value: number } | null = null;
	heat.forEach((row, rowIndex) =>
		row.forEach((value, hour) => {
			if (value > 0 && (!busiest || value > busiest.value))
				busiest = { row: rowIndex, hour, value };
		}),
	);
	const busiestCell = busiest as {
		row: number;
		hour: number;
		value: number;
	} | null;
	const weekdayOf = (row: number) => formatWeekday((row + 1) % 7, locale);

	// How often they come back
	const returnBuckets = bucketize(
		[...viewers.values()].map((list) => list.length),
		[
			{ label: t("stats.viewers.once", { defaultValue: "Once" }), min: 1 },
			{
				label: t("stats.viewers.two_three", { defaultValue: "2 to 3 times" }),
				min: 2,
			},
			{
				label: t("stats.viewers.four_nine", { defaultValue: "4 to 9 times" }),
				min: 4,
			},
			{
				label: t("stats.viewers.ten_plus", {
					defaultValue: "10 times or more",
				}),
				min: 10,
			},
		],
	);

	// Views that became chats: only people with no chat before their first view here.
	let messagedYou = 0;
	let youMessaged = 0;
	let blockedCount = 0;
	const delays: number[] = [];
	let newToChat = 0;
	for (const [profileId, list] of viewers) {
		const firstView = Math.min(...list);
		const contact = context.contactsByProfile.get(profileId);
		const earliestChat = Math.min(
			contact?.firstIn ?? Infinity,
			contact?.firstOut ?? Infinity,
		);
		if (earliestChat < firstView) continue;
		newToChat += 1;
		if (
			contact?.firstIn != null &&
			contact.firstIn >= firstView &&
			contact.firstIn < period.end
		) {
			messagedYou += 1;
			delays.push(contact.firstIn - firstView);
		}
		if (
			contact?.firstOut != null &&
			contact.firstOut >= firstView &&
			contact.firstOut < period.end
		)
			youMessaged += 1;
		if (blockedIds?.has(profileId)) blockedCount += 1;
	}

	// Profile change: the latest edit with days of views on both sides.
	const latestEdit = [...edits]
		.reverse()
		.find((edit) => edit.fields.length > 0 && edit.timestamp < period.end);
	const profileChange = (() => {
		if (!latestEdit) return null;
		const editDay = startOfLocalDay(latestEdit.timestamp);
		const earliestView = context.views[0]?.timestamp ?? Infinity;
		const beforeStart = Math.max(
			addLocalDays(editDay, -PROFILE_CHANGE_DAYS),
			startOfLocalDay(earliestView),
		);
		const afterEnd = Math.min(
			addLocalDays(editDay, PROFILE_CHANGE_DAYS + 1),
			startOfLocalDay(period.end),
		);
		const coverage = new Map(
			coverageForRange(context, beforeStart, addLocalDays(afterEnd, -1)).map(
				(day) => [day.day, day],
			),
		);
		const perDay = countByDay(context.views.map((view) => view.timestamp));
		const days: {
			key: string;
			views: number;
			comparable: boolean;
			after: boolean;
		}[] = [];
		for (
			let cursor = beforeStart;
			cursor < afterEnd;
			cursor = addLocalDays(cursor, 1)
		) {
			const key = localDayKey(cursor);
			// The day of the edit is split between before and after, so it belongs to neither.
			if (cursor === editDay) continue;
			days.push({
				key,
				views: perDay.get(key) ?? 0,
				comparable: isComparableDay(coverage.get(key)),
				after: cursor > editDay,
			});
		}
		const before = days.filter((day) => !day.after && day.comparable);
		const after = days.filter((day) => day.after && day.comparable);
		const average = (list: typeof days) =>
			list.length > 0
				? list.reduce((total, day) => total + day.views, 0) / list.length
				: null;
		return {
			edit: latestEdit,
			days,
			before,
			after,
			beforeAverage: average(before),
			afterAverage: average(after),
		};
	})();

	// Places
	const firstLocation = context.locations[0]?.timestamp ?? null;
	const placeRange = {
		start:
			firstLocation == null
				? null
				: Math.max(period.start ?? firstLocation, firstLocation),
		end: period.end,
	};
	const places =
		firstLocation == null
			? null
			: attributeViewsToPlaces(
					views.map((view) => view.timestamp),
					context.locations,
					placeRange,
				);
	const placeRows = (places?.places ?? [])
		.filter((place) => place.hours >= 1)
		.map((place) => ({ place, rate: place.views / place.hours }))
		.sort((a, b) => b.rate - a.rate);

	// Distances
	const timelyDistances = distances.filter(
		(distance) =>
			distance.observedAt - distance.viewTimestamp <= MAX_DISTANCE_LAG_MS,
	);
	const distanceRanges = [0, 1000, 5000, 20000];
	const distanceBuckets = bucketize(
		timelyDistances.map((distance) => distance.meters),
		distanceRanges.map((min, index) => ({
			label:
				index === distanceRanges.length - 1
					? t("stats.viewers.distance_over", {
							defaultValue: "Over {{distance}}",
							distance: formatDistanceForUnits(min, unitsPreset, t),
						})
					: t("stats.viewers.distance_range", {
							defaultValue: "{{from}} to {{to}}",
							from: formatDistanceForUnits(min, unitsPreset, t),
							to: formatDistanceForUnits(
								distanceRanges[index + 1],
								unitsPreset,
								t,
							),
						}),
			min,
		})),
	);

	// Favorites
	const favorites = [...context.contactsByProfile.values()].filter(
		(contact) => contact.favorite,
	);
	const favoriteViewers = favorites
		.map((contact) => ({ contact, list: viewers.get(contact.profileId) ?? [] }))
		.filter((entry) => entry.list.length > 0)
		.sort((a, b) => b.list.length - a.list.length);

	const periodText = periodLabel(t, period);

	return (
		<StatsGrid>
			<StatsCard
				span="wide"
				title={t("stats.viewers.per_day", { defaultValue: "Views per day" })}
				sources={["device"]}
				meta={t("stats.viewers.per_day_meta", {
					defaultValue: "{{views}} views from {{people}} people · {{period}}",
					views: formatNumber(views.length, locale),
					people: formatNumber(viewers.size, locale),
					period: periodText,
				})}
				note={viewerWarning(t)}
			>
				<BarChart
					labels={axis.labels}
					labelEvery={axis.labelEvery}
					details={axis.fullLabels.map(
						(label, index) =>
							`${label} · ${t("stats.viewers.per_day_detail", {
								defaultValue: "{{new}} new · {{returning}} returning",
								new: newPerBucket[index],
								returning: returningPerBucket[index],
							})}`,
					)}
					series={[
						{
							name: t("stats.viewers.new", { defaultValue: "New viewers" }),
							values: newPerBucket,
						},
						{
							name: t("stats.viewers.returning", {
								defaultValue: "Returning viewers",
							}),
							values: returningPerBucket,
							color: SERIES_COLORS.secondary,
						},
					]}
				/>
			</StatsCard>

			<StatsCard
				span="third"
				title={t("stats.viewers.come_back", {
					defaultValue: "How often they come back",
				})}
				sources={["device"]}
				meta={t("stats.viewers.come_back_meta", {
					defaultValue: "{{count}} viewers · {{period}}",
					count: formatNumber(viewers.size, locale),
					period: periodText,
				})}
			>
				{viewers.size === 0 ? (
					<NotEnoughData />
				) : (
					<BarRows
						share
						rows={returnBuckets.map((bucket) => ({
							label: bucket.label,
							value: percent(bucket.count, viewers.size) ?? 0,
							display: `${percent(bucket.count, viewers.size)}%`,
							sub: t("stats.people_count", {
								defaultValue: "{{count}} people",
								defaultValue_one: "{{count}} person",
								count: bucket.count,
							}),
						}))}
					/>
				)}
			</StatsCard>

			<StatsCard
				span="wide"
				title={t("stats.viewers.when", {
					defaultValue: "When people view you",
				})}
				sources={["device"]}
				meta={t("stats.viewers.when_meta", {
					defaultValue:
						"{{period}} · in your time zone · tap a square for its count",
					period: periodText,
				})}
			>
				{views.length === 0 ? (
					<NotEnoughData />
				) : (
					<>
						<HeatGrid
							values={heat}
							rowLabels={Array.from({ length: 7 }, (_, row) =>
								new Intl.DateTimeFormat(locale, { weekday: "short" }).format(
									new Date(1970, 0, 5 + row),
								),
							)}
							describe={(row, hour, value) =>
								`${weekdayOf(row)} ${formatHour(hour, locale)}–${formatHour((hour + 1) % 24, locale)} · ${t(
									"stats.views_count",
									{
										defaultValue: "{{count}} views",
										defaultValue_one: "{{count}} view",
										count: value,
									},
								)}`
							}
						/>
						{busiestCell ? (
							<p className="mt-2 text-sm">
								{t("stats.viewers.busiest", {
									defaultValue: "Busiest: {{day}} {{from}}–{{to}}",
									day: weekdayOf(busiestCell.row),
									from: formatHour(busiestCell.hour, locale),
									to: formatHour((busiestCell.hour + 1) % 24, locale),
								})}
							</p>
						) : null}
					</>
				)}
			</StatsCard>

			<StatsCard
				span="third"
				title={t("stats.viewers.became_chats", {
					defaultValue: "Views that became chats",
				})}
				sources={blockedIds ? ["device", "grindr"] : ["device"]}
				meta={t("stats.viewers.became_chats_meta", {
					defaultValue: "{{count}} viewers you had no chat with before",
					count: formatNumber(newToChat, locale),
				})}
			>
				{newToChat === 0 ? (
					<NotEnoughData />
				) : (
					<StatTiles
						items={[
							{
								label: t("stats.viewers.messaged_you", {
									defaultValue: "Messaged you",
								}),
								value: `${percent(messagedYou, newToChat)}%`,
								sub: t("stats.of_count", {
									defaultValue: "{{part}} of {{whole}}",
									part: messagedYou,
									whole: newToChat,
								}),
							},
							{
								label: t("stats.viewers.time_to_message", {
									defaultValue: "Time to message",
								}),
								value: formatDuration(median(delays)),
								sub: t("stats.typical", { defaultValue: "typical" }),
							},
							{
								label: t("stats.viewers.blocked", {
									defaultValue: "Blocked by you",
								}),
								value: blockedIds ? formatNumber(blockedCount, locale) : "…",
								sub: t("stats.of_whole", {
									defaultValue: "of {{whole}}",
									whole: newToChat,
								}),
							},
							{
								label: t("stats.viewers.you_messaged", {
									defaultValue: "You messaged",
								}),
								value: formatNumber(youMessaged, locale),
								sub: t("stats.of_whole", {
									defaultValue: "of {{whole}}",
									whole: newToChat,
								}),
							},
						]}
					/>
				)}
			</StatsCard>

			<StatsCard
				span="wide"
				title={t("stats.viewers.profile_changes", {
					defaultValue: "Profile changes",
				})}
				sources={["device", "log"]}
				meta={t("stats.viewers.profile_changes_meta", {
					defaultValue: "Views before and after your latest edit in GrindFlop",
				})}
				note={t("stats.viewers.profile_changes_note", {
					defaultValue:
						"Days recorded for less than half the day are left out, and so is the day of the edit.",
				})}
			>
				{!profileChange ? (
					<NotEnoughData>
						{t("stats.viewers.profile_changes_empty", {
							defaultValue:
								"Edit your profile in GrindFlop and the views before and after appear here.",
						})}
					</NotEnoughData>
				) : (
					<>
						<p className="mb-2 text-sm">
							{profileChange.edit.fields
								.map((field) =>
									t(`stats.profile_field.${field}`, {
										defaultValue: PROFILE_FIELD_LABELS[field] ?? field,
									}),
								)
								.join(", ")}{" "}
							· {formatDay(profileChange.edit.timestamp, locale)}
						</p>
						<BarChart
							labels={profileChange.days.map((day) =>
								formatDayKey(day.key, locale),
							)}
							labelEvery={profileChange.days.length > 8 ? 2 : 1}
							details={profileChange.days.map(
								(day) =>
									`${formatDayKey(day.key, locale)} · ${t("stats.views_count", {
										defaultValue: "{{count}} views",
										defaultValue_one: "{{count}} view",
										count: day.views,
									})}${
										day.comparable
											? ""
											: ` · ${t("stats.viewers.left_out", { defaultValue: "left out, not fully recorded" })}`
									}`,
							)}
							marker={profileChange.days.findIndex((day) => day.after)}
							series={[
								{
									name: t("stats.viewers.counted", { defaultValue: "Counted" }),
									values: profileChange.days.map((day) =>
										day.comparable ? day.views : 0,
									),
								},
								{
									name: t("stats.viewers.left_out_short", {
										defaultValue: "Left out",
									}),
									values: profileChange.days.map((day) =>
										day.comparable ? 0 : day.views,
									),
									hatched: true,
								},
							]}
							height={130}
						/>
						<div className="mt-3">
							{profileChange.before.length === 0 ||
							profileChange.after.length === 0 ? (
								<NotEnoughData>
									{t("stats.viewers.profile_changes_wait", {
										defaultValue:
											"Needs at least one fully recorded day on each side of the edit.",
									})}
								</NotEnoughData>
							) : (
								<StatTiles
									items={[
										{
											label: t("stats.viewers.before_edit", {
												defaultValue: "Before the edit",
											}),
											value: t("stats.per_day", {
												defaultValue: "{{value}} / day",
												value: Math.round(profileChange.beforeAverage ?? 0),
											}),
											sub: t("stats.days_count", {
												defaultValue: "{{count}} days",
												defaultValue_one: "{{count}} day",
												count: profileChange.before.length,
											}),
										},
										{
											label: t("stats.viewers.after_edit", {
												defaultValue: "After the edit",
											}),
											value: t("stats.per_day", {
												defaultValue: "{{value}} / day",
												value: Math.round(profileChange.afterAverage ?? 0),
											}),
											sub: (() => {
												const change =
													profileChange.beforeAverage &&
													profileChange.afterAverage != null
														? Math.round(
																((profileChange.afterAverage -
																	profileChange.beforeAverage) /
																	profileChange.beforeAverage) *
																	100,
															)
														: null;
												const days = t("stats.days_count", {
													defaultValue: "{{count}} days",
													defaultValue_one: "{{count}} day",
													count: profileChange.after.length,
												});
												return change == null
													? days
													: `${change >= 0 ? "+" : "−"}${Math.abs(change)}% · ${days}`;
											})(),
											tone:
												profileChange.beforeAverage != null &&
												profileChange.afterAverage != null
													? profileChange.afterAverage >=
														profileChange.beforeAverage
														? "good"
														: "bad"
													: "muted",
										},
									]}
								/>
							)}
						</div>
					</>
				)}
			</StatsCard>

			<StatsCard
				span="third"
				title={t("stats.viewers.by_location", {
					defaultValue: "Views by location",
				})}
				sources={["device", "log"]}
				meta={t("stats.viewers.by_location_meta", {
					defaultValue:
						"Views per hour spent at each place, so short visits compare fairly",
				})}
				note={
					firstLocation != null
						? t("stats.viewers.by_location_note", {
								defaultValue:
									"Counts from {{date}}, when the location log started. Each view goes to the place that was active when it happened.",
								date: formatShortDate(firstLocation, locale),
							})
						: undefined
				}
			>
				{placeRows.length === 0 ? (
					<NotEnoughData>
						{t("stats.viewers.by_location_empty", {
							defaultValue:
								"Set or change your location while Stats is on, and views per place appear here.",
						})}
					</NotEnoughData>
				) : (
					<BarRows
						rows={placeRows.map(({ place, rate }) => ({
							label:
								place.name ??
								(place.lat != null && place.lon != null
									? `${place.lat.toFixed(3)}, ${place.lon.toFixed(3)}`
									: place.key),
							value: rate,
							display: t("stats.per_hour", {
								defaultValue: "{{value}} / h",
								value: rate.toFixed(1),
							}),
							sub: t("stats.viewers.place_sub", {
								defaultValue: "{{views}} views in {{hours}} h",
								views: place.views,
								hours: Math.round(place.hours),
							}),
						}))}
					/>
				)}
			</StatsCard>

			<StatsCard
				span="half"
				title={t("stats.viewers.distance", {
					defaultValue: "How far away viewers are",
				})}
				sources={["log"]}
				meta={t("stats.viewers.distance_meta", {
					defaultValue:
						"{{count}} views with a distance, seen within 2 h of the view · {{period}}",
					count: formatNumber(timelyDistances.length, locale),
					period: periodText,
				})}
			>
				{timelyDistances.length === 0 ? (
					<NotEnoughData>
						{t("stats.viewers.distance_empty", {
							defaultValue: "No distances recorded for this period yet.",
						})}
					</NotEnoughData>
				) : (
					<BarRows
						share
						rows={distanceBuckets.map((bucket) => ({
							label: bucket.label,
							value: percent(bucket.count, timelyDistances.length) ?? 0,
							display: `${percent(bucket.count, timelyDistances.length)}%`,
							sub: t("stats.views_count", {
								defaultValue: "{{count}} views",
								defaultValue_one: "{{count}} view",
								count: bucket.count,
							}),
						}))}
					/>
				)}
			</StatsCard>

			<StatsCard
				span="half"
				title={t("stats.viewers.favorites", {
					defaultValue: "Favorites who viewed you",
				})}
				sources={["device"]}
				meta={t("stats.viewers.favorites_meta", {
					defaultValue:
						"{{viewed}} of the {{total}} chats you marked as favorite · {{period}}",
					viewed: favoriteViewers.length,
					total: favorites.length,
					period: periodText,
				})}
			>
				{favoriteViewers.length === 0 ? (
					<NotEnoughData />
				) : (
					<PeopleList
						numbered={false}
						rows={favoriteViewers.slice(0, 8).map(({ contact, list }) => {
							const info = personName(context, contact.profileId);
							return {
								key: contact.profileId,
								profileId: contact.profileId,
								name: info.name,
								imageHash: info.imageHash,
								sub: t("stats.viewers.favorite_sub", {
									defaultValue: "last viewed {{date}}",
									date: formatDay(Math.max(...list), locale),
								}),
								value: t("stats.views_count", {
									defaultValue: "{{count}} views",
									defaultValue_one: "{{count}} view",
									count: list.length,
								}),
							};
						})}
					/>
				)}
			</StatsCard>
		</StatsGrid>
	);
}
