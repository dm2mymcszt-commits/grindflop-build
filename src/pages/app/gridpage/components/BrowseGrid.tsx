import type { BrowseCard } from "../../GridPage.types";
import { BrowseCardTile } from "./BrowseCardTile";
import { usePreferences } from "../../../../contexts/PreferencesContext";
import { cn } from "../../../../utils/cn";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Ghost, MapPin } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
	EmptyState,
	ErrorState,
} from "../../../../components/ui/states";
import { Button } from "../../../../components/ui/button";
import { getAsyncState } from "../../../../hooks/useAsyncViewState";
import type { ChatContactIndexRecord } from "../../../../types/chat-contact-index";
import { chunkIntoRows, rowTopAtOrAbove } from "../gridRows";

// Rows kept mounted beyond each edge of the screen. Enough that a quick flick
// lands on tiles that already exist rather than on empty space, few enough
// that what is mounted stays a small fraction of what is loaded.
const OVERSCAN_ROWS = 4;

function BrowseGridSkeleton({ isDesktop, mobileColumns }: { isDesktop: boolean; mobileColumns: "2" | "3" }) {
	const count = isDesktop ? 30 : mobileColumns === "2" ? 16 : 24;
	return (
		<div
			className={cn("w-full grid", isDesktop ? "gap-2 px-[var(--app-px)]" : "gap-px")}
			style={{
				gridTemplateColumns: isDesktop
					? "repeat(6, minmax(0, 1fr))"
					: mobileColumns === "2"
						? "repeat(auto-fill, minmax(clamp(33.4%, 15vw, 250px), 1fr))"
						: "repeat(auto-fill, minmax(clamp(25.1%, 15vw, 250px), 1fr))",
			}}
		>
			{Array.from({ length: count }).map((_, i) => (
				<div
					key={i}
					className={cn(
						"animate-pulse bg-[var(--surface-2)] relative w-full h-0 pb-[100%] overflow-hidden",
						!isDesktop && "rounded-[4px]",
						isDesktop && "rounded-xl",
					)}
				>
					<div className="absolute inset-x-0 top-0 bg-gradient-to-b from-black/30 to-transparent p-2 flex flex-col gap-1.5">
						<div className="h-2.5 w-16 rounded-full bg-white/20" />
					</div>
					<div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/30 to-transparent p-2 flex gap-1">
						<div className="h-2 w-8 rounded-full bg-white/20" />
					</div>
				</div>
			))}
		</div>
	);
}

type RowMetrics = {
	columnCount: number;
	/** One row plus the gap under it: the distance from one row's top to the next. */
	rowSizePx: number;
	/** False until the browser has been asked; until then the numbers are a guess. */
	measured: boolean;
};

type BrowseGridProps = {
	isLoadingCards: boolean;
	cardsError: string | null;
	isLocationMissing?: boolean;
	/** Incognito mode is on: the grid is not loaded at all, and says so. */
	isIncognitoActive?: boolean;
	onOpenLocation?: () => void;
	onManagePrivacy?: () => void;
	cards: BrowseCard[];
	chatContactIndexByProfileId?: Record<string, ChatContactIndexRecord>;
	localNicknamesByProfileId?: Record<string, string>;
	onSelectProfile: (profileId: string) => void;
	onMessageProfile: (profileId: string) => void;
	hasMore?: boolean;
	isLoadingMore?: boolean;
	onLoadMore?: () => void;
	/**
	 * Changes each time a page was fetched, whether or not it added a tile
	 * (the filters applied on this device can leave a page with nothing to show).
	 */
	loadMoreKey?: string | null;
	hideImages?: boolean;
	// The grid scrolls inside an ancestor the page renders (FeedScrollContainer),
	// so the windowing needs that element rather than a scroller of its own.
	scrollContainerRef: RefObject<HTMLDivElement | null>;
	// Restoring the scroll position, and lining a row up under the header, live
	// here: only this component knows how tall a row is and where the grid
	// starts, and the tile that used to be looked up in the page at the restored
	// position is not there to find any more.
	headerRef?: RefObject<HTMLElement | null>;
	browseCacheKey?: string;
	hasRestoredScroll: boolean;
	onRestoredScrollChange: (restored: boolean) => void;
};

