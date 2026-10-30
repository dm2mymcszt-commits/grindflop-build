import { Album, Check, ChevronLeft, Clock3, Film, HardDriveDownload, Layers, ListChecks, Lock, RefreshCw, Star, Trash2, Wifi, X } from "lucide-react";
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import toast from "react-hot-toast";
import type { TFunction } from "i18next";
import { EmptyState, ErrorState } from "../../components/ui/states";
import { ConfirmDialog } from "../../components/ui/confirm-dialog";
import { FeedScrollContainer } from "../../components/ui/FeedScrollContainer";
import { PageHeaderBackground } from "../../components/ui/PageHeaderBackground";
import { useAuth } from "../../contexts/useAuth";
import { usePreferences } from "../../contexts/PreferencesContext";
import { useApiFunctions } from "../../hooks/useApiFunctions";
import { useAvatarCache } from "../../hooks/useAvatarCache";
import { ProfileImage } from "../../components/ui/profile-image";
import type { AlbumViewer, SharedAlbumItem } from "../../types/shared-albums";
import type { GetSharedAlbumsInput } from "../../types/api-functions";
import type { AlbumContentItem } from "../../types/chat-page";
import { ApiFunctionError } from "../../services/apiHelpers";
import { showAlbumApiWarning } from "../../utils/albumWarning";
import { getThumbImageUrl, validateMediaHash } from "../../utils/media";
import { cn } from "../../utils/cn";
import {
	captureAlbum,
	deleteLocalAlbum,
	ensureAlbumCacheChecked,
	getCachedAlbumCoverUri,
	getLocalAlbum,
	subscribeToAlbumCache,
} from "../../services/albumStore";
import { resolveAvatarSrc } from "../../services/avatarStore";
import { getAlbumMediaCounts, getAllAlbums, listConversations } from "../../services/chatDb";
import { getLocalNicknamesForProfiles } from "../../services/chatContactIndex";
import { toDataUri } from "../../services/mediaStore";
import { PullToRefreshContainer } from "./components/PullToRefreshContainer";
import { AlbumViewerPanel } from "./shared-albums/AlbumViewerPanel";
import { getAlbumCover, refreshAlbumChecks } from "../../services/albumContentCheck";
import { isExplicitFilterEnabled } from "../../services/contentCheck";
import { useContentChecks } from "../../hooks/useContentChecks";
import { useVisibleAlbumContent } from "../../hooks/useVisibleAlbumContent";
import { formatAlbumCounts, formatTimeLeft, formatTimeLeftShort } from "./shared-albums/albumFormat";
import { type AlbumOwner, mediaHashFromUrl, readAlbumOwners, rememberAlbumOwners } from "./shared-albums/albumOwners";
import { hideAlbums, readHiddenAlbumIds } from "./shared-albums/hiddenAlbums";
import { PhotoViewer, type PhotoViewerMedia } from "../../components/PhotoViewer";
import { PhotoActionBar } from "../../components/PhotoActionBar";
import { useRevealOnScroll } from "../../hooks/useRevealOnScroll";
import { useLongPress } from "../../hooks/useLongPress";

/** Timestamps from the feed are milliseconds; accept seconds too. */
function toMs(value: number | null | undefined): number | null {
	if (value == null || value <= 0) return null;
	return value < 1e12 ? value * 1000 : value;
}

function albumCover(item: SharedAlbumItem): string | null {
	// Every album here is somebody else's. With the explicit-photo filter on,
	// its cover is only shown once all of its items have been checked and cleared.
	if (isExplicitFilterEnabled() && getAlbumCover(item.album.albumId) != null) return null;
	return (
		getCachedAlbumCoverUri(item.album.albumId) ??
		item.album.content?.thumbUrl ??
		item.album.content?.coverUrl ??
		item.album.content?.url ??
		null
	);
}

function albumAvatar(item: SharedAlbumItem): string | null {
	const fallback = item.profileImageUrl ?? (item.profileMediaHash ? getThumbImageUrl(item.profileMediaHash, "320x320") : null);
	return resolveAvatarSrc(item.profileMediaHash, fallback);
}

/**
 * The live album's items in its order, plus saved items it no longer lists.
 * Saved files win over live links: they are already on screen when the live
 * album arrives, and swapping them for links would load every tile again.
 */
function mergeWithSaved(live: AlbumContentItem[], saved: AlbumContentItem[]): AlbumContentItem[] {
	const savedById = new Map(saved.map((entry) => [entry.contentId, entry] as const));
	const liveIds = new Set(live.map((entry) => entry.contentId));
	return [
		...live.map((entry) => {
			const cached = savedById.get(entry.contentId);
			return cached
				? {
						...entry,
						thumbUrl: cached.thumbUrl ?? entry.thumbUrl,
						url: cached.url ?? entry.url,
						coverUrl: cached.coverUrl ?? entry.coverUrl,
					}
				: entry;
		}),
		...saved.filter((entry) => !liveIds.has(entry.contentId)),
	];
}

