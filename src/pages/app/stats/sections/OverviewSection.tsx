import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
	blockedYouIn,
	countByDay,
	inPeriod,
	percentChange,
	sumBuckets,
	type BlockLogRow,
} from "../statsCompute";
import {
	loadAlbumsReceived,
	loadBlockData,
	loadChatCounts,
	loadMessagesByWeekHour,
	loadMessagesPerDay,
	loadMostMessages,
	personName,
	type BlockData,
} from "../statsData";
import {
	formatDayKey,
	formatHour,
	formatNumber,
	formatWeekday,
} from "../statsFormat";
import {
	BarChart,
	CoverageStrip,
	SectionError,
	SectionLoading,
	SERIES_COLORS,
	StatsCard,
	StatsGrid,
	type TileItem,
} from "../StatsUi";
import { PersonLink } from "../statsPeople";
import { useStatsResource } from "../useStatsResource";
import {
	chartAxis,
	chartStart,
	conversationPerson,
	coverageForRange,
	periodLabel,
	sumValues,
	viewerRangeComplete,
	viewsIn,
	type SectionProps,
} from "./shared";

function blocksIn(
	data: BlockData,
	range: { start: number | null; end: number },
): number {
	const logged = data.log.filter(
		(row) => row.event_type === "block" && inPeriod(row.timestamp, range),
	).length;
	const earlier = data.earlierSelfBlocks.filter((row) =>
		inPeriod(row.timestamp, range),
	).length;
	return logged + earlier;
}

const REASON_LABELS: Record<string, string> = {
	age: "Age limit",
	no_age: "No age set",
	distance: "Distance",
	right_now: "Right Now status",
	looking_for: "Looking for",
	social_link: "X / Twitter account",
	name_keyword: "Name keyword",
	bio_keyword: "Bio keyword",
	message_keyword: "Message keyword",
	keyword: "Keyword",
	first_message: "First message",
	first_media: "Photo as first message",
	left_on_seen: "Left on seen",
	faceless: "No face photo",
	explicit_media: "Explicit photo",
	rule: "Automation rule",
	counter_block: "They blocked you",
	other: "Other",
};

export function reasonLabel(
	t: (key: string, options?: Record<string, unknown>) => string,
	kind: string | null,
): string {
	const key = kind ?? "other";
	return t(`stats.reason.${key}`, {
		defaultValue: REASON_LABELS[key] ?? REASON_LABELS.other,
	});
}