export function BrowseGrid({
	isLoadingCards,
	cardsError,
	isLocationMissing,
	isIncognitoActive,
	onOpenLocation,
	onManagePrivacy,
	cards,
	chatContactIndexByProfileId,
	localNicknamesByProfileId,
	onSelectProfile,
	onMessageProfile,
	hasMore,
	isLoadingMore,
	onLoadMore,
	loadMoreKey,
	hideImages,
	scrollContainerRef,
	headerRef,
	browseCacheKey,
	hasRestoredScroll,
	onRestoredScrollChange,
}: BrowseGridProps) {
	const { t } = useTranslation();
	const { mobileGridColumns } = usePreferences();
	const [isDesktop, setIsDesktop] = useState(() => {
		if (typeof window === "undefined") {
			return false;
		}
		return window.matchMedia("(hover: hover) and (pointer: fine)").matches;
	});

	useEffect(() => {
		if (typeof window === "undefined") {
			return;
		}

		const query = window.matchMedia("(hover: hover) and (pointer: fine)");
		const update = () => setIsDesktop(query.matches);

		update();
		query.addEventListener("change", update);
		return () => query.removeEventListener("change", update);
	}, []);

	const gridTemplateColumns = isDesktop
		? "repeat(6, minmax(0, 1fr))"
		: mobileGridColumns === "2"
			? "repeat(auto-fill,  minmax(clamp(33.4%, 15vw, 250px), 1fr))"
			: "repeat(auto-fill,  minmax(clamp(25.1%, 15vw, 250px), 1fr))";
	const gridClassName = cn("grid w-full", isDesktop ? "gap-2 px-[var(--app-px)]" : "gap-px");

	// How many columns fit and how tall a row is (a tile is always square, see
	// BrowseCardTile) cannot be worked out here: on a phone the template is
	// auto-fill over a clamp() of percentages, which the browser resolves at
	// layout. So they are read back from a probe: an empty, invisible grid with
	// the very same template and classes as a real row.
	const probeElRef = useRef<HTMLDivElement | null>(null);
	const probeObserverRef = useRef<ResizeObserver | null>(null);
	const [rowMetrics, setRowMetrics] = useState<RowMetrics>(() => ({
		columnCount: isDesktop ? 6 : mobileGridColumns === "2" ? 2 : 3,
		rowSizePx: 140,
		measured: false,
	}));

	const measureProbe = useCallback((el: HTMLDivElement) => {
		const style = window.getComputedStyle(el);
		const tracks = style.gridTemplateColumns.split(" ").filter(Boolean);
		const columnCount = tracks.length;
		const columnWidthPx = parseFloat(tracks[0] ?? "0");
		const rowGapPx = parseFloat(style.rowGap || "0") || 0;
		if (columnCount > 0 && columnWidthPx > 0) {
			const rowSizePx = columnWidthPx + rowGapPx;
			setRowMetrics((prev) =>
				prev.measured && prev.columnCount === columnCount && prev.rowSizePx === rowSizePx
					? prev
					: { columnCount, rowSizePx, measured: true },
			);
		}
	}, []);

	const probeRefCallback = useCallback(
		(el: HTMLDivElement | null) => {
			probeObserverRef.current?.disconnect();
			probeObserverRef.current = null;
			probeElRef.current = el;
			if (!el) {
				return;
			}
			measureProbe(el);
			const observer = new ResizeObserver(() => measureProbe(el));
			observer.observe(el);
			probeObserverRef.current = observer;
		},
		[measureProbe],
	);

	useEffect(() => {
		if (probeElRef.current) {
			measureProbe(probeElRef.current);
		}
	}, [gridTemplateColumns, gridClassName, measureProbe]);

	// Where the grid starts inside the scroll container: the container pads its
	// top so the feed can slide under the page header. The windowing has to know,
	// or it would count rows as on screen while they are still under that padding.
	const listElRef = useRef<HTMLDivElement | null>(null);
	const [scrollMargin, setScrollMargin] = useState(0);
	const readScrollMargin = useCallback((): number | null => {
		const list = listElRef.current;
		const container = scrollContainerRef.current;
		if (!list || !container) {
			return null;
		}
		return list.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
	}, [scrollContainerRef]);
	const measureScrollMargin = useCallback(() => {
		const next = readScrollMargin();
		if (next === null) {
			return;
		}
		setScrollMargin((prev) => (Math.abs(prev - next) < 0.5 ? prev : next));
	}, [readScrollMargin]);
	const listRefCallback = useCallback(
		(el: HTMLDivElement | null) => {
			listElRef.current = el;
			if (el) {
				measureScrollMargin();
			}
		},
		[measureScrollMargin],
	);
	// It only moves when the layout does: the row size changing covers a resize,
	// a rotation and a change of text size alike.
	useLayoutEffect(() => {
		measureScrollMargin();
	}, [measureScrollMargin, rowMetrics.rowSizePx, rowMetrics.columnCount]);

	const rows = useMemo(() => chunkIntoRows(cards, rowMetrics.columnCount), [cards, rowMetrics.columnCount]);

	const getItemKey = useCallback((index: number) => rows[index]?.[0]?.profileId ?? index, [rows]);

	const rowVirtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => scrollContainerRef.current,
		estimateSize: () => rowMetrics.rowSizePx,
		overscan: OVERSCAN_ROWS,
		scrollMargin,
		getItemKey,
	});

	// The row size is handed over as an estimate and then kept, so a new one
	// (a resize, a rotation, another column setting) has to be pushed in.
	useLayoutEffect(() => {
		rowVirtualizer.measure();
	}, [rowVirtualizer, rowMetrics.rowSizePx]);

	const virtualRows = rowVirtualizer.getVirtualItems();
	const lastVirtualRowIndex = virtualRows.length > 0 ? virtualRows[virtualRows.length - 1].index : -1;

	// Ask for the next page once the last loaded row is among the mounted ones,
	// which is a few rows before the reader gets to it. One request per arrival:
	// the same end of the same list is not asked for twice, so a request that
	// failed is not hammered, and leaving the end and coming back asks again.
	// A page that added no tile still moves loadMoreKey, so the scan goes on.
	const requestedForRef = useRef<string | null>(null);
	useEffect(() => {
		const isAtEnd = rows.length > 0 && lastVirtualRowIndex >= rows.length - 1;
		if (!isAtEnd) {
			requestedForRef.current = null;
			return;
		}
		if (!hasMore || !onLoadMore || isLoadingMore) {
			return;
		}
		const requestKey = `${rows.length}:${loadMoreKey ?? ""}`;
		if (requestedForRef.current === requestKey) {
			return;
		}
		requestedForRef.current = requestKey;
		onLoadMore();
	}, [lastVirtualRowIndex, rows.length, hasMore, isLoadingMore, onLoadMore, loadMoreKey]);

	// Put the grid back where it was left once the cards are in, then nudge it
	// so the top row lines up under the header instead of being cut by it.
	useLayoutEffect(() => {
		if (cards.length === 0 || hasRestoredScroll || isLoadingCards) {
			return;
		}
		// Until the real row size is known the grid is not its real height, and a
		// position near the end would be clamped to somewhere else.
		if (!rowMetrics.measured) {
			// The grid itself is not what is on screen (no location, an error):
			// there is nothing to put back.
			if (!probeElRef.current) {
				onRestoredScrollChange(true);
				return;
			}
			// It is, and the browser answers on the next render. The page keeps
			// the grid hidden until this is settled, so should the answer never
			// come, carry on without restoring rather than leave it hidden.
			const giveUp = window.setTimeout(() => onRestoredScrollChange(true), 500);
			return () => window.clearTimeout(giveUp);
		}

		const container = scrollContainerRef.current;
		const saved = browseCacheKey ? sessionStorage.getItem(`grid-scroll-${browseCacheKey}`) : null;
		const savedScrollTop = saved ? parseInt(saved, 10) : 0;
		if (!container || !(savedScrollTop > 0)) {
			onRestoredScrollChange(true);
			return;
		}

		container.scrollTop = savedScrollTop;

		const header = headerRef?.current;
		const listTop = readScrollMargin();
		if (header && listTop !== null) {
			const headerLine =
				container.scrollTop + (header.getBoundingClientRect().bottom - container.getBoundingClientRect().top);
			const rowTop = rowTopAtOrAbove(headerLine, listTop, rowMetrics.rowSizePx);
			if (rowTop !== null && rowTop < headerLine) {
				container.scrollTop -= headerLine - rowTop;
			}
		}

		// The rows for the new position are only mounted once the scroll event
		// has been through, which is before the next frame is drawn. Saying
		// "restored" straight away would show that position for one frame with
		// the rows of the top of the list, that is, with nothing in it.
		const frame = requestAnimationFrame(() => onRestoredScrollChange(true));
		return () => cancelAnimationFrame(frame);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [cards.length, hasRestoredScroll, isLoadingCards, browseCacheKey, rowMetrics.measured, rowMetrics.rowSizePx]);

	if (isIncognitoActive) {
		return (
			/* Padding applied to maintain header alignment for non-grid states */
			<div className="w-full px-[var(--app-px)]">
				<div
					className="flex flex-col items-center justify-center gap-4 text-center"
					style={{ minHeight: "60dvh" }}
				>
					<div className="rounded-2xl bg-[var(--surface-2)] p-4">
						<Ghost className="h-7 w-7 text-[var(--accent)]" />
					</div>
					<div className="grid max-w-xs gap-1.5">
						<p className="text-base font-semibold text-[var(--text)]">
							{t("browse_page.incognito_active_title", { defaultValue: "Incognito mode is on" })}
						</p>
						<p className="text-sm text-[var(--text-muted)]">
							{t("browse_page.incognito_active_desc", {
								defaultValue:
									"The Grid does not load while incognito mode is on, so that browsing does not show you as online.",
							})}
						</p>
					</div>
					{onManagePrivacy && (
						<Button variant="primary" onClick={onManagePrivacy} leftIcon={<Ghost className="h-4 w-4" />}>
							{t("browse_page.incognito_active_button", { defaultValue: "Manage incognito mode" })}
						</Button>
					)}
				</div>
			</div>
		);
	}

	if (isLocationMissing) {
		return (
			/* Padding applied to maintain header alignment for non-grid states */
			<div className="w-full px-[var(--app-px)]">
				<div
					className="flex flex-col items-center justify-center gap-4 text-center"
					style={{ minHeight: "60dvh" }}
				>
					<div className="rounded-2xl bg-[var(--surface-2)] p-4">
						<MapPin className="h-7 w-7 text-[var(--accent)]" />
					</div>
					<div className="grid max-w-xs gap-1.5">
						<p className="text-base font-semibold text-[var(--text)]">
							{t("browse_page.no_location_title")}
						</p>
						<p className="text-sm text-[var(--text-muted)]">
							{t("browse_page.no_location_desc")}
						</p>
					</div>
					<Button variant="primary" onClick={onOpenLocation} leftIcon={<MapPin className="h-4 w-4" />}>
						{t("browse_page.no_location_button")}
					</Button>
				</div>
			</div>
		);
	}

	const viewState = getAsyncState(
		{ isLoading: isLoadingCards, error: cardsError, data: cards },
		cards.length === 0,
	);

	if (viewState === "loading") {
		return (
			<BrowseGridSkeleton isDesktop={isDesktop} mobileColumns={mobileGridColumns as "2" | "3"} />
		);
	}

	if (viewState === "error") {
		return (
			/* Padding applied to maintain header alignment for non-grid states */
			<div className="w-full px-[var(--app-px)]">
				<ErrorState
					title={t("browse_page.error_load_feed")}
					description={cardsError ?? undefined}
				/>
			</div>
		);
	}

	if (viewState === "empty") {
		return (
			/* Padding applied to maintain header alignment for non-grid states */
			<div className="w-full px-[var(--app-px)]">
				<EmptyState
					title={t("browse_page.empty_title")}
					description={t("browse_page.empty_desc")}
				/>
			</div>
		);
	}

	return (
		<div className="w-full flex flex-col gap-4">
			{/*
				Only the rows on screen, and a few either side, exist. The grid used
				to keep every tile it had ever loaded, each holding its photo, so a
				minute of scrolling left hundreds mounted; this box is as tall as all
				of them would be, and the rows are placed inside it.

				Hiding images is a switch on the grid, not a prop on every tile. As a
				prop it re-rendered every tile the grid had loaded, and each photo
				animated a 24px blur on the way — on an iPhone, all at once.
			*/}
			<div
				ref={listRefCallback}
				data-hide-images={hideImages ? "" : undefined}
				className="group/grid relative w-full"
				style={{ height: rowVirtualizer.getTotalSize() }}
			>
				<div
					ref={probeRefCallback}
					aria-hidden="true"
					className={cn(gridClassName, "pointer-events-none invisible absolute inset-x-0 top-0")}
					style={{ gridTemplateColumns, height: 0, overflow: "hidden" }}
				/>
				{virtualRows.map((virtualRow) => {
					const row = rows[virtualRow.index];
					if (!row) {
						return null;
					}
					return (
						<div
							key={virtualRow.key}
							data-index={virtualRow.index}
							className={cn(gridClassName, "absolute inset-x-0")}
							// Placed with `top`, not a transform: a row never moves once
							// it is mounted, and a transform on each one would make it a
							// layer of its own for the compositor to keep.
							style={{ gridTemplateColumns, top: virtualRow.start - scrollMargin }}
						>
							{row.map((card) => (
								<BrowseCardTile
									key={card.profileId}
									card={card}
									chatContactStatus={chatContactIndexByProfileId?.[card.profileId] ?? null}
									localNickname={localNicknamesByProfileId?.[card.profileId]}
									onSelectProfile={onSelectProfile}
									onMessageProfile={onMessageProfile}
									isDesktop={isDesktop}
								/>
							))}
						</div>
					);
				})}
			</div>
			{hasMore && (
				<div className="px-[var(--app-px)] pb-8">
					<div className="h-8 w-full" aria-hidden="true" />
					{isLoadingMore ? (
						<p className="text-center text-sm text-[var(--text-muted)]">
							{t("browse_page.loading")}
						</p>
					) : null}
				</div>
			)}
		</div>
	);
}
