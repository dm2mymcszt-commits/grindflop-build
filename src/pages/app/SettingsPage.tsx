import { useNavigate } from "react-router-dom";
import {
	AlertCircle,
	Bell,
	Bookmark,
	Bug,
	CheckCircle2,
	ChevronLeft,
	ChevronRight,
	DatabaseBackup,
	Download,
	Images,
	Info,
	Loader2,
	LogOut,
	Megaphone,
	Palette,
	Radar,
	Search,
	Shield,
	SlidersHorizontal,
    Workflow,
	UserPlus,
	UserX,
	X,
} from "lucide-react";
import { useState, useCallback, useEffect, useMemo, useRef, type CSSProperties } from "react";
import toast from "react-hot-toast";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useAuth } from "../../contexts/useAuth";
import { useApi } from "../../hooks/useApi";
import { usePreferences } from "../../contexts/PreferencesContext";
import { exportAllLogs } from "../../services/chatLog";
import { useInboxSyncStatus } from "../../hooks/useInboxSyncStatus";
import type { InboxSyncStatus } from "../../services/inboxSync";
import { Button } from "../../components/ui/button";
import { ConfirmDialog } from "../../components/ui/confirm-dialog";
import { FingerprintCheckButton } from "../../components/FingerprintCheckButton";
import { VersionAnnouncement } from "../../components/VersionAnnouncement";
import { VERSION_ANNOUNCEMENTS } from "../../data/versionAnnouncements";
import { Avatar } from "../../components/ui/avatar";
import { getThumbImageUrl } from "../../utils/media";
import { getSavedAccountProfile, removeSavedAccountProfile } from "../../services/savedAccountProfiles";
import {
	settingsSearchHref,
	useSettingsSearchIndex,
	type SettingsSearchEntry,
} from "../../data/settingsSearchIndex";
import { useSettingsJump } from "../../hooks/useSettingsJump";
import { searchSettings } from "../../utils/settingsSearch";

const PUSH_TOKEN_STORAGE_KEY = "fg-fcm-token";
const PUSH_TOKEN_SYNCED_STORAGE_KEY = "fg-fcm-token-synced";
// Always previews whichever entry was added/edited most recently, regardless
// of whether it matches the app's current running version yet.
const LATEST_ANNOUNCEMENT = VERSION_ANNOUNCEMENTS[VERSION_ANNOUNCEMENTS.length - 1] ?? null;
function getErrorMessage(error: unknown, fallback: string): string {
	if (error instanceof Error && error.message) {
		return error.message;
	}

	if (typeof error === "string") {
		return error;
	}

	try {
		return JSON.stringify(error);
	} catch {
		// ignore
	}

	return fallback;
}

