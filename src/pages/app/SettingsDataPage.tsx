import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	Download,
	FileDown,
	FileUp,
	Loader2,
	Minimize2,
	RotateCcw,
	ShieldCheck,
	Trash2,
	Upload,
} from "lucide-react";
import toast from "react-hot-toast";
import { useTranslation } from "react-i18next";
import { useSettingsJump } from "../../hooks/useSettingsJump";
import { BackToSettings } from "../../components/BackToSettings";
import { CopyAccountSettingsCard } from "../../components/settings/CopyAccountSettingsCard";
import { GoogleDriveSyncCard } from "../../components/settings/GoogleDriveSyncCard";
import { ConfirmDialog } from "../../components/ui/confirm-dialog";
import { ToggleRow } from "../../components/ui/toggle-row";
import { useAuth } from "../../contexts/useAuth";
import * as chatDb from "../../services/chatDb";
import {
	BACKUP_SECTIONS,
	REQUIRED_SECTIONS,
	estimateBackupSections,
	deleteStoredSections,
	DELETABLE_BACKUP_SECTIONS,
	SYNCED_BACKUP_SECTIONS,
	exportBackup,
	importBackup,
	isBackupV2File,
	deltaSinceForPeer,
	type BackupProgress,
	type BackupSection,
	type SectionEstimate,
} from "../../services/backup";
import { createBackupWriter } from "../../services/backupFile";
import { listPeers, type BackupPeer } from "../../services/backupPeers";
import { deleteAllDownloadedMedia, getDownloadedMediaUsage } from "../../services/saveMedia";
import { isAutoDownloadMediaEnabled, setAutoDownloadMediaEnabled } from "../../utils/mediaSettings";
import { resetAppearanceAndBehaviour } from "../../utils/resetSettings";
import { appLog } from "../../utils/logger";
import type { FullDbExport } from "../../types/chat-db";

function formatBytes(bytes: number): string {
	if (bytes <= 0) return "0 B";
	const units = ["B", "KB", "MB", "GB"];
	const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
	const value = bytes / 1024 ** exponent;
	return `${exponent === 0 ? value : value.toFixed(1)} ${units[exponent]}`;
}

function getErrorMessage(error: unknown, fallback: string): string {
	return error instanceof Error && error.message ? error.message : fallback;
}

/** Free space worth offering to reclaim: under this, compacting is not worth the wait. */
const COMPACTABLE_FREE_BYTES = 50 * 1024 * 1024;

