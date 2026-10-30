import {
	useEffect,
	useMemo,
	useRef,
	useState,
	type ComponentType,
} from "react";
import {
	ChartColumn,
	Cloud,
	Eye,
	Hand,
	Image as ImageIcon,
	Info,
	LayoutDashboard,
	Loader2,
	Medal,
	MessageCircle,
	RefreshCw,
	ShieldBan,
	TriangleAlert,
	Trophy,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../../../contexts/useAuth";
import { usePreferences } from "../../../contexts/PreferencesContext";
import { useApiFunctions } from "../../../hooks/useApiFunctions";
import { useLocalNicknames } from "../../../hooks/useLocalNicknames";
import {
	getGoogleDriveSyncStatus,
	runGoogleDriveSyncNow,
	type GoogleDriveSyncStatus,
} from "../../../services/googleDriveSync";
import {
	isStatsEnabled,
	STATS_SETTINGS_UPDATED_EVENT,
} from "../../../services/statsLog";
import { cn } from "../../../utils/cn";
import { setCachedProfileDetail } from "../gridpage/cache";
import { resolvePeriod, type StatsPeriodKey } from "./statsCompute";
import { loadStatsContext, type StatsContext } from "./statsData";
import {
	formatAgo,
	formatNumber,
	formatShortDate,
	formatTime,
} from "./statsFormat";
import { createGrindrStats } from "./statsGrindr";
import { StatsPeopleContext, type StatsPeople } from "./statsPeople";
import { SectionError, SectionLoading } from "./StatsUi";
import { useStatsResource } from "./useStatsResource";
import { BlockingSection } from "./sections/BlockingSection";
import { InboxSection } from "./sections/InboxSection";
import { MediaSection } from "./sections/MediaSection";
import { OverviewSection } from "./sections/OverviewSection";
import { RankingsSection } from "./sections/RankingsSection";
import { RecordsSection } from "./sections/RecordsSection";
import type { SectionProps } from "./sections/shared";
import { TapsSection } from "./sections/TapsSection";
import { ViewersSection } from "./sections/ViewersSection";

type SectionKey =
	| "overview"
	| "viewers"
	| "inbox"
	| "blocking"
	| "media"
	| "taps"
	| "rankings"
	| "records";

const SECTIONS: {
	key: SectionKey;
	icon: ComponentType<{ className?: string }>;
	label: string;
	description: string;
	component: ComponentType<SectionProps>;
}[] = [
	{
		key: "overview",
		icon: LayoutDashboard,
		label: "Overview",
		description: "A summary of the period you picked.",
		component: OverviewSection,
	},
	{
		key: "viewers",
		icon: Eye,
		label: "Viewers",
		description: "Who looks at your profile, when, and what happens next.",
		component: ViewersSection,
	},
	{
		key: "inbox",
		icon: MessageCircle,
		label: "Inbox",
		description: "How your chats start, go and end.",
		component: InboxSection,
	},
	{
		key: "blocking",
		icon: ShieldBan,
		label: "Blocking",
		description: "What your auto-block rules catch, and who blocks you.",
		component: BlockingSection,
	},
	{
		key: "media",
		icon: ImageIcon,
		label: "Media & albums",
		description: "Albums and media shared with you.",
		component: MediaSection,
	},
	{
		key: "taps",
		icon: Hand,
		label: "Taps",
		description: "Taps as Grindr returns them right now.",
		component: TapsSection,
	},
	{
		key: "rankings",
		icon: Trophy,
		label: "Rankings",
		description: "Tap a person to open their profile.",
		component: RankingsSection,
	},
	{
		key: "records",
		icon: Medal,
		label: "Records",
		description: "Your bests since the oldest data on this device.",
		component: RecordsSection,
	},
];

const PERIODS: { key: StatsPeriodKey; label: string }[] = [
	{ key: "7d", label: "7 days" },
	{ key: "30d", label: "30 days" },
	{ key: "all", label: "All time" },
];

const PERIOD_STORAGE_KEY = "fg-stats-period";
const SYNC_WARNING_HIDDEN_KEY = "fg-stats-sync-warning-hidden";

function readStorage(key: string): string | null {
	try {
		return window.localStorage.getItem(key);
	} catch {
		return null;
	}
}

function writeStorage(key: string, value: string): void {
	try {
		window.localStorage.setItem(key, value);
	} catch {
		// A preference that cannot be saved is simply not remembered.
	}
}

function isPhone(): boolean {
	return (
		/Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
		(navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
	);
}

function useStatsEnabled(): boolean {
	const [enabled, setEnabled] = useState(isStatsEnabled);
	useEffect(() => {
		const sync = () => setEnabled(isStatsEnabled());
		window.addEventListener(STATS_SETTINGS_UPDATED_EVENT, sync);
		return () => window.removeEventListener(STATS_SETTINGS_UPDATED_EVENT, sync);
	}, []);
	return enabled;
}

/**
 * The Stats page. Everything on it is read when it opens — or when Refresh is
 * pressed — and dropped when it closes; while it is closed it does nothing.
 */
export default function StatsPage() {
	const { t, i18n } = useTranslation();
	const locale = i18n.language;
	const navigate = useNavigate();
	const { userId } = useAuth();
	const localNicknames = useLocalNicknames();
	const { unitsPreset } = usePreferences();
	const api = useApiFunctions();
	const enabled = useStatsEnabled();

	const [periodKey, setPeriodKey] = useState<StatsPeriodKey>(() => {
		const stored = readStorage(PERIOD_STORAGE_KEY);
		return stored === "30d" || stored === "all" ? stored : "7d";
	});
	// Kept in the address so coming back from a profile lands on the same section.
	const [searchParams, setSearchParams] = useSearchParams();
	const sectionKey: SectionKey =
		SECTIONS.find((entry) => entry.key === searchParams.get("section"))?.key ??
		"overview";
	const setSectionKey = (key: SectionKey) =>
		setSearchParams(key === "overview" ? {} : { section: key }, {
			replace: true,
		});
	const [refreshToken, setRefreshToken] = useState(0);

	const contextResource = useStatsResource(
		userId != null && enabled ? () => loadStatsContext(userId) : null,
		[userId, enabled, refreshToken],
	);
	const context =
		contextResource.status === "ready" ? contextResource.data : null;
	const period = useMemo(
		() => resolvePeriod(periodKey, context?.loadedAt ?? Date.now()),
		[periodKey, context?.loadedAt],
	);
	// One set of Grindr requests per visit; Refresh starts a new set.
	const grindr = useMemo(() => {
		void refreshToken;
		return createGrindrStats(api);
	}, [api, refreshToken]);

	const people = useMemo<StatsPeople>(
		() => ({
			lookUp: grindr.person,
			known: grindr.knownPerson,
			nickname: (profileId) => localNicknames[profileId] ?? null,
			open: async (profileId, known) => {
				const result = await grindr.person(profileId);
				// Open, blocked either way, deleted, or Grindr could not be
				// asked: the profile page handles each of those and says which,
				// with the name and picture this row was showing.
				if (result.detail) setCachedProfileDetail(profileId, result.detail);
				navigate(`/profile/${profileId}`, {
					state: {
						returnTo:
							sectionKey === "overview"
								? "/stats"
								: `/stats?section=${sectionKey}`,
						knownProfile: {
							name: known?.name ?? result.name,
							imageHash: known?.imageHash ?? result.imageHash,
						},
					},
				});
				return result;
			},
		}),
		[grindr, navigate, sectionKey, localNicknames],
	);

	const [driveStatus, setDriveStatus] = useState<GoogleDriveSyncStatus | null>(
		null,
	);
	useEffect(() => {
		if (userId == null) return;
		let cancelled = false;
		getGoogleDriveSyncStatus({ profileId: userId }).then(
			(status) => {
				if (!cancelled) setDriveStatus(status);
			},
			() => undefined,
		);
		return () => {
			cancelled = true;
		};
	}, [userId, refreshToken]);

	const [showSyncWarning, setShowSyncWarning] = useState(
		() => isPhone() && readStorage(SYNC_WARNING_HIDDEN_KEY) !== "true",
	);

	const section =
		SECTIONS.find((entry) => entry.key === sectionKey) ?? SECTIONS[0];
	const SectionComponent = section.component;
	const now = context?.loadedAt ?? Date.now();
	const driveConnected = driveStatus?.available && driveStatus.googleConnected;

	if (!enabled) {
		return (
			<section className="app-screen">
				<h1 className="app-title mb-4">
					{t("stats.title", { defaultValue: "Stats" })}
				</h1>
				<div className="surface-card flex flex-col items-start gap-3 p-5">
					<ChartColumn className="h-6 w-6 text-[var(--accent)]" />
					<p className="text-sm">
						{t("stats.off", {
							defaultValue:
								"Stats is switched off, so nothing is being recorded for this page.",
						})}
					</p>
					<button
						type="button"
						onClick={() => navigate("/settings/customizability")}
						className="rounded-xl border border-[var(--accent)] bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[var(--accent-contrast)]"
					>
						{t("stats.open_settings", { defaultValue: "Open settings" })}
					</button>
				</div>
			</section>
		);
	}

	return (
		<section className="app-screen">
			<header className="mb-4 flex flex-wrap items-end justify-between gap-3">
				<div>
					<h1 className="app-title">
						{t("stats.title", { defaultValue: "Stats" })}
					</h1>
					<p className="mt-1 text-sm text-[var(--text-muted)]">
						{context
							? [
									t("stats.updated", {
										defaultValue: "Updated {{time}}",
										time: formatTime(context.loadedAt, locale),
									}),
									driveConnected
										? t("stats.drive_synced", {
												defaultValue: "Google Drive synced {{ago}}",
												ago: formatAgo(driveStatus?.lastSuccessfulSyncAt, now),
											})
										: null,
								]
									.filter(Boolean)
									.join(" · ")
							: t("stats.loading", { defaultValue: "Loading…" })}
					</p>
				</div>
				<div className="flex items-center gap-2">
					<div
						className="inline-flex rounded-full border border-[var(--border)] bg-[var(--surface)] p-1"
						role="group"
					>
						{PERIODS.map((option) => (
							<button
								key={option.key}
								type="button"
								aria-pressed={periodKey === option.key}
								onClick={() => {
									setPeriodKey(option.key);
									writeStorage(PERIOD_STORAGE_KEY, option.key);
								}}
								className={cn(
									"rounded-full px-3 py-1.5 text-sm transition",
									periodKey === option.key
										? "bg-[var(--accent)] font-semibold text-[var(--accent-contrast)]"
										: "text-[var(--text-muted)] hover:text-[var(--text)]",
								)}
							>
								{t(`stats.period.${option.key}`, {
									defaultValue: option.label,
								})}
							</button>
						))}
					</div>
					<button
						type="button"
						onClick={() => setRefreshToken((value) => value + 1)}
						className="grid h-10 w-10 place-items-center rounded-full border border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] hover:text-[var(--text)]"
						aria-label={t("stats.refresh", { defaultValue: "Refresh" })}
					>
						<RefreshCw className="h-4 w-4" />
					</button>
				</div>
			</header>

			<div className="mb-5 flex gap-3 rounded-2xl border border-[color-mix(in_srgb,var(--accent)_35%,transparent)] bg-[color-mix(in_srgb,var(--accent)_8%,transparent)] px-4 py-3">
				<Info className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent)]" />
				<div className="min-w-0 text-sm leading-relaxed">
					<p>
						{t("stats.banner", {
							defaultValue:
								"You can use Stats right away, but the numbers become reliable after a few days, ideally a week. Most of what you see comes from data recorded on this device.",
						})}
					</p>
					{context ? (
						<p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--text-muted)]">
							<span>
								{context.trackingStart != null
									? t("stats.recording_since", {
											defaultValue:
												"Stats logs recording since {{date}} · {{count}} days",
											date: formatShortDate(context.trackingStart, locale),
											count: Math.max(
												1,
												Math.ceil((now - context.trackingStart) / 86_400_000),
											),
										})
									: t("stats.recording_not_started", {
											defaultValue: "Stats logs have nothing recorded yet",
										})}
							</span>
							{context.sources.movedFromOldAccount ? (
								<span>
									{t("stats.moved_from_old_account", {
										defaultValue: "Includes data moved from your old account",
									})}
								</span>
							) : null}
							{driveConnected ? (
								<span className="inline-flex items-center gap-1">
									<Cloud className="h-3 w-3" />
									{t("stats.drive_synced", {
										defaultValue: "Google Drive synced {{ago}}",
										ago: formatAgo(driveStatus?.lastSuccessfulSyncAt, now),
									})}
								</span>
							) : null}
						</p>
					) : null}
				</div>
			</div>

			<div className="lg:grid lg:grid-cols-[210px_minmax(0,1fr)] lg:items-start lg:gap-6">
				<aside className="mb-4 lg:sticky lg:top-4 lg:mb-0">
					<nav
						className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0"
						aria-label={t("stats.sections", { defaultValue: "Stats sections" })}
					>
						{SECTIONS.map((entry) => {
							const Icon = entry.icon;
							const active = entry.key === sectionKey;
							return (
								<button
									key={entry.key}
									type="button"
									aria-current={active}
									onClick={() => setSectionKey(entry.key)}
									className={cn(
										"inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-full border px-3 py-1.5 text-sm transition lg:w-full lg:rounded-xl lg:border-transparent lg:px-3 lg:py-2",
										active
											? "border-[var(--accent)] bg-[var(--accent)] font-semibold text-[var(--accent-contrast)] lg:bg-[var(--surface)] lg:text-[var(--text)]"
											: "border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] hover:text-[var(--text)] lg:bg-transparent",
									)}
								>
									<Icon
										className={cn(
											"h-4 w-4",
											active ? "lg:text-[var(--accent)]" : "",
										)}
									/>
									{t(`stats.section.${entry.key}`, {
										defaultValue: entry.label,
									})}
								</button>
							);
						})}
					</nav>
					{context ? <SourcesPanel context={context} locale={locale} /> : null}
				</aside>

				<main className="min-w-0">
					<div className="mb-3">
						<h2 className="text-lg font-semibold">
							{t(`stats.section.${section.key}`, {
								defaultValue: section.label,
							})}
						</h2>
						<p className="text-sm text-[var(--text-muted)]">
							{t(`stats.section.${section.key}_description`, {
								defaultValue: section.description,
							})}
						</p>
					</div>
					{contextResource.status === "loading" ? (
						<SectionLoading />
					) : contextResource.status === "error" ? (
						<SectionError
							error={contextResource.error}
							onRetry={contextResource.reload}
						/>
					) : context ? (
						<StatsPeopleContext.Provider value={people}>
							<SectionComponent
								key={`${section.key}:${periodKey}:${context.loadedAt}`}
								context={context}
								period={period}
								grindr={grindr}
								locale={locale}
								unitsPreset={unitsPreset}
							/>
						</StatsPeopleContext.Provider>
					) : null}
				</main>
			</div>

			{showSyncWarning && userId != null ? (
				<SyncWarningDialog
					status={driveStatus}
					profileId={userId}
					onClose={(dontShowAgain) => {
						if (dontShowAgain) writeStorage(SYNC_WARNING_HIDDEN_KEY, "true");
						setShowSyncWarning(false);
					}}
					onSynced={() => setRefreshToken((value) => value + 1)}
				/>
			) : null}
		</section>
	);
}

