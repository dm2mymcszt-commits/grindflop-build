import { useState, type ReactNode } from "react";
import { ChevronRight, Hourglass, Loader2, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ProfileImage } from "../../../components/ui/profile-image";
import { useExplicitProfilePhotos } from "../../../hooks/useExplicitProfilePhotos";
import { isExplicitProfilePhoto } from "../../../services/explicitProfilePhotos";
import { HIDDEN_MEDIA_PLACEHOLDER } from "../../../utils/hiddenMediaPlaceholder";
import { getThumbImageUrl, validateMediaHash } from "../../../utils/media";
import { cn } from "../../../utils/cn";
import { personDisplayName, personStateLabel, usePerson } from "./statsPeople";

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

export type StatsSource = "device" | "grindr" | "log";

const SPAN_CLASSES = {
	full: "col-span-2 lg:col-span-12",
	wide: "col-span-2 lg:col-span-8",
	half: "col-span-2 md:col-span-1 lg:col-span-6",
	third: "col-span-2 md:col-span-1 lg:col-span-4",
	quarter: "col-span-2 md:col-span-1 lg:col-span-3",
} as const;

export type StatsSpan = keyof typeof SPAN_CLASSES;

export function StatsGrid({ children }: { children: ReactNode }) {
	return (
		<div className="grid grid-cols-2 gap-3 lg:grid-cols-12">{children}</div>
	);
}

export function SourceBadge({ source }: { source: StatsSource }) {
	const { t } = useTranslation();
	const config = {
		device: {
			label: t("stats.badge.device", { defaultValue: "This device" }),
			className: "bg-[var(--surface-2)] text-[var(--text-muted)]",
		},
		grindr: {
			label: t("stats.badge.grindr", { defaultValue: "Grindr" }),
			className: "bg-sky-500/15 text-sky-500",
		},
		log: {
			label: t("stats.badge.log", { defaultValue: "Stats log" }),
			className:
				"bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] text-[var(--accent-readable,var(--accent))]",
		},
	}[source];
	return (
		<span
			className={cn(
				"whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium",
				config.className,
			)}
		>
			{config.label}
		</span>
	);
}

export function StatsNote({ children }: { children: ReactNode }) {
	return (
		<div className="mt-3 flex gap-2 rounded-xl bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-600 dark:text-amber-300">
			<TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
			<span>{children}</span>
		</div>
	);
}

export function StatsCard({
	title,
	sources,
	meta,
	span = "third",
	note,
	children,
}: {
	title: string;
	sources: StatsSource[];
	meta?: ReactNode;
	span?: StatsSpan;
	note?: ReactNode;
	children: ReactNode;
}) {
	return (
		<article className={cn("surface-card min-w-0 p-4", SPAN_CLASSES[span])}>
			<div className="flex items-start justify-between gap-2">
				<h3 className="text-[15px] font-semibold leading-snug">{title}</h3>
				<div className="flex flex-wrap justify-end gap-1">
					{sources.map((source) => (
						<SourceBadge key={source} source={source} />
					))}
				</div>
			</div>
			{meta ? (
				<p className="mt-0.5 text-xs text-[var(--text-muted)]">{meta}</p>
			) : null}
			<div className="mt-3">{children}</div>
			{note ? <StatsNote>{note}</StatsNote> : null}
		</article>
	);
}

export function NotEnoughData({ children }: { children?: ReactNode }) {
	const { t } = useTranslation();
	return (
		<div className="flex flex-col items-center gap-1 py-4 text-center text-xs text-[var(--text-muted)]">
			<Hourglass className="h-5 w-5" />
			<p className="text-sm font-medium text-[var(--text)]">
				{t("stats.not_enough", { defaultValue: "Not enough data yet" })}
			</p>
			{children ? <p>{children}</p> : null}
		</div>
	);
}

export function SectionLoading() {
	return (
		<div className="flex items-center justify-center py-16 text-[var(--text-muted)]">
			<Loader2 className="h-6 w-6 animate-spin" />
		</div>
	);
}

