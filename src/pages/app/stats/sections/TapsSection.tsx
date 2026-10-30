import { useTranslation } from "react-i18next";
import { formatDay, formatNumber } from "../statsFormat";
import {
	BarRows,
	NotEnoughData,
	SectionError,
	SectionLoading,
	StatsCard,
	StatsGrid,
	StatTiles,
} from "../StatsUi";
import { useStatsResource } from "../useStatsResource";
import type { SectionProps } from "./shared";

const TAP_LABELS: Record<number, { key: string; label: string }> = {
	0: { key: "friendly", label: "Friendly" },
	1: { key: "hot", label: "Hot" },
	2: { key: "looking", label: "Looking" },
};

export function TapsSection({ context, grindr, locale }: SectionProps) {
	const { t } = useTranslation();
	const resource = useStatsResource(async () => {
		const [taps, blocked] = await Promise.all([
			grindr.taps(),
			grindr.blockedIds().catch(() => null),
		]);
		return { taps, blocked };
	}, [grindr]);

	if (resource.status === "loading") return <SectionLoading />;
	if (resource.status === "error")
		return <SectionError error={resource.error} onRetry={resource.reload} />;
	const { taps, blocked } = resource.data;

	const warning = t("stats.taps.warning", {
		defaultValue:
			"Taps have no history on this device. These are only the taps Grindr returns when you open this page.",
	});

	const byType = new Map<string, { label: string; count: number }>();
	for (const tap of taps) {
		const known = tap.tapType != null ? TAP_LABELS[tap.tapType] : undefined;
		const key = known?.key ?? "other";
		const entry = byType.get(key) ?? {
			label: t(`interest_page.tap_labels.${known?.key ?? "default"}`, {
				defaultValue: known?.label ?? "Tap",
			}),
			count: 0,
		};
		entry.count += 1;
		byType.set(key, entry);
	}
	const oldest = taps.reduce<number | null>(
		(min, tap) =>
			tap.timestamp != null && (min == null || tap.timestamp < min)
				? tap.timestamp
				: min,
		null,
	);

	const viewerIds = new Set(context.views.map((view) => view.profileId));
	const alsoViewed = taps.filter((tap) => viewerIds.has(tap.profileId)).length;
	const messaged = taps.filter(
		(tap) => context.contactsByProfile.get(tap.profileId)?.firstIn != null,
	).length;
	const youBlocked = blocked
		? taps.filter((tap) => blocked.has(tap.profileId)).length
		: null;
	const neverSeen = taps.filter(
		(tap) =>
			!viewerIds.has(tap.profileId) &&
			!context.contactsByProfile.has(tap.profileId),
	).length;

	return (
		<StatsGrid>
			<StatsCard
				span="half"
				title={t("stats.taps.title", { defaultValue: "Taps" })}
				sources={["grindr"]}
				meta={
					oldest != null
						? t("stats.taps.meta_since", {
								defaultValue:
									"{{count}} taps returned by Grindr · oldest {{date}}",
								count: formatNumber(taps.length, locale),
								date: formatDay(oldest, locale),
							})
						: t("stats.taps.meta", {
								defaultValue: "{{count}} taps returned by Grindr",
								count: formatNumber(taps.length, locale),
							})
				}
				note={warning}
			>
				{taps.length === 0 ? (
					<NotEnoughData />
				) : (
					<BarRows
						rows={[...byType.values()]
							.sort((a, b) => b.count - a.count)
							.map((entry) => ({ label: entry.label, value: entry.count }))}
					/>
				)}
			</StatsCard>

			<StatsCard
				span="half"
				title={t("stats.taps.who", { defaultValue: "Who tapped you" })}
				sources={blocked ? ["grindr", "device"] : ["grindr"]}
				meta={t("stats.taps.who_meta", {
					defaultValue:
						"The same {{count}} taps, matched with what this device knows",
					count: formatNumber(taps.length, locale),
				})}
			>
				{taps.length === 0 ? (
					<NotEnoughData />
				) : (
					<StatTiles
						items={[
							{
								label: t("stats.taps.also_viewed", {
									defaultValue: "Also viewed you",
								}),
								value: formatNumber(alsoViewed, locale),
								sub: t("stats.of_whole", {
									defaultValue: "of {{whole}}",
									whole: taps.length,
								}),
							},
							{
								label: t("stats.taps.messaged", {
									defaultValue: "Messaged you",
								}),
								value: formatNumber(messaged, locale),
								sub: t("stats.of_whole", {
									defaultValue: "of {{whole}}",
									whole: taps.length,
								}),
							},
							{
								label: t("stats.taps.you_blocked", {
									defaultValue: "You blocked",
								}),
								value:
									youBlocked == null ? "–" : formatNumber(youBlocked, locale),
								sub: t("stats.of_whole", {
									defaultValue: "of {{whole}}",
									whole: taps.length,
								}),
							},
							{
								label: t("stats.taps.never_seen", {
									defaultValue: "Never seen before",
								}),
								value: formatNumber(neverSeen, locale),
								sub: t("stats.taps.never_seen_sub", {
									defaultValue: "no view or chat on this device",
								}),
							},
						]}
					/>
				)}
			</StatsCard>
		</StatsGrid>
	);
}
