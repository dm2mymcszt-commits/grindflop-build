import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AlertTriangle, FileDown, FileUp, Info, Loader2, Pause, Play, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../../contexts/useAuth";
import { useApiFunctions } from "../../../hooks/useApiFunctions";
import { ConfirmDialog } from "../../../components/ui/confirm-dialog";
import {
	clearBlockImport,
	exportBlockList,
	getBlockImportJob,
	pauseBlockImport,
	resumeBlockImport,
	setBlockImportPace,
	startBlockImport,
	subscribeBlockImport,
	type BlockImportJob,
} from "../../../services/blockListImport";
import {
	BlockListParseError,
	DEFAULT_IMPORT_PACE,
	IMPORT_PACES,
	estimateImportMs,
	parseBlockListFile,
	planBlockImport,
	type BlockListParseErrorCode,
	type ImportPace,
	type ParsedBlockList,
} from "../../../utils/blockListImportRules";

const PACE_ORDER: ImportPace[] = ["careful", "balanced", "fast", "instant"];

type PendingImport = {
	fileName: string;
	fileCount: number;
	toBlock: string[];
	alreadyBlocked: number;
	skippedSelf: boolean;
};

function useBlockImportJob(ownerId: string | null): BlockImportJob | null {
	const getSnapshot = useCallback(() => (ownerId ? getBlockImportJob(ownerId) : null), [ownerId]);
	return useSyncExternalStore(subscribeBlockImport, getSnapshot);
}

/** A clock that ticks every second, only while `enabled`. */
function useNow(enabled: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!enabled) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [enabled]);
	return now;
}