export function SettingsDataPage() {
	const { t } = useTranslation();
	useSettingsJump();
	const { userId, settingsReady } = useAuth();

	const sectionLabels: Record<BackupSection, { label: string; description: string }> = {
		core: {
			label: t("data_backup.section_core", { defaultValue: "Chats & settings" }),
			description: t("data_backup.section_core_desc", {
				defaultValue: "Conversations, messages, block history, saved phrases and locations, and every app setting.",
			}),
		},
		index: {
			label: t("data_backup.section_index", { defaultValue: "Profile index" }),
			description: t("data_backup.section_index_desc", {
				defaultValue: "Which profiles you've already chatted with, plus any nicknames you set. Restores the badges on the grid.",
			}),
		},
		views: {
			label: t("data_backup.section_views", { defaultValue: "Viewed-me history" }),
			description: t("data_backup.section_views_desc", {
				defaultValue: "Profiles banked by the background scanner. Without these, locked views show as “Unknown Profile”.",
			}),
		},
		local: {
			label: t("data_backup.section_local", { defaultValue: "Rules & preferences" }),
			description: t("data_backup.section_local_desc", {
				defaultValue: "Auto-block rules, ghost mode, whitelist, scanner settings, notifications, and theme.",
			}),
		},
		chatMedia: {
			label: t("data_backup.section_chat_media", { defaultValue: "Chat photos & videos" }),
			description: t("data_backup.section_chat_media_desc", {
				defaultValue: "Cached media from your conversations, including view-once items that can't be re-fetched.",
			}),
		},
		albumMedia: {
			label: t("data_backup.section_album_media", { defaultValue: "Albums" }),
			description: t("data_backup.section_album_media_desc", {
				defaultValue: "Album contents and cover images. Usually the largest part of a backup.",
			}),
		},
		avatars: {
			label: t("data_backup.section_avatars", { defaultValue: "Profile pictures" }),
			description: t("data_backup.section_avatars_desc", {
				defaultValue: "Cached avatars, so restored profiles show their picture immediately.",
			}),
		},
	};

	const [autoDownloadMedia, setAutoDownloadMedia] = useState(() => isAutoDownloadMediaEnabled());
	const [usage, setUsage] = useState<{ count: number; totalBytes: number } | null>(null);
	const [dbUsage, setDbUsage] = useState<chatDb.DatabaseUsage | null>(null);
	const [isCompacting, setIsCompacting] = useState(false);
	const [showCompactConfirm, setShowCompactConfirm] = useState(false);
	const [isLoadingUsage, setIsLoadingUsage] = useState(true);
	const [isDeleting, setIsDeleting] = useState(false);
	const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
	const [isExporting, setIsExporting] = useState(false);
	const [isImporting, setIsImporting] = useState(false);
	const [progress, setProgress] = useState<BackupProgress | null>(null);
	const [estimates, setEstimates] = useState<SectionEstimate[] | null>(null);
	const [selected, setSelected] = useState<Set<BackupSection>>(
		() => new Set<BackupSection>(BACKUP_SECTIONS),
	);
	const [mirrorImport, setMirrorImport] = useState(false);
	const [peers, setPeers] = useState<BackupPeer[]>([]);
	const [targetPeerId, setTargetPeerId] = useState<string | null>(null);
	const [fullExport, setFullExport] = useState(false);
	const [pendingFile, setPendingFile] = useState<File | null>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const [purgeSelected, setPurgeSelected] = useState<Set<BackupSection>>(
		() => new Set<BackupSection>(),
	);
	const [showPurgeConfirm, setShowPurgeConfirm] = useState(false);
	const [isPurging, setIsPurging] = useState(false);
	const [showResetConfirm, setShowResetConfirm] = useState(false);
	const [isResetting, setIsResetting] = useState(false);

	const handleResetAppearance = () => {
		setIsResetting(true);
		try {
			resetAppearanceAndBehaviour();
			toast.success(t("data_backup.reset.success", { defaultValue: "Settings reset. Reloading…" }));
			// The pages hold the old values in memory, so the app starts over.
			window.location.reload();
		} catch (error) {
			appLog.warn("[settings] reset failed", error);
			toast.error(getErrorMessage(error, t("data_backup.reset.failed", { defaultValue: "Could not reset the settings." })));
			setIsResetting(false);
			setShowResetConfirm(false);
		}
	};

	const loadUsage = useCallback(async () => {
		setIsLoadingUsage(true);
		try {
			const [downloaded, database] = await Promise.all([
				getDownloadedMediaUsage(),
				chatDb.getDatabaseUsage().catch(() => null),
			]);
			setUsage(downloaded);
			setDbUsage(database);
		} catch (error) {
			appLog.error("[SettingsDataPage] failed to load downloaded-media usage", error);
		} finally {
			setIsLoadingUsage(false);
		}
	}, []);

	// 0 means "measure everything"; a peer watermark narrows it to the rows a
	// delta would actually carry, so the sizes shown match what gets written.
	const deltaSince = useMemo(
		() => (fullExport ? 0 : deltaSinceForPeer(targetPeerId)),
		[fullExport, targetPeerId],
	);
	const isDelta = deltaSince > 0;
	const activePeer = useMemo(
		() => peers.find((peer) => peer.deviceId === targetPeerId) ?? null,
		[peers, targetPeerId],
	);

	const loadEstimates = useCallback(async (since: number) => {
		try {
			setEstimates(await estimateBackupSections(since));
		} catch (error) {
			appLog.error("[SettingsDataPage] failed to estimate backup sections", error);
		}
	}, []);

	useEffect(() => {
		void loadUsage();
	}, [loadUsage]);

	useEffect(() => {
		const known = listPeers();
		setPeers(known);
		// With a single known peer there is nothing to choose between, so it is
		// selected outright rather than making the user pick it every time.
		setTargetPeerId((current) => current ?? known[0]?.deviceId ?? null);
	}, []);

	useEffect(() => {
		setEstimates(null);
		void loadEstimates(deltaSince);
	}, [loadEstimates, deltaSince]);

	const selectedBytes = useMemo(
		() =>
			(estimates ?? [])
				.filter((estimate) => selected.has(estimate.section))
				.reduce((total, estimate) => total + estimate.bytes, 0),
		[estimates, selected],
	);

	const toggleSection = (section: BackupSection) => {
		if (REQUIRED_SECTIONS.includes(section)) {
			return;
		}
		setSelected((previous) => {
			const next = new Set(previous);
			if (next.has(section)) {
				next.delete(section);
			} else {
				next.add(section);
			}
			return next;
		});
	};

	const togglePurgeSection = (section: BackupSection) => {
		setPurgeSelected((current) => {
			const next = new Set(current);
			if (next.has(section)) next.delete(section);
			else next.add(section);
			return next;
		});
	};

	const purgeBytes = useMemo(
		() =>
			(estimates ?? [])
				.filter((estimate) => purgeSelected.has(estimate.section))
				.reduce((total, estimate) => total + estimate.bytes, 0),
		[estimates, purgeSelected],
	);

	const purgeTouchesSynced = useMemo(
		() => [...purgeSelected].some((section) => SYNCED_BACKUP_SECTIONS.includes(section)),
		[purgeSelected],
	);

	const handlePurge = async () => {
		setIsPurging(true);
		try {
			await deleteStoredSections([...purgeSelected]);
			setPurgeSelected(new Set<BackupSection>());
			setShowPurgeConfirm(false);
			await loadUsage();
			setEstimates(await estimateBackupSections(0));
			toast.success(
				t("data_backup.purge_done", { defaultValue: "Selected data removed." }),
			);
		} catch (error) {
			appLog.error("[SettingsDataPage] failed to delete stored sections", error);
			toast.error(
				t("data_backup.purge_failed", {
					defaultValue: "Could not remove that data.",
				}),
			);
		} finally {
			setIsPurging(false);
		}
	};

	const handleDeleteAll = async () => {
		setIsDeleting(true);
		try {
			const result = await deleteAllDownloadedMedia();
			if (result.unsupported) {
				toast.error(
					t("data_backup.delete_unsupported", {
						defaultValue: "Saved files can only be deleted from the installed app.",
					}),
				);
			} else if (result.failed > 0) {
				toast.error(
					t("data_backup.delete_partial", {
						defaultValue: "Deleted {{deleted}} files, {{failed}} failed.",
						deleted: result.deleted + result.pruned,
						failed: result.failed,
					}),
				);
			} else if (result.deleted === 0 && result.pruned > 0) {
				// Every tracked file had already been removed outside the app.
				// Saying "deleted 0" here would read as another failure.
				toast.success(
					t("data_backup.delete_pruned_only", {
						defaultValue: "Cleared {{count}} entries — those files were already gone.",
						count: result.pruned,
					}),
				);
			} else {
				toast.success(
					t("data_backup.delete_success", {
						defaultValue: "Deleted {{count}} downloaded files.",
						count: result.deleted + result.pruned,
					}),
				);
			}
			await loadUsage();
		} catch (error) {
			toast.error(getErrorMessage(error, t("data_backup.delete_failed", { defaultValue: "Failed to delete downloaded media." })));
		} finally {
			setIsDeleting(false);
			setShowDeleteConfirm(false);
		}
	};

	const handleExport = async () => {
		if (userId == null) {
			toast.error(t("data_backup.export_no_user", { defaultValue: "You must be signed in to export." }));
			return;
		}
		setIsExporting(true);
		setProgress(null);
		try {
			const destination = await createBackupWriter();
			const result = await exportBackup(
				userId,
				[...selected],
				destination.writer,
				setProgress,
				{ targetPeerId, full: fullExport },
			);

			const where =
				destination.location === "ios-files-app"
					? t("data_backup.export_success_ios", {
							defaultValue: "Saved to Files → On My iPhone → GrindFlop → {{name}}",
							name: destination.fileName,
						})
					: destination.location === "downloads-folder"
						? t("data_backup.export_success_path", {
								defaultValue: "Saved to Downloads/FreeGrind/{{name}}",
								name: destination.fileName,
							})
						: t("data_backup.export_success", { defaultValue: "Data exported." });
			toast.success(
				result.mode === "delta"
					? t("data_backup.export_success_delta", {
							defaultValue: "{{where}} — {{count}} changes since the last sync.",
							where,
							count: result.rowsWritten,
						})
					: where,
			);

			// Nothing to re-measure: the watermark only moves once this file is
			// confirmed imported on the other device, which sends an ack back.
		} catch (error) {
			toast.error(getErrorMessage(error, t("data_backup.export_failed", { defaultValue: "Failed to export data." })));
		} finally {
			setIsExporting(false);
			setProgress(null);
		}
	};

	const runImport = async (file: File) => {
		if (userId == null) {
			toast.error(t("data_backup.import_no_user", { defaultValue: "You must be signed in to import." }));
			return;
		}
		setIsImporting(true);
		setProgress(null);
		try {
			const result = (await isBackupV2File(file))
				? await importBackup(file, userId, { mirror: mirrorImport }, setProgress)
				: // Files written by older builds are a single JSON object rather
					// than NDJSON, and still import through the original merge path.
					await chatDb.importFullDatabase(JSON.parse(await file.text()) as FullDbExport, userId);

			if (!result.ok) {
				toast.error(
					result.error === "wrong_owner"
						? t("data_backup.import_wrong_owner", { defaultValue: "This export belongs to a different profile and can't be imported here." })
						: t("data_backup.import_invalid", { defaultValue: "This file isn't a valid data export." }),
				);
				return;
			}
			// A full import can touch conversations, messages, and every
			// setting (automation, privacy, browse filters, location, etc.),
			// each of which is otherwise cached in memory or React state and
			// only ever (re)loaded on app start / account switch — a reload
			// is the only way to guarantee everything reflects the import.
			// Naming the source device confirms the two installs are now linked,
			// which is what makes the next export offer a changes-only file.
			toast.success(
				"deviceName" in result
					? t("data_backup.import_success_from", {
							defaultValue: "Imported {{count}} rows from {{name}}. Reloading…",
							count: result.rowsImported,
							name: result.deviceName,
						})
					: t("data_backup.import_success", {
							defaultValue: "Imported {{count}} rows. Reloading…",
							count: result.rowsImported,
						}),
			);
			window.location.reload();
		} catch (error) {
			toast.error(getErrorMessage(error, t("data_backup.import_failed", { defaultValue: "Failed to import data." })));
		} finally {
			setIsImporting(false);
			setProgress(null);
		}
	};

	const handleCompact = async () => {
		setShowCompactConfirm(false);
		setIsCompacting(true);
		const fileBefore = dbUsage?.fileBytes ?? 0;
		try {
			const after = await chatDb.compactDatabase();
			setDbUsage(after);
			toast.success(
				t("data_backup.compact_done", {
					defaultValue: "Gave {{size}} back to your disk.",
					size: formatBytes(Math.max(0, fileBefore - after.fileBytes)),
				}),
			);
		} catch (error) {
			appLog.error("[SettingsDataPage] compacting the database failed", error);
			toast.error(t("data_backup.compact_failed", { defaultValue: "Couldn't compact the database." }));
		} finally {
			setIsCompacting(false);
		}
	};

	const handleImportFile = async (file: File) => {
		// Mirror mode erases before it writes, so it always gets a confirmation
		// naming what goes. A plain merge can't lose anything and doesn't.
		if (mirrorImport) {
			setPendingFile(file);
			return;
		}
		await runImport(file);
	};

	const confirmMirrorImport = async () => {
		const file = pendingFile;
		setPendingFile(null);
		if (file) {
			await runImport(file);
		}
	};

	const busy = isExporting || isImporting;
	const progressLabel = progress
		? `${sectionLabels[progress.section].label} — ${progress.rowsDone.toLocaleString()}${
				progress.rowsTotal > 0 ? ` / ${progress.rowsTotal.toLocaleString()}` : ""
			}`
		: null;
	const progressPercent =
		progress && progress.rowsTotal > 0
			? Math.min(100, Math.round((progress.rowsDone / progress.rowsTotal) * 100))
			: null;

	return (
		<section className="app-screen">
			<header className="mb-7">
				<BackToSettings />
				<h1 className="app-title mb-1">{t("data_backup.title", { defaultValue: "Data" })}</h1>
				<p className="app-subtitle">
					{t("data_backup.subtitle", { defaultValue: "Manage downloaded media and back up your account's entire data." })}
				</p>
			</header>

			<div className="grid gap-6">
				{/* Media Storage */}
				<div>
					<p className="mb-2 px-1 text-xs font-semibold uppercase tracking-widest text-[var(--text-muted)]">
						{t("data_backup.media_storage", { defaultValue: "Media Storage" })}
					</p>
					<div className="surface-card overflow-hidden divide-y divide-[var(--border)]">
						<ToggleRow
							icon={<Download className="h-5 w-5" />}
							iconClass="bg-emerald-500/15 text-emerald-400"
							id="data-auto-download-media"
							label={t("data_backup.auto_download_media", { defaultValue: "Auto-download media" })}
							description={t("data_backup.auto_download_media_desc", { defaultValue: "Also save every cached photo and video to your device's Downloads folder, in addition to the app's local database." })}
							checked={autoDownloadMedia}
							onChange={(checked) => {
								setAutoDownloadMedia(checked);
								void setAutoDownloadMediaEnabled(checked);
							}}
						/>

						<div id="data-app-database" className="flex items-center justify-between gap-4 px-4 py-3.5">
							<div className="min-w-0">
								<p className="text-sm font-medium text-[var(--text)]">
									{t("data_backup.app_database", { defaultValue: "App database" })}
								</p>
								<p className="mt-0.5 text-xs text-[var(--text-muted)]">
									{isLoadingUsage
										? t("data_backup.storage_loading", { defaultValue: "Calculating…" })
										: t("data_backup.app_database_summary", {
												defaultValue: "{{size}} of cached chats, albums and avatars",
												size: formatBytes(dbUsage?.usedBytes ?? 0),
											})}
								</p>
								{!isLoadingUsage && (dbUsage?.freeBytes ?? 0) > 0 ? (
									<p className="mt-0.5 text-xs text-[var(--text-muted)]">
										{t("data_backup.app_database_free", {
											defaultValue:
												"The file also holds {{size}} of empty space left by data you deleted. It is reused for new data, and only compacting gives it back to the disk.",
											size: formatBytes(dbUsage?.freeBytes ?? 0),
										})}
									</p>
								) : null}
							</div>
							{!isLoadingUsage && (dbUsage?.freeBytes ?? 0) >= COMPACTABLE_FREE_BYTES ? (
								<button
									type="button"
									onClick={() => setShowCompactConfirm(true)}
									disabled={isCompacting}
									className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-[var(--surface-2)] px-3 text-xs font-semibold text-[var(--text)] transition hover:bg-[var(--surface)] disabled:opacity-50"
								>
									{isCompacting ? (
										<Loader2 className="h-3.5 w-3.5 animate-spin" />
									) : (
										<Minimize2 className="h-3.5 w-3.5" />
									)}
									{t("data_backup.compact", { defaultValue: "Compact" })}
								</button>
							) : null}
						</div>

						<div id="data-storage-used" className="flex items-center justify-between gap-4 px-4 py-3.5">
							<div className="min-w-0">
								<p className="text-sm font-medium text-[var(--text)]">
									{t("data_backup.storage_used", { defaultValue: "Saved to this device" })}
								</p>
								<p className="mt-0.5 text-xs text-[var(--text-muted)]">
									{isLoadingUsage
										? t("data_backup.storage_loading", { defaultValue: "Calculating…" })
										: t("data_backup.storage_summary", {
												defaultValue: "{{size}} across {{count}} files",
												size: formatBytes(usage?.totalBytes ?? 0),
												count: usage?.count ?? 0,
											})}
								</p>
							</div>
							<button
								type="button"
								onClick={() => setShowDeleteConfirm(true)}
								disabled={isDeleting || isLoadingUsage || (usage?.count ?? 0) === 0}
								className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-red-500/15 px-3 text-xs font-semibold text-red-400 transition hover:bg-red-500/25 disabled:opacity-50"
							>
								{isDeleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
								{t("data_backup.delete_all", { defaultValue: "Delete all" })}
							</button>
						</div>
					</div>
				</div>

				<CopyAccountSettingsCard id="data-copy-settings" />

				<GoogleDriveSyncCard id="data-drive-sync" profileId={settingsReady ? userId : null} />

				{/* Backup */}
				<div>
					<p className="mb-2 px-1 text-xs font-semibold uppercase tracking-widest text-[var(--text-muted)]">
						{t("data_backup.backup", { defaultValue: "Backup" })}
					</p>
					<div className="surface-card overflow-hidden divide-y divide-[var(--border)]">
						<div id="data-export" className="px-4 py-3.5">
							<div className="flex items-start gap-3">
								<div className="shrink-0 rounded-2xl bg-teal-500/15 p-2.5 text-teal-400">
									<FileDown className="h-5 w-5" />
								</div>
								<div className="min-w-0 flex-1">
									<p className="text-sm font-semibold leading-snug">
										{t("data_backup.export", { defaultValue: "Export all data" })}
									</p>
									<p className="mt-0.5 text-xs leading-snug text-[var(--text-muted)]">
										{t("data_backup.export_card_desc", {
											defaultValue: "Choose what to include, then move the file to another device to reproduce this account exactly.",
										})}
									</p>
								</div>
							</div>

							{peers.length > 0 && (
								<div className="mt-3 rounded-xl bg-[var(--surface-2)] p-1">
									<div className="grid grid-cols-2 gap-1">
										<button
											type="button"
											onClick={() => setFullExport(false)}
											disabled={busy}
											className={`rounded-lg px-3 py-2 text-xs font-semibold transition ${!fullExport ? "bg-[var(--surface)] text-[var(--text)] shadow-sm" : "text-[var(--text-muted)]"}`}
										>
											{t("data_backup.mode_delta", {
												defaultValue: "Changes only",
											})}
										</button>
										<button
											type="button"
											onClick={() => setFullExport(true)}
											disabled={busy}
											className={`rounded-lg px-3 py-2 text-xs font-semibold transition ${fullExport ? "bg-[var(--surface)] text-[var(--text)] shadow-sm" : "text-[var(--text-muted)]"}`}
										>
											{t("data_backup.mode_full", { defaultValue: "Everything" })}
										</button>
									</div>
									<p className="px-2 pb-1 pt-2 text-[11px] leading-snug text-[var(--text-muted)]">
										{isDelta
											? t("data_backup.mode_delta_desc", {
													defaultValue:
														"Only what changed since you last exported for {{name}}. Much smaller, and safe to merge on top of what's already there.",
													name: activePeer?.deviceName ?? t("data_backup.that_device"),
												})
											: fullExport
												? t("data_backup.mode_full_desc", {
														defaultValue:
															"Everything selected below, regardless of what you've already sent.",
													})
												: t("data_backup.mode_delta_first", {
														defaultValue:
															"This is the first export for {{name}}, so it includes everything. Later exports will only carry what changed.",
														name: activePeer?.deviceName ?? t("data_backup.that_device"),
													})}
									</p>
									{peers.length > 1 && (
										<div className="flex flex-wrap gap-1 px-1 pb-1">
											{peers.map((peer) => (
												<button
													key={peer.deviceId}
													type="button"
													onClick={() => setTargetPeerId(peer.deviceId)}
													disabled={busy}
													className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition ${peer.deviceId === targetPeerId ? "bg-[var(--accent)] text-[var(--accent-contrast)]" : "bg-[var(--surface)] text-[var(--text-muted)]"}`}
												>
													{peer.deviceName}
												</button>
											))}
										</div>
									)}
								</div>
							)}

							<div className="mt-3 grid gap-1.5">
								{BACKUP_SECTIONS.map((section) => {
									const estimate = estimates?.find((item) => item.section === section);
									const required = REQUIRED_SECTIONS.includes(section);
									const isOn = selected.has(section) || required;
									return (
										<label
											key={section}
											className={`flex cursor-pointer items-start gap-2.5 rounded-xl px-2.5 py-2 transition-colors ${required ? "cursor-default opacity-70" : "hover:bg-[var(--surface-2)]"}`}
										>
											<input
												type="checkbox"
												checked={isOn}
												disabled={required || busy}
												onChange={() => toggleSection(section)}
												className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]"
											/>
											<span className="min-w-0 flex-1">
												<span className="flex items-baseline justify-between gap-2">
													<span className="text-xs font-semibold text-[var(--text)]">
														{sectionLabels[section].label}
													</span>
													<span className="shrink-0 text-[11px] tabular-nums text-[var(--text-muted)]">
														{estimate
															? `${estimate.rows.toLocaleString()} · ${formatBytes(estimate.bytes)}`
															: "…"}
													</span>
												</span>
												<span className="mt-0.5 block text-[11px] leading-snug text-[var(--text-muted)]">
													{sectionLabels[section].description}
												</span>
											</span>
										</label>
									);
								})}
							</div>

							<button
								type="button"
								onClick={() => void handleExport()}
								disabled={busy}
								className="mt-3 inline-flex h-10 w-full items-center justify-center gap-2 rounded-full bg-[var(--accent)] px-4 text-sm font-semibold text-[var(--accent-contrast)] transition disabled:opacity-50"
							>
								{isExporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
								{!estimates
									? t("data_backup.export_action", { defaultValue: "Export" })
									: isDelta
										? t("data_backup.export_action_delta", {
												defaultValue: "Export changes — about {{size}}",
												size: formatBytes(selectedBytes),
											})
										: t("data_backup.export_action_sized", {
												defaultValue: "Export — about {{size}}",
												size: formatBytes(selectedBytes),
											})}
							</button>
						</div>

						<button
							type="button"
							id="data-import"
							onClick={() => fileInputRef.current?.click()}
							disabled={busy}
							className={`flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors ${busy ? "opacity-50" : "hover:bg-[var(--surface-2)] active:bg-[var(--surface-2)]"}`}
						>
							<div className="shrink-0 rounded-2xl bg-violet-500/15 p-2.5 text-violet-400">
								<FileUp className="h-5 w-5" />
							</div>
							<div className="min-w-0 flex-1">
								<p className="text-sm font-semibold leading-snug">
									{t("data_backup.import", { defaultValue: "Import data" })}
								</p>
								<p className="mt-0.5 text-xs leading-snug text-[var(--text-muted)]">
									{mirrorImport
										? t("data_backup.import_card_desc_mirror", {
												defaultValue: "Erase what's here and replace it with the file, making this device an exact copy. The app reloads afterwards.",
											})
										: t("data_backup.import_card_desc", {
												defaultValue: "Merge a previously exported file back in — nothing already here is erased. The app reloads afterwards.",
											})}
								</p>
							</div>
							{isImporting ? (
								<Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--text-muted)]" />
							) : (
								<Upload className="h-4 w-4 shrink-0 text-[var(--text-muted)] opacity-50" />
							)}
						</button>

						<ToggleRow
							label={t("data_backup.import_mirror", { defaultValue: "Replace everything" })}
							description={t("data_backup.import_mirror_desc", {
								defaultValue: "Wipe the categories included in the file before importing, instead of merging. Use this to make a second device identical to the first.",
							})}
							checked={mirrorImport}
							onChange={setMirrorImport}
							activeColor="rgb(248 113 113)"
						/>

						<input
							ref={fileInputRef}
							type="file"
							accept="application/json,.json"
							className="hidden"
							onChange={(event) => {
								const file = event.target.files?.[0];
								event.target.value = "";
								if (file) void handleImportFile(file);
							}}
						/>

						{progressLabel && (
							<div className="px-4 py-3">
								<div className="mb-1.5 flex items-baseline justify-between gap-2">
									<p className="text-xs font-medium text-[var(--text)]">
										{isExporting
											? t("data_backup.progress_exporting", { defaultValue: "Exporting…" })
											: t("data_backup.progress_importing", { defaultValue: "Importing…" })}
									</p>
									<p className="text-[11px] tabular-nums text-[var(--text-muted)]">{progressLabel}</p>
								</div>
								<div className="h-1.5 overflow-hidden rounded-full bg-[var(--surface-2)]">
									<div
										className="h-full rounded-full bg-[var(--accent)] transition-[width]"
										style={{ width: progressPercent == null ? "100%" : `${progressPercent}%` }}
									/>
								</div>
							</div>
						)}

						<div className="flex items-start gap-2.5 px-4 py-3">
							<ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
							<p className="text-xs leading-relaxed text-[var(--text-muted)]">
								{t("data_backup.backup_note", {
									defaultValue: "Exports are tied to your profile — a file can only be imported back into the same account it came from, so sign in on the other device first.",
								})}
							</p>
						</div>
					</div>
				</div>
			</div>

			<div className="mt-4">
				<p className="mb-2 px-1 text-xs font-semibold uppercase tracking-widest text-[var(--text-muted)]">
					{t("data_backup.manage_title", { defaultValue: "Stored data" })}
				</p>
				<div id="data-stored" className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
					<div className="px-4 py-3.5">
						<p className="text-sm font-semibold">
							{t("data_backup.manage_heading", {
								defaultValue: "Free up space on this device",
							})}
						</p>
						<p className="mt-0.5 text-xs leading-relaxed text-[var(--text-muted)]">
							{t("data_backup.manage_desc", {
								defaultValue:
									"Remove data you no longer need here. Conversations, messages and settings are never removed. Export first if you want a copy.",
							})}
						</p>

						<div className="mt-3 grid gap-1.5">
							{DELETABLE_BACKUP_SECTIONS.map((section) => {
								const estimate = estimates?.find((item) => item.section === section);
								const synced = SYNCED_BACKUP_SECTIONS.includes(section);
								return (
									<label
										key={section}
										className="flex cursor-pointer items-start gap-2.5 rounded-xl px-2.5 py-2 transition-colors hover:bg-[var(--surface-2)]"
									>
										<input
											type="checkbox"
											checked={purgeSelected.has(section)}
											disabled={busy || isPurging}
											onChange={() => togglePurgeSection(section)}
											className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]"
										/>
										<span className="min-w-0 flex-1">
											<span className="flex items-baseline justify-between gap-2">
												<span className="text-xs font-semibold text-[var(--text)]">
													{sectionLabels[section].label}
												</span>
												<span className="shrink-0 text-[11px] tabular-nums text-[var(--text-muted)]">
													{estimate
														? `${estimate.rows.toLocaleString()} · ${formatBytes(estimate.bytes)}`
														: "…"}
												</span>
											</span>
											<span className="mt-0.5 block text-[11px] leading-snug text-[var(--text-muted)]">
												{synced
													? t("data_backup.manage_synced_hint", {
															defaultValue:
																"Cloud sync carries this. Removing it here can also remove it from your other devices.",
														})
													: t("data_backup.manage_local_hint", {
															defaultValue:
																"This device only. Media is never uploaded by cloud sync.",
														})}
											</span>
										</span>
									</label>
								);
							})}
						</div>

						<button
							type="button"
							onClick={() => setShowPurgeConfirm(true)}
							disabled={purgeSelected.size === 0 || busy || isPurging}
							className="mt-3 inline-flex h-10 w-full items-center justify-center gap-2 rounded-full border border-red-500/30 bg-red-500/10 px-4 text-sm font-semibold text-red-300 transition disabled:opacity-40"
						>
							{isPurging ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
							{purgeSelected.size === 0
								? t("data_backup.manage_action_empty", {
										defaultValue: "Select what to remove",
									})
								: t("data_backup.manage_action", {
										defaultValue: "Remove selected — frees about {{size}}",
										size: formatBytes(purgeBytes),
									})}
						</button>
					</div>
				</div>

				{/* Reset */}
				<div>
					<p className="mb-2 px-1 text-xs font-semibold uppercase tracking-widest text-[var(--text-muted)]">
						{t("data_backup.reset.section", { defaultValue: "Reset" })}
					</p>
					<div className="surface-card overflow-hidden">
						<div id="data-reset" className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 px-4 py-3.5">
							<div className="min-w-0 flex-1 basis-56">
								<p className="text-sm font-medium text-[var(--text)]">
									{t("data_backup.reset.action", { defaultValue: "Reset appearance and behaviour" })}
								</p>
								<p className="mt-0.5 text-xs leading-snug text-[var(--text-muted)]">
									{t("data_backup.reset.desc", {
										defaultValue:
											"Puts the theme, layout, confirmations, notification switches and tab choices kept on this device back to their defaults. Blocking and automation rules, privacy, filters, sync, conversations and media are left alone.",
									})}
								</p>
							</div>
							<button
								type="button"
								onClick={() => setShowResetConfirm(true)}
								disabled={isResetting}
								className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-red-500/30 bg-red-500/10 px-3 text-xs font-semibold text-red-300 transition hover:bg-red-500/20 disabled:opacity-50"
							>
								{isResetting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
								{t("data_backup.reset.section", { defaultValue: "Reset" })}
							</button>
						</div>
					</div>
				</div>
			</div>

			<ConfirmDialog
				isOpen={showResetConfirm}
				title={t("data_backup.reset.confirm_title", { defaultValue: "Reset appearance and behaviour?" })}
				message={t("data_backup.reset.confirm_message", {
					defaultValue:
						"The theme, layout, confirmations, notification switches and tab choices on this device go back to their defaults, and the app reloads. Blocking and automation rules, privacy, filters, sync, conversations and media are not touched.",
				})}
				confirmLabel={t("data_backup.reset.section", { defaultValue: "Reset" })}
				cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
				confirmTone="danger"
				isProcessing={isResetting}
				onConfirm={handleResetAppearance}
				onCancel={() => setShowResetConfirm(false)}
			/>

			<ConfirmDialog
				isOpen={showCompactConfirm}
				title={t("data_backup.compact_confirm_title", { defaultValue: "Compact the app database?" })}
				message={t("data_backup.compact_confirm_message", {
					defaultValue:
						"This rewrites the database file without the empty space that deleted data left behind. Nothing you still have is removed, but the app may be busy for a minute, so avoid closing it while it runs.",
				})}
				confirmLabel={t("data_backup.compact", { defaultValue: "Compact" })}
				cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
				isProcessing={isCompacting}
				onConfirm={() => void handleCompact()}
				onCancel={() => setShowCompactConfirm(false)}
			/>

			<ConfirmDialog
				isOpen={showDeleteConfirm}
				title={t("data_backup.delete_confirm_title", { defaultValue: "Delete all downloaded media?" })}
				message={t("data_backup.delete_confirm_message", {
					defaultValue: "This permanently deletes every photo and video this app has saved to your device (manual saves and auto-downloads). The app's own local cache is not affected.",
				})}
				confirmLabel={t("data_backup.delete_all", { defaultValue: "Delete all" })}
				cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
				confirmTone="danger"
				isProcessing={isDeleting}
				onConfirm={() => void handleDeleteAll()}
				onCancel={() => setShowDeleteConfirm(false)}
			/>

			<ConfirmDialog
				isOpen={pendingFile !== null}
				title={t("data_backup.import_mirror_confirm_title", { defaultValue: "Replace this device's data?" })}
				message={t("data_backup.import_mirror_confirm_message", {
					defaultValue: "Every category included in the file will be erased here first — conversations, messages, settings, and any cached media the file covers. Anything on this device that isn't in the file is lost and can't be recovered.",
				})}
				confirmLabel={t("data_backup.import_mirror_confirm", { defaultValue: "Erase and import" })}
				cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
				confirmTone="danger"
				isProcessing={isImporting}
				onConfirm={() => void confirmMirrorImport()}
				onCancel={() => setPendingFile(null)}
			/>
			<ConfirmDialog
				isOpen={showPurgeConfirm}
				title={t("data_backup.manage_confirm_title", {
					defaultValue: "Remove the selected data?",
				})}
				message={
					purgeTouchesSynced
						? t("data_backup.manage_confirm_synced", {
								defaultValue:
									"This permanently removes the selected data from this device. You picked a category that cloud sync carries, so the removal can reach your other devices on the next sync. Conversations, messages and settings are not touched.",
							})
						: t("data_backup.manage_confirm_local", {
								defaultValue:
									"This permanently removes the selected data from this device. Cached media is not carried by cloud sync, so your other devices keep their own copies. Conversations, messages and settings are not touched.",
							})
				}
				confirmLabel={t("data_backup.manage_confirm_action", { defaultValue: "Remove" })}
				cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
				confirmTone="danger"
				isProcessing={isPurging}
				onConfirm={() => void handlePurge()}
				onCancel={() => setShowPurgeConfirm(false)}
			/>

		</section>
	);
}