function describeInboxSyncStatus(status: InboxSyncStatus, t: TFunction) {
	switch (status.phase) {
		case "syncing_list":
			return {
				title: t("settings.chat_sync_syncing_list", { defaultValue: "Checking for new chats…" }),
				description:
					status.changedSoFar > 0
						? t("settings.chat_sync_syncing_list_desc_changed", {
								defaultValue: "{{checked}} checked, {{changed}} new or updated",
								checked: status.conversationsSoFar,
								changed: status.changedSoFar,
							})
						: t("settings.chat_sync_syncing_list_desc", {
								defaultValue: "{{count}} checked so far",
								count: status.conversationsSoFar,
							}),
				badgeIcon: <Loader2 className="h-3 w-3 animate-spin" />,
				badgeClass: "",
				badgeStyle: {
					backgroundColor: "var(--accent)",
					color: "var(--accent-contrast)",
				} as CSSProperties | undefined,
				progressPercent: null as number | null,
				active: true,
			};
		case "syncing_messages": {
			const progressPercent =
				status.total > 0 ? Math.round((status.completed / status.total) * 100) : null;
			return {
				title: t("settings.chat_sync_syncing_messages", {
					defaultValue: "Syncing latest messages…",
				}),
				description: t("settings.chat_sync_syncing_messages_desc", {
					defaultValue: "{{completed}} / {{total}} conversations",
					completed: status.completed,
					total: status.total,
				}),
				badgeIcon: <Loader2 className="h-3 w-3 animate-spin" />,
				badgeClass: "",
				badgeStyle: {
					backgroundColor: "var(--accent)",
					color: "var(--accent-contrast)",
				} as CSSProperties | undefined,
				progressPercent,
				active: true,
			};
		}
		case "done":
			return {
				title: t("settings.chat_sync_done", { defaultValue: "Chats up to date" }),
				description:
					status.changed > 0
						? t("settings.chat_sync_done_desc_changed", {
								defaultValue: "{{count}} conversations total, {{changed}} just updated",
								count: status.conversations,
								changed: status.changed,
							})
						: t("settings.chat_sync_done_desc", {
								defaultValue: "{{count}} conversations synced",
								count: status.conversations,
							}),
				badgeIcon: <CheckCircle2 className="h-3 w-3" />,
				badgeClass: "bg-emerald-500 text-white",
				badgeStyle: undefined as CSSProperties | undefined,
				progressPercent: null,
				active: false,
			};
		case "error":
			return {
				title: t("settings.chat_sync_error", { defaultValue: "Chat sync failed" }),
				description: status.message,
				badgeIcon: <AlertCircle className="h-3 w-3" />,
				badgeClass: "bg-red-500 text-white",
				badgeStyle: undefined as CSSProperties | undefined,
				progressPercent: null,
				active: false,
			};
		default:
			return {
				title: t("settings.chat_sync_preparing", { defaultValue: "Preparing chat sync…" }),
				description: t("settings.chat_sync_preparing_desc", {
					defaultValue: "Runs in the background and won't slow down the app.",
				}),
				badgeIcon: <Loader2 className="h-3 w-3 animate-spin" />,
				badgeClass: "",
				badgeStyle: {
					backgroundColor: "var(--accent)",
					color: "var(--accent-contrast)",
				} as CSSProperties | undefined,
				progressPercent: null,
				active: true,
			};
	}
}