function SourcesPanel({
	context,
	locale,
}: {
	context: StatsContext;
	locale: string;
}) {
	const { t } = useTranslation();
	const rows = [
		{
			label: t("stats.sources.messages", { defaultValue: "Messages" }),
			sub:
				context.sources.firstMessageAt != null
					? t("stats.sources.since", {
							defaultValue: "since {{date}}",
							date: formatShortDate(context.sources.firstMessageAt, locale),
						})
					: "",
			value: formatNumber(context.sources.messages, locale),
		},
		{
			label: t("stats.sources.chats", { defaultValue: "Chats" }),
			sub: "",
			value: formatNumber(context.sources.conversations, locale),
		},
		{
			label: t("stats.sources.viewers", { defaultValue: "Viewers" }),
			sub: t("stats.sources.viewers_kept", { defaultValue: "kept 30 days" }),
			value: formatNumber(context.viewers.length, locale),
		},
		{
			label: t("stats.sources.logs", { defaultValue: "Stats logs" }),
			sub:
				context.trackingStart != null
					? t("stats.sources.since", {
							defaultValue: "since {{date}}",
							date: formatShortDate(context.trackingStart, locale),
						})
					: "",
			value: formatNumber(context.sources.statsRows, locale),
		},
	];
	return (
		<section className="surface-card mt-4 hidden p-4 lg:block">
			<p className="mb-1 text-[11px] font-semibold uppercase tracking-widest text-[var(--text-muted)]">
				{t("stats.sources.title", { defaultValue: "What this page reads" })}
			</p>
			<dl className="divide-y divide-[var(--border)] text-sm">
				{rows.map((row) => (
					<div
						key={row.label}
						className="flex items-baseline justify-between gap-2 py-2"
					>
						<dt>
							{row.label}
							{row.sub ? (
								<span className="block text-[11px] text-[var(--text-muted)]">
									{row.sub}
								</span>
							) : null}
						</dt>
						<dd className="tabular-nums">{row.value}</dd>
					</div>
				))}
			</dl>
			<p className="mt-2 text-[11px] leading-relaxed text-[var(--text-muted)]">
				{t("stats.sources.footer", {
					defaultValue:
						"Read when you opened this page. Leaving it stops everything and clears it from memory.",
				})}
			</p>
		</section>
	);
}