export function OverviewSection({
	context,
	period,
	locale,
}: SectionProps) {
	const { t } = useTranslation();
	const me = context.me;
	const resource = useStatsResource(async () => {
		const [
			blocks,
			chats,
			previousChats,
			perDay,
			weekHours,
			mostMessages,
			albums,
		] = await Promise.all([
			loadBlockData(me),
			loadChatCounts(me, period),
			period.previous
				? loadChatCounts(me, period.previous)
				: Promise.resolve(null),
			loadMessagesPerDay(me, period),
			loadMessagesByWeekHour(me, period),
			loadMostMessages(period, 1),
			loadAlbumsReceived(me, period),
		]);
		return {
			blocks,
			chats,
			previousChats,
			perDay,
			weekHours,
			mostMessages,
			albums,
		};
	}, [me, period.key, period.end]);

	if (resource.status === "loading") return <SectionLoading />;
	if (resource.status === "error")
		return <SectionError error={resource.error} onRetry={resource.reload} />;
	const {
		blocks,
		chats,
		previousChats,
		perDay,
		weekHours,
		mostMessages,
		albums,
	} = resource.data;

	const views = viewsIn(context, period);
	const previousViews = period.previous
		? viewsIn(context, period.previous)
		: [];
	const viewsComparable =
		period.previous != null && viewerRangeComplete(context, period.previous);
	const uniqueViewers = new Set(views.map((view) => view.profileId)).size;
	const previousUnique = new Set(previousViews.map((view) => view.profileId))
		.size;
	const blocked = blocksIn(blocks, period);
	const blockedYou = blockedYouIn(blocks.blockedYou, period).length;

	const start = chartStart(period, [
		context.views[0]?.timestamp,
		context.sources.firstMessageAt,
		context.trackingStart,
	]);
	const axis = chartAxis(start, period.end, locale);
	const viewsPerBucket = sumBuckets(
		axis.buckets,
		countByDay(views.map((view) => view.timestamp)),
	);
	const receivedPerBucket = sumBuckets(
		axis.buckets,
		new Map(perDay.map((row) => [row.day, row.received])),
	);

	/**
	 * `viewerData`: the number comes from the viewer store, which cannot answer
	 * for anything over 30 days old. `colored`: more is better, so a change
	 * earns a colour; for blocks it is neither good nor bad.
	 */
	const comparison = (
		current: number,
		previous: number | null,
		{ viewerData, colored }: { viewerData: boolean; colored: boolean },
	): Pick<TileItem, "sub" | "tone"> => {
		if (!period.previous) {
			return {
				sub: t("stats.compare.all_time", {
					defaultValue: "All data on this device",
				}),
				tone: "muted",
			};
		}
		if (viewerData && !viewsComparable) {
			return {
				sub: t("stats.compare.viewers_kept", {
					defaultValue: "Nothing earlier: viewers are kept 30 days",
				}),
				tone: "muted",
			};
		}
		const change = percentChange(current, previous);
		if (change == null) {
			return {
				sub:
					previous === 0
						? t("stats.compare.none_before", {
								defaultValue: "None in the period before",
							})
						: t("stats.compare.nothing", {
								defaultValue: "Nothing to compare",
							}),
				tone: "muted",
			};
		}
		return {
			sub:
				change === 0
					? t("stats.compare.same", {
							defaultValue: "Same as the period before",
						})
					: t("stats.compare.change", {
							defaultValue: "{{change}} vs the period before",
							change: `${change > 0 ? "+" : "−"}${Math.abs(change)}%`,
						}),
			tone: colored && change !== 0 ? (change > 0 ? "good" : "bad") : "muted",
		};
	};
	const viewerKpi = { viewerData: true, colored: true };
	const chatKpi = { viewerData: false, colored: true };
	const neutralKpi = { viewerData: false, colored: false };

	const tiles: TileItem[] = [
		{
			label: t("stats.kpi.views", { defaultValue: "Profile views" }),
			value: formatNumber(views.length, locale),
			...comparison(views.length, previousViews.length, viewerKpi),
		},
		{
			label: t("stats.kpi.unique_viewers", { defaultValue: "Unique viewers" }),
			value: formatNumber(uniqueViewers, locale),
			...comparison(uniqueViewers, previousUnique, viewerKpi),
		},
		{
			label: t("stats.kpi.new_chats", { defaultValue: "New chats" }),
			value: formatNumber(chats.started, locale),
			...comparison(chats.started, previousChats?.started ?? null, chatKpi),
		},
		{
			label: t("stats.kpi.real_conversations", {
				defaultValue: "Real conversations",
			}),
			value: formatNumber(chats.real, locale),
			...comparison(chats.real, previousChats?.real ?? null, chatKpi),
		},
		{
			label: t("stats.kpi.you_blocked", { defaultValue: "You blocked" }),
			value: formatNumber(blocked, locale),
			...comparison(
				blocked,
				period.previous ? blocksIn(blocks, period.previous) : null,
				neutralKpi,
			),
		},
		{
			label: t("stats.kpi.blocked_you", { defaultValue: "Blocked you" }),
			value: formatNumber(blockedYou, locale),
			...comparison(
				blockedYou,
				period.previous
					? blockedYouIn(blocks.blockedYou, period.previous).length
					: null,
				neutralKpi,
			),
		},
	];

	// Coverage over the period, or since Stats started for all time.
	const coverageStart =
		period.start ?? chartStart(period, [context.trackingStart]);
	const coverage = coverageForRange(context, coverageStart, period.end);
	const full = coverage.filter((day) => day.state === "full").length;
	const partial = coverage.filter((day) => day.state === "partial").length;
	const before = coverage.filter((day) => day.state === "before").length;
	const none = coverage.filter((day) => day.state === "none").length;
	const coverageSummary = [
		t("stats.coverage.summary_full", {
			defaultValue: "{{full}} of {{total}} days recorded all day",
			full,
			total: coverage.length,
		}),
		partial > 0
			? t("stats.coverage.summary_partial", {
					defaultValue: "{{count}} partly",
					count: partial,
				})
			: null,
		none > 0
			? t("stats.coverage.summary_none", {
					defaultValue: "{{count}} not recorded",
					count: none,
				})
			: null,
		before > 0
			? t("stats.coverage.summary_before", {
					defaultValue: "{{count}} before Stats was on",
					count: before,
				})
			: null,
	]
		.filter(Boolean)
		.join(" · ");

	// Highlights
	const cells = new Map<string, number>();
	for (const view of views) {
		const date = new Date(view.timestamp);
		const key = `${date.getDay()}:${date.getHours()}`;
		cells.set(key, (cells.get(key) ?? 0) + 1);
	}
	for (const row of weekHours) {
		const key = `${row.weekday}:${row.hour}`;
		cells.set(key, (cells.get(key) ?? 0) + row.received);
	}
	const bestCell = [...cells.entries()].sort((a, b) => b[1] - a[1])[0];
	const viewsByProfile = new Map<string, number>();
	for (const view of views)
		viewsByProfile.set(
			view.profileId,
			(viewsByProfile.get(view.profileId) ?? 0) + 1,
		);
	const topViewer = [...viewsByProfile.entries()].sort(
		(a, b) => b[1] - a[1],
	)[0];
	const busiestChat = mostMessages[0];
	const busiestPerson = busiestChat
		? conversationPerson(context, busiestChat.conversationId)
		: null;
	const reasons = new Map<string, number>();
	const autoBlocks = blocks.log.filter(
		(row: BlockLogRow) =>
			row.event_type === "block" &&
			row.method === "auto" &&
			inPeriod(row.timestamp, period),
	);
	for (const row of autoBlocks)
		reasons.set(
			row.reason_kind ?? "other",
			(reasons.get(row.reason_kind ?? "other") ?? 0) + 1,
		);
	const topReason = [...reasons.entries()].sort((a, b) => b[1] - a[1])[0];

	const highlights: { label: string; value: ReactNode }[] = [
		{
			label: t("stats.highlight.best_time", { defaultValue: "Busiest time" }),
			value: bestCell
				? (() => {
						const [weekday, hour] = bestCell[0].split(":").map(Number);
						return `${formatWeekday(weekday, locale)} ${formatHour(hour, locale)}`;
					})()
				: "–",
		},
		{
			label: t("stats.highlight.top_viewer", { defaultValue: "Top viewer" }),
			value: topViewer ? (
				<PersonLink
					profileId={topViewer[0]}
					name={personName(context, topViewer[0]).name}
					suffix={String(topViewer[1])}
				/>
			) : (
				"–"
			),
		},
		{
			label: t("stats.highlight.busiest_chat", {
				defaultValue: "Busiest chat",
			}),
			value: busiestChat ? (
				<PersonLink
					profileId={busiestPerson?.profileId ?? null}
					name={busiestPerson?.name}
					suffix={String(busiestChat.count)}
				/>
			) : (
				"–"
			),
		},
		{
			label: t("stats.highlight.top_reason", {
				defaultValue: "Top auto-block reason",
			}),
			value: topReason
				? `${reasonLabel(t, topReason[0])} · ${Math.round((topReason[1] / autoBlocks.length) * 100)}%`
				: "–",
		},
		{
			label: t("stats.highlight.albums", {
				defaultValue: "Albums shared with you",
			}),
			value: formatNumber(albums.length, locale),
		},
		{
			label: t("stats.highlight.blocked_you", {
				defaultValue: "People who blocked you",
			}),
			value: formatNumber(blockedYou, locale),
		},
	];

	return (
		<StatsGrid>
			{tiles.map((tile) => (
				<article
					key={tile.label}
					className="surface-card col-span-1 min-w-0 p-4 lg:col-span-4 xl:col-span-2"
				>
					<p className="truncate text-xs text-[var(--text-muted)]">
						{tile.label}
					</p>
					<p className="mt-0.5 text-2xl font-semibold tabular-nums">
						{tile.value}
					</p>
					<p
						className={
							tile.tone === "good"
								? "text-xs text-emerald-500"
								: tile.tone === "bad"
									? "text-xs text-red-400"
									: "text-xs text-[var(--text-muted)]"
						}
					>
						{tile.sub}
					</p>
				</article>
			))}

			<StatsCard
				span="full"
				title={t("stats.coverage.title", {
					defaultValue: "Recording coverage",
				})}
				sources={["log"]}
				meta={t("stats.coverage.meta", {
					defaultValue:
						"Days this device or a synced device was collecting views",
				})}
				note={t("stats.coverage.note", {
					defaultValue:
						"A dip on a partly recorded day means the app was not collecting views, not that fewer people viewed you. Before/after comparisons leave those days out.",
				})}
			>
				<CoverageStrip
					cells={coverage.map((day) => ({
						label: formatDayKey(day.day, locale),
						detail:
							day.state === "before"
								? `${formatDayKey(day.day, locale)} · ${t("stats.coverage.before_detail", { defaultValue: "before Stats was turned on" })}`
								: `${formatDayKey(day.day, locale)} · ${t(
										"stats.coverage.hours_detail",
										{
											defaultValue: "recorded {{hours}} of {{possible}} hours",
											hours: day.hours,
											possible: day.possibleHours,
										},
									)}`,
						state: day.state,
						share: day.possibleHours > 0 ? day.hours / day.possibleHours : 0,
					}))}
				/>
				<p className="mt-2 text-sm">{coverageSummary}</p>
			</StatsCard>

			<StatsCard
				span="wide"
				title={t("stats.overview.activity", {
					defaultValue: "Views and messages",
				})}
				sources={["device"]}
				meta={periodLabel(t, period)}
			>
				<BarChart
					grouped
					labels={axis.labels}
					labelEvery={axis.labelEvery}
					details={axis.fullLabels.map(
						(label, index) =>
							`${label} · ${t("stats.overview.activity_detail", {
								defaultValue:
									"{{views}} views · {{messages}} messages received",
								views: viewsPerBucket[index],
								messages: receivedPerBucket[index],
							})}`,
					)}
					series={[
						{
							name: t("stats.series.views", { defaultValue: "Profile views" }),
							values: viewsPerBucket,
						},
						{
							name: t("stats.series.received", {
								defaultValue: "Messages received",
							}),
							values: receivedPerBucket,
							color: SERIES_COLORS.secondary,
						},
					]}
				/>
				<p className="mt-2 text-xs text-[var(--text-muted)]">
					{t("stats.overview.activity_totals", {
						defaultValue: "{{views}} views · {{messages}} messages received",
						views: formatNumber(sumValues(viewsPerBucket), locale),
						messages: formatNumber(sumValues(receivedPerBucket), locale),
					})}
				</p>
			</StatsCard>

			<StatsCard
				span="third"
				title={t("stats.overview.highlights", { defaultValue: "Highlights" })}
				sources={["device", "log"]}
				meta={periodLabel(t, period)}
			>
				<dl className="divide-y divide-[var(--border)] text-sm">
					{highlights.map((item) => (
						<div
							key={item.label}
							className="flex items-baseline justify-between gap-3 py-2"
						>
							<dt className="text-[var(--text-muted)]">{item.label}</dt>
							<dd className="min-w-0 truncate text-right font-medium">
								{item.value}
							</dd>
						</div>
					))}
				</dl>
			</StatsCard>
		</StatsGrid>
	);
}
