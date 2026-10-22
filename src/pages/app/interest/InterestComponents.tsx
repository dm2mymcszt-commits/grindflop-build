import { memo, type CSSProperties } from "react";
import { Eye, Lock, Ban, History, MoveHorizontal, CalendarDays, Clock, Trophy } from "lucide-react";
import { useTranslation } from "react-i18next";
import { getThumbImageUrl } from "../../../utils/media";
import { useExplicitProfilePhotos } from "../../../hooks/useExplicitProfilePhotos";
import { isExplicitProfilePhoto } from "../../../services/explicitProfilePhotos";
import { HIDDEN_MEDIA_PLACEHOLDER } from "../../../utils/hiddenMediaPlaceholder";
import { ProfileImage } from "../../../components/ui/profile-image";
import {
	type InterestItem,
	type InterestTab,
	type InterestViewsSort,
	type InterestViewsWindow,
	formatTimestamp,
	getTapEmoji,
	PREVIEW_ID_PREFIX,
} from "./interestUtils";
import { cn } from "../../../utils/cn";
import { useRevealOnScroll } from "../../../hooks/useRevealOnScroll";

export const InterestTabs = memo(function InterestTabs({
	activeTab,
	onViewsClick,
	onTapsClick,
	firstTab = "taps",
	shouldBounce = false,
	newViewsCount = 0,
	newTapsCount = 0,
}: {
	activeTab: InterestTab;
	onViewsClick: () => void;
	onTapsClick: () => void;
	firstTab?: InterestTab;
	shouldBounce?: boolean;
	newViewsCount?: number;
	newTapsCount?: number;
}) {
	const { t } = useTranslation();

	const isViewsFirst = firstTab === "views";

	// Determine logical order of labels based on firstTab
	const labels = isViewsFirst
		? [t("interest_page.tabs.views"), t("interest_page.tabs.taps")]
		: [t("interest_page.tabs.taps"), t("interest_page.tabs.views")];

	const handlers = isViewsFirst
		? [onViewsClick, onTapsClick]
		: [onTapsClick, onViewsClick];

	const counts = isViewsFirst
		? [newViewsCount, newTapsCount]
		: [newTapsCount, newViewsCount];

	// Index of the currently active tab in the visual array
	const activeIndex = isViewsFirst
		? (activeTab === "views" ? 0 : 1)
		: (activeTab === "taps" ? 0 : 1);

	return (
		<div className="glass-pill relative inline-grid grid-cols-2 items-center p-1">
			{/*
				The sliding pill. Both tabs share one column width, so the pill is always
				exactly one column wide and moves by translating a whole column. Nothing
				is measured, and it animates a transform rather than left and width, so
				WebKit has no layout animation to leave stranded part-way — which is how
				it kept freezing as a small circle over the wrong tab.
			*/}
			<div
				aria-hidden="true"
				className="absolute top-1 bottom-1 left-1 rounded-full bg-[var(--accent)] shadow-sm transition-transform duration-300 ease-out"
				style={{
					width: "calc(50% - 0.25rem)",
					transform: `translateX(calc(${activeIndex * 100}% + ${shouldBounce ? 8 : 0}px))`,
				}}
			/>

			{labels.map((label, i) => (
				<button
					key={label}
					type="button"
					onClick={handlers[i]}
					className={cn(
						"relative z-10 flex h-8 items-center justify-center rounded-full px-5 transition-all duration-300 ease-out active:scale-95",
						shouldBounce && "translate-x-2",
						activeIndex === i
							? "text-[var(--accent-contrast)] text-base font-black tracking-tight"
							: "text-[var(--accent)] hover:opacity-80 text-sm font-bold"
					)}
				>
					<span>{label}</span>
					<span
						className={cn(
							"flex h-4.5 items-center justify-center rounded-full text-[10px] font-black transition-all duration-300 ease-out overflow-hidden",
							counts[i] > 0
								? "ml-2 min-w-[1.125rem] px-1 opacity-100 scale-100"
								: "ml-0 min-w-0 w-0 px-0 opacity-0 scale-50 pointer-events-none",
							activeIndex === i
								? "bg-[var(--accent-contrast)] text-[var(--accent)]"
								: "bg-[var(--accent)] text-[var(--accent-contrast)]"
						)}
					>
						{counts[i] > 0 ? (counts[i] > 99 ? "99+" : counts[i]) : ""}
					</span>
				</button>
			))}
		</div>
	);
});

/**
 * Views-tab sort switch: newest-first (the default) versus a leaderboard of
 * the people who've viewed us most.
 *
 * Collapsed to the icon alone in "recent" mode so it stays out of the way of
 * the tabs pill on narrow screens, and expands to show its label once ranking
 * is on — the state that isn't the default is the one worth spelling out.
 */
