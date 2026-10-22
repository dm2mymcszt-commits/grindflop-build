import { useTranslation } from "react-i18next";
import { DAY_MS, localDayKey, rankFastestResponders } from "../statsCompute";
import {
	loadAlbumSharers,
	loadMostMessages,
	loadProfileOpens,
	loadReplyGaps,
	personName,
} from "../statsData";
import { formatDay, formatDuration } from "../statsFormat";
import {
	NotEnoughData,
	PeopleList,
	SectionError,
	SectionLoading,
	StatsCard,
	StatsGrid,
	type PersonRowItem,
} from "../StatsUi";
import { useStatsResource } from "../useStatsResource";
import {
	conversationPerson,
	periodLabel,
	viewerWarning,
	viewsIn,
	type SectionProps,
} from "./shared";

const RANK_SIZE = 5;
/** Fewer replies than this and a "typical" reply time is mostly chance. */
const MIN_REPLIES = 5;
/** A view this long after you opened their profile no longer counts as viewing back. */
const VIEWED_BACK_WINDOW_MS = 3 * DAY_MS;

export function RankingsSection({
	context,
	period,
	locale,
}: SectionProps) {
	const { t } = useTranslation();
	const me = context.me;
	const resource = useStatsResource(async () => {
		const [mostMessages, gaps, sharers, opens] = await Promise.all([
			loadMostMessages(period, RANK_SIZE),
			loadReplyGaps(me, period),
			loadAlbumSharers(me, RANK_SIZE),
			loadProfileOpens(period),
		]);
		return { mostMessages, gaps, sharers, opens };
	}, [me, period.key, period.end]);

	if (resource.status === "loading") return <SectionLoading />;
	if (resource.status === "error")
		return <SectionError error={resource.error} onRetry={resource.reload} />;
	const { mostMessages, gaps, sharers, opens } = resource.data;
	const periodText = periodLabel(t, period);

	const personRow = (
		profileId: string,
		sub: string,
		value: string,
	): PersonRowItem => {
		const info = personName(context, profileId);
		return {
			key: profileId,
			profileId,
			name: info.name,
			imageHash: info.imageHash,
			sub,
			value,
		};
	};

	const viewsByProfile = new Map<string, number[]>();
	for (const view of viewsIn(context, period)) {
		const list = viewsByProfile.get(view.profileId) ?? [];
		list.push(view.timestamp);
		viewsByProfile.set(view.profileId, list);
	}
	const viewerStats = [...viewsByProfile.entries()].map(
		([profileId, list]) => ({
			profileId,
			views: list.length,
			days: new Set(list.map((timestamp) => localDayKey(timestamp))).size,
		}),
	);
	const topViewers = [...viewerStats]
		.sort((a, b) => b.views - a.views || b.days - a.days)
		.slice(0, RANK_SIZE);
	const loyalViewers = [...viewerStats]
		.filter((entry) => entry.days > 1)
		.sort((a, b) => b.days - a.days || b.views - a.views)
		.slice(0, RANK_SIZE);

	const fastest = rankFastestResponders(gaps, MIN_REPLIES).slice(0, RANK_SIZE);

	// Viewed back: the first view from them after you opened their profile.
	const viewedBack: {
		profileId: string;
		openedAt: number;
		delay: number;
		recorded: boolean;
	}[] = [];
	const seen = new Set<string>();
	for (const open of opens) {
		if (seen.has(open.profileId)) continue;
		const view = context.views.find(
			(entry) =>
				entry.profileId === open.profileId &&
				entry.timestamp > open.timestamp &&
				entry.timestamp - open.timestamp <= VIEWED_BACK_WINDOW_MS,
		);
		if (!view) continue;
		seen.add(open.profileId);
		viewedBack.push({
			profileId: open.profileId,
			openedAt: open.timestamp,
			delay: view.timestamp - open.timestamp,
			recorded: open.viewRecorded,
		});
	}
	viewedBack.sort((a, b) => a.delay - b.delay);

	const conversationRow = (
		conversationId: string,
		sub: string,
		value: string,
	): PersonRowItem => {
		const person = conversationPerson(context, conversationId);
		return {
			key: conversationId,
			profileId: person?.profileId ?? null,
			name: person?.name ?? null,
			imageHash: person?.imageHash ?? null,
			sub,
			value,
		};
	};

	return (
		<StatsGrid>
			<StatsCard
				title={t("stats.rankings.top_viewers", { defaultValue: "Top viewers" })}
				sources={["device"]}
				meta={t("stats.rankings.top_viewers_meta", {
					defaultValue: "Most views · {{period}}",
					period: periodText,
				})}
				note={viewerWarning(t)}
			>
				{topViewers.length === 0 ? (
					<NotEnoughData />
				) : (
					<PeopleList
						rows={topViewers.map((entry) =>
							personRow(
								entry.profileId,
								t("stats.rankings.different_days", {
									defaultValue: "on {{count}} different days",
									count: entry.days,
								}),
								t("stats.views_count", {
									defaultValue: "{{count}} views",
									defaultValue_one: "{{count}} view",
									count: entry.views,
								}),
							),
						)}
					/>
				)}
			</StatsCard>

			<StatsCard
				title={t("stats.rankings.loyal_viewers", {
					defaultValue: "Loyal viewers",
				})}
				sources={["device"]}
				meta={t("stats.rankings.loyal_viewers_meta", {
					defaultValue: "Most different days they viewed you · {{period}}",
					period: periodText,
				})}
				note={viewerWarning(t)}
			>
				{loyalViewers.length === 0 ? (
					<NotEnoughData />
				) : (
					<PeopleList
						rows={loyalViewers.map((entry) =>
							personRow(
								entry.profileId,
								t("stats.views_count", {
									defaultValue: "{{count}} views",
									defaultValue_one: "{{count}} view",
									count: entry.views,
								}),
								t("stats.days_count", {
									defaultValue: "{{count}} days",
									defaultValue_one: "{{count}} day",
									count: entry.days,
								}),
							),
						)}
					/>
				)}
			</StatsCard>

			<StatsCard
				title={t("stats.rankings.most_messages", {
					defaultValue: "Most messages",
				})}
				sources={["device"]}
				meta={t("stats.rankings.most_messages_meta", {
					defaultValue: "Both directions · {{period}}",
					period: periodText,
				})}
			>
				{mostMessages.length === 0 ? (
					<NotEnoughData />
				) : (
					<PeopleList
						rows={mostMessages.map((entry) =>
							conversationRow(
								entry.conversationId,
								t("stats.rankings.last_message", {
									defaultValue: "last message {{date}}",
									date: formatDay(entry.lastTs, locale),
								}),
								String(entry.count),
							),
						)}
					/>
				)}
			</StatsCard>

			<StatsCard
				title={t("stats.rankings.fastest", { defaultValue: "Fastest replies" })}
				sources={["device"]}
				meta={t("stats.rankings.fastest_meta", {
					defaultValue:
						"Typical reply time · people with {{count}} replies or more · {{period}}",
					count: MIN_REPLIES,
					period: periodText,
				})}
			>
				{fastest.length === 0 ? (
					<NotEnoughData />
				) : (
					<PeopleList
						rows={fastest.map((entry) =>
							conversationRow(
								entry.conversationId,
								t("stats.replies_count", {
									defaultValue: "{{count}} replies",
									defaultValue_one: "{{count}} reply",
									count: entry.count,
								}),
								formatDuration(entry.median),
							),
						)}
					/>
				)}
			</StatsCard>

			<StatsCard
				title={t("stats.rankings.album_sharers", {
					defaultValue: "Album sharers",
				})}
				sources={["device"]}
				meta={t("stats.rankings.album_sharers_meta", {
					defaultValue: "All time · albums saved on this device",
				})}
			>
				{sharers.length === 0 ? (
					<NotEnoughData />
				) : (
					<PeopleList
						rows={sharers.map((entry) =>
							personRow(
								entry.profileId,
								t("stats.rankings.items", {
									defaultValue: "{{count}} photos and videos",
									defaultValue_one: "{{count}} photo or video",
									count: entry.items,
								}),
								t("stats.albums_count", {
									defaultValue: "{{count}} albums",
									defaultValue_one: "{{count}} album",
									count: entry.albums,
								}),
							),
						)}
					/>
				)}
			</StatsCard>

			<StatsCard
				title={t("stats.rankings.viewed_back", { defaultValue: "Viewed back" })}
				sources={["device", "log"]}
				meta={t("stats.rankings.viewed_back_meta", {
					defaultValue:
						"People whose profile you opened who then viewed you within 3 days · {{period}}",
					period: periodText,
				})}
			>
				{viewedBack.length === 0 ? (
					<NotEnoughData />
				) : (
					<PeopleList
						rows={viewedBack
							.slice(0, RANK_SIZE)
							.map((entry) =>
								personRow(
									entry.profileId,
									`${formatDay(entry.openedAt, locale)} · ${
										entry.recorded
											? t("stats.rankings.visible_visit", {
													defaultValue: "your visit was shown to them",
												})
											: t("stats.rankings.hidden_visit", {
													defaultValue: "your visit was hidden",
												})
									}`,
									t("stats.rankings.later", {
										defaultValue: "{{delay}} later",
										delay: formatDuration(entry.delay),
									}),
								),
							)}
					/>
				)}
			</StatsCard>
		</StatsGrid>
	);
}