function SyncWarningDialog({
	status,
	profileId,
	onClose,
	onSynced,
}: {
	status: GoogleDriveSyncStatus | null;
	profileId: number;
	onClose: (dontShowAgain: boolean) => void;
	onSynced: () => void;
}) {
	const { t } = useTranslation();
	const dialogRef = useRef<HTMLDialogElement | null>(null);
	const [dontShowAgain, setDontShowAgain] = useState(false);
	const [syncing, setSyncing] = useState(false);
	const [syncError, setSyncError] = useState<string | null>(null);
	const [lastSync, setLastSync] = useState<number | null>(
		status?.lastSuccessfulSyncAt ?? null,
	);

	useEffect(() => {
		setLastSync(status?.lastSuccessfulSyncAt ?? null);
	}, [status?.lastSuccessfulSyncAt]);

	useEffect(() => {
		const dialog = dialogRef.current;
		if (!dialog || dialog.open) return;
		try {
			dialog.showModal();
		} catch {
			dialog.show();
		}
		return () => {
			if (dialog.open) dialog.close();
		};
	}, []);

	const connected = status?.available && status.googleConnected;

	const syncNow = async () => {
		setSyncing(true);
		setSyncError(null);
		try {
			const next = await runGoogleDriveSyncNow({ profileId });
			setLastSync(next.lastSuccessfulSyncAt);
			if (next.error) {
				setSyncError(next.error.message);
			} else {
				onSynced();
			}
		} catch (error) {
			setSyncError(error instanceof Error ? error.message : String(error));
		} finally {
			setSyncing(false);
		}
	};

	return (
		<dialog
			ref={dialogRef}
			onCancel={(event) => {
				event.preventDefault();
				if (!syncing) onClose(dontShowAgain);
			}}
			className="fixed inset-0 m-auto h-fit w-[calc(100%-2rem)] max-w-sm rounded-2xl border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface)_92%,black_8%)] p-0 text-[var(--text)] shadow-2xl backdrop:bg-black/50"
		>
			<div className="p-5">
				<span className="grid h-10 w-10 place-items-center rounded-2xl bg-amber-500/15 text-amber-500">
					<TriangleAlert className="h-5 w-5" />
				</span>
				<p className="mt-3 text-base font-semibold">
					{t("stats.sync_warning.title", {
						defaultValue: "Stats on this phone may be off",
					})}
				</p>
				<p className="mt-2 text-sm leading-relaxed text-[var(--text-muted)]">
					{t("stats.sync_warning.body", {
						defaultValue:
							"Stats are built from the data saved on this device. If this phone is not in sync with your other devices through Google Drive, numbers will be missing or wrong.",
					})}
				</p>
				<p className="mt-2 text-sm leading-relaxed text-[var(--text-muted)]">
					{t("stats.sync_warning.best_device", {
						defaultValue:
							"They are most accurate on the device that holds the most data, usually the one where GrindFlop runs the most.",
					})}
				</p>
				<div className="mt-4 flex items-center justify-between gap-3 rounded-xl bg-[var(--surface-2)] px-3 py-2 text-sm">
					<span className="text-[var(--text-muted)]">
						{t("stats.sync_warning.last_sync", {
							defaultValue: "Last Google Drive sync",
						})}
					</span>
					<span className="text-right font-medium">
						{connected
							? lastSync != null
								? formatAgo(lastSync, Date.now())
								: t("stats.sync_warning.never", { defaultValue: "never" })
							: t("stats.sync_warning.not_set_up", {
									defaultValue: "not set up",
								})}
					</span>
				</div>
				{syncError ? (
					<p className="mt-2 text-xs text-red-400">{syncError}</p>
				) : null}
				<label className="mt-4 flex items-center gap-2 text-sm text-[var(--text-muted)]">
					<input
						type="checkbox"
						checked={dontShowAgain}
						onChange={(event) => setDontShowAgain(event.target.checked)}
						className="h-4 w-4 accent-[var(--accent)]"
					/>
					{t("stats.sync_warning.dont_show", {
						defaultValue: "Don't show this again",
					})}
				</label>
				<div className="mt-5 flex gap-2">
					{connected ? (
						<button
							type="button"
							onClick={() => void syncNow()}
							disabled={syncing}
							className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] text-sm font-medium disabled:opacity-60"
						>
							{syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
							{t("stats.sync_warning.sync_now", { defaultValue: "Sync now" })}
						</button>
					) : null}
					<button
						type="button"
						onClick={() => onClose(dontShowAgain)}
						disabled={syncing}
						className="inline-flex h-11 flex-1 items-center justify-center rounded-xl border border-[var(--accent)] bg-[var(--accent)] text-sm font-semibold text-[var(--accent-contrast)] disabled:opacity-60"
					>
						{t("stats.sync_warning.continue", { defaultValue: "Continue" })}
					</button>
				</div>
			</div>
		</dialog>
	);
}
