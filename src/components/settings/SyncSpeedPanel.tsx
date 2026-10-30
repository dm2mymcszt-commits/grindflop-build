import { useCallback, useEffect, useMemo, useState } from "react";
import {
	Ban,
	CheckCircle2,
	ChevronDown,
	Copy,
	Gauge,
	XCircle,
} from "lucide-react";
import toast from "react-hot-toast";
import { useTranslation } from "react-i18next";
import {
	SYNC_SPEED_UPDATED_EVENT,
	listSyncSpeedRuns,
} from "../../services/syncSpeedLog";
import {
	buildSyncSpeedReport,
	formatSpeedUp,
	formatSyncDuration,
	summarizeSyncSpeed,
	type SyncSpeedEngineSummary,
	type SyncSpeedLabel,
	type SyncSpeedRun,
} from "../../utils/syncSpeedSummary";
import { Button } from "../ui/button";

const RECENT_RUNS_SHOWN = 25;

function formatCount(value: number): string {
	return new Intl.NumberFormat().format(Math.round(value));
}

function EngineTile({
	title,
	summary,
	highlight,
}: {
	title: string;
	summary: SyncSpeedEngineSummary;
	highlight: boolean;
}) {
	const { t } = useTranslation();
	const hasRuns =
		summary.syncRuns > 0 || summary.failedRuns > 0 || summary.statusRuns > 0;
	return (
		<div
			className={`min-w-0 rounded-xl p-3 ${
				highlight ? "bg-emerald-500/10 ring-1 ring-emerald-500/25" : "bg-[var(--surface-2)]"
			}`}
		>
			<p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
				{title}
			</p>
			{hasRuns ? (
				<>
					<p className="mt-1 text-lg font-semibold tabular-nums text-[var(--text)]">
						{summary.medianMs != null ? formatSyncDuration(summary.medianMs) : "—"}
					</p>
					<p className="text-[11px] text-[var(--text-muted)]">
						{t("data_backup.drive_sync.speed.typical", {
							defaultValue: "Typical everyday sync",
						})}
					</p>
					<div className="mt-2 grid gap-0.5 text-[11px] leading-relaxed text-[var(--text-muted)]">
						{summary.fastestMs != null && summary.slowestMs != null ? (
							<span>
								{t("data_backup.drive_sync.speed.range", {
									defaultValue: "{{fastest}} to {{slowest}}",
									fastest: formatSyncDuration(summary.fastestMs),
									slowest: formatSyncDuration(summary.slowestMs),
								})}
							</span>
						) : null}
						<span>
							{t("data_backup.drive_sync.speed.runs", {
								defaultValue: "{{ok}} completed · {{failed}} failed",
								ok: summary.syncRuns,
								failed: summary.failedRuns,
							})}
						</span>
						{summary.longestCatchUpMs != null ? (
							<span>
								{t("data_backup.drive_sync.speed.catch_up_line", {
									defaultValue:
										"Catch-up after reconnecting: {{duration}} at most ({{count}})",
									duration: formatSyncDuration(summary.longestCatchUpMs),
									count: summary.catchUpRuns,
								})}
							</span>
						) : null}
						{summary.medianRowsChecked != null ? (
							<span>
								{t("data_backup.drive_sync.speed.rows_per_sync", {
									defaultValue: "{{count}} rows checked per sync",
									count: formatCount(summary.medianRowsChecked),
								})}
							</span>
						) : null}
						{summary.medianStatusMs != null ? (
							<span>
								{t("data_backup.drive_sync.speed.status_line", {
									defaultValue: "Status ready in {{duration}}",
									duration: formatSyncDuration(summary.medianStatusMs),
								})}
							</span>
						) : null}
					</div>
				</>
			) : (
				<p className="mt-1 text-xs text-[var(--text-muted)]">
					{t("data_backup.drive_sync.speed.no_runs", { defaultValue: "No runs yet" })}
				</p>
			)}
		</div>
	);
}

function OutcomeIcon({ run }: { run: SyncSpeedRun }) {
	if (run.outcome === "ok") {
		return <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" />;
	}
	if (run.outcome === "cancelled") {
		return <Ban className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />;
	}
	return <XCircle className="h-3.5 w-3.5 shrink-0 text-red-400" />;
}

/**
 * Before/after proof for the sync rewrite: every sync on this device with how
 * long it took, the old engine next to the new one. Device-local history.
 */