export const ViewsSortToggle = memo(function ViewsSortToggle({
	sort,
	onToggle,
}: {
	sort: InterestViewsSort;
	onToggle: () => void;
}) {
	const { t } = useTranslation();
	const isRanked = sort === "most_viewed";
	const label = t(`interest_page.sort.${isRanked ? "most_viewed" : "recent"}`);

	return (
		<button
			type="button"
			onClick={onToggle}
			title={t("interest_page.sort.toggle_hint")}
			aria-label={t("interest_page.sort.toggle_hint")}
			aria-pressed={isRanked}
			className={cn(
				"glass-pill flex h-8 shrink-0 items-center justify-center overflow-hidden transition-all duration-500 ease-in-out active:scale-95",
				isRanked ? "pl-3 pr-3.5" : "neutral px-2.5",
			)}
			style={{ "--pill-color": "var(--accent)" } as CSSProperties}
		>
			{isRanked ? (
				<Trophy className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
			) : (
				<Clock className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
			)}
			<span
				className={cn(
					"overflow-hidden whitespace-nowrap text-[10px] font-bold uppercase leading-none tracking-widest text-[var(--accent)] transition-all duration-500 ease-in-out",
					isRanked ? "ml-2 max-w-[140px] opacity-100" : "ml-0 max-w-0 opacity-0",
				)}
			>
				{label}
			</span>
		</button>
	);
});

/**
 * Views-tab recency scope: everything, the last 24 hours, or the last 7 days.
 *
 * Cycles on tap rather than opening a picker — three options with an obvious
 * order don't earn a popover, and the tabs pill leaves little room beside it.
 * The calendar icon appears only while a window is active, so the default
 * state stays narrow and a filtered list is visibly filtered.
 */
export const ViewsWindowToggle = memo(function ViewsWindowToggle({
	viewsWindow,
	onToggle,
}: {
	viewsWindow: InterestViewsWindow;
	onToggle: () => void;
}) {
	const { t } = useTranslation();
	const isFiltered = viewsWindow !== "all";

	return (
		<button
			type="button"
			onClick={onToggle}
			title={t("interest_page.window.toggle_hint")}
			aria-label={t("interest_page.window.toggle_hint")}
			className={cn(
				"glass-pill flex h-8 shrink-0 items-center justify-center gap-1.5 px-2.5 transition-all duration-500 ease-in-out active:scale-95",
				isFiltered ? "text-[var(--accent)]" : "neutral text-[var(--text-muted)]",
			)}
			style={{ "--pill-color": "var(--accent)" } as CSSProperties}
		>
			{isFiltered && <CalendarDays className="h-3.5 w-3.5 shrink-0" />}
			<span className="whitespace-nowrap text-[10px] font-bold uppercase leading-none tracking-widest">
				{t(`interest_page.window.${viewsWindow}`)}
			</span>
		</button>
	);
});

/** Medal tints for the podium; everyone below it ranks in muted text. */
const rankColorMap: Record<number, string> = {
	1: "#FFC93C",
	2: "#C7CDD4",
	3: "#D08A4E",
};

const emojiColorMap: Record<number, string> = {
	0: "255, 200, 0", // 👋
	1: "255, 140, 0", // 🔥
	2: "168, 85, 247", // 😈
};