export function SectionError({
	error,
	onRetry,
}: {
	error: unknown;
	onRetry: () => void;
}) {
	const { t } = useTranslation();
	return (
		<div className="surface-card flex flex-col items-center gap-3 p-6 text-center">
			<TriangleAlert className="h-6 w-6 text-amber-500" />
			<p className="text-sm">
				{t("stats.load_failed", {
					defaultValue: "This section could not be loaded.",
				})}
			</p>
			<p className="text-xs text-[var(--text-muted)]">
				{error instanceof Error ? error.message : String(error)}
			</p>
			<button
				type="button"
				onClick={onRetry}
				className="rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-medium hover:border-[var(--accent)]"
			>
				{t("stats.retry", { defaultValue: "Try again" })}
			</button>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

export type TileItem = {
	label: string;
	value: string;
	sub?: string;
	tone?: "good" | "bad" | "muted";
};

export function StatTiles({
	items,
	columns = 2,
}: {
	items: TileItem[];
	columns?: 2 | 3;
}) {
	return (
		<div
			className={cn(
				"grid gap-2",
				columns === 3 ? "grid-cols-2 sm:grid-cols-3" : "grid-cols-2",
			)}
		>
			{items.map((item) => (
				<div
					key={item.label}
					className="min-w-0 rounded-xl bg-[var(--surface-2)] px-3 py-2.5"
				>
					<p className="truncate text-xs text-[var(--text-muted)]">
						{item.label}
					</p>
					<p className="text-xl font-semibold leading-tight tabular-nums">
						{item.value}
					</p>
					{item.sub ? (
						<p
							className={cn(
								"text-xs",
								item.tone === "good"
									? "text-emerald-500"
									: item.tone === "bad"
										? "text-red-400"
										: "text-[var(--text-muted)]",
							)}
						>
							{item.sub}
						</p>
					) : null}
				</div>
			))}
		</div>
	);
}

export function BigNumber({ value, sub }: { value: string; sub?: string }) {
	return (
		<div>
			<p className="text-3xl font-semibold leading-tight tabular-nums">
				{value}
			</p>
			{sub ? <p className="text-xs text-[var(--text-muted)]">{sub}</p> : null}
		</div>
	);
}

export type BarRow = {
	label: string;
	value: number;
	display?: string;
	sub?: string;
};

/** Horizontal bars. `share` scales against 100 (percentages); otherwise against the largest row. */
export function BarRows({
	rows,
	share = false,
}: {
	rows: BarRow[];
	share?: boolean;
}) {
	const max = Math.max(1, ...rows.map((row) => row.value));
	return (
		<div className="grid gap-2.5">
			{rows.map((row) => (
				<div key={row.label}>
					<div className="flex items-end justify-between gap-3 text-sm">
						<span className="min-w-0 break-words">
							{row.label}
							{row.sub ? (
								<span className="block text-xs text-[var(--text-muted)]">
									{row.sub}
								</span>
							) : null}
						</span>
						<span className="shrink-0 tabular-nums">
							{row.display ?? row.value}
						</span>
					</div>
					<div className="mt-1 h-1.5 rounded-full bg-[var(--surface-2)]">
						<div
							className="h-1.5 rounded-full bg-[var(--accent)]"
							style={{
								width: `${Math.max(0, Math.min(100, share ? row.value : (row.value / max) * 100))}%`,
							}}
						/>
					</div>
				</div>
			))}
		</div>
	);
}

export function SplitBar({
	left,
	right,
	leftLabel,
	rightLabel,
}: {
	left: number;
	right: number;
	leftLabel: string;
	rightLabel: string;
}) {
	const total = left + right;
	const leftShare = total > 0 ? Math.round((left / total) * 100) : 0;
	return (
		<div>
			<div className="flex h-3 overflow-hidden rounded-full bg-[var(--surface-2)]">
				<div
					className="bg-[var(--accent)]"
					style={{ width: `${leftShare}%` }}
				/>
				<div
					className="bg-[color-mix(in_srgb,var(--text-muted)_55%,transparent)]"
					style={{ width: `${total > 0 ? 100 - leftShare : 0}%` }}
				/>
			</div>
			<div className="mt-2 flex justify-between text-sm tabular-nums">
				<span>
					{leftLabel} · {total > 0 ? `${leftShare}%` : "–"}
				</span>
				<span>
					{rightLabel} · {total > 0 ? `${100 - leftShare}%` : "–"}
				</span>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

export const SERIES_COLORS = {
	primary: "var(--accent)",
	secondary: "color-mix(in srgb, var(--text-muted) 55%, transparent)",
};

export type ChartSeries = {
	name: string;
	values: number[];
	color?: string;
	/** Striped, for values that are known to be incomplete. */
	hatched?: boolean;
};

const HATCH =
	"repeating-linear-gradient(135deg, color-mix(in srgb, var(--text-muted) 45%, transparent) 0 3px, transparent 3px 6px)";

function niceMax(value: number): number {
	for (const step of [
		1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000,
	]) {
		if (step * 4 >= value) return step * 4;
	}
	return Math.ceil(value / 4000) * 4000;
}

/**
 * Vertical bars, stacked or side by side. Tapping or hovering a bar shows its
 * exact values above the chart, so the numbers are readable on a phone too.
 */
export function BarChart({
	labels,
	details,
	series,
	grouped = false,
	height = 160,
	labelEvery = 1,
	marker,
}: {
	labels: string[];
	/** The full description of each bar, shown when it is selected. */
	details: string[];
	series: ChartSeries[];
	grouped?: boolean;
	height?: number;
	labelEvery?: number;
	/** Draws a dashed line before this bar index. */
	marker?: number;
}) {
	const [active, setActive] = useState<number | null>(null);
	const peak = grouped
		? Math.max(0, ...series.flatMap((s) => s.values))
		: Math.max(
				0,
				...labels.map((_, index) =>
					series.reduce((sum, s) => sum + (s.values[index] ?? 0), 0),
				),
			);
	const max = niceMax(Math.max(1, peak));
	const gap = labels.length > 20 ? 2 : 6;
	return (
		<div>
			<p className="mb-2 min-h-[1.25rem] text-xs text-[var(--text-muted)]">
				{active != null ? details[active] : " "}
			</p>
			<div className="grid grid-cols-[28px_minmax(0,1fr)] gap-x-2">
				<div className="relative" style={{ height }}>
					{[0, 1, 2, 3, 4].map((step) => (
						<span
							key={step}
							className="absolute right-0 translate-y-1/2 text-[10px] tabular-nums text-[var(--text-muted)]"
							style={{ bottom: `${step * 25}%` }}
						>
							{Math.round((max * step) / 4)}
						</span>
					))}
				</div>
				<div
					className="relative"
					style={{ height }}
					onPointerLeave={() => setActive(null)}
				>
					{[0, 1, 2, 3, 4].map((step) => (
						<div
							key={step}
							className="absolute inset-x-0 border-t border-dashed border-[var(--border)]"
							style={{ bottom: `${step * 25}%` }}
						/>
					))}
					{marker != null && labels.length > 0 ? (
						<div
							className="absolute -top-1 bottom-0 z-10 border-l-2 border-dashed border-[var(--accent)]"
							style={{ left: `calc(${(marker / labels.length) * 100}% - 1px)` }}
						/>
					) : null}
					<div className="absolute inset-0 flex items-end" style={{ gap }}>
						{labels.map((label, index) => (
							<button
								key={`${label}-${index}`}
								type="button"
								aria-label={details[index]}
								onPointerEnter={() => setActive(index)}
								onClick={() => setActive(index)}
								className={cn(
									"flex h-full min-w-0 flex-1",
									grouped
										? "flex-row items-end gap-px"
										: "flex-col-reverse gap-px",
									active === index ? "brightness-125" : "",
								)}
							>
								{series.map((s) => {
									const value = s.values[index] ?? 0;
									return (
										<span
											key={s.name}
											className={cn(
												"block",
												grouped
													? "flex-1 rounded-t-[3px]"
													: "w-full first:rounded-none last:rounded-t-[4px]",
											)}
											style={{
												height: `${(value / max) * 100}%`,
												background: s.hatched
													? HATCH
													: (s.color ?? SERIES_COLORS.primary),
											}}
										/>
									);
								})}
							</button>
						))}
					</div>
				</div>
				<div />
				<div className="mt-1 flex" style={{ gap }}>
					{labels.map((label, index) => (
						<span
							key={`${label}-${index}`}
							className="min-w-0 flex-1 overflow-visible whitespace-nowrap text-center text-[10px] text-[var(--text-muted)]"
						>
							{(labels.length - 1 - index) % labelEvery === 0 ? label : ""}
						</span>
					))}
				</div>
			</div>
			<ChartLegend series={series} />
		</div>
	);
}

export function ChartLegend({ series }: { series: ChartSeries[] }) {
	if (series.length < 2) return null;
	return (
		<div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--text-muted)]">
			{series.map((s) => (
				<span key={s.name} className="inline-flex items-center gap-1.5">
					<span
						className="inline-block h-2.5 w-2.5 rounded-[3px]"
						style={{
							background: s.hatched
								? HATCH
								: (s.color ?? SERIES_COLORS.primary),
						}}
					/>
					{s.name}
				</span>
			))}
		</div>
	);
}

/** Days of the week against hours of the day, darker where there is more. */
export function HeatGrid({
	values,
	rowLabels,
	describe,
}: {
	/** values[row][hour] */
	values: number[][];
	rowLabels: string[];
	describe: (row: number, hour: number, value: number) => string;
}) {
	const [active, setActive] = useState<string | null>(null);
	const max = Math.max(1, ...values.flat());
	return (
		<div>
			<p className="mb-2 min-h-[1.25rem] text-xs text-[var(--text-muted)]">
				{active ?? " "}
			</p>
			<div
				className="grid grid-cols-[34px_repeat(24,minmax(0,1fr))] items-center gap-[2px]"
				onPointerLeave={() => setActive(null)}
			>
				{values.map((row, rowIndex) => (
					<div key={rowLabels[rowIndex]} className="contents">
						<span className="text-[10px] text-[var(--text-muted)]">
							{rowLabels[rowIndex]}
						</span>
						{row.map((value, hour) => (
							<button
								key={hour}
								type="button"
								aria-label={describe(rowIndex, hour, value)}
								onPointerEnter={() =>
									setActive(describe(rowIndex, hour, value))
								}
								onClick={() => setActive(describe(rowIndex, hour, value))}
								className="h-4 rounded-[3px] sm:h-5"
								style={{
									background:
										value > 0
											? `color-mix(in srgb, var(--accent) ${Math.round(15 + (value / max) * 85)}%, transparent)`
											: "var(--surface-2)",
								}}
							/>
						))}
					</div>
				))}
				<span />
				{Array.from({ length: 24 }, (_, hour) => (
					<span key={hour} className="text-[10px] text-[var(--text-muted)]">
						{hour % 6 === 0 ? `${hour}h` : ""}
					</span>
				))}
			</div>
		</div>
	);
}

export type CoverageCell = {
	label: string;
	detail: string;
	state: "full" | "partial" | "none" | "before";
	share: number;
};

export function CoverageStrip({ cells }: { cells: CoverageCell[] }) {
	const { t } = useTranslation();
	const [active, setActive] = useState<number | null>(null);
	return (
		<div>
			<p className="mb-2 min-h-[1.25rem] text-xs text-[var(--text-muted)]">
				{active != null ? cells[active]?.detail : " "}
			</p>
			<div className="flex gap-[3px]" onPointerLeave={() => setActive(null)}>
				{cells.map((cell, index) => (
					<button
						key={`${cell.label}-${index}`}
						type="button"
						aria-label={cell.detail}
						onPointerEnter={() => setActive(index)}
						onClick={() => setActive(index)}
						className="h-7 min-w-0 flex-1 rounded-[5px]"
						style={{
							background:
								cell.state === "before"
									? HATCH
									: cell.state === "none"
										? "var(--surface-2)"
										: cell.state === "full"
											? "var(--accent)"
											: `color-mix(in srgb, var(--accent) ${Math.round(25 + cell.share * 50)}%, transparent)`,
						}}
					/>
				))}
			</div>
			<div className="mt-1 flex justify-between text-[10px] text-[var(--text-muted)]">
				<span>{cells[0]?.label}</span>
				<span>{cells[cells.length - 1]?.label}</span>
			</div>
			<ChartLegend
				series={[
					{
						name: t("stats.coverage.full", {
							defaultValue: "Recorded all day",
						}),
						values: [],
						color: "var(--accent)",
					},
					{
						name: t("stats.coverage.partial", {
							defaultValue: "Partly recorded",
						}),
						values: [],
						color: "color-mix(in srgb, var(--accent) 45%, transparent)",
					},
					{
						name: t("stats.coverage.none", { defaultValue: "Not recorded" }),
						values: [],
						color: "var(--surface-2)",
					},
					{
						name: t("stats.coverage.before", {
							defaultValue: "Before Stats was on",
						}),
						values: [],
						hatched: true,
					},
				]}
			/>
		</div>
	);
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

export type PersonRowItem = {
	key: string;
	/** Their profile opens when this is set. */
	profileId: string | null;
	/** The name saved on this device. Without one, Grindr is asked. */
	name: string | null;
	imageHash: string | null;
	sub?: string;
	value?: string;
};

export function PeopleList({
	rows,
	numbered = true,
}: {
	rows: PersonRowItem[];
	numbered?: boolean;
}) {
	return (
		<ol className="divide-y divide-[var(--border)]">
			{rows.map((row, index) => (
				<PersonRow
					key={row.key}
					row={row}
					rank={numbered ? index + 1 : null}
				/>
			))}
		</ol>
	);
}

function PersonRow({ row, rank }: { row: PersonRowItem; rank: number | null }) {
	const { t } = useTranslation();
	const person = usePerson(row.profileId, row.name, row.imageHash);
	useExplicitProfilePhotos();
	const status = personStateLabel(t, person.lookup?.state);
	const imageHash = row.imageHash ?? person.lookup?.imageHash ?? null;
	return (
		<li>
			<button
				type="button"
				onClick={person.open}
				disabled={!person.open || person.opening}
				className="flex w-full items-center gap-3 py-2 text-left disabled:cursor-default"
			>
				{rank != null ? (
					<span
						className={cn(
							"w-4 shrink-0 text-sm font-semibold tabular-nums",
							rank <= 3 ? "text-[var(--accent)]" : "text-[var(--text-muted)]",
						)}
					>
						{rank}
					</span>
				) : null}
				<span className="h-9 w-9 shrink-0 overflow-hidden rounded-full">
					<ProfileImage
						src={
							imageHash && validateMediaHash(imageHash)
								? isExplicitProfilePhoto(imageHash)
									? HIDDEN_MEDIA_PLACEHOLDER
									: getThumbImageUrl(imageHash)
								: null
						}
						alt=""
						iconClassName="h-4 w-4"
					/>
				</span>
				<span className="min-w-0 flex-1">
					<span className="flex min-w-0 items-baseline gap-1.5">
						<span className="truncate text-sm">
							{personDisplayName(t, row.name, person)}
						</span>
						{status ? (
							<span className="shrink-0 text-xs text-[var(--text-muted)]">
								{status}
							</span>
						) : null}
					</span>
					{row.sub ? (
						<span className="block truncate text-xs text-[var(--text-muted)]">
							{row.sub}
						</span>
					) : null}
				</span>
				{row.value ? (
					<span className="shrink-0 text-sm font-semibold tabular-nums">
						{row.value}
					</span>
				) : null}
				{person.opening ? (
					<Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--text-muted)]" />
				) : person.open ? (
					<ChevronRight className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
				) : null}
			</button>
		</li>
	);
}
