import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getForbiddenKeywordEntries } from "../../../../utils/autoblock";
import {
	blockedYouIn,
	countByDay,
	DAY_MS,
	findAutoBlockMistakes,
	inPeriod,
	median,
	percent,
	sumBuckets,
} from "../statsCompute";
import { loadBlockData, personName } from "../statsData";
import {
	formatDay,
	formatDuration,
	formatNumber,
	formatShortDate,
} from "../statsFormat";
import {
	BarChart,
	BarRows,
	BigNumber,
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
import { reasonLabel } from "./OverviewSection";
import {
	chartAxis,
	chartStart,
	periodLabel,
	type SectionProps,
} from "./shared";

const KEYWORD_KINDS = new Set([
	"name_keyword",
	"bio_keyword",
	"message_keyword",
	"first_message",
	"rule",
]);
/** How far back "caught nobody" looks. */
const UNUSED_KEYWORD_WINDOW_MS = 30 * DAY_MS;

export function BlockingSection({
	context,
	period,
	grindr,
	locale,
}: SectionProps) {
	const { t } = useTranslation();
	const me = context.me;
	const resource = useStatsResource(
		() => loadBlockData(me),
		[me, period.key, period.end],
	);
	const [grindrBlocked, setGrindrBlocked] = useState<number | null | "error">(
		null,
	);
	useEffect(() => {
		let cancelled = false;
		grindr.blockedIds().then(
			(ids) => {
				if (!cancelled) setGrindrBlocked(ids.size);
			},
			() => {
				if (!cancelled) setGrindrBlocked("error");
			},
		);
		return () => {
			cancelled = true;
		};
	}, [grindr]);

	if (resource.status === "loading") return <SectionLoading />;
	if (resource.status === "error")
		return <SectionError error={resource.error} onRetry={resource.reload} />;
	const data = resource.data;
	const periodText = periodLabel(t, period);

	const logInPeriod = data.log.filter((row) => inPeriod(row.timestamp, period));
	const blocks = logInPeriod.filter((row) => row.event_type === "block");
	const autoBlocks = blocks.filter((row) => row.method === "auto");
	const manualBlocks = blocks.filter((row) => row.method === "manual");
	const earlier = data.earlierSelfBlocks.filter((row) =>
		inPeriod(row.timestamp, period),
	);
	const logStart = data.log[0]?.timestamp ?? null;

	const start = chartStart(period, [
		logStart,
		data.earlierSelfBlocks[0]?.timestamp,
	]);
	const axis = chartAxis(start, period.end, locale);
	const autoPerBucket = sumBuckets(
		axis.buckets,
		countByDay(autoBlocks.map((row) => row.timestamp)),
	);
	const manualPerBucket = sumBuckets(
		axis.buckets,
		countByDay(manualBlocks.map((row) => row.timestamp)),
	);
	const unknownPerBucket = sumBuckets(
		axis.buckets,
		countByDay(earlier.map((row) => row.timestamp)),
	);

	const reasons = new Map<string, number>();
	for (const row of autoBlocks)
		reasons.set(
			row.reason_kind ?? "other",
			(reasons.get(row.reason_kind ?? "other") ?? 0) + 1,
		);

	const keywordCounts = new Map<string, number>();
	for (const row of autoBlocks) {
		if (
			!row.reason_kind ||
			!KEYWORD_KINDS.has(row.reason_kind) ||
			!row.reason_detail
		)
			continue;
		const keyword = row.reason_detail.toLowerCase();
		keywordCounts.set(keyword, (keywordCounts.get(keyword) ?? 0) + 1);
	}
	const unusedWindowStart = Math.max(
		period.end - UNUSED_KEYWORD_WINDOW_MS,
		logStart ?? period.end,
	);
	const recentlyMatched = new Set(
		data.log
			.filter((row) => row.timestamp >= unusedWindowStart && row.reason_detail)
			.map((row) => (row.reason_detail as string).toLowerCase()),
	);
	const keywordEntries = getForbiddenKeywordEntries();
	const unusedKeywords = keywordEntries.filter(
		(entry) => !recentlyMatched.has(entry.text.toLowerCase()),
	);

	const rules = new Map<string, number>();
	for (const row of autoBlocks) {
		if (row.reason_kind !== "rule") continue;
		const name =
			row.rule_name ||
			row.reason_label ||
			t("stats.blocking.unnamed_rule", { defaultValue: "Unnamed rule" });
		rules.set(name, (rules.get(name) ?? 0) + 1);
	}

	const mistakes = findAutoBlockMistakes(data.log).filter((row) =>
		inPeriod(row.timestamp, period),
	);
	const mistakeReasons = new Map<string, number>();
	for (const row of mistakes)
		mistakeReasons.set(
			row.reason_kind ?? "other",
			(mistakeReasons.get(row.reason_kind ?? "other") ?? 0) + 1,
		);
	const topMistakeReason = [...mistakeReasons.entries()].sort(
		(a, b) => b[1] - a[1],
	)[0];

	// Blocked before replying: blocks of someone who had written to you first.
	const blockTimes = [
		...blocks
			.filter((row) => row.profile_id)
			.map((row) => ({
				profileId: row.profile_id as string,
				timestamp: row.timestamp,
			})),
		...earlier
			.filter((row) => row.profileId)
			.map((row) => ({
				profileId: row.profileId as string,
				timestamp: row.timestamp,
			})),
	];
	let hadChat = 0;
	let neverReplied = 0;
	for (const block of blockTimes) {
		const contact = context.contactsByProfile.get(block.profileId);
		if (!contact?.firstIn || contact.firstIn > block.timestamp) continue;
		hadChat += 1;
		if (contact.firstOut == null || contact.firstOut > block.timestamp)
			neverReplied += 1;
	}

	const blockedYou = blockedYouIn(data.blockedYou, period);
	const blockedYouDelay = median(
		blockedYou
			.filter((row) => row.firstTs != null)
			.map((row) => row.timestamp - (row.firstTs as number)),
	);

	const totalBlocks = blocks.length + earlier.length;

	return (
		<StatsGrid>
			<StatsCard
				span="wide"
				title={t("stats.blocking.per_day", { defaultValue: "Blocks per day" })}
				sources={["device", "log"]}
				meta={t("stats.blocking.per_day_meta", {
					defaultValue:
						"{{total}} blocks · {{auto}} automatic · {{manual}} by hand · {{period}}",
					total: formatNumber(totalBlocks, locale),
					auto: formatNumber(autoBlocks.length, locale),
					manual: formatNumber(manualBlocks.length, locale),
					period: periodText,
				})}
				note={
					earlier.length > 0
						? t("stats.blocking.unknown_note", {
								defaultValue:
									"{{count}} blocks happened before the block log started, so whether they were automatic is unknown. Only the latest block per chat is known from before then.",
								count: earlier.length,
							})
						: undefined
				}
			>
				{totalBlocks === 0 ? (
					<NotEnoughData />
				) : (
					<BarChart
						labels={axis.labels}
						labelEvery={axis.labelEvery}
						details={axis.fullLabels.map(
							(label, index) =>
								`${label} · ${t("stats.blocking.per_day_detail", {
									defaultValue:
										"{{auto}} automatic · {{manual}} by hand · {{unknown}} unknown",
									auto: autoPerBucket[index],
									manual: manualPerBucket[index],
									unknown: unknownPerBucket[index],
								})}`,
						)}
						series={[
							{
								name: t("stats.blocking.automatic", {
									defaultValue: "Automatic",
								}),
								values: autoPerBucket,
							},
							{
								name: t("stats.blocking.by_hand", { defaultValue: "By hand" }),
								values: manualPerBucket,
								color: SERIES_COLORS.secondary,
							},
							...(earlier.length > 0
								? [
										{
											name: t("stats.blocking.unknown", {
												defaultValue: "Before the log",
											}),
											values: unknownPerBucket,
											hatched: true,
										},
									]
								: []),
						]}
					/>
				)}
			</StatsCard>

			<StatsCard
				span="third"
				title={t("stats.blocking.reasons", {
					defaultValue: "Why people were auto-blocked",
				})}
				sources={["log"]}
				meta={t("stats.blocking.reasons_meta", {
					defaultValue: "{{count}} automatic blocks · {{period}}",
					defaultValue_one: "{{count}} automatic block · {{period}}",
					count: formatNumber(autoBlocks.length, locale),
					period: periodText,
				})}
			>
				{autoBlocks.length === 0 ? (
					<NotEnoughData />
				) : (
					<BarRows
						rows={[...reasons.entries()]
							.sort((a, b) => b[1] - a[1])
							.map(([kind, count]) => ({
								label: reasonLabel(t, kind),
								value: count,
							}))}
					/>
				)}
			</StatsCard>

			<StatsCard
				span="third"
				title={t("stats.blocking.keywords", {
					defaultValue: "Keywords that work",
				})}
				sources={["log"]}
				meta={t("stats.blocking.keywords_meta", {
					defaultValue: "Profiles each keyword caught · {{period}}",
					period: periodText,
				})}
			>
				{keywordCounts.size === 0 ? (
					<NotEnoughData />
				) : (
					<BarRows
						rows={[...keywordCounts.entries()]
							.sort((a, b) => b[1] - a[1])
							.slice(0, 8)
							.map(([keyword, count]) => ({
								label: `“${keyword}”`,
								value: count,
							}))}
					/>
				)}
				{logStart != null && keywordEntries.length > 0 ? (
					<p className="mt-3 text-sm text-[var(--text-muted)]">
						{t("stats.blocking.unused_keywords", {
							defaultValue:
								"Caught nobody since {{date}}: {{unused}} of your {{total}} forbidden keywords",
							unused: unusedKeywords.length,
							total: keywordEntries.length,
							date: formatShortDate(unusedWindowStart, locale),
						})}
					</p>
				) : null}
			</StatsCard>

			<StatsCard
				span="third"
				title={t("stats.blocking.rules", {
					defaultValue: "Rules that fire most",
				})}
				sources={["log"]}
				meta={t("stats.blocking.rules_meta", {
					defaultValue: "Automation rules that blocked someone · {{period}}",
					period: periodText,
				})}
			>
				{rules.size === 0 ? (
					<NotEnoughData />
				) : (
					<BarRows
						rows={[...rules.entries()]
							.sort((a, b) => b[1] - a[1])
							.map(([name, count]) => ({ label: name, value: count }))}
					/>
				)}
			</StatsCard>

			<StatsCard
				span="third"
				title={t("stats.blocking.mistakes", {
					defaultValue: "Auto-block mistakes",
				})}
				sources={["log"]}
				meta={t("stats.blocking.mistakes_meta", {
					defaultValue: "Automatic blocks you undid yourself · {{period}}",
					period: periodText,
				})}
			>
				{autoBlocks.length === 0 ? (
					<NotEnoughData />
				) : mistakes.length === 0 ? (
					<p className="text-sm text-[var(--text-muted)]">
						{t("stats.blocking.no_mistakes", {
							defaultValue:
								"You have not unblocked anyone an automatic block caught.",
						})}
					</p>
				) : (
					<>
						<StatTiles
							items={[
								{
									label: t("stats.blocking.unblocked_by_you", {
										defaultValue: "Unblocked by you",
									}),
									value: formatNumber(mistakes.length, locale),
									sub: t("stats.of_whole", {
										defaultValue: "of {{whole}}",
										whole: autoBlocks.length,
									}),
								},
								{
									label: t("stats.blocking.most_from", {
										defaultValue: "Most from",
									}),
									value: topMistakeReason
										? reasonLabel(t, topMistakeReason[0])
										: "–",
									sub: topMistakeReason
										? t("stats.of_count", {
												defaultValue: "{{part}} of {{whole}}",
												part: topMistakeReason[1],
												whole:
													reasons.get(topMistakeReason[0]) ??
													topMistakeReason[1],
											})
										: undefined,
								},
							]}
						/>
						<div className="mt-3">
							<PeopleList
								numbered={false}
								rows={mistakes.slice(0, 5).map((row) => {
									const info = personName(context, row.profile_id as string);
									return {
										key: row.id,
										profileId: row.profile_id,
										name: info.name,
										imageHash: info.imageHash,
										sub: `${reasonLabel(t, row.reason_kind)} · ${formatDay(row.timestamp, locale)}`,
									};
								})}
							/>
						</div>
					</>
				)}
			</StatsCard>

			<StatsCard
				span="third"
				title={t("stats.blocking.before_replying", {
					defaultValue: "Blocked before replying",
				})}
				sources={["device"]}
				meta={t("stats.blocking.before_replying_meta", {
					defaultValue: "Chats you blocked without ever answering · {{period}}",
					period: periodText,
				})}
			>
				{hadChat === 0 ? (
					<NotEnoughData />
				) : (
					<BigNumber
						value={`${percent(neverReplied, hadChat)}%`}
						sub={t("stats.blocking.before_replying_sub", {
							defaultValue:
								"{{part}} of {{whole}} blocked people who had written to you",
							part: neverReplied,
							whole: hadChat,
						})}
					/>
				)}
			</StatsCard>

			<StatsCard
				span="third"
				title={t("stats.blocking.blocked_you", {
					defaultValue: "People who blocked you",
				})}
				sources={["device"]}
				meta={
					blockedYou.length > 0 && blockedYouDelay != null
						? t("stats.blocking.blocked_you_meta", {
								defaultValue:
									"{{count}} people · typically {{delay}} after the first message",
								count: blockedYou.length,
								delay: formatDuration(blockedYouDelay),
							})
						: periodText
				}
			>
				{blockedYou.length === 0 ? (
					<p className="text-sm text-[var(--text-muted)]">
						{t("stats.blocking.nobody_blocked_you", {
							defaultValue: "Nobody blocked you in this period.",
						})}
					</p>
				) : (
					<PeopleList
						numbered={false}
						rows={blockedYou.slice(0, 6).map((row) => {
							const info = row.profileId
								? personName(context, row.profileId)
								: null;
							const replied =
								row.firstOutTs != null && row.firstOutTs < row.timestamp;
							return {
								key: `${row.conversationId}:${row.timestamp}`,
								profileId: row.profileId,
								name: row.name ?? info?.name ?? null,
								imageHash: row.imageHash ?? info?.imageHash ?? null,
								sub: [
									formatDay(row.timestamp, locale),
									row.firstTs != null
										? t("stats.blocking.after_first", {
												defaultValue: "{{delay}} after first message",
												delay: formatDuration(row.timestamp - row.firstTs),
											})
										: null,
									row.firstTs == null
										? t("stats.blocking.no_messages", {
												defaultValue: "no messages saved",
											})
										: replied
											? t("stats.blocking.you_had_replied", {
													defaultValue: "you had replied",
												})
											: t("stats.blocking.you_had_not_replied", {
													defaultValue: "you hadn't replied",
												}),
								]
									.filter(Boolean)
									.join(" · "),
							};
						})}
					/>
				)}
			</StatsCard>

			<StatsCard
				span="third"
				title={t("stats.blocking.on_grindr", {
					defaultValue: "Blocked on Grindr",
				})}
				sources={["grindr"]}
				meta={t("stats.blocking.on_grindr_meta", {
					defaultValue:
						"Your whole block list, including blocks made in other apps",
				})}
			>
				<BigNumber
					value={
						grindrBlocked === "error"
							? "–"
							: grindrBlocked == null
								? "…"
								: formatNumber(grindrBlocked, locale)
					}
					sub={
						grindrBlocked === "error"
							? t("stats.grindr_failed", {
									defaultValue: "Grindr did not answer",
								})
							: undefined
					}
				/>
			</StatsCard>
		</StatsGrid>
	);
}