function AlbumCard({
	item,
	onClick,
	onLongPress,
	onDelete,
	isDeleting,
	isSelecting,
	isSelected,
	t,
}: {
	item: SharedAlbumItem;
	onClick: () => void;
	/** Long press, or right click on PC: starts selecting with this album. */
	onLongPress: () => void;
	onDelete: () => void;
	isDeleting: boolean;
	isSelecting: boolean;
	isSelected: boolean;
	t: TFunction;
}) {
	const { ref, revealClass } = useRevealOnScroll();
	// The click that follows a long press must not also open or toggle the album.
	const wasLongPressedRef = useRef(false);
	const longPress = useLongPress(() => {
		wasLongPressedRef.current = true;
		onLongPress();
		window.setTimeout(() => {
			wasLongPressedRef.current = false;
		}, 350);
	}, 450);
	const cover = albumCover(item);
	const avatarUrl = albumAvatar(item);
	const counts = formatAlbumCounts(t, item.album.contentCount.imageCount, item.album.contentCount.videoCount);
	const timeLeft = item.localOnly ? null : formatTimeLeftShort(t, item.expiresAt);
	const badge = "flex h-6 items-center justify-center gap-1 rounded-full bg-black/45 text-[10px] font-semibold tabular-nums text-white/90 backdrop-blur-sm";

	return (
		<div ref={ref} className={revealClass}>
			{/* A size container: on a phone a card is ~110px wide, too narrow for the full-size avatar.
			    Not selectable as text: a press on a card is a tap or a long press, and a
			    selection used to take in whole cards (and iOS offered Copy / Look Up). */}
			<div
				className={cn(
					"@container group no-touch-callout relative w-full overflow-hidden rounded-2xl bg-[var(--surface-2)] shadow-[0_10px_28px_rgba(0,0,0,0.22)] ring-inset transition-transform duration-200",
					isSelected ? "scale-[0.96] ring-2 ring-[var(--accent)]" : "ring-1 ring-white/5",
					!isSelecting && "hover:-translate-y-0.5",
				)}
				onContextMenu={(event) => {
					event.preventDefault();
					onLongPress();
				}}
				{...(isSelecting ? {} : longPress)}
			>
				<button
					type="button"
					onClick={() => {
						if (!wasLongPressedRef.current) onClick();
					}}
					aria-pressed={isSelecting ? isSelected : undefined}
					className="block w-full text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
				>
					<div className="relative aspect-[4/6] w-full">
						{cover ? (
							<img
								src={cover}
								alt=""
								loading="lazy"
								decoding="async"
								draggable={false}
								className="h-full w-full scale-110 object-cover blur-xl"
							/>
						) : (
							<div className="flex h-full w-full items-start justify-center bg-[radial-gradient(ellipse_at_top,color-mix(in_srgb,var(--accent)_14%,transparent),transparent_75%)] pt-4 text-[var(--text-muted)]">
								<Album className="h-5 w-5 opacity-40" />
							</div>
						)}
						<div
							className={cn(
								"absolute inset-0 transition-colors duration-200",
								isSelected ? "bg-black/45" : "bg-gradient-to-b from-black/5 via-black/20 to-black/55",
							)}
						/>

						<div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-2.5 pt-6 text-center text-white @min-[150px]:gap-3 @min-[150px]:px-3">
							<div className="relative">
								<div className="h-14 w-14 overflow-hidden rounded-full bg-white/15 shadow-lg ring-2 ring-white/25 @min-[150px]:h-20 @min-[150px]:w-20">
									<ProfileImage src={avatarUrl} alt={item.profileName} />
								</div>
								{item.isOnline ? (
									<span className="absolute bottom-0.5 right-0.5 h-3 w-3 rounded-full bg-emerald-400 ring-2 ring-black/40 @min-[150px]:bottom-1 @min-[150px]:right-1 @min-[150px]:h-3.5 @min-[150px]:w-3.5" />
								) : null}
							</div>
							<div className="w-full min-w-0">
								<p className="truncate text-sm font-semibold leading-tight text-white drop-shadow @min-[150px]:text-base">
									{item.profileName}
								</p>
								<p className="mt-1 flex items-center justify-center gap-1 text-[11px] font-medium leading-tight text-white/75 drop-shadow @min-[150px]:text-xs">
									{!item.localOnly && item.savedCount > 0 ? (
										<HardDriveDownload
											className="h-3 w-3 shrink-0"
											aria-label={t("shared_albums.saved_label")}
										/>
									) : null}
									<span className="truncate">
										{item.album.albumName?.trim() ? `${item.album.albumName.trim()} · ${counts}` : counts}
									</span>
								</p>
							</div>
						</div>

						<div className="absolute inset-x-2 top-2 flex flex-wrap items-center gap-1 pr-8">
							{item.hasUnseenContent ? (
								<span
									className="flex h-6 items-center rounded-full bg-[var(--accent)] px-2 text-[10px] font-bold uppercase tracking-wide text-[var(--accent-contrast)] shadow"
									title={t("shared_albums.badge_new_hint")}
								>
									{t("shared_albums.badge_new")}
								</span>
							) : null}
							{!item.localOnly && item.totalAlbumsShared != null && item.totalAlbumsShared > 1 ? (
								<span className={cn(badge, "px-2")} title={t("shared_albums.album_position", { number: item.albumNumber, total: item.totalAlbumsShared })}>
									<Layers className="h-3 w-3" />
									{item.albumNumber}/{item.totalAlbumsShared}
								</span>
							) : null}
							{item.isViewable === false && item.savedCount === 0 ? (
								<span className={cn(badge, "w-6")} title={t("shared_albums.badge_locked_hint")}>
									<Lock className="h-3 w-3" aria-label={t("shared_albums.badge_locked_hint")} />
								</span>
							) : null}
							{timeLeft ? (
								<span className={cn(badge, "px-2")} title={formatTimeLeft(t, item.expiresAt) ?? undefined}>
									<Clock3 className="h-3 w-3" />
									{timeLeft}
								</span>
							) : null}
						</div>
					</div>
				</button>
				{isSelecting ? (
					<span
						className={cn(
							"pointer-events-none absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full border-2 shadow-lg transition-colors duration-200",
							isSelected
								? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-contrast)]"
								: "border-white/70 bg-black/35 backdrop-blur-sm",
						)}
						aria-hidden
					>
						{isSelected ? <Check className="h-4 w-4" strokeWidth={3} /> : null}
					</span>
				) : (
					<button
						type="button"
						onClick={(event) => {
							event.stopPropagation();
							onDelete();
						}}
						disabled={isDeleting}
						title={t("shared_albums.delete")}
						aria-label={t("shared_albums.delete")}
						className="absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur-sm transition hover:bg-red-500/85 disabled:opacity-50 pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:focus-visible:opacity-100"
					>
						<Trash2 className="h-3.5 w-3.5" />
					</button>
				)}
			</div>
		</div>
	);
}

