import { useTranslation } from "react-i18next";
import {
	percent,
	sumBuckets,
	summarizeChats,
	summarizeReplies,
} from "../statsCompute";
import {
	loadConversationSummaries,
	loadMessagesByWeekHour,
	loadMessagesPerDay,
	loadMessageTypes,
	loadReactions,
	loadReplyGaps,
	loadSavedPhraseUse,
	type TypeCount,
} from "../statsData";
import { formatDuration, formatHour, formatNumber } from "../statsFormat";
import {
	BarChart,
	BarRows,
	NotEnoughData,
	SectionError,
	SectionLoading,
	SERIES_COLORS,
	SplitBar,
	StatsCard,
	StatsGrid,
	StatTiles,
} from "../StatsUi";
import { useStatsResource } from "../useStatsResource";
import {
	chartAxis,
	chartStart,
	periodLabel,
	sumValues,
	type SectionProps,
} from "./shared";

/** Below this many chats you started, a reply rate says more about luck than about you. */
const MIN_OPENERS = 10;

const TYPE_GROUPS: { key: string; label: string; types: string[] }[] = [
	{ key: "text", label: "Text", types: ["Text"] },
	{ key: "photo", label: "Photo", types: ["Image"] },
	{
		key: "disappearing",
		label: "Disappearing photo or video",
		types: ["ExpiringImage", "ExpiringVideo"],
	},
	{ key: "album", label: "Album", types: ["Album", "ExpiringAlbum"] },
	{
		key: "video",
		label: "Video",
		types: ["Video", "NonExpiringVideo", "PrivateVideo"],
	},
	{ key: "voice", label: "Voice", types: ["Audio"] },
	{ key: "gif", label: "GIF or Gaymoji", types: ["Giphy", "Gaymoji"] },
	{ key: "location", label: "Location", types: ["Location"] },
	{
		key: "reply",
		label: "Reply to a photo or album",
		types: ["AlbumContentReply", "ProfilePhotoReply", "AlbumContentReaction"],
	},
];

function groupTypes(rows: readonly TypeCount[], mine: boolean | null) {
	const counts = new Map<string, number>();
	let total = 0;
	for (const row of rows) {
		if (mine != null && (row.mine === 1) !== mine) continue;
		if (row.type?.startsWith("System")) continue;
		const group =
			TYPE_GROUPS.find((entry) => entry.types.includes(row.type ?? ""))?.key ??
			"other";
		counts.set(group, (counts.get(group) ?? 0) + row.count);
		total += row.count;
	}
	return { counts, total };
}

