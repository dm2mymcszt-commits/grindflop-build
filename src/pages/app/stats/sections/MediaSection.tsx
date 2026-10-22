import { useTranslation } from "react-i18next";
import { countByDay, sumBuckets } from "../statsCompute";
import {
	loadAlbumsReceived,
	loadDownloadedMedia,
	loadMessageTypes,
} from "../statsData";
import { formatNumber } from "../statsFormat";
import {
	BarChart,
	BarRows,
	NotEnoughData,
	SectionError,
	SectionLoading,
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

const DISAPPEARING = new Set(["ExpiringImage", "ExpiringVideo"]);
const KEPT = new Set(["Image", "Video", "NonExpiringVideo", "PrivateVideo"]);

function formatBytes(bytes: number, locale: string): string {
	if (bytes <= 0) return "0 B";
	const units = ["B", "KB", "MB", "GB", "TB"];
	const exponent = Math.min(
		Math.floor(Math.log(bytes) / Math.log(1024)),
		units.length - 1,
	);
	const value = bytes / 1024 ** exponent;
	return `${new Intl.NumberFormat(locale, { maximumFractionDigits: value < 10 ? 1 : 0 }).format(value)} ${units[exponent]}`;
}

export function MediaSection({
	context,
	period,
	grindr,
	locale,
}: SectionProps) {
	const { t } = useTranslation();
	const me = context.me;
	const resource = useStatsResource(async () => {
		const [albums, types, downloads] = await Promise.all([
			loadAlbumsReceived(me, period),
			loadMessageTypes(me, period),
			loadDownloadedMedia(),
		]);
		return { albums, types, downloads };
	}, [me, period.key, period.end]);
	const ownAlbums = useStatsResource(() => grindr.ownAlbums(), [grindr]);

	if (resource.status === "loading") return <SectionLoading />;
	if (resource.status === "error")
		return <SectionError error={resource.error} onRetry={resource.reload} />;
	const { albums, types, downloads } = resource.data;
	const periodText = periodLabel(t, period);

	const start = chartStart(period, [albums[0], context.sources.firstMessageAt]);
	const axis = chartAxis(start, period.end, locale);
	const albumsPerBucket = sumBuckets(axis.buckets, countByDay(albums));

	const media = (mine: boolean, set: Set<string>) =>
		types
			.filter(
				(row) =>
					(row.mine === 1) === mine && row.type != null && set.has(row.type),
			)
			.reduce((total, row) => total + row.count, 0);
	const receivedDisappearing = media(false, DISAPPEARING);
	const receivedKept = media(false, KEPT);
	const sentDisappearing = media(true, DISAPPEARING);
	const sentKept = media(true, KEPT);

	const photos = downloads.filter((entry) => entry.kind !== "video");
	const videos = downloads.filter((entry) => entry.kind === "video");
	const bytes = (list: typeof downloads) =>
		list.reduce((total, entry) => total + entry.byteSize, 0);

	return (
		<StatsGrid>
			<StatsCard
				span="wide"
				title={t("stats.media.albums", {
					defaultValue: "Albums shared with you",
				})}
				sources={["device"]}
				meta={t("stats.media.albums_meta", {
					defaultValue: "{{count}} albums shared in chats · {{period}}",
					count: formatNumber(albums.length, locale),
					period: periodText,
				})}
			>
				{albums.length === 0 ? (
					<NotEnoughData />
				) : (
					<BarChart
						labels={axis.labels}
						labelEvery={axis.labelEvery}
						details={axis.fullLabels.map(
							(label, index) =>
								`${label} · ${t("stats.albums_count", {
									defaultValue: "{{count}} albums",
									defaultValue_one: "{{count}} album",
									count: albumsPerBucket[index],
								})}`,
						)}
						series={[
							{
								name: t("stats.media.albums_series", {
									defaultValue: "Albums",
								}),
								values: albumsPerBucket,
							},
						]}
					/>
				)}
			</StatsCard>

			<StatsCard
				span="third"
				title={t("stats.media.photos_videos", {
					defaultValue: "Photos and videos",
				})}
				sources={["device"]}
				meta={periodText}
			>
				<StatTiles
					items={[
						{
							label: t("stats.media.received", { defaultValue: "Received" }),
							value: formatNumber(receivedDisappearing + receivedKept, locale),
							sub: t("stats.media.split", {
								defaultValue: "{{disappearing}} disappearing · {{kept}} kept",
								disappearing: receivedDisappearing,
								kept: receivedKept,
							}),
						},
						{
							label: t("stats.media.sent", { defaultValue: "Sent" }),
							value: formatNumber(sentDisappearing + sentKept, locale),
							sub: t("stats.media.split", {
								defaultValue: "{{disappearing}} disappearing · {{kept}} kept",
								disappearing: sentDisappearing,
								kept: sentKept,
							}),
						},
					]}
				/>
			</StatsCard>

			<StatsCard
				span="half"
				title={t("stats.media.saved", { defaultValue: "Saved to this device" })}
				sources={["device"]}
				meta={t("stats.media.saved_meta", {
					defaultValue:
						"{{count}} files · {{size}} · all time, on this device only",
					count: formatNumber(downloads.length, locale),
					size: formatBytes(bytes(downloads), locale),
				})}
			>
				{downloads.length === 0 ? (
					<NotEnoughData />
				) : (
					<BarRows
						rows={[
							{
								label: t("stats.media.photos", { defaultValue: "Photos" }),
								value: photos.length,
								display: formatNumber(photos.length, locale),
								sub: formatBytes(bytes(photos), locale),
							},
							{
								label: t("stats.media.videos", { defaultValue: "Videos" }),
								value: videos.length,
								display: formatNumber(videos.length, locale),
								sub: formatBytes(bytes(videos), locale),
							},
						]}
					/>
				)}
			</StatsCard>

			<StatsCard
				span="half"
				title={t("stats.media.your_albums", { defaultValue: "Your albums" })}
				sources={["grindr"]}
				meta={t("stats.media.your_albums_meta", {
					defaultValue: "How many people can open each album",
				})}
			>
				{ownAlbums.status === "loading" ? (
					<SectionLoading />
				) : ownAlbums.status === "error" ? (
					<p className="text-sm text-[var(--text-muted)]">
						{t("stats.grindr_failed", {
							defaultValue: "Grindr did not answer",
						})}
					</p>
				) : ownAlbums.data.length === 0 ? (
					<NotEnoughData>
						{t("stats.media.no_albums", {
							defaultValue: "You have no albums.",
						})}
					</NotEnoughData>
				) : (
					<BarRows
						rows={ownAlbums.data.map((album) => ({
							label:
								album.name?.trim() ||
								t("stats.media.untitled", { defaultValue: "Untitled album" }),
							value: album.shares ?? 0,
							display:
								album.shares == null
									? "–"
									: t("stats.people_count", {
											defaultValue: "{{count}} people",
											defaultValue_one: "{{count}} person",
											count: album.shares,
										}),
						}))}
					/>
				)}
				{ownAlbums.status === "ready" && ownAlbums.data.length > 0 ? (
					<p className="mt-2 text-xs text-[var(--text-muted)]">
						{t("stats.media.shares_total", {
							defaultValue: "{{count}} shares in total",
							defaultValue_one: "{{count}} share in total",
							count: sumValues(
								ownAlbums.data.map((album) => album.shares ?? 0),
							),
						})}
					</p>
				) : null}
			</StatsCard>
		</StatsGrid>
	);
}
