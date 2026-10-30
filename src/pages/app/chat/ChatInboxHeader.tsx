import { Archive, EyeOff, Images, Loader2, Pin, PinOff, Search, SlidersHorizontal, Star, X } from "lucide-react";
import { type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { PageHeaderBackground } from "../../../components/ui/PageHeaderBackground";
import { FilterPill } from "../../../components/ui/FilterPill";
import { buildChatFiltersDraft, type ChatFiltersDraft } from "./chatUtils";
import { cn } from "../../../utils/cn";
import type { InboxFilters } from "../../../types/messages";
import type { InboxVisibilityFilter } from "../../../types/chat-page";
import { useInboxSyncStatus } from "../../../hooks/useInboxSyncStatus";
import { ConnectionDot } from "./ConnectionDot";

export type ChatInboxHeaderProps = {
	isDesktop: boolean;
	userId: number | null;
	inboxFilters: InboxFilters;
	// Pinned/Archived/Hidden are edited in the general filter overlay now
	// (ChatFiltersPanel), not as separate header pills — these read-only
	// values are only needed here to seed that overlay's draft when it opens.
	pinnedFilter: InboxVisibilityFilter;
	archivedFilter: InboxVisibilityFilter;
	hiddenFilter: InboxVisibilityFilter;
	hasActiveInboxFilters: boolean;
	activeFilterCount: number;
	archivedCount: number;
	isSearchOpen: boolean;
	searchQuery: string;
	onSetIsSearchOpen: (v: boolean) => void;
	onSetSearchQuery: (v: string) => void;
	onSetIsFiltersOpen: (v: boolean) => void;
	onSetFiltersDraft: (v: ChatFiltersDraft) => void;
	onToggleFavoritesOnly: () => void;
	onTogglePinnedFilter: () => void;
	onToggleHiddenFilter: () => void;
	onToggleArchivedFilter: () => void;
	onLongPressArchived?: () => void;
	onToggleRightNowOnly: () => void;
	onToggleOnlineNowOnly: () => void;
	onClearInboxFilters: () => void;
	hiddenCount: number;
};

/** Small "Inbox · Syncing 42%" caption under the title — the mobile-only,
 * minimal home for background sync status. Desktop instead gets a proper
 * footer row under the list (ChatSyncFooterRow in ChatInboxPanel); mobile's
 * fixed bottom nav bar leaves no clean spot for a footer, so this reuses
 * space the header already owns instead of adding a new floating element. */
function ChatSyncHeaderCaption({ userId }: { userId: number | null }) {
	const { t } = useTranslation();
	const status = useInboxSyncStatus(userId);

	if (status.phase !== "syncing_list" && status.phase !== "syncing_messages") {
		return null;
	}

	const label =
		status.phase === "syncing_list"
			? t("chat.sync_progress.syncing_list", {
					defaultValue: "Syncing chats… {{count}} checked",
					count: status.conversationsSoFar,
				})
			: t("chat.sync_progress.syncing_messages_percent", {
					defaultValue: "Syncing messages… {{percent}}%",
					percent: status.total > 0 ? Math.round((status.completed / status.total) * 100) : 0,
				});

	return (
		<p className="mt-0.5 flex items-center gap-1 text-[11px] font-medium text-[var(--text-muted)]">
			<Loader2 className="h-2.5 w-2.5 shrink-0 animate-spin text-[var(--accent)]" />
			<span className="truncate">{label}</span>
		</p>
	);
}

export function ChatInboxHeader({
	isDesktop,
	userId,
	inboxFilters,
	pinnedFilter,
	archivedFilter,
	hiddenFilter,
	hasActiveInboxFilters,
	activeFilterCount,
	archivedCount,
	isSearchOpen,
	searchQuery,
	onSetIsSearchOpen,
	onSetSearchQuery,
	onSetIsFiltersOpen,
	onSetFiltersDraft,
	onToggleFavoritesOnly,
	onTogglePinnedFilter,
	onToggleHiddenFilter,
	onToggleArchivedFilter,
	onLongPressArchived,
	onToggleRightNowOnly: _onToggleRightNowOnly,
	onToggleOnlineNowOnly: _onToggleOnlineNowOnly,
	onClearInboxFilters: _onClearInboxFilters,
	hiddenCount,
}: ChatInboxHeaderProps) {
	const { t } = useTranslation();
	const navigate = useNavigate();

	return (
		<header className="relative z-20 shrink-0 pointer-events-none">
				<PageHeaderBackground color="var(--accent)" />

				<div className={`pointer-events-auto flex flex-col gap-3 mx-auto w-full px-[var(--app-px)] ${isDesktop ? "max-w-6xl" : ""}`}>

					{/* Row 1: title + icon buttons */}
					<div className="flex items-center justify-between gap-2">
						<div className="min-w-0">
							<h1 className="app-title relative w-fit">
								{t("nav.inbox")}
								<ConnectionDot isDesktop={isDesktop} />
							</h1>
							{!isDesktop && !isSearchOpen && <ChatSyncHeaderCaption userId={userId} />}
						</div>

						<div className="flex shrink-0 items-center gap-0.5">
							{!isSearchOpen && (
								<button
									type="button"
									onClick={() => navigate("/chat/albums")}
									className="-mr-1 rounded-xl p-2 text-[var(--text-muted)] transition hover:text-[var(--text)]"
									aria-label={t("chat.tabs.albums")}
								>
									<Images className="h-5 w-5" />
								</button>
							)}
							<button
								type="button"
								onClick={() => {
									if (isSearchOpen) { onSetIsSearchOpen(false); onSetSearchQuery(""); }
									else onSetIsSearchOpen(true);
								}}
								className="rounded-xl p-2 text-[var(--text-muted)] transition hover:text-[var(--text)]"
								aria-label={isSearchOpen ? t("common.close") : t("chat.open_search")}
							>
								{isSearchOpen ? <X className="h-5 w-5" /> : <Search className="h-5 w-5" />}
							</button>
						</div>
					</div>

					{/* Row 2: filter pills */}
					{!isSearchOpen && (
						<div className="-mx-[var(--app-px)] overflow-x-auto pb-4 pt-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
							<div className="flex min-w-max items-center gap-2 px-[var(--app-px)]">
								<FilterPill
									icon={<Star className={`h-3.5 w-3.5 ${inboxFilters.favoritesOnly ? "fill-current" : ""}`} />}
									label={t("browse_filters.options.favorites")}
									active={Boolean(inboxFilters.favoritesOnly)}
									onClick={onToggleFavoritesOnly}
								/>
								<FilterPill
									icon={pinnedFilter === "hide" ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
									label={t("chat.pinned")}
									active={pinnedFilter === "hide"}
									onClick={onTogglePinnedFilter}
								/>
								{hiddenCount > 0 && (
									<FilterPill
										icon={<EyeOff className="h-3.5 w-3.5" />}
										label={t("chat.hidden.filter_label", { defaultValue: "Hidden" })}
										active={hiddenFilter === "only"}
										onClick={onToggleHiddenFilter}
										badge={hiddenCount}
									/>
								)}
								<FilterPill
									icon={<Archive className="h-3.5 w-3.5" />}
									label={t("chat.archived.filter_label", { defaultValue: "Archived" })}
									active={archivedFilter === "only"}
									onClick={onToggleArchivedFilter}
									onLongPress={onLongPressArchived}
									badge={archivedCount > 0 ? archivedCount : undefined}
								/>
								<button
									type="button"
									onClick={() => {
										onSetFiltersDraft(buildChatFiltersDraft(inboxFilters, { pinnedFilter, archivedFilter, hiddenFilter }));
										onSetIsFiltersOpen(true);
									}}
									className={cn(
										"inline-flex shrink-0 items-center gap-1.5 px-4 py-2 text-sm font-bold transition-all active:scale-95",
										hasActiveInboxFilters
											? "rounded-full border border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-contrast)] shadow-lg shadow-[var(--accent)]/40"
											: "glass-pill text-[var(--accent)] hover:border-[var(--accent)]/60 hover:bg-[var(--accent)]/20",
									)}
									style={!hasActiveInboxFilters ? { "--pill-color": "var(--accent)" } as CSSProperties : undefined}
								>
									<SlidersHorizontal className="h-3.5 w-3.5" />
									{t("right_now.filters")}
									{hasActiveInboxFilters && activeFilterCount > 0 && (
										<span className="ml-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-[var(--accent-contrast)] px-1 text-[9px] font-bold text-[var(--accent)]">
											{activeFilterCount}
										</span>
									)}
								</button>
							</div>
						</div>
					)}

					{/* Row 2: search input */}
					{isSearchOpen && (
						<div className="flex flex-col gap-2 pb-4">
							<div className="relative">
								<Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
								<input
									autoFocus
									value={searchQuery}
									onChange={(e) => onSetSearchQuery(e.target.value)}
									placeholder={t("chat_search.placeholder")}
									className="h-10 w-full rounded-full border border-[var(--border)] bg-[var(--surface-2)] pl-9 pr-8 text-sm text-[var(--text)] outline-none transition focus:border-[var(--accent)]"
								/>
								{searchQuery && (
									<button
										type="button"
										onClick={() => onSetSearchQuery("")}
										className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-0.5 text-[var(--text-muted)] hover:text-[var(--text)]"
									>
										<X className="h-3.5 w-3.5" />
									</button>
								)}
							</div>
						</div>
					)}


				</div>
		</header>
	);
}