export function SyncSpeedPanel({
	profileId,
	deviceName,
}: {
	profileId: number;
	deviceName: string | null;
}) {
	const { t, i18n } = useTranslation();
	const [runs, setRuns] = useState<SyncSpeedRun[] | null>(null);
	const [open, setOpen] = useState(false);

	const load = useCallback(async () => {
		try {
			setRuns(await listSyncSpeedRuns(profileId));
		} catch {
			setRuns([]);
		}
	}, [profileId]);

	useEffect(() => {
		setRuns(null);
		void load();
		const onUpdated = (event: Event) => {
			const detail = (event as CustomEvent<{ profileId?: number }>).detail;
			if (detail?.profileId === profileId) void load();
		};
		window.addEventListener(SYNC_SPEED_UPDATED_EVENT, onUpdated);
		return () => window.removeEventListener(SYNC_SPEED_UPDATED_EVENT, onUpdated);
	}, [load, profileId]);

	const summary = useMemo(() => summarizeSyncSpeed(runs ?? []), [runs]);
	const syncRuns = useMemo(
		() => (runs ?? []).filter((run) => run.kind === "sync").slice(0, RECENT_RUNS_SHOWN),
		[runs],
	);

	const label: SyncSpeedLabel = useCallback(
		(key, defaultValue, values) => t(key, { defaultValue, ...values }),
		[t],
	);

	const engineName = (engine: SyncSpeedRun["engine"]) =>
		engine === "v1"
			? t("data_backup.drive_sync.speed.engine_v1", { defaultValue: "Old sync" })
			: t("data_backup.drive_sync.speed.engine_v2", { defaultValue: "New sync" });

	const triggerName = (run: SyncSpeedRun) => {
		switch (run.trigger) {
			case "auto":
				return t("data_backup.drive_sync.speed.trigger_auto", { defaultValue: "Automatic" });
			case "manual":
				return t("data_backup.drive_sync.speed.trigger_manual", { defaultValue: "Sync now" });
			case "connect":
				return t("data_backup.drive_sync.speed.trigger_connect", { defaultValue: "Connect" });
			case "pairing":
				return t("data_backup.drive_sync.speed.trigger_pairing", { defaultValue: "Pairing" });
			case "imported":
				return t("data_backup.drive_sync.speed.trigger_imported", {
					defaultValue: "Last run before the timer existed",
				});
			default:
				return run.trigger;
		}
	};

	const formatWhen = (ms: number) =>
		new Date(ms).toLocaleString(i18n.language, {
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		});

	const headline = (() => {
		if (runs == null) return null;
		const describe = (engineSummary: SyncSpeedEngineSummary) =>
			engineSummary.medianMs != null
				? formatSyncDuration(engineSummary.medianMs)
				: t("data_backup.drive_sync.speed.not_yet", { defaultValue: "not timed yet" });
		if (summary.syncSpeedUp != null) {
			return t("data_backup.drive_sync.speed.speed_up", {
				defaultValue: "New sync is {{factor}} faster",
				factor: formatSpeedUp(summary.syncSpeedUp),
			});
		}
		return t("data_backup.drive_sync.speed.headline", {
			defaultValue: "Old sync: {{old}} · New sync: {{next}}",
			old: describe(summary.v1),
			next: describe(summary.v2),
		});
	})();

	const copyReport = async () => {
		try {
			await navigator.clipboard.writeText(
				buildSyncSpeedReport(runs ?? [], label, deviceName),
			);
			toast.success(
				t("data_backup.drive_sync.speed.copied", {
					defaultValue: "Sync speed report copied.",
				}),
			);
		} catch {
			toast.error(
				t("data_backup.drive_sync.speed.copy_failed", {
					defaultValue: "Could not copy the report.",
				}),
			);
		}
	};

	const v2Faster =
		summary.syncSpeedUp != null && summary.syncSpeedUp > 1;

	return (
		<div className="mt-4 overflow-hidden rounded-xl border border-[var(--border)]">
			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				aria-expanded={open}
				className="flex w-full items-start gap-2.5 p-3 text-left"
			>
				<Gauge className="mt-0.5 h-4 w-4 shrink-0 text-sky-400" />
				<span className="min-w-0 flex-1">
					<span className="block text-sm font-medium">
						{t("data_backup.drive_sync.speed.title", {
							defaultValue: "Sync speed, before and after",
						})}
					</span>
					{headline ? (
						<span
							className={`mt-0.5 block text-xs leading-relaxed ${
								v2Faster ? "font-medium text-emerald-400" : "text-[var(--text-muted)]"
							}`}
						>
							{headline}
						</span>
					) : null}
				</span>
				<ChevronDown
					className={`mt-0.5 h-4 w-4 shrink-0 text-[var(--text-muted)] transition-transform ${
						open ? "rotate-180" : ""
					}`}
				/>
			</button>

			{open ? (
				<div className="grid grid-cols-[minmax(0,1fr)] gap-3 border-t border-[var(--border)] p-3">
					<p className="text-xs leading-relaxed text-[var(--text-muted)]">
						{t("data_backup.drive_sync.speed.desc", {
							defaultValue:
								"Every sync on this device is timed, from the moment it was asked for until it finished. The old sync's times stay here when the new sync arrives, so both can be compared on the same device and the same data. Kept on this device only.",
						})}
					</p>

					<div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
						<EngineTile title={engineName("v1")} summary={summary.v1} highlight={false} />
						<EngineTile title={engineName("v2")} summary={summary.v2} highlight={v2Faster} />
					</div>

					{syncRuns.length > 0 ? (
						<div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5">
							<p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
								{t("data_backup.drive_sync.speed.recent", {
									defaultValue: "Recent syncs",
								})}
							</p>
							<ul className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5">
								{syncRuns.map((run) => {
									const details: string[] = [];
									if (run.rowsChecked != null) {
										details.push(
											t("data_backup.drive_sync.speed.detail_rows", {
												defaultValue: "{{count}} rows checked",
												count: formatCount(run.rowsChecked),
											}),
										);
									}
									if (run.changesSent != null || run.changesReceived != null) {
										details.push(
											t("data_backup.drive_sync.speed.detail_changes", {
												defaultValue: "{{sent}} sent · {{received}} received",
												sent: formatCount(run.changesSent ?? 0),
												received: formatCount(run.changesReceived ?? 0),
											}),
										);
									}
									if (run.waitedMs != null && run.waitedMs >= 1_000) {
										details.push(
											t("data_backup.drive_sync.speed.detail_waited", {
												defaultValue: "waited {{duration}} to start",
												duration: formatSyncDuration(run.waitedMs),
											}),
										);
									}
									return (
										<li
											key={run.id ?? `${run.startedAtMs}-${run.trigger}`}
											className="rounded-lg bg-[var(--surface-2)] px-2.5 py-2"
										>
											<div className="flex items-center gap-2 text-xs">
												<OutcomeIcon run={run} />
												<span className="min-w-0 flex-1 truncate text-[var(--text)]">
													{formatWhen(run.startedAtMs)}
												</span>
												<span className="shrink-0 font-semibold tabular-nums text-[var(--text)]">
													{formatSyncDuration(run.totalMs)}
												</span>
											</div>
											<div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 pl-5 text-[11px] text-[var(--text-muted)]">
												<span
													className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
														run.engine === "v2"
															? "bg-emerald-500/15 text-emerald-400"
															: "bg-[var(--surface)] text-[var(--text-muted)]"
													}`}
												>
													{engineName(run.engine)}
												</span>
												<span>{triggerName(run)}</span>
											</div>
											{details.length > 0 ? (
												<p className="mt-0.5 pl-5 text-[11px] text-[var(--text-muted)]">
													{details.join(" · ")}
												</p>
											) : null}
											{run.outcome === "error" && run.error ? (
												<p className="mt-0.5 break-words pl-5 text-[11px] text-red-300">{run.error}</p>
											) : null}
										</li>
									);
								})}
							</ul>
						</div>
					) : (
						<p className="text-xs text-[var(--text-muted)]">
							{t("data_backup.drive_sync.speed.empty", {
								defaultValue:
									"No sync has been timed on this device yet. The next sync will appear here.",
							})}
						</p>
					)}

					<Button
						variant="secondary"
						size="sm"
						disabled={!runs || runs.length === 0}
						leftIcon={<Copy className="h-4 w-4" />}
						onClick={() => void copyReport()}
					>
						{t("data_backup.drive_sync.speed.copy", {
							defaultValue: "Copy report",
						})}
					</Button>
				</div>
			) : null}
		</div>
	);
}
