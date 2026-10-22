import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search, UserX, X } from "lucide-react";
import toast from "react-hot-toast";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { BackToSettings } from "../../components/BackToSettings";
import { PullToRefreshContainer } from "./components/PullToRefreshContainer";
import { BlockListTransferCard } from "./components/BlockListTransferCard";
import { useApiFunctions } from "../../hooks/useApiFunctions";
import { useBlockedProfileIds, useUnblockProfile } from "../../hooks/queries/useProfileQueries";
import { getThumbImageUrl, validateMediaHash } from "../../utils/media";
import { ProfileImage } from "../../components/ui/profile-image";
import { ConfirmDialog } from "../../components/ui/confirm-dialog";
import { EmptyState, ErrorState } from "../../components/ui/states";
import { logBlockEvent } from "../../services/statsLog";
import { SKIP_UNBLOCK_CONFIRM_KEY, isUnblockConfirmSkipped } from "../../utils/blockConfirm";

type BlockedProfileListItem = {
	profileId: string;
	displayName: string;
	avatarUrl: string | null;
};

/** How many profile details to fetch in one batch as the user scrolls. */
const BATCH_SIZE = 20;

export function SettingsBlockedPage() {
	const { t } = useTranslation();
	const navigate = useNavigate();
	const apiFunctions = useApiFunctions();
	const { data: blockedIdsData, isLoading: isLoadingIds, refetch: refetchIds } = useBlockedProfileIds();
	const { mutateAsync: unblockProfileMutation, isPending: isUnblocking } = useUnblockProfile();

	// ── Cache: profileId → detail (persists across scrolls) ──────────────
	const profileCacheRef = useRef(new Map<string, BlockedProfileListItem>());
	const [profileCache, setProfileCache] = useState(new Map<string, BlockedProfileListItem>());

	// ── Lazy-loading state ───────────────────────────────────────────────
	const [loadedUpTo, setLoadedUpTo] = useState(0); // how many IDs we've fetched details for
	const [initialBatchLoaded, setInitialBatchLoaded] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// ── Search ───────────────────────────────────────────────────────────
	const [searchQuery, setSearchQuery] = useState("");

	// ── UI state ──────────────────────────────────────────────────────────
	const [mutatingProfileId, setMutatingProfileId] = useState<string | null>(null);
	const [isUnblockingAll, setIsUnblockingAll] = useState(false);
	const [confirmUnblockAll, setConfirmUnblockAll] = useState(false);
	const [pendingUnblockProfileId, setPendingUnblockProfileId] = useState<string | null>(null);
	const [dontAskAgainChecked, setDontAskAgainChecked] = useState(false);

	// ── Sentinel ref for IntersectionObserver ─────────────────────────────
	const sentinelRef = useRef<HTMLDivElement | null>(null);

	// ── All blocked IDs (master list) ────────────────────────────────────
	const allBlockedIds: string[] = useMemo(() => blockedIdsData ?? [], [blockedIdsData]);

	// ── Filtered list (search) ───────────────────────────────────────────
	const filteredBlockedIds = useMemo(() => {
		if (!searchQuery.trim()) return allBlockedIds;
		const q = searchQuery.trim().toLowerCase();
		return allBlockedIds.filter((id) => {
			const cached = profileCache.get(id);
			if (cached) {
				return (
					cached.displayName.toLowerCase().includes(q) ||
					cached.profileId.includes(q)
				);
			}
			return id.includes(q);
		});
	}, [allBlockedIds, searchQuery, profileCache]);

	// ── Visible slice: show everything we've loaded so far ───────────────
	const visibleIds = useMemo(
		() => filteredBlockedIds.slice(0, loadedUpTo),
		[filteredBlockedIds, loadedUpTo],
	);

	const hasMore = loadedUpTo < allBlockedIds.length;

	// ── Batch-fetch profile details for a list of IDs ────────────────────
	const fetchBatch = useCallback(
		async (ids: string[]) => {
			// Filter out already-cached IDs
			const uncached = ids.filter((id) => !profileCacheRef.current.has(id));
			if (uncached.length === 0) return;

			const newEntries = new Map(profileCacheRef.current);
			try {
				const raw = await apiFunctions.getProfilesByIds(uncached);
				const profiles =
					raw && typeof raw === "object" && Array.isArray((raw as { profiles?: unknown }).profiles)
						? (raw as { profiles: unknown[] }).profiles
						: [];

				const fetchedIds = new Set<string>();
				for (const p of profiles) {
					if (!p || typeof p !== "object") continue;
					const idRaw = (p as { profileId?: unknown }).profileId;
					if (idRaw == null) continue;
					const profileId = String(idRaw);
					fetchedIds.add(profileId);

					const nameRaw = (p as { displayName?: unknown }).displayName;
					const displayName =
						typeof nameRaw === "string" && nameRaw.trim().length > 0
							? nameRaw.trim()
							: t("profile_details.profile_fallback", { id: profileId });
					const hashRaw = (p as { profileImageMediaHash?: unknown }).profileImageMediaHash;
					const avatarUrl =
						typeof hashRaw === "string" && validateMediaHash(hashRaw)
							? getThumbImageUrl(hashRaw, "75x75")
							: null;

					newEntries.set(profileId, { profileId, displayName, avatarUrl });
				}

				// For any uncached IDs that were not returned in the profiles response,
				// create a fallback entry.
				for (const id of uncached) {
					if (!fetchedIds.has(id)) {
						newEntries.set(id, {
							profileId: id,
							displayName: t("profile_details.profile_fallback", { id }),
							avatarUrl: null,
						});
					}
				}
			} catch (e) {
				console.error("Batch fetch failed", e);
				// In case of complete failure, populate fallback entries for uncached IDs
				for (const id of uncached) {
					newEntries.set(id, {
						profileId: id,
						displayName: t("profile_details.profile_fallback", { id }),
						avatarUrl: null,
					});
				}
			}

			profileCacheRef.current = newEntries;
			setProfileCache(new Map(newEntries));
		},
		[apiFunctions, t],
	);

	// ── Sequential batch loader ───────────────────────────────────────────
	const loadNextBatch = useCallback(async () => {
		if (!blockedIdsData || blockedIdsData.length === 0) return;

		const start = profileCacheRef.current.size;
		const end = Math.min(start + BATCH_SIZE, blockedIdsData.length);
		const batchIds = blockedIdsData.slice(start, end);

		if (batchIds.length === 0) return;

		try {
			await fetchBatch(batchIds);
		} catch {
			// Best effort — fetchBatch already creates fallback entries
		}

		setLoadedUpTo(end);
	}, [blockedIdsData, fetchBatch]);

	// ── Load initial batch when blocked IDs arrive ────────────────────────
	useEffect(() => {
		if (!blockedIdsData) return;

		if (blockedIdsData.length === 0) {
			setInitialBatchLoaded(true);
			return;
		}

		let cancelled = false;
		setError(null);

		void (async () => {
			try {
				await fetchBatch(blockedIdsData.slice(0, BATCH_SIZE));
				if (!cancelled) {
					setLoadedUpTo(Math.min(BATCH_SIZE, blockedIdsData.length));
					setInitialBatchLoaded(true);
				}
			} catch (loadError) {
				if (!cancelled) {
					setError(loadError instanceof Error ? loadError.message : t("settings_blocked.error_load"));
				}
			}
		})();

		return () => { cancelled = true; };
	}, [blockedIdsData, fetchBatch, t]);

	// ── IntersectionObserver → triggers loadNextBatch when sentinel visible
	useEffect(() => {
		const sentinel = sentinelRef.current;
		if (!sentinel || !hasMore || !initialBatchLoaded) return;

		let loading = false;

		const observer = new IntersectionObserver(
			(entries) => {
				if (entries[0]?.isIntersecting && !loading) {
					loading = true;
					void loadNextBatch().finally(() => { loading = false; });
				}
			},
			{ rootMargin: "600px" },
		);

		observer.observe(sentinel);
		return () => observer.disconnect();
		// Re-create the observer after each batch so it fires again
	}, [hasMore, initialBatchLoaded, loadedUpTo, loadNextBatch]);

	// ── Handlers ─────────────────────────────────────────────────────────
	const isLoading = isLoadingIds || (!initialBatchLoaded && (blockedIdsData?.length ?? 0) > 0);

	const performUnblock = async (profileId: string) => {
		if (isUnblocking) return;

		setMutatingProfileId(profileId);
		try {
			await unblockProfileMutation(profileId);
			toast.success(t("profile_details.unblock_success"));

			// Remove from local cache
			const updated = new Map(profileCacheRef.current);
			updated.delete(profileId);
			profileCacheRef.current = updated;
			setProfileCache(new Map(updated));
		} catch (unblockError) {
			toast.error(
				unblockError instanceof Error ? unblockError.message : t("profile_details.unblock_failed"),
			);
		} finally {
			setMutatingProfileId(null);
		}
	};

	// Confirmed through the app's own pop-up, as everywhere else that unblocks:
	// the native confirm box never appears in the iOS app.
	const handleUnblockPress = (profileId: string) => {
		if (mutatingProfileId || isUnblocking) return;
		if (isUnblockConfirmSkipped()) {
			void performUnblock(profileId);
			return;
		}
		setDontAskAgainChecked(false);
		setPendingUnblockProfileId(profileId);
	};

	const handleCancelUnblockConfirm = () => {
		if (isUnblocking) return;
		setPendingUnblockProfileId(null);
	};

	const handleConfirmUnblock = async () => {
		if (!pendingUnblockProfileId || isUnblocking) return;
		const profileId = pendingUnblockProfileId;
		if (dontAskAgainChecked) {
			localStorage.setItem(SKIP_UNBLOCK_CONFIRM_KEY, "true");
		}
		setPendingUnblockProfileId(null);
		await performUnblock(profileId);
	};

	const handleUnblockAll = async () => {
		setIsUnblockingAll(true);
		try {
			await apiFunctions.unblockAllProfiles();
			logBlockEvent({ eventType: "unblock", profileId: null, method: "manual", source: "unblock_all" });
			toast.success(t("settings_blocked.unblock_all_success", { defaultValue: "All users unblocked." }));
			profileCacheRef.current = new Map();
			setProfileCache(new Map());
			void refetchIds();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : t("settings_blocked.unblock_all_failed", { defaultValue: "Failed to unblock all profiles." }));
		} finally {
			setIsUnblockingAll(false);
			setConfirmUnblockAll(false);
		}
	};

	const handleProfileClick = (profileId: string) => {
		navigate(`/profile/${profileId}`, { state: { returnTo: "/settings/blocked" } });
	};

	// ── Computed display values ──────────────────────────────────────────
	const loadedCount = profileCache.size;
	const totalCount = allBlockedIds.length;

	return (
		<PullToRefreshContainer
			className="app-screen"
			onRefresh={() => refetchIds()}
			isDisabled={isLoading}
			refreshingLabel={t("settings_blocked.refreshing")}
		>
			<header className="mb-7">
				<BackToSettings />
				<h1 className="app-title mb-1">{t("settings_blocked.title")}</h1>
				<p className="app-subtitle">{t("settings_blocked.subtitle")}</p>
			</header>

			<div className="grid gap-6">
				{/* Above the list: with thousands blocked, the bottom of it is never reached. */}
				<BlockListTransferCard />

				{isLoading ? (
					<div>
						<div className="mb-2 flex items-center gap-2 px-1">
							<div className="h-3 w-16 animate-pulse rounded-full bg-[var(--surface-2)]" />
							{!isLoadingIds && blockedIdsData && blockedIdsData.length > 0 && (
								<div className="h-3.5 w-5 animate-pulse rounded-full bg-[var(--surface-2)]" />
							)}
						</div>
						<div className="surface-card divide-y divide-[var(--border)] overflow-hidden">
							{Array.from({ length: isLoadingIds ? 4 : Math.min(blockedIdsData?.length ?? 4, BATCH_SIZE) }).map((_, i) => (
								<div key={i} className="flex items-center gap-3 px-4 py-3">
									<div className="h-10 w-10 shrink-0 animate-pulse rounded-full bg-[var(--surface-2)]" />
									<div className="min-w-0 flex-1 space-y-1.5">
										<div className="h-3.5 w-28 animate-pulse rounded-full bg-[var(--surface-2)]" />
										<div className="h-3 w-16 animate-pulse rounded-full bg-[var(--surface-2)]" />
									</div>
									<div className="h-7 w-20 animate-pulse rounded-xl bg-[var(--surface-2)]" />
								</div>
							))}
						</div>
					</div>
				) : error ? (
					<ErrorState
						title={t("settings_blocked.error_load")}
						description={error}
						onRetry={() => void refetchIds()}
					/>
				) : allBlockedIds.length === 0 ? (
					<EmptyState
						title={t("settings_blocked.empty")}
						description={t("settings_blocked.empty_desc", { defaultValue: "Accounts you block won't be able to see you or message you." })}
					/>
				) : (
					<div>
						{/* ── Search bar & Unblock All ───────────────── */}
						<div className="flex gap-2 mb-3">
							<div className="relative flex-1">
								<Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
								<input
									type="text"
									value={searchQuery}
									onChange={(e) => setSearchQuery(e.target.value)}
									placeholder={t("settings_blocked.search_placeholder", { defaultValue: "Search by name or ID..." })}
									className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-1)] py-2.5 pl-9 pr-9 text-sm text-[var(--text)] placeholder:text-[var(--text-muted)] outline-none transition focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)]"
								/>
								{searchQuery && (
									<button
										type="button"
										onClick={() => setSearchQuery("")}
										className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-0.5 text-[var(--text-muted)] transition hover:text-[var(--text)]"
									>
										<X className="h-3.5 w-3.5" />
									</button>
								)}
							</div>
							
							{!isLoading && !error && allBlockedIds.length > 0 && (
								<button
									type="button"
									onClick={() => setConfirmUnblockAll(true)}
									disabled={isUnblockingAll}
									className="inline-flex shrink-0 items-center justify-center rounded-xl border border-red-500/30 bg-red-500/10 px-4 text-xs font-bold text-red-400 transition hover:bg-red-500/20 active:scale-95 disabled:opacity-50"
								>
									{isUnblockingAll 
										? t("settings_blocked.unblocking_all", { defaultValue: "Unblocking…" }) 
										: t("settings_blocked.unblock_all_title", { defaultValue: "Unblock All" })}
								</button>
							)}
						</div>

						{/* ── Header with counts ─────────────────────── */}
						<div className="mb-2 flex items-center gap-2 px-1">
							<p className="text-xs font-semibold uppercase tracking-widest text-[var(--text-muted)]">
								{t("settings_blocked.section_label", { defaultValue: "Blocked" })}
							</p>
							<span className="rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-[10px] font-bold tabular-nums text-[var(--text-muted)]">
								{searchQuery ? `${filteredBlockedIds.length} / ${totalCount}` : totalCount}
							</span>
							{loadedCount < totalCount && !searchQuery && (
								<span className="text-[10px] text-[var(--text-muted)] opacity-60">
									({loadedCount} {t("settings_blocked.loaded_label", { defaultValue: "loaded" })})
								</span>
							)}
						</div>

						{/* ── Profile list ────────────────────────────── */}
						{filteredBlockedIds.length === 0 && searchQuery ? (
							<div className="surface-card flex flex-col items-center justify-center gap-2 p-8 text-center">
								<Search className="h-8 w-8 text-[var(--text-muted)] opacity-40" />
								<p className="text-sm text-[var(--text-muted)]">
									{t("settings_blocked.no_search_results", { defaultValue: "No blocked profiles match your search." })}
								</p>
							</div>
						) : (
							<div className="surface-card divide-y divide-[var(--border)] overflow-hidden">
								{visibleIds.map((profileId) => {
									const profile = profileCache.get(profileId);
									const isMutating = mutatingProfileId === profileId;
									const isLoaded = !!profile;

									return (
										<div
											key={profileId}
											className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-[var(--surface-2)]/50 cursor-pointer active:bg-[var(--surface-2)]"
											onClick={() => handleProfileClick(profileId)}
											role="button"
											tabIndex={0}
											onKeyDown={(e) => { if (e.key === "Enter") handleProfileClick(profileId); }}
										>
											{/* Avatar */}
											<div className="h-10 w-10 shrink-0 overflow-hidden rounded-full">
												{isLoaded ? (
													<ProfileImage
														src={profile.avatarUrl}
														alt={t("profile_details.photo_alt", { name: profile.displayName })}
													/>
												) : (
													<div className="h-full w-full animate-pulse bg-[var(--surface-2)]" />
												)}
											</div>

											{/* Name + ID */}
											<div className="min-w-0 flex-1">
												{isLoaded ? (
													<>
														<p className="truncate text-sm font-semibold">
															{profile.displayName}
														</p>
														<p className="text-xs text-[var(--text-muted)]">
															{t("settings_blocked.profile_id", { id: profileId })}
														</p>
													</>
												) : (
													<div className="space-y-1.5">
														<div className="h-3.5 w-28 animate-pulse rounded-full bg-[var(--surface-2)]" />
														<div className="h-3 w-16 animate-pulse rounded-full bg-[var(--surface-2)]" />
													</div>
												)}
											</div>

											{/* Unblock button */}
											<button
												type="button"
												onClick={(e) => {
													e.stopPropagation();
													handleUnblockPress(profileId);
												}}
												onPointerUp={(event) => {
													if (event.pointerType === "mouse") return;
													event.preventDefault();
													event.stopPropagation();
													handleUnblockPress(profileId);
												}}
												disabled={isMutating}
												className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-[var(--border)] px-2.5 py-1.5 text-xs font-semibold text-[var(--text-muted)] transition hover:border-red-400/60 hover:bg-red-500/5 hover:text-red-400 disabled:opacity-50"
											>
												<UserX className="h-3.5 w-3.5" />
												{isMutating
													? t("profile_details.unblock_in_progress")
													: t("profile_details.unblock")}
											</button>
										</div>
									);
								})}

								{/* Infinite-scroll sentinel */}
								{hasMore && (
									<div ref={sentinelRef} className="flex items-center justify-center gap-2 px-4 py-4">
										<div className="h-4 w-4 animate-spin rounded-full border-2 border-[var(--text-muted)] border-t-transparent" />
										<span className="text-xs text-[var(--text-muted)]">
											{t("settings_blocked.loading_more", { defaultValue: "Loading more..." })}
										</span>
									</div>
								)}
							</div>
						)}
					</div>
				)}


			</div>


			<ConfirmDialog
				isOpen={confirmUnblockAll}
				title={t("settings_blocked.unblock_all_title", { defaultValue: "Unblock All" })}
				message={t("settings_blocked.unblock_all_confirm", { defaultValue: "This will unblock all blocked accounts. Are you sure?" })}
				confirmLabel={isUnblockingAll ? t("settings_blocked.unblocking_all", { defaultValue: "Unblocking…" }) : t("settings_blocked.unblock_all_title", { defaultValue: "Unblock All" })}
				cancelLabel={t("settings_blocked.cancel", { defaultValue: "Cancel" })}
				onConfirm={() => void handleUnblockAll()}
				onCancel={() => setConfirmUnblockAll(false)}
				isProcessing={isUnblockingAll}
				confirmTone="danger"
			/>

			<ConfirmDialog
				isOpen={pendingUnblockProfileId !== null}
				title={t("profile_details.unblock")}
				message={t("profile_details.unblock_confirm")}
				confirmLabel={t("profile_details.unblock")}
				cancelLabel={t("chat.actions.cancel")}
				onConfirm={handleConfirmUnblock}
				onCancel={handleCancelUnblockConfirm}
				isProcessing={isUnblocking}
				dontAskAgainLabel={t("profile_details.dont_ask_again")}
				dontAskAgainChecked={dontAskAgainChecked}
				onDontAskAgainChange={setDontAskAgainChecked}
			/>
		</PullToRefreshContainer>
	);
}