export function SharedAlbumsPage() {
	const { t } = useTranslation();
	const navigate = useNavigate();
	const { userId } = useAuth();
	const { mobileGridColumns } = usePreferences();
	const apiFunctions = useApiFunctions();
	useAvatarCache();

	const [isLoading, setIsLoading] = useState(true);
	const [isRefreshing, setIsRefreshing] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [feedError, setFeedError] = useState<string | null>(null);
	const [items, setItems] = useState<SharedAlbumItem[]>([]);
	/** Album ids picked for deletion; null when not selecting. */
	const [selectedIds, setSelectedIds] = useState<ReadonlySet<number> | null>(null);
	const isSelecting = selectedIds !== null;
	const [openedViewer, setViewer] = useState<AlbumViewer | null>(null);
	// The opened album as the explicit-photo filter lets it be seen: every
	// item in its place, the ones not cleared swapped for the hidden tile.
	const visibleAlbum = useVisibleAlbumContent(
		openedViewer?.item.album.albumId ?? null,
		openedViewer?.content,
		openedViewer != null && openedViewer.item.profileId === userId,
	);
	const viewer = useMemo<AlbumViewer | null>(
		() =>
			openedViewer
				? { ...openedViewer, content: visibleAlbum.content, hiddenCount: visibleAlbum.hiddenCount }
				: null,
		[openedViewer, visibleAlbum],
	);
	// Covers on this page follow the checks too, so they are worked out for
	// every album with something saved, and the page redraws as they land.
	const explicitFilterOn = useContentChecks();
	useEffect(() => {
		if (!explicitFilterOn) return;
		for (const item of items) {
			if (item.savedCount > 0) void refreshAlbumChecks(item.album.albumId);
		}
	}, [explicitFilterOn, items]);
	const [fullScreenIndex, setFullScreenIndex] = useState<number | null>(null);
	const [, setAlbumCacheTick] = useState(0);
	const feedContainerRef = useRef<HTMLDivElement>(null);
	const viewerHistoryPushedRef = useRef(false);
	const fullScreenHistoryPushedRef = useRef(false);
	const openRequestRef = useRef(0);
	const minmaxValue = mobileGridColumns === "2" ? "130px" : "100px";

	const [filters, setFilters] = useState({ isFavorite: false, isOnline: false, onlyVideo: false });

	// Saved covers load in the background; re-render as they arrive.
	useEffect(() => subscribeToAlbumCache(() => setAlbumCacheTick((tick) => tick + 1)), []);

	const loadSharedAlbums = useCallback(async () => {
		setError(null);
		setFeedError(null);
		const hasActiveFilter = filters.isFavorite || filters.isOnline || filters.onlyVideo;

		try {
			const feedFilters: GetSharedAlbumsInput = {
				...(filters.isFavorite ? { isFavorite: true } : {}),
				...(filters.isOnline ? { isOnline: true } : {}),
				...(filters.onlyVideo ? { onlyVideo: true } : {}),
			};
			const [feedResult, storedAlbums, mediaCounts, conversations] = await Promise.all([
				apiFunctions.getSharedAlbums(feedFilters).then(
					(feed) => ({ feed, error: null }),
					(feedLoadError: unknown) => ({
						feed: null,
						error: feedLoadError instanceof Error ? feedLoadError.message : t("shared_albums.error_load_fallback"),
					}),
				),
				getAllAlbums().catch(() => []),
				getAlbumMediaCounts().catch(() => []),
				listConversations({ includeArchived: true }).catch(() => []),
			]);
			const { feed } = feedResult;

			const countsByAlbum = new Map(mediaCounts.map((entry) => [Number(entry.albumId), entry] as const));
			const conversationsByProfile = new Map(
				conversations
					.filter((conversation) => conversation.otherProfileId)
					.map((conversation) => [conversation.otherProfileId as string, conversation] as const),
			);
			const rememberedOwners = readAlbumOwners(userId);
			const seenOwners: Record<string, AlbumOwner> = {};
			const hiddenIds = readHiddenAlbumIds(userId);

			const ownerDetails = (profileId: number, feedName: string | null, feedImageUrl: string | null) => {
				const key = String(profileId);
				const conversation = conversationsByProfile.get(key);
				const participant = conversation?.entry.data.participants?.find((entry) => entry.profileId === profileId);
				const conversationHash = participant?.primaryMediaHash ?? null;
				const remembered = rememberedOwners[key];
				const mediaHash = [mediaHashFromUrl(feedImageUrl), conversationHash, remembered?.mediaHash].find(
					(hash): hash is string => !!hash && validateMediaHash(hash),
				) ?? null;
				const name =
					feedName?.trim() || conversation?.entry.data.name?.trim() || remembered?.name?.trim() || null;
				return { name, mediaHash, conversationId: conversation?.conversationId ?? null };
			};

			const feedAlbums = (feed?.sharedAlbums ?? []).filter((sharedAlbum) => !hiddenIds.has(sharedAlbum.albumId));
			const liveItems: SharedAlbumItem[] = feedAlbums.map((sharedAlbum) => {
				const owner = ownerDetails(sharedAlbum.ownerProfileId, sharedAlbum.profile.name, sharedAlbum.profile.profileUrl);
				seenOwners[String(sharedAlbum.ownerProfileId)] = { name: owner.name, mediaHash: owner.mediaHash };
				const cover = sharedAlbum.coverContent.location;
				return {
					profileId: sharedAlbum.ownerProfileId,
					profileName: owner.name || `Profile ${sharedAlbum.ownerProfileId}`,
					profileMediaHash: owner.mediaHash,
					profileImageUrl: sharedAlbum.profile.profileUrl,
					conversationId:
						owner.conversationId ??
						storedAlbums.find((stored) => Number(stored.albumId) === sharedAlbum.albumId)?.conversationId ??
						null,
					album: {
						albumId: sharedAlbum.albumId,
						albumName: sharedAlbum.name,
						content: { thumbUrl: cover, url: cover, coverUrl: cover },
						contentCount: { imageCount: sharedAlbum.imageCount, videoCount: sharedAlbum.videoCount },
					},
					// Overwritten below: the server's own albumNumber/totalAlbumsShared
					// have been seen duplicated or not matching the albums actually
					// shared, so the "x/total" badge is derived per owner instead.
					albumNumber: 0,
					totalAlbumsShared: 0,
					savedCount: countsByAlbum.get(sharedAlbum.albumId)?.savedCount ?? 0,
					isOnline: (toMs(sharedAlbum.profile.onlineUntil) ?? 0) > Date.now(),
					hasUnseenContent: sharedAlbum.hasUnseenContent,
					isViewable: sharedAlbum.albumViewable,
					expiresAt: toMs(sharedAlbum.expiresAt),
				};
			});

			// Group by owner, ordered by albumId — the one stable identifier here.
			const liveByOwner = new Map<number, SharedAlbumItem[]>();
			for (const item of liveItems) {
				const group = liveByOwner.get(item.profileId);
				if (group) group.push(item);
				else liveByOwner.set(item.profileId, [item]);
			}
			const orderedLive: SharedAlbumItem[] = [];
			for (const group of liveByOwner.values()) {
				group.sort((a, b) => a.album.albumId - b.album.albumId);
				group.forEach((item, index) => {
					item.albumNumber = index + 1;
					item.totalAlbumsShared = group.length;
				});
				orderedLive.push(...group);
			}

			// Albums not in the live feed, listed only when something of them is
			// saved on this device: a row alone (a share seen but never
			// downloaded, or only synced from the other device) has nothing to
			// open. Skipped under a filter, which would hide albums still shared
			// and label them "no longer shared". When the feed failed, these are
			// every saved album, shown on their own.
			const listedOrHiddenIds = new Set([...orderedLive.map((item) => item.album.albumId), ...hiddenIds]);
			const savedItems: SharedAlbumItem[] =
				hasActiveFilter
					? []
					: storedAlbums.flatMap((stored): SharedAlbumItem[] => {
							const albumId = Number(stored.albumId);
							const counts = countsByAlbum.get(albumId);
							const profileId = stored.ownerProfileId ? Number(stored.ownerProfileId) : null;
							if (listedOrHiddenIds.has(albumId) || !counts || counts.savedCount === 0 || profileId == null || profileId === userId) {
								return [];
							}
							const owner = ownerDetails(profileId, null, null);
							const cover =
								stored.previewCoverBase64 && stored.previewCoverMimeType
									? toDataUri(stored.previewCoverMimeType, stored.previewCoverBase64)
									: null;
							if (!cover) ensureAlbumCacheChecked(albumId);
							return [
								{
									profileId,
									profileName: owner.name || `Profile ${profileId}`,
									profileMediaHash: owner.mediaHash,
									profileImageUrl: null,
									conversationId: stored.conversationId ?? owner.conversationId,
									album: {
										albumId,
										albumName: stored.albumName,
										content: cover ? { thumbUrl: cover, url: cover, coverUrl: cover } : null,
										contentCount: {
											imageCount: counts.savedCount - counts.savedVideoCount,
											videoCount: counts.savedVideoCount,
										},
									},
									albumNumber: 0,
									savedCount: counts.savedCount,
									localOnly: true,
								},
							];
						});

			// A name the user gave someone wins, as it does in the inbox.
			const allItems = [...orderedLive, ...savedItems];
			const nicknames = await getLocalNicknamesForProfiles(
				[...new Set(allItems.map((item) => String(item.profileId)))],
			).catch(() => ({} as Record<string, string>));
			for (const item of allItems) {
				const nickname = nicknames[String(item.profileId)];
				if (nickname) item.profileName = nickname;
			}

			rememberAlbumOwners(userId, seenOwners);
			if (!feed && savedItems.length === 0) {
				setError(feedResult.error);
				setItems([]);
			} else {
				setFeedError(feed ? null : feedResult.error);
				setItems(allItems);
			}
		} catch (loadError) {
			setError(loadError instanceof Error ? loadError.message : t("shared_albums.error_load_fallback"));
		} finally {
			setIsLoading(false);
			setIsRefreshing(false);
		}
	}, [apiFunctions, userId, filters, t]);

	useEffect(() => {
		void loadSharedAlbums();
	}, [loadSharedAlbums]);

	const liveItems = useMemo(() => items.filter((item) => !item.localOnly), [items]);
	const cachedItems = useMemo(() => items.filter((item) => item.localOnly), [items]);

	const profileCount = useMemo(
		() => new Set(items.map((item) => item.profileId)).size,
		[items],
	);

	const handleRefresh = () => {
		if (isRefreshing || isLoading) return;
		setIsRefreshing(true);
		return loadSharedAlbums();
	};

	const toggleFilter = (key: keyof typeof filters) => {
		if (isRefreshing || isLoading) return;
		setIsRefreshing(true);
		setFilters((previous) => ({ ...previous, [key]: !previous[key] }));
	};

	// Selecting several albums to delete them together.
	const toggleSelected = useCallback((albumId: number) => {
		setSelectedIds((previous) => {
			const next = new Set(previous ?? []);
			if (next.has(albumId)) next.delete(albumId);
			else next.add(albumId);
			return next;
		});
	}, []);
	const exitSelection = useCallback(() => setSelectedIds(null), []);
	const selectedItems = useMemo(
		() => (selectedIds ? items.filter((item) => selectedIds.has(item.album.albumId)) : []),
		[items, selectedIds],
	);
	const allSelected = items.length > 0 && selectedItems.length === items.length;
	const toggleSelectAll = () =>
		setSelectedIds(allSelected ? new Set() : new Set(items.map((item) => item.album.albumId)));

	// A refresh or filter can drop albums that were selected.
	useEffect(() => {
		setSelectedIds((previous) => {
			if (!previous) return previous;
			const present = new Set(items.map((item) => item.album.albumId));
			const kept = [...previous].filter((albumId) => present.has(albumId));
			return kept.length === previous.size ? previous : new Set(kept);
		});
	}, [items]);

	useEffect(() => {
		if (!isSelecting) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !document.querySelector("dialog[open]")) {
				event.preventDefault();
				exitSelection();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [exitSelection, isSelecting]);

	const [confirmDeleteItems, setConfirmDeleteItems] = useState<SharedAlbumItem[] | null>(null);
	const [deleteProgress, setDeleteProgress] = useState<{ done: number; total: number } | null>(null);
	const isDeleting = deleteProgress !== null;

	const closeViewerState = useCallback(() => {
		openRequestRef.current += 1;
		setFullScreenIndex(null);
		setViewer(null);
		fullScreenHistoryPushedRef.current = false;
		viewerHistoryPushedRef.current = false;
	}, []);

	const closeFullScreenState = useCallback(() => {
		setFullScreenIndex(null);
		fullScreenHistoryPushedRef.current = false;
	}, []);

	const closeViewer = useCallback(() => {
		if (fullScreenHistoryPushedRef.current || viewerHistoryPushedRef.current) {
			window.history.back();
			return;
		}
		closeViewerState();
	}, [closeViewerState]);

	/**
	 * Removes albums one after the other: asks Grindr to stop the share when it
	 * is still live, then drops the saved copy. When Grindr refuses (every
	 * removal once failed this way), the album is hidden on this device instead
	 * of staying stuck in the list, and the toast says the share goes on.
	 */
	const handleDeleteAlbums = useCallback(async (targets: SharedAlbumItem[]) => {
		if (deleteProgress || targets.length === 0) return;
		setDeleteProgress({ done: 0, total: targets.length });
		const removed = new Set<number>();
		const hiddenOnly: number[] = [];
		let refusedStatus: number | null = null;
		for (const [index, item] of targets.entries()) {
			const albumId = item.album.albumId;
			if (!item.localOnly) {
				try {
					await apiFunctions.removeAlbumShare({ albumId });
				} catch (removeError) {
					refusedStatus = removeError instanceof ApiFunctionError ? removeError.status : refusedStatus;
					hiddenOnly.push(albumId);
				}
			}
			await deleteLocalAlbum(albumId);
			removed.add(albumId);
			setDeleteProgress({ done: index + 1, total: targets.length });
		}
		hideAlbums(userId, hiddenOnly);

		setItems((previous) => previous.filter((entry) => !removed.has(entry.album.albumId)));
		if (viewer && removed.has(viewer.item.album.albumId)) closeViewer();
		setSelectedIds((previous) => {
			if (!previous) return previous;
			const left = [...previous].filter((albumId) => !removed.has(albumId));
			return left.length === 0 ? null : new Set(left);
		});
		const doneMessage =
			targets.length === 1
				? t("shared_albums.toast_deleted")
				: t("shared_albums.toast_deleted_many", { count: removed.size });
		if (hiddenOnly.length === 0) {
			toast.success(doneMessage);
		} else {
			toast(
				`${doneMessage}. ${t("shared_albums.delete_hidden_only", {
					count: hiddenOnly.length,
					status: refusedStatus ?? "?",
				})}`,
				{ duration: 8000 },
			);
		}
		setDeleteProgress(null);
		setConfirmDeleteItems(null);
	}, [apiFunctions, closeViewer, deleteProgress, t, userId, viewer]);

	/**
	 * Opens the viewer at once and fills it in: the saved copy first when there
	 * is one, then the live album. Any failure is shown inside the viewer — it
	 * used to go to the top of the list, out of sight, so a tap looked like a
	 * flash and nothing else.
	 */
	const openViewer = useCallback(
		async (item: SharedAlbumItem) => {
			showAlbumApiWarning();
			const request = ++openRequestRef.current;
			const isCurrent = () => openRequestRef.current === request;
			const albumId = item.album.albumId;
			const update = (patch: Partial<AlbumViewer>) => {
				if (isCurrent()) setViewer((previous) => (previous ? { ...previous, ...patch } : previous));
			};

			setViewer({
				item,
				albumName: item.album.albumName ?? null,
				status: "loading",
				content: [],
				error: null,
				isSavedCopy: false,
			});
			if (!viewerHistoryPushedRef.current) {
				window.history.pushState({ sharedAlbumsOverlay: "viewer" }, "");
				viewerHistoryPushedRef.current = true;
			}

			const saved = item.savedCount > 0 ? await getLocalAlbum(albumId).catch(() => null) : null;
			if (!isCurrent()) return;
			const savedContent = saved?.content ?? [];
			const savedName = saved?.albumName ?? item.album.albumName ?? null;

			if (item.localOnly) {
				update(
					savedContent.length > 0
						? { status: "ready", content: savedContent, albumName: savedName, isSavedCopy: true }
						: { status: "error", error: t("shared_albums.error_nothing_saved") },
				);
				return;
			}
			if (savedContent.length > 0) {
				update({ status: "ready", content: savedContent, albumName: savedName });
			}

			try {
				await apiFunctions.openSharedAlbum({ albumId });
				const details = await apiFunctions.getAlbum(albumId);
				if (!isCurrent()) return;
				// Grindr can answer with no items for an album the feed says has
				// some: it locked the album for this account (albumViewable false),
				// or the share ended between the feed and the tap. Say which,
				// instead of calling the album empty.
				const listedCount = item.album.contentCount.imageCount + item.album.contentCount.videoCount;
				if (details.content.length === 0 && savedContent.length === 0 && listedCount > 0) {
					update({
						status: "error",
						error:
							item.isViewable === false
								? t("shared_albums.error_locked", { count: listedCount })
								: t("shared_albums.error_sent_nothing", { count: listedCount }),
					});
					return;
				}
				update({
					status: "ready",
					content: mergeWithSaved(details.content, savedContent),
					albumName: details.albumName ?? savedName,
					isSavedCopy: false,
				});
				setItems((previous) =>
					previous.map((entry) =>
						entry.album.albumId === albumId ? { ...entry, hasUnseenContent: false } : entry,
					),
				);

				// Fully cache every item's bytes, same as albums shared in a chat
				// thread — so the album survives the share ending.
				void captureAlbum({
					albumId: details.albumId,
					albumName: details.albumName,
					content: details.content,
					ownerProfileId: String(item.profileId),
					conversationId: item.conversationId,
					sharedViaMessageId: null,
					remainingViews: null,
					isViewable: true,
				}).then((stored) => {
					const savedCount = stored.filter((entry) => entry.hasData).length;
					setItems((previous) =>
						previous.map((entry) => (entry.album.albumId === albumId ? { ...entry, savedCount } : entry)),
					);
				}, () => undefined);
			} catch (openError) {
				if (!isCurrent()) return;
				const message =
					openError instanceof ApiFunctionError && openError.status === 403
						? t("shared_albums.error_restricted")
						: openError instanceof Error && openError.message
							? openError.message
							: t("shared_albums.error_open_fallback");
				update(
					savedContent.length > 0
						? { status: "ready", content: savedContent, albumName: savedName, isSavedCopy: true }
						: { status: "error", error: message },
				);
			}
		},
		[apiFunctions, t],
	);

	const handleMessageProfile = useCallback(
		(profileId: number) => {
			const nextParams = new URLSearchParams();
			nextParams.set("targetProfileId", String(profileId));
			nextParams.set("returnTo", "/chat/albums");
			navigate(`/chat?${nextParams.toString()}`);
		},
		[navigate],
	);

	const handleViewProfile = useCallback(
		(profileId: number) => {
			navigate(`/profile/${profileId}`, {
				state: { returnTo: "/chat/albums" },
			});
		},
		[navigate],
	);

	const sendAlbumContentReaction = useCallback(
		async (albumId: number, albumContentId: number, targetProfileId: number) => {
			try {
				await apiFunctions.sendMessage({
					type: "AlbumContentReaction",
					target: { type: "Direct", targetId: targetProfileId },
					body: { albumId, albumContentId },
				});
				toast.success(t("chat.toasts.album_reaction_sent", { defaultValue: "Reaction sent" }));
			} catch (error) {
				toast.error(error instanceof Error ? error.message : t("chat.errors.send_failed"));
			}
		},
		[apiFunctions, t],
	);

	const sendAlbumContentReply = useCallback(
		async (
			albumId: number,
			albumContentId: number,
			contentType: string | null | undefined,
			targetProfileId: number,
			text: string,
		) => {
			try {
				await apiFunctions.sendMessage({
					type: "AlbumContentReply",
					target: { type: "Direct", targetId: targetProfileId },
					body: { albumId, albumContentId, albumContentReply: text, contentType: contentType ?? "image/jpeg" },
				});
				toast.success(t("chat.toasts.album_reply_sent", { defaultValue: "Reply sent" }));
			} catch (error) {
				toast.error(error instanceof Error ? error.message : t("chat.errors.send_failed"));
			}
		},
		[apiFunctions, t],
	);

	const viewerPhotos = useMemo<PhotoViewerMedia[]>(() => {
		if (!viewer) return [];
		return viewer.content.map((item) => ({
			url: item.url || item.thumbUrl || item.coverUrl || "",
			type: item.contentType?.startsWith("video/") ? "video" : "image",
		}));
	}, [viewer]);

	const openFullScreen = useCallback(
		(index: number) => {
			if (!viewer || index < 0 || index >= viewer.content.length) {
				return;
			}

			setFullScreenIndex(index);
			if (!fullScreenHistoryPushedRef.current) {
				window.history.pushState({ sharedAlbumsOverlay: "full-screen" }, "");
				fullScreenHistoryPushedRef.current = true;
			}
		},
		[viewer],
	);

	const closeFullScreen = useCallback(() => {
		if (fullScreenHistoryPushedRef.current) {
			window.history.back();
			return;
		}

		closeFullScreenState();
	}, [closeFullScreenState]);

	const handleIndexChange = useCallback((index: number) => {
		setFullScreenIndex((prev) => (prev === index ? prev : index));
	}, []);

	useEffect(() => {
		const handlePopState = () => {
			if (fullScreenHistoryPushedRef.current) {
				closeFullScreenState();
				return;
			}

			if (viewerHistoryPushedRef.current) {
				closeViewerState();
			}
		};

		window.addEventListener("popstate", handlePopState);
		return () => {
			window.removeEventListener("popstate", handlePopState);
		};
	}, [closeFullScreenState, closeViewerState]);

	// The photo viewer handles its own Escape, on the same window listener
	// phase: answering it here too went back twice and closed the album with it.
	const isViewerOpen = viewer !== null;
	const isFullScreen = fullScreenIndex !== null;
	useEffect(() => {
		if (!isViewerOpen || isFullScreen) {
			return;
		}

		const onKeyDown = (event: KeyboardEvent) => {
			// An open confirm dialog closes itself on Escape.
			if (event.key === "Escape" && !document.querySelector("dialog[open]")) {
				event.preventDefault();
				event.stopPropagation();
				closeViewer();
			}
		};

		window.addEventListener("keydown", onKeyDown, { capture: true });
		return () => {
			window.removeEventListener("keydown", onKeyDown, { capture: true });
		};
	}, [closeViewer, isFullScreen, isViewerOpen]);

	const gridStyle: CSSProperties = {
		gridTemplateColumns: `repeat(auto-fill, minmax(clamp(${minmaxValue}, 15vw, 250px), 1fr))`,
	};
	const renderCards = (list: SharedAlbumItem[]) =>
		list.map((item) => (
			<AlbumCard
				key={`${item.profileId}:${item.album.albumId}`}
				item={item}
				onClick={() => (isSelecting ? toggleSelected(item.album.albumId) : void openViewer(item))}
				onLongPress={() => toggleSelected(item.album.albumId)}
				onDelete={() => setConfirmDeleteItems([item])}
				isDeleting={isDeleting}
				isSelecting={isSelecting}
				isSelected={selectedIds?.has(item.album.albumId) ?? false}
				t={t}
			/>
		));

	return (
		<>
			<PullToRefreshContainer
				className="app-screen flex h-dvh flex-col w-full !px-0 !pb-0 overflow-x-hidden"
				contentClassName="flex flex-1 flex-col min-h-0"
				style={{ overflow: "visible", overflowX: "hidden" }}
				onRefresh={handleRefresh}
				isDisabled={isLoading || isRefreshing || isSelecting}
				isAtTop={() => (feedContainerRef.current?.scrollTop ?? 0) <= 0}
				refreshingLabel={t("shared_albums.loading_title")}
				spinnerColor="var(--accent)"
			>
				{/* Header */}
				<header className="relative z-20 shrink-0 pointer-events-none">
					<PageHeaderBackground color="var(--accent)" />
					<div className="pointer-events-auto flex flex-col gap-3 mx-auto w-full max-w-6xl px-[var(--app-px)]">
						<button
							type="button"
							onClick={() => navigate("/chat")}
							className="mt-3 inline-flex items-center gap-1.5 self-start text-sm text-[var(--text-muted)] transition-colors hover:text-[var(--text)]"
						>
							<ChevronLeft className="h-4 w-4" />
							{t("nav.inbox")}
						</button>

						{/* Row 1: title + count subtitle + refresh */}
						<div className="flex items-center justify-between gap-2">
							<div className="min-w-0">
								<h1 className="app-title">{t("shared_albums.title")}</h1>
								<p className="app-subtitle">
									{isLoading
										? t("shared_albums.loading_title")
										: [
											t("shared_albums.albums_count", { count: items.length }),
											t("shared_albums.people_count", { count: profileCount }),
										].join(" · ")}
								</p>
							</div>
							<div className="flex shrink-0 items-center gap-1">
								{items.length > 0 ? (
									<button
										type="button"
										onClick={() => (isSelecting ? exitSelection() : setSelectedIds(new Set()))}
										disabled={isLoading || isDeleting}
										aria-pressed={isSelecting}
										className={cn(
											"inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-sm font-semibold transition disabled:opacity-50",
											isSelecting
												? "bg-[var(--accent)] text-[var(--accent-contrast)]"
												: "text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]",
										)}
									>
										<ListChecks className="h-4 w-4" />
										{isSelecting ? t("shared_albums.cancel") : t("shared_albums.select")}
									</button>
								) : null}
								<button
									type="button"
									onClick={handleRefresh}
									disabled={isRefreshing || isLoading || isSelecting}
									className="rounded-xl p-2 text-[var(--text-muted)] transition hover:text-[var(--text)] disabled:opacity-50"
									aria-label={t("shared_albums.refresh")}
								>
									<RefreshCw className={`h-5 w-5 ${isRefreshing || isLoading ? "animate-spin" : ""}`} />
								</button>
							</div>
						</div>

						{/* Row 2: filter pills */}
						<div className="flex flex-wrap items-center gap-2 pb-4">
							{([
								["isFavorite", Star, t("shared_albums.filter_favorites")],
								["isOnline", Wifi, t("shared_albums.filter_online")],
								["onlyVideo", Film, t("shared_albums.filter_video")],
							] as const).map(([key, Icon, label]) => (
								<button
									key={key}
									type="button"
									onClick={() => toggleFilter(key)}
									disabled={isRefreshing || isLoading}
									className={cn(
										"inline-flex shrink-0 items-center gap-1.5 px-4 py-2 text-sm font-bold transition-all active:scale-95 disabled:opacity-50",
										filters[key]
											? "rounded-full border border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-contrast)] shadow-lg shadow-[var(--accent)]/40"
											: "glass-pill text-[var(--accent)] hover:border-[var(--accent)]/60 hover:bg-[var(--accent)]/20",
									)}
									style={!filters[key] ? { "--pill-color": "var(--accent)" } as CSSProperties : undefined}
								>
									<Icon className={cn("h-3.5 w-3.5", key === "isFavorite" && filters[key] && "fill-current")} />
									{label}
								</button>
							))}
						</div>
					</div>
				</header>

				<FeedScrollContainer ref={feedContainerRef}>
					<div
						className={cn(
							"mx-auto w-full max-w-6xl px-[var(--app-px)]",
							// Room for the selection bar above the nav bar.
							isSelecting
								? "pb-[calc(env(safe-area-inset-bottom,0px)+200px)]"
								: "pb-[calc(env(safe-area-inset-bottom,0px)+120px)]",
						)}
					>
						{isLoading ? (
							<div className="grid gap-4" style={gridStyle}>
								{Array.from({ length: 12 }).map((_, i) => (
									<div key={i} className="overflow-hidden rounded-2xl bg-[var(--surface-2)]">
										<div className="relative aspect-[4/6] w-full animate-pulse">
											<div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-3">
												<div className="h-20 w-20 rounded-full bg-[var(--border)]" />
												<div className="h-3 w-24 rounded-full bg-[var(--border)]" />
												<div className="h-2.5 w-16 rounded-full bg-[var(--border)] opacity-70" />
											</div>
										</div>
									</div>
								))}
							</div>
						) : error ? (
							<ErrorState
								title={t("shared_albums.error_load_title")}
								description={error}
								onRetry={() => { setIsLoading(true); void loadSharedAlbums(); }}
							/>
						) : items.length === 0 ? (
							<EmptyState
								title={t("shared_albums.empty_title")}
								description={t("shared_albums.empty_desc")}
							/>
						) : (
							<>
								{feedError ? (
									<div className="mb-4 rounded-2xl bg-[var(--surface)] px-4 py-3 text-sm text-[var(--text-muted)] ring-1 ring-inset ring-[var(--border)]">
										{t("shared_albums.feed_failed_saved_only")}
									</div>
								) : null}

								{liveItems.length > 0 ? (
									<div className="grid gap-4" style={gridStyle}>
										{renderCards(liveItems)}
									</div>
								) : null}

								{cachedItems.length > 0 ? (
									<div className={liveItems.length > 0 ? "mt-8" : undefined}>
										<div className="mb-3 flex items-center gap-2 px-1">
											<p className="text-xs font-semibold uppercase tracking-widest text-[var(--text-muted)]">
												{feedError ? t("shared_albums.saved_section_title") : t("shared_albums.cached_section_title")}
											</p>
											<span className="rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-[10px] font-bold tabular-nums text-[var(--text-muted)]">
												{cachedItems.length}
											</span>
										</div>
										{!feedError ? (
											<p className="-mt-1.5 mb-3 px-1 text-xs text-[var(--text-muted)]">
												{t("shared_albums.cached_section_desc")}
											</p>
										) : null}
										<div className="grid gap-4" style={gridStyle}>
											{renderCards(cachedItems)}
										</div>
									</div>
								) : null}
							</>
						)}
					</div>
				</FeedScrollContainer>
			</PullToRefreshContainer>

			{/*
			 * Rendered as siblings of PullToRefreshContainer, not children — its
			 * Content Layer always has an active `transform` (even translateY(0)),
			 * which makes it the containing block for `position: fixed`
			 * descendants. Nesting these overlays inside it would clip them to
			 * app-screen's padding (a gap at the top) and trap them under the
			 * bottom NavBar's stacking context instead of covering it.
			 */}
			{isSelecting ? (
				<div className="album-panel-in pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom,0px)+96px)] z-[52] flex justify-center px-3 md:bottom-[calc(env(safe-area-inset-bottom,0px)+108px)]">
					<div className="pointer-events-auto flex w-full max-w-md items-center gap-1.5 rounded-full border border-white/10 bg-[color-mix(in_srgb,var(--surface)_86%,transparent)] p-1.5 shadow-[0_12px_40px_rgba(0,0,0,0.45)] backdrop-blur-xl">
						<button
							type="button"
							onClick={exitSelection}
							disabled={isDeleting}
							aria-label={t("shared_albums.cancel")}
							className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[var(--text)] transition hover:bg-[var(--surface-2)] disabled:opacity-50"
						>
							<X className="h-5 w-5" />
						</button>
						<span className="min-w-0 flex-1 truncate text-sm font-semibold tabular-nums text-[var(--text)]">
							{t("shared_albums.selected_count", { count: selectedItems.length })}
						</span>
						<button
							type="button"
							onClick={toggleSelectAll}
							disabled={isDeleting}
							className="h-10 shrink-0 rounded-full bg-[var(--surface-2)] px-3.5 text-sm font-semibold text-[var(--text)] transition hover:brightness-110 disabled:opacity-50"
						>
							{allSelected ? t("shared_albums.deselect_all") : t("shared_albums.select_all")}
						</button>
						<button
							type="button"
							onClick={() => setConfirmDeleteItems(selectedItems)}
							disabled={selectedItems.length === 0 || isDeleting}
							className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full bg-red-500 px-4 text-sm font-semibold text-white transition hover:bg-red-600 disabled:opacity-40"
						>
							<Trash2 className="h-4 w-4" />
							{t("shared_albums.delete")}
						</button>
					</div>
				</div>
			) : null}

			{viewer ? (
				<AlbumViewerPanel
					key={viewer.item.album.albumId}
					viewer={viewer}
					avatarUrl={albumAvatar(viewer.item)}
					coverUrl={albumCover(viewer.item)}
					fullScreenIndex={fullScreenIndex}
					closeViewer={closeViewer}
					openFullScreen={openFullScreen}
					onShowHidden={visibleAlbum.showHidden}
					onRetry={() => void openViewer(viewer.item)}
					onDelete={() => setConfirmDeleteItems([viewer.item])}
					onMessageProfile={handleMessageProfile}
					onViewProfile={handleViewProfile}
				/>
			) : null}

			{viewer !== null && fullScreenIndex !== null && (
				<PhotoViewer
					isOpen={true}
					onClose={closeFullScreen}
					photos={viewerPhotos}
					initialIndex={fullScreenIndex}
					onIndexChange={handleIndexChange}
					// Filed under the album's owner, who is always known here. The
					// conversation is only known when it is among the chats loaded
					// on this device, which left older ones in the main folder.
					conversationId={
						viewer.item.profileId != null && viewer.item.profileId !== userId
							? String(viewer.item.profileId)
							: viewer.item.conversationId
					}
					renderFooter={(idx) => {
						const item = viewer.content[idx];
						if (!item || item.hidden || viewer.item.profileId === userId) return null;
						return (
							<PhotoActionBar
								onSendText={(text) =>
									sendAlbumContentReply(viewer.item.album.albumId, item.contentId, item.contentType, viewer.item.profileId, text)
								}
								onReact={() => sendAlbumContentReaction(viewer.item.album.albumId, item.contentId, viewer.item.profileId)}
							/>
						);
					}}
				/>
			)}

			<ConfirmDialog
				isOpen={confirmDeleteItems !== null}
				title={
					(confirmDeleteItems?.length ?? 0) > 1
						? t("shared_albums.confirm_delete_many_title", { count: confirmDeleteItems?.length ?? 0 })
						: t("shared_albums.confirm_delete_title")
				}
				message={
					(confirmDeleteItems?.length ?? 0) > 1
						? t("shared_albums.confirm_delete_many_message")
						: t("shared_albums.confirm_delete_message")
				}
				confirmLabel={
					deleteProgress
						? deleteProgress.total > 1
							? t("shared_albums.deleting_progress", deleteProgress)
							: t("shared_albums.deleting")
						: t("shared_albums.delete")
				}
				cancelLabel={t("shared_albums.cancel")}
				onConfirm={() => (confirmDeleteItems ? void handleDeleteAlbums(confirmDeleteItems) : undefined)}
				onCancel={() => setConfirmDeleteItems(null)}
				isProcessing={isDeleting}
				confirmTone="danger"
			/>
		</>
	);
}