export function SettingsPage() {
	const { t } = useTranslation();
	const { userId, logout, savedAccounts, switchAccount, removeSavedAccount } = useAuth();
	const inboxSyncStatus = useInboxSyncStatus(userId);
	const inboxSyncDisplay = describeInboxSyncStatus(inboxSyncStatus, t);
	const [searchQuery, setSearchQuery] = useState("");
	const settingsSearchIndex = useSettingsSearchIndex();
	const searchResults = useMemo(
		() => searchSettings(settingsSearchIndex, searchQuery),
		[settingsSearchIndex, searchQuery],
	);
	const isSearching = searchQuery.trim().length > 0;
	useSettingsJump();
	const [switchingProfileId, setSwitchingProfileId] = useState<string | null>(null);
	const [removingProfileId, setRemovingProfileId] = useState<string | null>(null);
	const [isLoggingOut, setIsLoggingOut] = useState(false);
	// "active" = end the current session; a profile id = forget that saved
	// (non-active) account — both are presented the same way (logout icon +
	// confirmation) even though only the active one is a "real" logout.
	const [logoutConfirmTarget, setLogoutConfirmTarget] = useState<"active" | string | null>(null);
	const navigate = useNavigate();
	const { callMethod, asAppError } = useApi();
	const { developerMode, showDebugInfo, setPreferences } = usePreferences();
	const [previewAnnouncement, setPreviewAnnouncement] = useState(false);
	const [isSyncingFcm, setIsSyncingFcm] = useState(false);
	const [fcmToken, setFcmToken] = useState<string | null>(() => {
		const stored = window.localStorage.getItem(PUSH_TOKEN_STORAGE_KEY);
		if (stored) return stored;
		const win = window as Window & { __FG_FCM_TOKEN?: string };
		return typeof win.__FG_FCM_TOKEN === "string" ? win.__FG_FCM_TOKEN : null;
	});
	const [fcmSyncedToken, setFcmSyncedToken] = useState<string | null>(() => window.localStorage.getItem(PUSH_TOKEN_SYNCED_STORAGE_KEY));
	const [fcmEventLog, setFcmEventLog] = useState<{ time: string; token: string }[]>([]);
	const [manualToken, setManualToken] = useState("");
    // removed unused automation settings variables
	const fcmLogRef = useRef<HTMLDivElement>(null);
	const [isExporting, setIsExporting] = useState(false);

	const handleExport = async () => {
		setIsExporting(true);
		try {
			const data = await exportAllLogs();
			const json = JSON.stringify(data, null, 2);
			const blob = new Blob([json], { type: "application/json" });
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = `free-grind-export-${new Date().toISOString().slice(0, 10)}.json`;
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
			URL.revokeObjectURL(url);
			toast.success(t("settings.export_chat_done"));
		} catch (error) {
			const message = getErrorMessage(error, t("settings.export_chat_failed"));
			toast.error(message);
		} finally {
			setIsExporting(false);
		}
	};

	useEffect(() => {
		const onFcmToken = (event: Event) => {
			const token = (event as CustomEvent<{ token: string }>).detail?.token;
			if (typeof token !== "string") return;
			setFcmToken(token);
			setFcmSyncedToken(window.localStorage.getItem(PUSH_TOKEN_SYNCED_STORAGE_KEY));
			const time = new Date().toLocaleTimeString();
			setFcmEventLog((prev) => [...prev, { time, token }]);
			setTimeout(() => {
				fcmLogRef.current?.scrollTo({ top: fcmLogRef.current.scrollHeight, behavior: "smooth" });
			}, 50);
		};
		window.addEventListener("fg:fcm-token", onFcmToken as EventListener);
		return () => window.removeEventListener("fg:fcm-token", onFcmToken as EventListener);
	}, []);


	const handleForceSyncFcm = useCallback(async (overrideToken?: string) => {
		const tokenToSync = overrideToken ?? fcmToken;
		if (!tokenToSync) {
			toast.error("No FCM token to sync.");
			return;
		}
		setIsSyncingFcm(true);
		try {
			await callMethod("sync_push_token", { token: tokenToSync });
			window.localStorage.setItem(PUSH_TOKEN_SYNCED_STORAGE_KEY, tokenToSync);
			setFcmSyncedToken(tokenToSync);
			toast.success("FCM token synced to Grindr.");
		} catch (error) {
			const appError = asAppError(error);
			toast.error(appError?.prettyMessage ?? (error instanceof Error ? error.message : "Sync failed"));
		} finally {
			setIsSyncingFcm(false);
		}
	}, [fcmToken, callMethod, asAppError]);

	const handleLogout = async () => {
		setIsLoggingOut(true);
		try {
			await logout();
			navigate("/auth/sign-in");
		} catch (error) {
			const message = getErrorMessage(error, t("settings.logout_failed"));
			toast.error(message);
		} finally {
			setIsLoggingOut(false);
			setLogoutConfirmTarget(null);
		}
	};

	const handleSwitchAccount = async (profileId: string) => {
		setSwitchingProfileId(profileId);
		try {
			await switchAccount(profileId);
			navigate("/");
		} catch (error) {
			const message = getErrorMessage(error, "Failed to switch account.");
			toast.error(message);
		} finally {
			setSwitchingProfileId(null);
		}
	};

	const handleRemoveSavedAccount = async (profileId: string) => {
		setRemovingProfileId(profileId);
		try {
			await removeSavedAccount(profileId);
			removeSavedAccountProfile(profileId);
		} catch (error) {
			const message = getErrorMessage(error, t("settings.remove_account_failed"));
			toast.error(message);
		} finally {
			setRemovingProfileId(null);
			setLogoutConfirmTarget(null);
		}
	};



	const navRow = (
		onClick: (() => void) | null,
		icon: React.ReactNode,
		iconClass: string,
		label: string,
		desc: string,
		right?: React.ReactNode,
		disabled?: boolean,
		id?: string,
	) => {
		const inner = (
			<>
				<div className={`rounded-2xl p-2.5 shrink-0 ${iconClass}`}>
					{icon}
				</div>
				<div className="min-w-0 flex-1">
					<p className="text-sm font-semibold leading-snug">{label}</p>
					<p className="text-xs text-[var(--text-muted)] leading-snug mt-0.5">{desc}</p>
				</div>
				{right ?? <ChevronRight className="h-4 w-4 shrink-0 text-[var(--text-muted)] opacity-50" />}
			</>
		);
		const cls = `flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors ${disabled ? "opacity-50 cursor-not-allowed" : "hover:bg-[var(--surface-2)] active:bg-[var(--surface-2)]"}`;
		return onClick ? (
			<button id={id} type="button" onClick={onClick} disabled={disabled} className={cls}>
				{inner}
			</button>
		) : (
			<div id={id} className={cls}>{inner}</div>
		);
	};

	const openSearchResult = (entry: SettingsSearchEntry) => {
		// A result on this very screen: its row only exists once the list is back.
		if (entry.route === "/settings") {
			setSearchQuery("");
		}
		navigate(settingsSearchHref(entry));
	};

	return (
		<section className="app-screen">
			<header className="mb-7">
				<button
					type="button"
					onClick={() => navigate("/")}
					className="mb-4 inline-flex items-center gap-1.5 text-sm text-[var(--text-muted)] transition-colors hover:text-[var(--text)]"
					aria-label={t("settings.back_to_browse")}
				>
					<ChevronLeft className="h-4 w-4" />
					{t("nav.browse")}
				</button>
				<div className="flex items-center gap-2">
					<h1 className="app-title">{t("settings.title")}</h1>
					{developerMode ? (
						<span className="rounded-full bg-[var(--accent)] px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--accent-contrast)]">
							{t("settings.developer_mode")}
						</span>
					) : null}
				</div>
				<p className="app-subtitle mt-1">{t("settings.subtitle")}</p>
			</header>

			<div className="settings-search-bar mb-6 flex items-center gap-2.5 px-4 py-0.5">
				<Search className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
				<input
					type="text"
					inputMode="search"
					enterKeyHint="search"
					autoCapitalize="none"
					autoCorrect="off"
					spellCheck={false}
					value={searchQuery}
					onChange={(e) => setSearchQuery(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Escape" && searchQuery) {
							e.preventDefault();
							setSearchQuery("");
						}
					}}
					placeholder={t("settings.search_placeholder")}
					aria-label={t("settings.search_placeholder")}
					className="h-11 min-w-0 flex-1 bg-transparent text-sm text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none"
				/>
				{searchQuery ? (
					<button
						type="button"
						onClick={() => setSearchQuery("")}
						className="shrink-0 rounded-full p-1 text-[var(--text-muted)] transition hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
						aria-label={t("settings.search_clear")}
					>
						<X className="h-4 w-4" />
					</button>
				) : null}
			</div>

			{isSearching ? (
				searchResults.length === 0 ? (
					<p className="px-1 text-sm text-[var(--text-muted)]">
						{t("settings.search_no_results", { query: searchQuery.trim() })}
					</p>
				) : (
					<div className="surface-card overflow-hidden divide-y divide-[var(--border)]">
						{searchResults.map((entry) => (
							<button
								key={entry.id}
								type="button"
								onClick={() => openSearchResult(entry)}
								className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-[var(--surface-2)] active:bg-[var(--surface-2)]"
							>
								<div className={`shrink-0 rounded-2xl p-2.5 ${entry.iconClass}`}>
									<entry.icon className="h-5 w-5" />
								</div>
								<div className="min-w-0 flex-1">
									<p className="text-sm font-semibold leading-snug">{entry.label}</p>
									<p className="mt-0.5 truncate text-xs leading-snug text-[var(--text-muted)]">
										{entry.section}
										{entry.description ? ` — ${entry.description}` : ""}
									</p>
								</div>
								<ChevronRight className="h-4 w-4 shrink-0 text-[var(--text-muted)] opacity-50" />
							</button>
						))}
					</div>
				)
			) : (
			<div className="grid gap-6">

				{/* Profile — the active profile is the primary focus (tap it to edit
				    your profile), with the account switcher folded in below it for
				    the other saved accounts you can tap between without
				    re-entering a password. Each saved account keeps its own chat
				    history and caches fully separate (see chatDb.ts/cache.ts), so
				    switching never shows a leftover account's data. */}
				<div>
					<p className="mb-2 px-1 text-xs font-semibold uppercase tracking-widest text-[var(--text-muted)]">{t("settings.section_profile")}</p>
					<div className="surface-card overflow-hidden divide-y divide-[var(--border)]">
						{(() => {
							const activeAccount = userId != null
								? savedAccounts.find((account) => String(userId) === account.profileId)
								: undefined;
							const activeProfile = userId != null ? getSavedAccountProfile(String(userId)) : null;
							return (
								<div className="flex items-center gap-1">
									<button
										type="button"
										onClick={() => navigate("/settings/profile-editor")}
										className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-[var(--surface-2)] active:bg-[var(--surface-2)]"
									>
										<Avatar
											src={activeProfile?.photoHash ? getThumbImageUrl(activeProfile.photoHash, "75x75") : null}
											alt=""
											className="h-10 w-10 shrink-0 rounded-2xl border-0"
										/>
										<div className="min-w-0 flex-1">
											<p className="truncate text-sm font-semibold leading-snug">
												{activeProfile?.displayName || activeAccount?.email || t("settings.profile_editor")}
											</p>
											<p className="text-xs text-[var(--text-muted)] leading-snug mt-0.5">
												{t("settings.profile_editor_desc")}
											</p>
										</div>
									</button>
									<button
										type="button"
										onClick={() => setLogoutConfirmTarget("active")}
										aria-label={t("settings.logout")}
										className="mr-2 shrink-0 rounded-xl p-2.5 text-[var(--text-muted)] transition hover:bg-red-500/10 hover:text-red-400"
									>
										<LogOut className="h-4 w-4" />
									</button>
								</div>
							);
						})()}

						{savedAccounts
							.filter((account) => !(userId != null && String(userId) === account.profileId))
							.map((account) => {
								const isSwitching = switchingProfileId === account.profileId;
								const isRemoving = removingProfileId === account.profileId;
								const savedProfile = getSavedAccountProfile(account.profileId);
								return (
									<div key={account.profileId} className="flex items-center gap-1">
										<button
											type="button"
											onClick={() => void handleSwitchAccount(account.profileId)}
											disabled={isSwitching || isRemoving}
											className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-[var(--surface-2)] active:bg-[var(--surface-2)] disabled:cursor-not-allowed"
										>
											<div className="relative h-10 w-10 shrink-0">
												<Avatar
													src={savedProfile.photoHash ? getThumbImageUrl(savedProfile.photoHash, "75x75") : null}
													alt=""
													className="h-full w-full rounded-2xl border-0"
												/>
												{isSwitching && (
													<div className="absolute inset-0 flex items-center justify-center rounded-2xl bg-[var(--surface)]/80">
														<Loader2 className="h-5 w-5 animate-spin text-[var(--accent)]" />
													</div>
												)}
											</div>
											<div className="min-w-0 flex-1">
												<p className="truncate text-sm font-semibold leading-snug">
													{savedProfile.displayName || account.email || account.profileId}
												</p>
												<p className="text-xs text-[var(--text-muted)] leading-snug mt-0.5">
													{t("settings.account_tap_to_switch", { defaultValue: "Tap to switch" })}
												</p>
											</div>
										</button>
										<button
											type="button"
											onClick={() => setLogoutConfirmTarget(account.profileId)}
											disabled={isSwitching || isRemoving}
											aria-label={t("settings.logout")}
											className="mr-2 shrink-0 rounded-xl p-2.5 text-[var(--text-muted)] transition hover:bg-red-500/10 hover:text-red-400 disabled:opacity-60"
										>
											{isRemoving ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />}
										</button>
									</div>
								);
							})}
						<button
							type="button"
							onClick={() => navigate("/auth/sign-in?mode=add-profile")}
							className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-[var(--surface-2)] active:bg-[var(--surface-2)]"
						>
							<div className="rounded-2xl bg-[var(--surface-2)] p-2.5 shrink-0 text-[var(--text-muted)]">
								<UserPlus className="h-5 w-5" />
							</div>
							<div className="min-w-0 flex-1">
								<p className="text-sm font-semibold leading-snug">
									{t("settings.add_account", { defaultValue: "Add account" })}
								</p>
								<p className="text-xs text-[var(--text-muted)] leading-snug mt-0.5">
									{t("settings.add_account_desc", { defaultValue: "Sign in with another account" })}
								</p>
							</div>
							<ChevronRight className="h-4 w-4 shrink-0 text-[var(--text-muted)] opacity-50" />
						</button>
					</div>
				</div>

				{/* Customizability */}
				<div>
					<p className="mb-2 px-1 text-xs font-semibold uppercase tracking-widest text-[var(--text-muted)]">{t("settings.section_customizability")}</p>
					<div className="surface-card overflow-hidden divide-y divide-[var(--border)]">
						{navRow(
							() => navigate("/settings/customizability"),
							<Palette className="h-5 w-5" />,
							"bg-violet-500/15 text-violet-400",
							t("settings.customizability"),
							t("settings.customizability_desc"),
						)}
						{navRow(
							() => navigate("/settings/behavior"),
							<SlidersHorizontal className="h-5 w-5" />,
							"bg-slate-500/15 text-slate-400",
							t("settings.behavior"),
							t("settings.behavior_desc"),
						)}
						{navRow(
							() => navigate("/settings/notifications"),
							<Bell className="h-5 w-5" />,
							"bg-blue-500/15 text-blue-400",
							t("settings.notifications"),
							t("settings.notifications_desc"),
						)}
					</div>
				</div>

				{/* Chat */}
				<div>
					<p className="mb-2 px-1 text-xs font-semibold uppercase tracking-widest text-[var(--text-muted)]">{t("settings.section_chat")}</p>
					<div className="surface-card overflow-hidden divide-y divide-[var(--border)]">
						<div className="flex items-center gap-3 px-4 py-3.5">
							<div className="relative shrink-0">
								<div className="rounded-2xl bg-[var(--surface-2)] p-2.5 text-[var(--text-muted)]">
									<DatabaseBackup className="h-5 w-5" />
								</div>
								<div
									className={`absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full ring-2 ring-[var(--surface)] ${inboxSyncDisplay.badgeClass}`}
									style={inboxSyncDisplay.badgeStyle}
								>
									{inboxSyncDisplay.badgeIcon}
								</div>
							</div>
							<div className="min-w-0 flex-1">
								<div className="flex items-center justify-between gap-2">
									<p className="text-sm font-semibold leading-snug">{inboxSyncDisplay.title}</p>
									{inboxSyncDisplay.progressPercent != null && (
										<p className="shrink-0 text-xs font-semibold tabular-nums text-[var(--accent)]">
											{inboxSyncDisplay.progressPercent}%
										</p>
									)}
								</div>
								<p className="mt-0.5 text-xs leading-snug tabular-nums text-[var(--text-muted)]">
									{inboxSyncDisplay.description}
								</p>
								{inboxSyncDisplay.active && (
									<div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-2)]">
										<div
											className={
												inboxSyncDisplay.progressPercent == null
													? "h-full w-2/5 animate-progress-indeterminate rounded-full bg-[var(--accent)]"
													: "h-full rounded-full bg-[var(--accent)] transition-all duration-300"
											}
											style={
												inboxSyncDisplay.progressPercent != null
													? { width: `${inboxSyncDisplay.progressPercent}%` }
													: undefined
											}
										/>
									</div>
								)}
							</div>
						</div>
						{navRow(
							() => navigate("/settings/automation"),
							<Workflow className="h-5 w-5" />,
							"bg-amber-500/15 text-amber-400",
							t("settings.automation"),
							t("settings.automation_desc"),
						)}
						{navRow(
							() => navigate("/settings/saved-phrases"),
							<Bookmark className="h-5 w-5" />,
							"bg-emerald-500/15 text-emerald-400",
							t("settings.saved_phrases", { defaultValue: "Saved Phrases" }),
							t("settings.saved_phrases_desc", { defaultValue: "Manage chat quick replies and import/export .txt" }),
						)}
						{navRow(
							() => navigate("/settings/albums"),
							<Images className="h-5 w-5" />,
							"bg-pink-500/15 text-pink-400",
							t("settings.my_albums"),
							t("settings.my_albums_desc"),
						)}
						{navRow(
							isExporting ? null : () => void handleExport(),
							<Download className="h-5 w-5" />,
							"bg-teal-500/15 text-teal-400",
							t("settings.export_chat", { defaultValue: "Export Chats" }),
							t("settings.export_chat_desc", { defaultValue: "Download all message history as JSON." }),
							isExporting ? <span className="text-xs text-[var(--text-muted)]">{t("settings.exporting")}</span> : undefined,
							isExporting,
							"settings-export-chat",
						)}
					</div>
				</div>

				{/* Safety */}
				<div>
					<p className="mb-2 px-1 text-xs font-semibold uppercase tracking-widest text-[var(--text-muted)]">{t("settings.section_safety")}</p>
					<div className="surface-card overflow-hidden divide-y divide-[var(--border)]">
						{navRow(
							() => navigate("/settings/blocked"),
							<UserX className="h-5 w-5" />,
							"bg-red-500/15 text-red-400",
							t("settings.blocked_accounts"),
							t("settings.blocked_accounts_desc"),
						)}
						{navRow(
							() => navigate("/settings/privacy"),
							<Shield className="h-5 w-5" />,
							"bg-sky-500/15 text-sky-400",
							t("settings.privacy"),
							t("settings.privacy_desc"),
						)}
					</div>
				</div>

				{/* Data */}
				<div>
					<p className="mb-2 px-1 text-xs font-semibold uppercase tracking-widest text-[var(--text-muted)]">
						{t("settings.data_section", { defaultValue: "Data" })}
					</p>
					<div className="surface-card overflow-hidden divide-y divide-[var(--border)]">
						{navRow(
							() => navigate("/settings/data"),
							<DatabaseBackup className="h-5 w-5" />,
							"bg-teal-500/15 text-teal-400",
							t("settings.data", { defaultValue: "Data" }),
							t("settings.data_desc", { defaultValue: "Downloaded media storage, and back up/restore your entire account" }),
						)}
					</div>
				</div>



				{/* Dev tools */}
				{developerMode ? (
					<div>
						<p className="mb-2 px-1 text-xs font-semibold uppercase tracking-widest text-[var(--text-muted)]">{t("settings.section_developer")}</p>
						<div className="surface-card overflow-hidden divide-y divide-[var(--border)]">
							<div className="flex w-full items-center gap-3 px-4 py-3.5">
								<div className="rounded-2xl bg-[var(--surface-2)] p-2.5 shrink-0 text-[var(--text-muted)]">
									<Bug className="h-5 w-5" />
								</div>
								<div className="min-w-0 flex-1">
									<p className="text-sm font-semibold leading-snug">Show Debug Overlays</p>
									<p className="text-xs text-[var(--text-muted)] mt-0.5">Displays source (cache/network) info in the grid.</p>
								</div>
								<button
									type="button"
									onClick={() => void setPreferences({ showDebugInfo: !showDebugInfo })}
									className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${showDebugInfo ? "bg-[var(--accent)]" : "bg-[var(--surface-2)]"}`}
								>
									<span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ${showDebugInfo ? "translate-x-5" : "translate-x-0"}`} />
								</button>
							</div>
							{navRow(
								() => navigate("/settings/api-inspector"),
								<Radar className="h-5 w-5" />,
								"bg-[var(--surface-2)] text-[var(--text-muted)]",
								t("settings.api_inspector"),
								t("settings.api_inspector_desc"),
							)}
							<div className="p-4 sm:p-5">
								<div className="flex items-start gap-3">
									<div className="rounded-2xl bg-[var(--surface-2)] p-2.5 shrink-0 text-[var(--text-muted)]">
										<Bell className="h-5 w-5" />
									</div>
									<div className="grid gap-3 min-w-0 flex-1">
										<div className="flex items-center gap-2 flex-wrap">
											<p className="text-sm font-semibold">Push Token (FCM)</p>
											{fcmToken && (
												<span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${fcmSyncedToken === fcmToken ? "bg-green-500/20 text-green-400" : "bg-yellow-500/20 text-yellow-400"}`}>
													{fcmSyncedToken === fcmToken ? "✓ Synced" : "⚠ Not synced"}
												</span>
											)}
										</div>
										{fcmToken ? (
											<div className="grid gap-2">
												<div className="rounded-lg bg-[var(--surface-2)] px-3 py-2">
													<p className="text-xs text-[var(--text-muted)] mb-1">Token (tap to select)</p>
													<p className="break-all font-mono text-xs select-all">{fcmToken}</p>
												</div>
												<Button type="button" size="sm" disabled={isSyncingFcm} onClick={() => void handleForceSyncFcm()} className="w-full justify-center">
													{isSyncingFcm ? "Syncing..." : "Force re-sync"}
												</Button>
                                            </div>
										) : (
											<div className="rounded-lg bg-yellow-500/10 border border-yellow-500/30 px-3 py-2 text-sm text-yellow-400">
												<p className="font-medium mb-0.5">No token received yet</p>
												<p className="text-xs opacity-80">Android delivers the FCM token via the <code>fg:fcm-token</code> event after Firebase initialises on launch.</p>
											</div>
										)}
										<div>
											<p className="text-xs font-medium text-[var(--text-muted)] mb-1">
												Live event log {fcmEventLog.length > 0 ? `(${fcmEventLog.length} received this session)` : "(waiting…)"}
											</p>
											<div ref={fcmLogRef} className="rounded-lg bg-[var(--surface-2)] px-3 py-2 max-h-32 overflow-y-auto">
												{fcmEventLog.length === 0 ? (
													<p className="font-mono text-xs text-[var(--text-muted)] italic">No fg:fcm-token events fired since this page opened</p>
												) : (
													fcmEventLog.map((entry, i) => (
														<p key={i} className="font-mono text-xs break-all">
															<span className="text-[var(--text-muted)]">[{entry.time}] </span>
															{entry.token.slice(0, 20)}…{entry.token.slice(-8)}
														</p>
													))
												)}
											</div>
										</div>
										<div className="grid gap-1.5">
											<p className="text-xs font-medium text-[var(--text-muted)]">Manual token (paste to force-sync)</p>
											<div className="flex gap-2">
												<input
													type="text"
													value={manualToken}
													onChange={(e) => setManualToken(e.target.value)}
													placeholder="Paste FCM token here…"
													className="input-field min-w-0 flex-1 font-mono text-xs"
												/>
												<Button type="button" size="sm" disabled={isSyncingFcm || !manualToken.trim()} onClick={() => void handleForceSyncFcm(manualToken.trim())}>
													Sync
												</Button>
											</div>
										</div>
									</div>
								</div>
							</div>
							<div className="p-4 sm:p-5 border-t border-[var(--border)]">
								<div className="flex items-start gap-3">
									<div className="rounded-2xl bg-[var(--surface-2)] p-2.5 shrink-0 text-[var(--text-muted)]">
										<Radar className="h-5 w-5" />
									</div>
									<div className="grid gap-3 min-w-0 flex-1">
										<div>
											<p className="text-sm font-semibold">Fingerprint Check</p>
											<p className="text-xs text-[var(--text-muted)] mt-0.5">Verify your HTTP/TLS fingerprint matches OkHttp configuration.</p>
										</div>
										<FingerprintCheckButton />
									</div>
								</div>
							</div>
							{navRow(
								() => setPreviewAnnouncement(true),
								<Megaphone className="h-5 w-5" />,
								"bg-[var(--surface-2)] text-[var(--text-muted)]",
								"Preview Version Announcement",
								LATEST_ANNOUNCEMENT
									? `View the "${t(LATEST_ANNOUNCEMENT.headlineKey)}" screen (v${LATEST_ANNOUNCEMENT.version}).`
									: "No version announcement configured yet.",
								undefined,
								!LATEST_ANNOUNCEMENT,
							)}
						</div>
					</div>
				) : null}

				{previewAnnouncement && LATEST_ANNOUNCEMENT && (
					<VersionAnnouncement
						announcement={LATEST_ANNOUNCEMENT}
						buttonLabel="Close"
						onClose={() => setPreviewAnnouncement(false)}
					/>
				)}

				{/* About */}
				<div>
					<p className="mb-2 px-1 text-xs font-semibold uppercase tracking-widest text-[var(--text-muted)]">{t("settings.section_about")}</p>
					<div className="surface-card overflow-hidden divide-y divide-[var(--border)]">
						{navRow(
							() => navigate("/settings/about"),
							<Info className="h-5 w-5" />,
							"bg-slate-500/15 text-slate-400",
							t("settings.about"),
							t("settings.about_desc"),
						)}
					</div>
				</div>

			</div>
			)}

			<ConfirmDialog
				isOpen={logoutConfirmTarget != null}
				title={t("settings.logout_confirm_title", { defaultValue: "Log out?" })}
				message={
					logoutConfirmTarget === "active"
						? t("profile_editor.logout_description", { defaultValue: "You will be signed out of your account on this device." })
						: t("settings.logout_other_description", { defaultValue: "You'll need to sign in again to use this account on this device." })
				}
				confirmLabel={t("settings.logout")}
				cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
				confirmTone="danger"
				isProcessing={
					logoutConfirmTarget === "active" ? isLoggingOut : removingProfileId === logoutConfirmTarget
				}
				onConfirm={() => {
					if (logoutConfirmTarget === "active") {
						void handleLogout();
					} else if (logoutConfirmTarget != null) {
						void handleRemoveSavedAccount(logoutConfirmTarget);
					}
				}}
				onCancel={() => setLogoutConfirmTarget(null)}
			/>
		</section>
	);
}
