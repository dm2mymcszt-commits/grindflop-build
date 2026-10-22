import type { ReactNode } from "react";
import {
	Clock,
	Eye,
	Flame,
	Image as ImageIcon,
	MessageCircle,
	Repeat,
	ShieldBan,
	Zap,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
	countByDay,
	localDayKey,
	longestDayStreak,
	resolvePeriod,
} from "../statsCompute";
import {
	loadBlockData,
	loadMessageRecords,
	loadMessagesByWeekHour,
	personName,
} from "../statsData";
import {
	formatDay,
	formatDayKey,
	formatDuration,
	formatHour,
	formatNumber,
	formatWeekday,
} from "../statsFormat";
import {
	SectionError,
	SectionLoading,
	SourceBadge,
	StatsGrid,
	type StatsSource,
} from "../StatsUi";
import { useStatsResource } from "../useStatsResource";
import { PersonLink } from "../statsPeople";
import { conversationPerson, type SectionProps } from "./shared";

type RecordTile = {
	icon: ReactNode;
	label: string;
	value: string;
	sub: ReactNode;
	source: StatsSource;
};

export function RecordsSection({ context, locale }: SectionProps) {
	const { t } = useTranslation();
	const me = context.me;
	const resource = useStatsResource(async () => {
		const allTime = resolvePeriod("all", context.loadedAt);
		const [records, blocks, weekHours] = await Promise.all([
			loadMessageRecords(me),
			loadBlockData(me),
			loadMessagesByWeekHour(me, allTime),
		]);
		return { records, blocks, weekHours };
	}, [me, context.loadedAt]);

	if (resource.status === "loading") return <SectionLoading />;
	if (resource.status === "error")
		return <SectionError error={resource.error} onRetry={resource.reload} />;
	const { records, blocks, weekHours } = resource.data;
	const none = t("stats.records.none", { defaultValue: "Nothing yet" });

	const viewsPerDay = countByDay(context.views.map((view) => view.timestamp));
	const busiestViews = [...viewsPerDay.entries()].sort(
		(a, b) => b[1] - a[1],
	)[0];
	const streak = longestDayStreak(viewsPerDay.keys(), context.loadedAt);

	const perPersonDay = new Map<string, number>();
	for (const view of context.views) {
		const key = `${view.profileId}|${localDayKey(view.timestamp)}`;
		perPersonDay.set(key, (perPersonDay.get(key) ?? 0) + 1);
	}
	const mostFromOne = [...perPersonDay.entries()].sort(
		(a, b) => b[1] - a[1],
	)[0];

	const cells = new Map<string, number>();
	for (const view of context.views) {
		const date = new Date(view.timestamp);
		const key = `${date.getDay()}:${date.getHours()}`;
		cells.set(key, (cells.get(key) ?? 0) + 1);
	}
	for (const row of weekHours) {
		const key = `${row.weekday}:${row.hour}`;
		cells.set(key, (cells.get(key) ?? 0) + row.received);
	}
	const bestCell = [...cells.entries()].sort((a, b) => b[1] - a[1])[0];

	const autoPerDay = countByDay(
		blocks.log
			.filter((row) => row.event_type === "block" && row.method === "auto")
			.map((row) => row.timestamp),
	);
	const mostAuto = [...autoPerDay.entries()].sort((a, b) => b[1] - a[1])[0];

	const fastestPerson = records.fastestReply
		? conversationPerson(context, records.fastestReply.conversationId)
		: null;

	const tiles: RecordTile[] = [
		{
			icon: <Eye className="h-4 w-4" />,
			label: t("stats.records.busiest_views", {
				defaultValue: "Busiest day for views",
			}),
			value: busiestViews ? formatNumber(busiestViews[1], locale) : none,
			sub: busiestViews ? formatDayKey(busiestViews[0], locale) : "",
			source: "device",
		},
		{
			icon: <MessageCircle className="h-4 w-4" />,
			label: t("stats.records.busiest_messages", {
				defaultValue: "Busiest day for messages",
			}),
			value: records.busiestMessageDay
				? formatNumber(records.busiestMessageDay.count, locale)
				: none,
			sub: records.busiestMessageDay
				? formatDayKey(records.busiestMessageDay.day, locale)
				: "",
			source: "device",
		},
		{
			icon: <Flame className="h-4 w-4" />,
			label: t("stats.records.streak", { defaultValue: "Longest view streak" }),
			value:
				streak.length > 0
					? t("stats.days_count", {
							defaultValue: "{{count}} days",
							defaultValue_one: "{{count}} day",
							count: streak.length,
						})
					: none,
			sub: streak.ongoing
				? t("stats.records.still_going", { defaultValue: "Still going" })
				: streak.endDay
					? t("stats.records.ended", {
							defaultValue: "Ended {{date}}",
							date: formatDayKey(streak.endDay, locale),
						})
					: "",
			source: "device",
		},
		{
			icon: <Zap className="h-4 w-4" />,
			label: t("stats.records.fastest_reply", {
				defaultValue: "Fastest reply you got",
			}),
			value: records.fastestReply
				? formatDuration(records.fastestReply.gap)
				: none,
			sub: records.fastestReply ? (
				<PersonLink
					profileId={fastestPerson?.profileId ?? null}
					name={fastestPerson?.name}
					suffix={formatDay(records.fastestReply.timestamp, locale)}
				/>
			) : (
				""
			),
			source: "device",
		},
		{
			icon: <Repeat className="h-4 w-4" />,
			label: t("stats.records.most_from_one", {
				defaultValue: "Most views from one person in a day",
			}),
			value: mostFromOne ? formatNumber(mostFromOne[1], locale) : none,
			sub: mostFromOne
				? (() => {
						const [profileId, day] = mostFromOne[0].split("|");
						return (
							<PersonLink
								profileId={profileId}
								name={personName(context, profileId).name}
								suffix={formatDayKey(day, locale)}
							/>
						);
					})()
				: "",
			source: "device",
		},
		{
			icon: <ImageIcon className="h-4 w-4" />,
			label: t("stats.records.biggest_album", {
				defaultValue: "Biggest album shared with you",
			}),
			value: records.biggestAlbum
				? formatNumber(records.biggestAlbum.items, locale)
				: none,
			sub: records.biggestAlbum ? (
				<PersonLink
					profileId={records.biggestAlbum.profileId}
					name={personName(context, records.biggestAlbum.profileId).name}
					suffix={formatDay(records.biggestAlbum.createdAt, locale)}
				/>
			) : (
				""
			),
			source: "device",
		},
		{
			icon: <Clock className="h-4 w-4" />,
			label: t("stats.records.best_hour", {
				defaultValue: "Busiest hour of the week",
			}),
			value: bestCell
				? (() => {
						const [weekday, hour] = bestCell[0].split(":").map(Number);
						return `${formatWeekday(weekday, locale)} ${formatHour(hour, locale)}`;
					})()
				: none,
			sub: t("stats.records.best_hour_sub", {
				defaultValue: "Most views and messages received",
			}),
			source: "device",
		},
		{
			icon: <ShieldBan className="h-4 w-4" />,
			label: t("stats.records.most_auto_blocks", {
				defaultValue: "Most auto-blocks in a day",
			}),
			value: mostAuto ? formatNumber(mostAuto[1], locale) : none,
			sub: mostAuto ? formatDayKey(mostAuto[0], locale) : "",
			source: "log",
		},
	];

	return (
		<StatsGrid>
			{tiles.map((tile) => (
				<article
					key={tile.label}
					className="surface-card col-span-1 min-w-0 p-4 lg:col-span-6 xl:col-span-3"
				>
					<div className="flex items-start justify-between gap-2">
						<span className="text-[var(--accent)]">{tile.icon}</span>
						<SourceBadge source={tile.source} />
					</div>
					<p className="mt-2 text-xs text-[var(--text-muted)]">{tile.label}</p>
					<p className="text-xl font-semibold tabular-nums">{tile.value}</p>
					<p className="truncate text-xs text-[var(--text-muted)]">
						{tile.sub}
					</p>
				</article>
			))}
		</StatsGrid>
	);
}