export function InboxSection({ context, period, locale }: SectionProps) {
	const { t } = useTranslation();
	const me = context.me;
	const resource = useStatsResource(async () => {
		const [summaries, gaps, perDay, weekHours, types, reactions, phrases] =
			await Promise.all([
				loadConversationSummaries(me, period),
				loadReplyGaps(me, period),
				loadMessagesPerDay(me, period),
				loadMessagesByWeekHour(me, period),
				loadMessageTypes(me, period),
				loadReactions(me, period),
				loadSavedPhraseUse(me, period),
			]);
		return { summaries, gaps, perDay, weekHours, types, reactions, phrases };
	}, [me, period.key, period.end]);

	if (resource.status === "loading") return <SectionLoading />;
	if (resource.status === "error")
		return <SectionError error={resource.error} onRetry={resource.reload} />;
	const { summaries, gaps, perDay, weekHours, types, reactions, phrases } =
		resource.data;

	const periodText = periodLabel(t, period);
	const chats = summarizeChats(summaries, me, period.end);
	const replies = summarizeReplies(gaps);

	const start = chartStart(period, [context.sources.firstMessageAt]);
	const axis = chartAxis(start, period.end, locale);
	const receivedPerBucket = sumBuckets(
		axis.buckets,
		new Map(perDay.map((row) => [row.day, row.received])),
	);
	const sentPerBucket = sumBuckets(
		axis.buckets,
		new Map(perDay.map((row) => [row.day, row.sent])),
	);

	const byHour = Array.from({ length: 24 }, (_, hour) => ({
		received: weekHours
			.filter((row) => row.hour === hour)
			.reduce((total, row) => total + row.received, 0),
		sent: weekHours
			.filter((row) => row.hour === hour)
			.reduce((total, row) => total + row.sent, 0),
	}));

	const allTypes = groupTypes(types, null);
	const unsentByThem = types
		.filter((row) => row.mine === 0)
		.reduce((total, row) => total + row.unsent, 0);

	const typeLabel = (key: string) =>
		t(`stats.inbox.type.${key}`, {
			defaultValue:
				TYPE_GROUPS.find((entry) => entry.key === key)?.label ?? "Other",
		});

	const replyBucketLabels: Record<string, string> = {
		under_1m: t("stats.inbox.reply_under_1m", { defaultValue: "Under 1 min" }),
		"1_5m": t("stats.inbox.reply_1_5m", { defaultValue: "1 to 5 min" }),
		"5_30m": t("stats.inbox.reply_5_30m", { defaultValue: "5 to 30 min" }),
		over_30m: t("stats.inbox.reply_over_30m", { defaultValue: "Over 30 min" }),
	};

	const chatsMeta = t("stats.inbox.chats_meta", {
		defaultValue: "{{count}} chats started · {{period}}",
		count: formatNumber(chats.started, locale),
		period: periodText,
	});

	return (
		<StatsGrid>
			<StatsCard
				span="wide"
				title={t("stats.inbox.per_day", { defaultValue: "Messages per day" })}
				sources={["device"]}
				meta={t("stats.inbox.per_day_meta", {
					defaultValue: "{{received}} received · {{sent}} sent · {{period}}",
					received: formatNumber(sumValues(receivedPerBucket), locale),
					sent: formatNumber(sumValues(sentPerBucket), locale),
					period: periodText,
				})}
			>
				<BarChart
					grouped
					labels={axis.labels}
					labelEvery={axis.labelEvery}
					details={axis.fullLabels.map(
						(label, index) =>
							`${label} · ${t("stats.inbox.per_day_detail", {
								defaultValue: "{{received}} received · {{sent}} sent",
								received: receivedPerBucket[index],
								sent: sentPerBucket[index],
							})}`,
					)}
					series={[
						{
							name: t("stats.series.received_short", {
								defaultValue: "Received",
							}),
							values: receivedPerBucket,
						},
						{
							name: t("stats.series.sent", { defaultValue: "Sent" }),
							values: sentPerBucket,
							color: SERIES_COLORS.secondary,
						},
					]}
				/>
			</StatsCard>

			<StatsCard
				span="third"
				title={t("stats.inbox.reply_time", { defaultValue: "Reply time" })}
				sources={["device"]}
				meta={t("stats.inbox.reply_time_meta", {
					defaultValue: "Typical time · pauses over 12 h are left out",
				})}
			>
				<StatTiles
					items={[
						{
							label: t("stats.inbox.you_reply", {
								defaultValue: "You reply in",
							}),
							value: formatDuration(replies.mineMedian),
							sub: t("stats.replies_count", {
								defaultValue: "{{count}} replies",
								defaultValue_one: "{{count}} reply",
								count: replies.mineCount,
							}),
						},
						{
							label: t("stats.inbox.they_reply", {
								defaultValue: "They reply in",
							}),
							value: formatDuration(replies.theirsMedian),
							sub: t("stats.replies_count", {
								defaultValue: "{{count}} replies",
								defaultValue_one: "{{count}} reply",
								count: replies.theirsCount,
							}),
						},
					]}
				/>
				{replies.mineCount > 0 ? (
					<div className="mt-4">
						<p className="mb-2 text-xs text-[var(--text-muted)]">
							{t("stats.inbox.your_replies", { defaultValue: "Your replies" })}
						</p>
						<BarRows
							share
							rows={replies.mineBuckets.map((bucket) => ({
								label: replyBucketLabels[bucket.label] ?? bucket.label,
								value: percent(bucket.count, replies.mineCount) ?? 0,
								display: `${percent(bucket.count, replies.mineCount)}%`,
							}))}
						/>
					</div>
				) : null}
			</StatsCard>

			<StatsCard
				span="wide"
				title={t("stats.inbox.by_hour", {
					defaultValue: "When messages arrive",
				})}
				sources={["device"]}
				meta={t("stats.inbox.by_hour_meta", {
					defaultValue: "By hour of the day, in your time zone · {{period}}",
					period: periodText,
				})}
			>
				<BarChart
					grouped
					height={140}
					labels={byHour.map((_, hour) => `${hour}h`)}
					labelEvery={3}
					details={byHour.map(
						(row, hour) =>
							`${formatHour(hour, locale)}–${formatHour((hour + 1) % 24, locale)} · ${t(
								"stats.inbox.per_day_detail",
								{
									defaultValue: "{{received}} received · {{sent}} sent",
									received: row.received,
									sent: row.sent,
								},
							)}`,
					)}
					series={[
						{
							name: t("stats.series.received_short", {
								defaultValue: "Received",
							}),
							values: byHour.map((row) => row.received),
						},
						{
							name: t("stats.series.sent", { defaultValue: "Sent" }),
							values: byHour.map((row) => row.sent),
							color: SERIES_COLORS.secondary,
						},
					]}
				/>
			</StatsCard>

			<StatsCard
				span="third"
				title={t("stats.inbox.who_first", { defaultValue: "Who writes first" })}
				sources={["device"]}
				meta={chatsMeta}
			>
				{chats.started === 0 ? (
					<NotEnoughData />
				) : (
					<>
						<SplitBar
							left={chats.theyStarted}
							right={chats.youStarted}
							leftLabel={t("stats.them", { defaultValue: "Them" })}
							rightLabel={t("stats.you", { defaultValue: "You" })}
						/>
						<p className="mt-3 text-sm text-[var(--text-muted)]">
							{[
								chats.theyStarted > 0
									? t("stats.inbox.you_answer", {
											defaultValue:
												"When they write first, you answer {{rate}}% of the time.",
											rate: percent(chats.youAnsweredTheirs, chats.theyStarted),
										})
									: null,
								chats.youStarted > 0
									? t("stats.inbox.they_answer", {
											defaultValue:
												"When you write first, they answer {{rate}}% of the time.",
											rate: percent(chats.theyAnsweredYours, chats.youStarted),
										})
									: null,
							]
								.filter(Boolean)
								.join(" ")}
						</p>
					</>
				)}
			</StatsCard>

			<StatsCard
				span="third"
				title={t("stats.inbox.chat_length", {
					defaultValue: "How long chats last",
				})}
				sources={["device"]}
				meta={chatsMeta}
			>
				{chats.started === 0 ? (
					<NotEnoughData />
				) : (
					<BarRows
						share
						rows={chats.lengthBuckets.map((bucket) => ({
							label: t(
								`stats.inbox.length_${bucket.label.replace("+", "plus").replace("-", "_")}`,
								{
									defaultValue:
										bucket.label === "1"
											? "1 message"
											: `${bucket.label.replace("-", " to ").replace("+", " or more")} messages`,
								},
							),
							value: percent(bucket.count, chats.started) ?? 0,
							display: `${percent(bucket.count, chats.started)}%`,
							sub: t("stats.chats_count", {
								defaultValue: "{{count}} chats",
								defaultValue_one: "{{count}} chat",
								count: bucket.count,
							}),
						}))}
					/>
				)}
			</StatsCard>

			<StatsCard
				span="third"
				title={t("stats.inbox.where_stop", {
					defaultValue: "Where chats stop",
				})}
				sources={["device"]}
				meta={t("stats.inbox.where_stop_meta", {
					defaultValue: "Who sent the last message",
				})}
			>
				{chats.started === 0 ? (
					<NotEnoughData />
				) : (
					<>
						<SplitBar
							left={chats.lastFromThem}
							right={chats.lastFromYou}
							leftLabel={t("stats.them", { defaultValue: "Them" })}
							rightLabel={t("stats.you", { defaultValue: "You" })}
						/>
						{chats.medianAnsweredLength != null ? (
							<p className="mt-3 text-sm text-[var(--text-muted)]">
								{t("stats.inbox.answered_length", {
									defaultValue:
										"Chats where you both wrote usually last {{count}} messages.",
									count: Math.round(chats.medianAnsweredLength),
								})}
							</p>
						) : null}
					</>
				)}
			</StatsCard>

			<StatsCard
				span="third"
				title={t("stats.inbox.unanswered", {
					defaultValue: "Unanswered messages",
				})}
				sources={["device"]}
				meta={t("stats.inbox.unanswered_meta", {
					defaultValue:
						"Chats with no reply after 48 h · blocked chats left out",
				})}
			>
				<StatTiles
					items={[
						{
							label: t("stats.inbox.yours", { defaultValue: "Yours" }),
							value: formatNumber(chats.unansweredYours, locale),
							sub: t("stats.inbox.they_never", {
								defaultValue: "they never answered",
							}),
						},
						{
							label: t("stats.inbox.theirs", { defaultValue: "Theirs" }),
							value: formatNumber(chats.unansweredTheirs, locale),
							sub: t("stats.inbox.you_never", {
								defaultValue: "you never answered",
							}),
						},
					]}
				/>
			</StatsCard>

			<StatsCard
				span="third"
				title={t("stats.inbox.openers", {
					defaultValue: "Openers you receive",
				})}
				sources={["device"]}
				meta={t("stats.inbox.openers_meta", {
					defaultValue: "{{count}} first messages · {{period}}",
					count: formatNumber(chats.openersTotal, locale),
					period: periodText,
				})}
			>
				{chats.openersTotal === 0 ? (
					<NotEnoughData />
				) : (
					<BarRows
						share
						rows={[
							{
								label: t("stats.inbox.photo_opener", {
									defaultValue: "Photo, video or album first",
								}),
								value: percent(chats.photoFirst, chats.openersTotal) ?? 0,
								display: `${percent(chats.photoFirst, chats.openersTotal)}%`,
							},
							...chats.openers.slice(0, 5).map((opener) => ({
								label: `“${opener.label}”`,
								value: percent(opener.count, chats.openersTotal) ?? 0,
								display: `${percent(opener.count, chats.openersTotal)}%`,
							})),
						]}
					/>
				)}
			</StatsCard>

			<StatsCard
				span="third"
				title={t("stats.inbox.your_openers", { defaultValue: "Your openers" })}
				sources={["device"]}
				meta={t("stats.inbox.your_openers_meta", {
					defaultValue: "Chats where you wrote first · {{period}}",
					period: periodText,
				})}
			>
				{chats.youStarted < MIN_OPENERS ? (
					<NotEnoughData>
						{t("stats.inbox.your_openers_needed", {
							defaultValue:
								"Needs {{needed}} chats you started. You have {{count}}.",
							needed: MIN_OPENERS,
							count: chats.youStarted,
						})}
					</NotEnoughData>
				) : (
					<StatTiles
						items={[
							{
								label: t("stats.inbox.got_reply", {
									defaultValue: "Got a reply",
								}),
								value: `${percent(chats.theyAnsweredYours, chats.youStarted)}%`,
								sub: t("stats.of_count", {
									defaultValue: "{{part}} of {{whole}}",
									part: chats.theyAnsweredYours,
									whole: chats.youStarted,
								}),
							},
							{
								label: t("stats.inbox.reply_after", {
									defaultValue: "Reply after",
								}),
								value: formatDuration(chats.medianTimeToTheirReply),
								sub: t("stats.typical", { defaultValue: "typical" }),
							},
						]}
					/>
				)}
			</StatsCard>

			<StatsCard
				span="third"
				title={t("stats.inbox.saved_phrases", {
					defaultValue: "Saved phrases",
				})}
				sources={["device"]}
				meta={t("stats.inbox.saved_phrases_meta", {
					defaultValue: "Answered within a day · {{period}}",
					period: periodText,
				})}
			>
				{phrases.length === 0 ? (
					<NotEnoughData>
						{t("stats.inbox.saved_phrases_empty", {
							defaultValue: "No saved phrase was sent in this period.",
						})}
					</NotEnoughData>
				) : (
					<BarRows
						share
						rows={phrases.slice(0, 6).map((phrase) => ({
							label: `“${phrase.phrase}”`,
							value: percent(phrase.answered, phrase.sent) ?? 0,
							display: `${percent(phrase.answered, phrase.sent)}%`,
							sub: t("stats.inbox.sent_times", {
								defaultValue: "sent {{count}} times",
								defaultValue_one: "sent once",
								count: phrase.sent,
							}),
						}))}
					/>
				)}
			</StatsCard>

			<StatsCard
				span="third"
				title={t("stats.inbox.types", { defaultValue: "Message types" })}
				sources={["device"]}
				meta={t("stats.inbox.types_meta", {
					defaultValue: "{{count}} messages · {{period}}",
					count: formatNumber(allTypes.total, locale),
					period: periodText,
				})}
			>
				{allTypes.total === 0 ? (
					<NotEnoughData />
				) : (
					<BarRows
						share
						rows={[...allTypes.counts.entries()]
							.sort((a, b) => b[1] - a[1])
							.map(([key, count]) => ({
								label: typeLabel(key),
								value: percent(count, allTypes.total) ?? 0,
								display: `${percent(count, allTypes.total)}%`,
							}))}
					/>
				)}
			</StatsCard>

			<StatsCard
				span="third"
				title={t("stats.inbox.photo_first", {
					defaultValue: "Photo before hello",
				})}
				sources={["device"]}
				meta={t("stats.inbox.photo_first_meta", {
					defaultValue: "Chats they opened with media before any text",
				})}
			>
				{chats.theyStarted === 0 ? (
					<NotEnoughData />
				) : (
					<StatTiles
						items={[
							{
								label: t("stats.inbox.photo_first_label", {
									defaultValue: "Media first",
								}),
								value: `${percent(chats.photoFirst, chats.theyStarted)}%`,
								sub: t("stats.of_count", {
									defaultValue: "{{part}} of {{whole}}",
									part: chats.photoFirst,
									whole: chats.theyStarted,
								}),
							},
							{
								label: t("stats.inbox.time_to_album", {
									defaultValue: "Time to an album",
								}),
								value: formatDuration(chats.medianTimeToAlbum),
								sub: t("stats.albums_count", {
									defaultValue: "{{count}} albums",
									defaultValue_one: "{{count}} album",
									count: chats.albumsCounted,
								}),
							},
						]}
					/>
				)}
			</StatsCard>

			<StatsCard
				span="third"
				title={t("stats.inbox.unsent_reactions", {
					defaultValue: "Unsent and reactions",
				})}
				sources={["device"]}
				meta={periodText}
			>
				<StatTiles
					items={[
						{
							label: t("stats.inbox.they_unsent", {
								defaultValue: "They unsent",
							}),
							value: formatNumber(unsentByThem, locale),
							sub: t("stats.messages_word", { defaultValue: "messages" }),
						},
						{
							label: t("stats.inbox.reactions", { defaultValue: "Reactions" }),
							value: `${formatNumber(reactions.received, locale)} / ${formatNumber(reactions.given, locale)}`,
							sub: t("stats.inbox.received_given", {
								defaultValue: "received / given",
							}),
						},
					]}
				/>
			</StatsCard>
		</StatsGrid>
	);
}