export function BlockListTransferCard() {
	const { t, i18n } = useTranslation();
	const { userId } = useAuth();
	const api = useApiFunctions();
	const queryClient = useQueryClient();
	const ownerId = userId == null ? null : String(userId);
	const job = useBlockImportJob(ownerId);
	const now = useNow(job?.status === "running");

	const fileInputRef = useRef<HTMLInputElement>(null);
	const [isExporting, setIsExporting] = useState(false);
	const [isPreparing, setIsPreparing] = useState(false);
	const [pending, setPending] = useState<PendingImport | null>(null);
	const [pace, setPace] = useState<ImportPace>(DEFAULT_IMPORT_PACE);
	const [confirmCancel, setConfirmCancel] = useState(false);
	const [instantAccepted, setInstantAccepted] = useState(false);
	const [confirmInstantSwitch, setConfirmInstantSwitch] = useState(false);

	const importActive = job != null && job.status !== "done";

	const formatDuration = (ms: number): string => {
		const minutes = ms / 60_000;
		if (minutes < 60) {
			return t("settings_blocked.duration_minutes", {
				defaultValue: "{{count}} min",
				count: Math.max(1, Math.round(minutes)),
			});
		}
		const hours = minutes / 60;
		if (hours < 36) {
			return t("settings_blocked.duration_hours", {
				defaultValue: "{{count}} h",
				count: Math.round(hours),
			});
		}
		return t("settings_blocked.duration_days", {
			defaultValue: "{{count}} days",
			count: Math.round(hours / 24),
		});
	};

	const formatClock = (timestamp: number): string => {
		const date = new Date(timestamp);
		const sameDay = date.toDateString() === new Date().toDateString();
		return sameDay
			? date.toLocaleTimeString(i18n.language, { hour: "2-digit", minute: "2-digit" })
			: date.toLocaleString(i18n.language, { weekday: "short", hour: "2-digit", minute: "2-digit" });
	};

	const paceLabel = (value: ImportPace): string => {
		switch (value) {
			case "careful":
				return t("settings_blocked.pace_careful", { defaultValue: "Careful" });
			case "balanced":
				return t("settings_blocked.pace_balanced", { defaultValue: "Balanced" });
			case "fast":
				return t("settings_blocked.pace_fast", { defaultValue: "Fast" });
			case "instant":
				return t("settings_blocked.pace_instant", { defaultValue: "Instant" });
		}
	};

	const paceDescription = (value: ImportPace): string => {
		const settings = IMPORT_PACES[value];
		if (settings.concurrency > 1) {
			return t("settings_blocked.pace_instant_desc", {
				defaultValue: "{{count}} at a time, no pauses, no daily limit. The riskiest pace.",
				count: settings.concurrency,
			});
		}
		const gap = t("settings_blocked.pace_gap", {
			defaultValue: "{{min}}–{{max}} s apart",
			min: settings.gapMs[0] / 1000,
			max: settings.gapMs[1] / 1000,
		});
		const limit =
			settings.dailyLimit == null
				? t("settings_blocked.pace_no_limit", { defaultValue: "no daily limit" })
				: t("settings_blocked.pace_daily_limit", {
						defaultValue: "at most {{count}} a day",
						count: settings.dailyLimit.toLocaleString(),
					});
		return `${gap}, ${limit}`;
	};

	const parseErrorMessage = (code: BlockListParseErrorCode): string => {
		switch (code) {
			case "empty":
				return t("settings_blocked.import_error_empty", { defaultValue: "That file has no profiles in it." });
			case "newer_version":
				return t("settings_blocked.import_error_newer", {
					defaultValue: "That file comes from a newer version of GrindFlop. Update the app first.",
				});
			case "not_ids":
				return t("settings_blocked.import_error_not_ids", {
					defaultValue: "That file has things in it that aren't profile IDs, so nothing was imported.",
				});
			default:
				return t("settings_blocked.import_error_format", { defaultValue: "That isn't a block list file." });
		}
	};

	const handleExport = async () => {
		setIsExporting(true);
		try {
			const { count, destination, source } = await exportBlockList(api);
			if (!destination) {
				toast(t("settings_blocked.export_nothing", { defaultValue: "You haven't blocked anyone yet." }));
				return;
			}
			const where =
				destination.location === "ios-files-app"
					? t("settings_blocked.export_where_ios", {
							defaultValue: "Files → On My iPhone → GrindFlop → {{name}}",
							name: destination.fileName,
						})
					: destination.location === "downloads-folder"
						? t("settings_blocked.export_where_downloads", {
								defaultValue: "Downloads/FreeGrind/{{name}}",
								name: destination.fileName,
							})
						: destination.fileName;
			if (source.kind === "grindr") {
				toast.success(
					t("settings_blocked.export_success", {
						defaultValue: "Saved {{count}} blocked profiles to {{where}}",
						count: count.toLocaleString(),
						where,
					}),
					{ duration: 6000 },
				);
				return;
			}
			const saved = t("settings_blocked.export_success_device", {
				defaultValue: "Grindr didn't answer, so the copy saved on this device was used. Saved {{count}} blocked profiles to {{where}}.",
				count: count.toLocaleString(),
				where,
			});
			const age =
				source.savedAt == null
					? null
					: t("settings_blocked.export_device_age", {
							defaultValue: "The copy was last updated {{time}}.",
							time: new Date(source.savedAt).toLocaleString(i18n.language, { dateStyle: "medium", timeStyle: "short" }),
						});
			const partial = source.complete
				? null
				: t("settings_blocked.export_device_partial", {
						defaultValue:
							"It may be missing people: it only has blocks this app has seen since Stats was turned on. Export again once Grindr is back for the full list.",
					});
			toast.success([saved, age, partial].filter(Boolean).join(" "), { duration: 12000 });
		} catch (error) {
			toast.error(
				error instanceof Error && error.message
					? error.message
					: t("settings_blocked.export_failed", { defaultValue: "Couldn't export the block list." }),
			);
		} finally {
			setIsExporting(false);
		}
	};

	const handleFile = async (file: File) => {
		if (!ownerId) return;
		setIsPreparing(true);
		try {
			let parsed: ParsedBlockList;
			try {
				parsed = parseBlockListFile(await file.text());
			} catch (error) {
				toast.error(
					error instanceof BlockListParseError
						? parseErrorMessage(error.code)
						: t("settings_blocked.import_error_format", { defaultValue: "That isn't a block list file." }),
				);
				return;
			}
			// Read fresh, so people already blocked aren't sent again.
			const currentlyBlocked = await api.getBlockedProfileIds();
			const plan = planBlockImport(parsed.profileIds, currentlyBlocked, ownerId);
			if (plan.toBlock.length === 0) {
				toast.success(
					t("settings_blocked.import_nothing_new", {
						defaultValue: "Everyone in that file is already blocked on this account.",
					}),
				);
				return;
			}
			setPace(DEFAULT_IMPORT_PACE);
			setInstantAccepted(false);
			setPending({
				fileName: file.name,
				fileCount: parsed.profileIds.length,
				toBlock: plan.toBlock,
				alreadyBlocked: plan.alreadyBlocked,
				skippedSelf: plan.skippedSelf,
			});
		} catch (error) {
			toast.error(
				error instanceof Error && error.message
					? error.message
					: t("settings_blocked.import_failed", { defaultValue: "Couldn't read your current block list." }),
			);
		} finally {
			setIsPreparing(false);
		}
	};

	const handleStart = () => {
		if (!pending || !ownerId) return;
		try {
			startBlockImport({
				ownerId,
				profileIds: pending.toBlock,
				alreadyBlocked: pending.alreadyBlocked,
				pace,
			});
			setPending(null);
		} catch {
			toast.error(
				t("settings_blocked.import_save_failed", {
					defaultValue: "Couldn't save the list on this device, so the import didn't start.",
				}),
			);
		}
	};

	const statusLine = (current: BlockImportJob): string => {
		if (current.status === "done") {
			const finished = t("settings_blocked.import_status_done", {
				defaultValue: "Finished {{when}}.",
				when: formatClock(current.finishedAt ?? current.startedAt),
			});
			if (current.failed === 0) return finished;
			return `${finished} ${t("settings_blocked.import_status_done_retry", {
				defaultValue:
					"To try the {{count}} that couldn't be blocked again, import the same file: everyone already blocked is skipped.",
				count: current.failed.toLocaleString(),
			})}`;
		}
		if (current.status === "paused") {
			switch (current.stopReason) {
				case "forbidden":
					return t("settings_blocked.import_stop_forbidden", {
						defaultValue:
							"Paused: Grindr refused to block for this account. Nothing more is sent until you resume.",
					});
				case "rate_limited":
					return t("settings_blocked.import_stop_rate_limited", {
						defaultValue:
							"Paused: Grindr kept asking to slow down for hours. Try again later, at a slower pace.",
					});
				case "too_fast":
					return t("settings_blocked.import_stop_too_fast", {
						defaultValue:
							"Stopped: Grindr said too many requests, so Instant stopped straight away. The {{count}} it refused are kept with the rest of the list. Pick a slower pace before resuming.",
						count: current.retryIds.length.toLocaleString(),
					});
				case "failing":
					return t("settings_blocked.import_stop_failing", {
						defaultValue: "Paused: 10 blocks in a row failed. Last error: {{error}}",
						error: current.lastError ?? "—",
					});
				default:
					return t("settings_blocked.import_status_paused", { defaultValue: "Paused." });
			}
		}
		const waitUntil = current.waitUntil ?? 0;
		const seconds = Math.max(0, Math.ceil((waitUntil - now) / 1000));
		switch (current.waitReason) {
			case "break":
				return t("settings_blocked.import_status_break", {
					defaultValue: "Taking a short break, back at {{time}}.",
					time: formatClock(waitUntil),
				});
			case "daily_limit":
				return t("settings_blocked.import_status_daily_limit", {
					defaultValue: "Reached today's limit of {{count}}. Carries on {{time}}.",
					count: (IMPORT_PACES[current.pace].dailyLimit ?? 0).toLocaleString(),
					time: formatClock(waitUntil),
				});
			case "rate_limited":
				return t("settings_blocked.import_status_rate_limited", {
					defaultValue: "Grindr asked to slow down. Trying again at {{time}}.",
					time: formatClock(waitUntil),
				});
			case "retry":
				return t("settings_blocked.import_status_retry", {
					defaultValue: "The last block didn't go through. Trying again in {{seconds}} s.",
					seconds,
				});
			default:
				if (seconds > 0) {
					return t("settings_blocked.import_status_next", {
						defaultValue: "Next block in {{seconds}} s.",
						seconds,
					});
				}
				return IMPORT_PACES[current.pace].concurrency > 1
					? t("settings_blocked.import_status_instant", {
							defaultValue: "Blocking {{count}} at a time…",
							count: IMPORT_PACES[current.pace].concurrency,
						})
					: t("settings_blocked.import_status_blocking", { defaultValue: "Blocking…" });
		}
	};

	const rowClass = (disabled: boolean) =>
		`flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors ${disabled ? "opacity-50" : "hover:bg-[var(--surface-2)] active:bg-[var(--surface-2)]"}`;

	const renderPacePicker = (selected: ImportPace, onSelect: (value: ImportPace) => void, count: number) => (
		<div className="grid gap-1.5">
			{PACE_ORDER.map((value) => {
				const isOn = value === selected;
				return (
					<button
						key={value}
						type="button"
						onClick={() => onSelect(value)}
						className={`rounded-xl border px-3 py-2 text-left transition-colors ${isOn ? "border-[var(--accent)] bg-[var(--surface-2)]" : "border-[var(--border)] hover:bg-[var(--surface-2)]"}`}
					>
						<span className="flex items-baseline justify-between gap-2">
							<span className="text-xs font-semibold text-[var(--text)]">{paceLabel(value)}</span>
							<span className="shrink-0 text-[11px] tabular-nums text-[var(--text-muted)]">
								{t("settings_blocked.pace_estimate", {
									defaultValue: "about {{duration}}",
									duration: formatDuration(estimateImportMs(count, value)),
								})}
							</span>
						</span>
						<span className="mt-0.5 block text-[11px] leading-snug text-[var(--text-muted)]">
							{paceDescription(value)}
						</span>
					</button>
				);
			})}
		</div>
	);

	const renderInstantNotes = (count: number) => (
		<div className="mt-3 rounded-xl border border-red-500/30 bg-red-500/10 p-3">
			<p className="flex items-center gap-1.5 text-xs font-semibold text-red-400">
				<AlertTriangle className="h-3.5 w-3.5" />
				{t("settings_blocked.instant_notes_title", { defaultValue: "Before you use Instant" })}
			</p>
			<ul className="mt-2 grid list-disc gap-1.5 pl-4 text-[11px] leading-snug text-[var(--text-muted)]">
				<li>
					{t("settings_blocked.instant_note_speed", {
						defaultValue:
							"It sends {{concurrency}} blocks at a time with no pauses, one round straight after another, so {{count}} profiles take about {{duration}}. Not literally all at once: that many requests together would mostly fail and freeze the app.",
						concurrency: IMPORT_PACES.instant.concurrency,
						count: count.toLocaleString(),
						duration: formatDuration(estimateImportMs(count, "instant")),
					})}
				</li>
				<li>
					{t("settings_blocked.instant_note_risk", {
						defaultValue:
							"A burst like this is what spam detection looks for. Grindr may slow the account down, restrict it or ban it, and GrindFlop can't undo that. It's safest on an account you could afford to lose; on your main account, pick a slower pace.",
					})}
				</li>
				<li>
					{t("settings_blocked.instant_note_chats", {
						defaultValue:
							"Anyone on the list you've chatted with loses that chat, on both sides. A list from someone else can include people you talk to.",
					})}
				</li>
				<li>
					{t("settings_blocked.instant_note_stop", {
						defaultValue:
							"If Grindr says too many requests or refuses the account, it stops at once instead of pushing on. The rest wait here: resume later, at a slower pace.",
					})}
				</li>
				<li>
					{t("settings_blocked.instant_note_undo", {
						defaultValue:
							"Undoing it is slow: Unblock All also removes the blocks you made yourself, otherwise it's one profile at a time.",
					})}
				</li>
				<li>
					{t("settings_blocked.instant_note_open", {
						defaultValue:
							"Keep GrindFlop open and in front until it finishes, especially on iOS. The app may be slower while it runs.",
					})}
				</li>
			</ul>
		</div>
	);

	const handleProgressPace = (value: ImportPace) => {
		if (!ownerId) return;
		if (value === "instant") setConfirmInstantSwitch(true);
		else setBlockImportPace(ownerId, value);
	};

	const renderProgress = (current: BlockImportJob) => {
		// Every profile ends up blocked or given up on, once; ones kept for a
		// retry after an Instant stop are neither yet.
		const done = Math.min(current.blocked + current.failed, current.total);
		const percent = current.total > 0 ? Math.round((done / current.total) * 100) : 100;
		const remaining = current.total - done;
		return (
			<div className="grid gap-3 px-4 py-3.5">
				<div>
					<div className="mb-1.5 flex items-baseline justify-between gap-2">
						<p className="text-xs font-semibold text-[var(--text)]">
							{current.status === "done"
								? t("settings_blocked.import_title_done", { defaultValue: "Block list imported" })
								: t("settings_blocked.import_title_running", { defaultValue: "Importing block list" })}
						</p>
						<p className="text-[11px] tabular-nums text-[var(--text-muted)]">
							{done.toLocaleString()} / {current.total.toLocaleString()} · {percent}%
						</p>
					</div>
					<div
						className="h-1.5 overflow-hidden rounded-full bg-[var(--surface-2)]"
						role="progressbar"
						aria-valuemin={0}
						aria-valuemax={current.total}
						aria-valuenow={done}
					>
						<div
							className={`h-full rounded-full transition-[width] ${current.status === "paused" ? "bg-[var(--text-muted)]" : "bg-[var(--accent)]"}`}
							style={{ width: `${percent}%` }}
						/>
					</div>
				</div>

				<p className="text-[11px] tabular-nums leading-relaxed text-[var(--text-muted)]">
					{t("settings_blocked.import_counts", {
						defaultValue: "Blocked {{blocked}} · Couldn't block {{failed}} · Already blocked before {{already}}",
						blocked: current.blocked.toLocaleString(),
						failed: current.failed.toLocaleString(),
						already: current.alreadyBlocked.toLocaleString(),
					})}
				</p>

				<p className={`text-xs leading-relaxed ${current.status === "paused" && current.stopReason !== "user" ? "text-red-400" : "text-[var(--text)]"}`}>
					{statusLine(current)}
					{current.status === "running" && remaining > 0 && (
						<span className="text-[var(--text-muted)]">
							{" "}
							{t("settings_blocked.import_time_left", {
								defaultValue: "About {{duration}} left.",
								// Plus whatever wait is running now, which can be an hour's backoff or a day's limit.
								duration: formatDuration(
									estimateImportMs(remaining, current.pace) + Math.max(0, (current.waitUntil ?? 0) - now),
								),
							})}
						</span>
					)}
				</p>

				{current.status !== "done" && (
					<div>
						<div className="grid grid-cols-4 gap-1 rounded-xl border border-[var(--border)] p-1">
							{PACE_ORDER.map((value) => (
								<button
									key={value}
									type="button"
									onClick={() => handleProgressPace(value)}
									className={`rounded-lg px-1.5 py-1.5 text-xs font-semibold transition-colors ${value === current.pace ? "bg-[var(--surface-2)] text-[var(--text)]" : value === "instant" ? "text-red-400/80 hover:text-red-400" : "text-[var(--text-muted)] hover:text-[var(--text)]"}`}
								>
									{paceLabel(value)}
								</button>
							))}
						</div>
						<p className="mt-1.5 px-1 text-[11px] leading-snug text-[var(--text-muted)]">
							{paceDescription(current.pace)}
						</p>
					</div>
				)}

				<div className="flex gap-2">
					{current.status === "done" ? (
						<button
							type="button"
							onClick={() => ownerId && clearBlockImport(ownerId)}
							className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-xl border border-[var(--border)] px-3 text-xs font-semibold text-[var(--text-muted)] transition hover:text-[var(--text)]"
						>
							{t("settings_blocked.import_dismiss", { defaultValue: "Dismiss" })}
						</button>
					) : (
						<>
							<button
								type="button"
								onClick={() =>
									ownerId &&
									(current.status === "running" ? pauseBlockImport(ownerId) : resumeBlockImport(ownerId))
								}
								className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-xl border border-[var(--border)] px-3 text-xs font-semibold text-[var(--text)] transition hover:bg-[var(--surface-2)]"
							>
								{current.status === "running" ? (
									<>
										<Pause className="h-3.5 w-3.5" />
										{t("settings_blocked.import_pause", { defaultValue: "Pause" })}
									</>
								) : (
									<>
										<Play className="h-3.5 w-3.5" />
										{t("settings_blocked.import_resume", { defaultValue: "Resume" })}
									</>
								)}
							</button>
							<button
								type="button"
								onClick={() => setConfirmCancel(true)}
								className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-xl border border-red-500/30 bg-red-500/10 px-3 text-xs font-semibold text-red-400 transition hover:bg-red-500/20"
							>
								<X className="h-3.5 w-3.5" />
								{t("settings_blocked.import_cancel", { defaultValue: "Stop import" })}
							</button>
						</>
					)}
				</div>
			</div>
		);
	};

	return (
		<div>
			<p className="mb-2 px-1 text-xs font-semibold uppercase tracking-widest text-[var(--text-muted)]">
				{t("settings_blocked.transfer_label", { defaultValue: "Move your block list" })}
			</p>
			<div className="surface-card divide-y divide-[var(--border)] overflow-hidden">
				<button type="button" onClick={() => void handleExport()} disabled={isExporting} className={rowClass(isExporting)}>
					<div className="shrink-0 rounded-2xl bg-sky-500/15 p-2.5 text-sky-400">
						<FileDown className="h-5 w-5" />
					</div>
					<div className="min-w-0 flex-1">
						<p className="text-sm font-semibold leading-snug">
							{t("settings_blocked.export_title", { defaultValue: "Export block list" })}
						</p>
						<p className="mt-0.5 text-xs leading-snug text-[var(--text-muted)]">
							{t("settings_blocked.export_desc", {
								defaultValue: "Save everyone you've blocked to a file. Import it on another account, or share it.",
							})}
						</p>
					</div>
					{isExporting && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--text-muted)]" />}
				</button>

				<button
					type="button"
					onClick={() => fileInputRef.current?.click()}
					disabled={isPreparing || importActive || !ownerId}
					className={rowClass(isPreparing || importActive || !ownerId)}
				>
					<div className="shrink-0 rounded-2xl bg-violet-500/15 p-2.5 text-violet-400">
						<FileUp className="h-5 w-5" />
					</div>
					<div className="min-w-0 flex-1">
						<p className="text-sm font-semibold leading-snug">
							{t("settings_blocked.import_title", { defaultValue: "Import block list" })}
						</p>
						<p className="mt-0.5 text-xs leading-snug text-[var(--text-muted)]">
							{importActive
								? t("settings_blocked.import_desc_busy", {
										defaultValue: "An import is already going on this account. Stop it to start another.",
									})
								: t("settings_blocked.import_desc", {
										defaultValue: "Block everyone in a file, slowly with breaks, or all in one go with Instant.",
									})}
						</p>
					</div>
					{isPreparing && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--text-muted)]" />}
				</button>

				{job && renderProgress(job)}

				{importActive && (
					<div className="flex items-start gap-2.5 px-4 py-3">
						<Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
						<p className="text-xs leading-relaxed text-[var(--text-muted)]">
							{t("settings_blocked.import_note", {
								defaultValue:
									"Blocking only happens while GrindFlop is open and signed in to this account; it carries on from where it stopped. On iPhone it pauses whenever the app is in the background, so a PC left open is quickest.",
							})}
						</p>
					</div>
				)}

				<input
					ref={fileInputRef}
					type="file"
					accept="application/json,.json,text/plain,.txt,text/csv,.csv"
					className="hidden"
					onChange={(event) => {
						const file = event.target.files?.[0];
						event.target.value = "";
						if (file) void handleFile(file);
					}}
				/>
			</div>

			<ConfirmDialog
				isOpen={pending !== null}
				title={t("settings_blocked.import_confirm_title", { defaultValue: "Import block list" })}
				message={
					pending
						? [
								t("settings_blocked.import_confirm_message", {
									defaultValue:
										"{{file}} lists {{count}} profiles. {{already}} are already blocked here, so {{toBlock}} will be blocked.",
									file: pending.fileName,
									count: pending.fileCount.toLocaleString(),
									already: pending.alreadyBlocked.toLocaleString(),
									toBlock: pending.toBlock.length.toLocaleString(),
								}),
								pending.skippedSelf
									? t("settings_blocked.import_confirm_self", {
											defaultValue: "It also lists this account itself, which is left out.",
										})
									: null,
								t("settings_blocked.import_confirm_stop", {
									defaultValue: "You can pause or stop whenever you like; blocks already done stay.",
								}),
							]
								.filter(Boolean)
								.join(" ")
						: ""
				}
				confirmLabel={
					pace === "instant"
						? t("settings_blocked.import_start_instant", { defaultValue: "Block all now" })
						: t("settings_blocked.import_start", { defaultValue: "Start" })
				}
				cancelLabel={t("settings_blocked.cancel", { defaultValue: "Cancel" })}
				onConfirm={handleStart}
				onCancel={() => setPending(null)}
				confirmTone={pace === "instant" ? "danger" : "default"}
				confirmDisabled={pace === "instant" && !instantAccepted}
			>
				{pending && (
					<div className="mt-4">
						<p className="mb-2 text-xs font-semibold text-[var(--text)]">
							{t("settings_blocked.pace_title", { defaultValue: "Pace" })}
						</p>
						{renderPacePicker(pace, setPace, pending.toBlock.length)}
						{pace === "instant" && (
							<>
								{renderInstantNotes(pending.toBlock.length)}
								<label className="mt-3 flex cursor-pointer items-start gap-2.5 text-xs leading-snug text-[var(--text)]">
									<input
										type="checkbox"
										checked={instantAccepted}
										onChange={(event) => setInstantAccepted(event.target.checked)}
										className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]"
									/>
									{t("settings_blocked.instant_accept", {
										defaultValue: "I've read this and accept the risk to this account.",
									})}
								</label>
							</>
						)}
					</div>
				)}
			</ConfirmDialog>

			<ConfirmDialog
				isOpen={confirmInstantSwitch}
				title={t("settings_blocked.instant_switch_title", { defaultValue: "Switch to Instant?" })}
				message={t("settings_blocked.instant_switch_message", {
					defaultValue: "The rest of the list is blocked straight away, with no pauses.",
				})}
				confirmLabel={t("settings_blocked.instant_switch_confirm", { defaultValue: "Accept the risk and switch" })}
				cancelLabel={t("settings_blocked.cancel", { defaultValue: "Cancel" })}
				onConfirm={() => {
					if (ownerId) setBlockImportPace(ownerId, "instant");
					setConfirmInstantSwitch(false);
				}}
				onCancel={() => setConfirmInstantSwitch(false)}
				confirmTone="danger"
			>
				{job && renderInstantNotes(Math.max(0, job.total - job.blocked - job.failed))}
			</ConfirmDialog>

			<ConfirmDialog
				isOpen={confirmCancel}
				title={t("settings_blocked.import_cancel_title", { defaultValue: "Stop the import?" })}
				message={t("settings_blocked.import_cancel_message", {
					defaultValue: "Everyone blocked so far stays blocked. The rest of the list won't be.",
				})}
				confirmLabel={t("settings_blocked.import_cancel", { defaultValue: "Stop import" })}
				cancelLabel={t("settings_blocked.cancel", { defaultValue: "Cancel" })}
				onConfirm={() => {
					if (ownerId) clearBlockImport(ownerId);
					setConfirmCancel(false);
					// The list below shows who got blocked before the stop.
					void queryClient.invalidateQueries({ queryKey: ["blocked-profile-ids"] });
				}}
				onCancel={() => setConfirmCancel(false)}
				confirmTone="danger"
			/>
		</div>
	);
}