export const InterestRow = memo(function InterestRow({
	item,
	mode,
	onOpenProfile,
	now,
	isFirst,
	isBlocked = false,
	rank = null,
	nickname = null,
}: {
	item: InterestItem;
	mode: InterestTab;
	onOpenProfile: (profileId: string) => void;
	now: number;
	isFirst?: boolean;
	isBlocked?: boolean;
	/** 1-based leaderboard position, or null when the list isn't ranked. */
	rank?: number | null;
	/** The name the user gave them, shown in place of their own. */
	nickname?: string | null;
}) {
	const { t } = useTranslation();
	const { ref, revealClass } = useRevealOnScroll();
	// A photo the detector called explicit is drawn as the hidden tile.
	useExplicitProfilePhotos();
	const imageSrc = !item.imageHash
		? null
		: isExplicitProfilePhoto(item.imageHash)
			? HIDDEN_MEDIA_PLACEHOLDER
			: getThumbImageUrl(item.imageHash, "320x320");

	const isPrivate = !item.canOpenProfile;
	// A blocked person keeps the muted look and the badge but still opens:
	// their page says who blocked whom and offers Unblock.
	const isMuted = isPrivate || isBlocked;
	const isRecovered = !!item.isFromCache && !isPrivate && !item.profileId.startsWith(PREVIEW_ID_PREFIX);
	const isOnline = typeof item.onlineUntil === "number" && item.onlineUntil > now;

	const displayName = nickname
		? nickname
		: item.displayName
		? item.displayName
		: isPrivate
			? t("interest_page.unknown_profile")
			: t("interest_page.profile_fallback", { id: item.profileId });

	return (
		<div
			ref={ref}
			className={cn(
				"relative flex items-center gap-4 pl-4 pr-4 py-3 transition-colors",
				isMuted && "opacity-75 grayscale-[0.3]",
				!isPrivate && "hover:bg-[var(--surface-2)]/40",
				revealClass
			)}
		>
			{/* Leaderboard position (ranked views only) */}
			{rank != null && (
				<div className="-mr-1 flex min-w-5 shrink-0 items-center justify-center">
					<span
						className={cn(
							"font-black leading-none tabular-nums",
							rank >= 100 ? "text-[11px]" : "text-sm",
						)}
						style={{
							color: rankColorMap[rank] ?? "var(--text-muted)",
							textShadow: rankColorMap[rank] ? `0 0 8px ${rankColorMap[rank]}66` : undefined,
						}}
					>
						{rank}
					</span>
				</div>
			)}

			{/* Avatar */}
			<button
				type="button"
				onClick={() => !isPrivate && onOpenProfile(item.profileId)}
				disabled={isPrivate}
				className="relative shrink-0"
			>
				<div className="h-15 w-15 squircle drop-shadow-sm bg-[var(--surface-2)]">
					<ProfileImage
						src={imageSrc}
						alt={displayName}
					/>
				</div>
				{isOnline && (
					<span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-[1.5px] border-[var(--bg)] bg-green-500 shadow-sm z-10" />
				)}
				{isMuted && (
					<div className="absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-[var(--surface-2)] text-[var(--text-muted)] ring-1 ring-[var(--surface)] z-10">
						{isPrivate ? <Lock className="h-3 w-3" /> : <span title={t("interest_page.blocked_profile")}><Ban className="h-3 w-3" /></span>}
					</div>
				)}
			</button>

			{/* Info */}
			<div className="min-w-0 flex-1">
				<button
					type="button"
					onClick={() => !isPrivate && onOpenProfile(item.profileId)}
					disabled={isPrivate}
					className="w-full text-left"
				>
					<div className="flex items-center gap-1.5">
						<p className={`truncate text-sm font-bold ${isMuted ? "text-[var(--text-muted)]" : "text-[var(--text)]"}`}>
							{displayName}
						</p>
						{isRecovered && (
							<span title={t("interest_page.recovered_tooltip")}><History className="h-3 w-3 text-[var(--accent)]" /></span>
						)}
					</div>
					<p className="mt-0.5 truncate text-xs text-[var(--text-muted)] font-medium">
						{formatTimestamp(item.timestamp, t, now)}
					</p>
				</button>
			</div>

			{/* Action Area (Views or Taps) */}
			{!isPrivate && (
				<div className="shrink-0 flex items-center justify-center h-12 w-12">
					{mode === "taps" ? (
						<div className="relative flex h-12 w-12 items-center justify-center">
							<span
								className="text-2xl leading-none select-none"
								style={{
									filter: `drop-shadow(0 0 3px rgba(${emojiColorMap[item.tapType ?? 0] || "255, 200, 0"}, 0.55)) drop-shadow(0 0 7px rgba(${emojiColorMap[item.tapType ?? 0] || "255, 200, 0"}, 0.3))`,
								}}
							>
								{getTapEmoji(item.tapType)}
							</span>
							{item.isMutual && (
								<span
									className="absolute -bottom-0.5 -right-0.5 flex h-4.5 w-4.5 items-center justify-center rounded-full text-white shadow-md"
									style={{ backgroundColor: `rgb(${emojiColorMap[item.tapType ?? 0] || "255, 200, 0"})` }}
									title={t("interest_page.mutual_tap_tooltip")}
								>
									<MoveHorizontal className="h-2.5 w-2.5" />
								</span>
							)}
						</div>
					) : (
						<div
							className="glass-pill flex h-8 items-center gap-1.5 px-3"
							style={{
								"--pill-color": rank != null ? "var(--accent)" : "var(--text-muted)",
							} as CSSProperties}
						>
							<Eye
								className={cn(
									"h-3.5 w-3.5",
									rank != null ? "text-[var(--accent)]" : "text-[var(--text-muted)]",
								)}
							/>
							<span
								className={cn(
									"text-xs font-bold leading-none tabular-nums",
									rank != null ? "text-[var(--accent)]" : "text-[var(--text)]",
								)}
							>
								{item.viewCount || 1}
							</span>
						</div>
					)}
				</div>
			)}

			{isFirst && <div className="absolute top-0 right-0 left-0 h-px bg-[var(--surface-2)]" />}
			{/* Full-width Divider */}
			<div className="absolute bottom-0 right-0 left-0 h-px bg-[var(--surface-2)]" />
		</div>
	);
});
