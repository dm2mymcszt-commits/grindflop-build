import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	AlertTriangle,
	Check,
	Cloud,
	CloudOff,
	CloudUpload,
	Copy,
	EyeOff,
	HardDrive,
	KeyRound,
	Laptop,
	Loader2,
	LockKeyhole,
	LogOut,
	RefreshCw,
	ShieldCheck,
	Trash2,
} from "lucide-react";
import toast from "react-hot-toast";
import { useTranslation } from "react-i18next";
import { formatRelativeTime } from "../../utils/relativeTime";
import {
	connectGoogleDriveSync,
	disconnectGoogleDriveSyncDevice,
	exportGoogleDriveSyncPairingCode,
	getGoogleDriveSyncStatus,
	importGoogleDriveSyncPairingCode,
	resetGoogleDriveSyncCloudData,
	runGoogleDriveSyncNow,
	subscribeGoogleDriveSyncStatus,
	type GoogleDriveSyncPhase,
	type GoogleDrivePairingCode,
	type GoogleDriveSyncStatus,
} from "../../services/googleDriveSync";
import type { ContactIndexSyncScope } from "../../services/chatContactIndex";
import {
	getGoogleDriveContactScope,
	setGoogleDriveContactScope,
	subscribeGoogleDriveContactScope,
	isGoogleDriveAutoSyncPaused,
	setGoogleDriveAutoSyncPaused,
	subscribeGoogleDriveAutoSyncPaused,
} from "../../services/googleDriveSyncRuntime";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/confirm-dialog";

type SyncAction =
	| "connect"
	| "reauthorize"
	| "export-key"
	| "import-key"
	| "sync"
	| "disconnect"
	| "reset";
type Confirmation = "disconnect" | "reset" | null;

function getErrorMessage(error: unknown, fallback: string): string {
	return error instanceof Error && error.message ? error.message : fallback;
}

function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
	const units = ["B", "KB", "MB", "GB"];
	const exponent = Math.min(
		Math.floor(Math.log(bytes) / Math.log(1024)),
		units.length - 1,
	);
	const value = bytes / 1024 ** exponent;
	return `${exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`;
}

function StatusBadge({
	phase,
	pendingChanges,
}: {
	phase: GoogleDriveSyncPhase;
	pendingChanges: number;
}) {
	const { t } = useTranslation();

	const presentation = useMemo(() => {
		switch (phase) {
			case "loading":
				return {
					label: t("data_backup.drive_sync.status_loading", {
						defaultValue: "Checking",
					}),
					className: "bg-[var(--surface-2)] text-[var(--text-muted)]",
					icon: <Loader2 className="h-3 w-3 animate-spin" />,
				};
			case "connecting":
				return {
					label: t("data_backup.drive_sync.status_connecting", {
						defaultValue: "Connecting",
					}),
					className: "bg-amber-500/15 text-amber-400",
					icon: <Loader2 className="h-3 w-3 animate-spin" />,
				};
			case "pairing":
				return {
					label: t("data_backup.drive_sync.status_pairing", {
						defaultValue: "Pairing required",
					}),
					className: "bg-violet-500/15 text-violet-400",
					icon: <KeyRound className="h-3 w-3" />,
				};
			case "syncing":
				return {
					label: t("data_backup.drive_sync.status_syncing", {
						defaultValue: "Syncing",
					}),
					className: "bg-sky-500/15 text-sky-400",
					icon: <RefreshCw className="h-3 w-3 animate-spin" />,
				};
			case "paired":
				return pendingChanges > 0
					? {
							label: t("data_backup.drive_sync.status_pending", {
								defaultValue: "Changes pending",
							}),
							className: "bg-amber-500/15 text-amber-400",
							icon: <CloudUpload className="h-3 w-3" />,
						}
					: {
							label: t("data_backup.drive_sync.status_current", {
								defaultValue: "Up to date",
							}),
							className: "bg-emerald-500/15 text-emerald-400",
							icon: <Check className="h-3 w-3" />,
						};
			case "error":
				return {
					label: t("data_backup.drive_sync.status_error", {
						defaultValue: "Needs attention",
					}),
					className: "bg-red-500/15 text-red-400",
					icon: <AlertTriangle className="h-3 w-3" />,
				};
			default:
				return {
					label: t("data_backup.drive_sync.status_disconnected", {
						defaultValue: "Not connected",
					}),
					className: "bg-[var(--surface-2)] text-[var(--text-muted)]",
					icon: <CloudOff className="h-3 w-3" />,
				};
		}
	}, [pendingChanges, phase, t]);

	return (
		<span
			className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${presentation.className}`}
		>
			{presentation.icon}
			{presentation.label}
		</span>
	);
}

export function GoogleDriveSyncCard({
	id,
	profileId,
}: {
	id?: string;
	profileId: number | null;
}) {
	const { t } = useTranslation();
	const [status, setStatus] = useState<GoogleDriveSyncStatus | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const [activeAction, setActiveAction] = useState<SyncAction | null>(null);
	const [confirmation, setConfirmation] = useState<Confirmation>(null);
	const [pairingCode, setPairingCode] = useState<GoogleDrivePairingCode | null>(
		null,
	);
	const [pairingCodeInput, setPairingCodeInput] = useState("");
	const profileGenerationRef = useRef(0);
	const [autoSyncPaused, setAutoSyncPausedState] = useState(
		isGoogleDriveAutoSyncPaused,
	);

	useEffect(
		() => subscribeGoogleDriveAutoSyncPaused(setAutoSyncPausedState),
		[],
	);

	const [contactScope, setContactScopeState] = useState<ContactIndexSyncScope>(
		getGoogleDriveContactScope,
	);

	useEffect(
		() => subscribeGoogleDriveContactScope(setContactScopeState),
		[],
	);
	const actionLockRef = useRef(false);

	const refreshStatus = useCallback(async () => {
		if (profileId == null) return;
		const generation = profileGenerationRef.current;
		try {
			const next = await getGoogleDriveSyncStatus({ profileId });
			if (generation !== profileGenerationRef.current) return;
			setStatus(next);
			setLoadError(null);
		} catch (error) {
			if (generation !== profileGenerationRef.current) return;
			setLoadError(
				getErrorMessage(
					error,
					t("data_backup.drive_sync.load_failed", {
						defaultValue: "Could not read Google Drive sync status.",
					}),
				),
			);
		}
	}, [profileId, t]);

	useEffect(() => {
		profileGenerationRef.current += 1;
		setStatus(null);
		setLoadError(null);
		setActionError(null);
		setActiveAction(null);
		setConfirmation(null);
		setPairingCode(null);
		setPairingCodeInput("");
		actionLockRef.current = false;

		if (profileId == null) return;
		const generation = profileGenerationRef.current;
		const unsubscribe = subscribeGoogleDriveSyncStatus(
			{ profileId },
			(next) => {
				if (generation !== profileGenerationRef.current) return;
				setStatus(next);
				setLoadError(null);
			},
		);
		void refreshStatus();

		const handleVisibilityChange = () => {
			if (document.visibilityState === "visible") void refreshStatus();
		};
		document.addEventListener("visibilitychange", handleVisibilityChange);

		return () => {
			unsubscribe();
			document.removeEventListener("visibilitychange", handleVisibilityChange);
		};
	}, [profileId, refreshStatus]);

	useEffect(() => {
		if (status && status.vaultState !== "ready") setPairingCode(null);
	}, [status]);

	const runAction = useCallback(
		async (
			action: SyncAction,
			operation: (activeProfileId: number) => Promise<GoogleDriveSyncStatus>,
			successMessage?: string,
		) => {
			if (profileId == null || actionLockRef.current) return;
			const generation = profileGenerationRef.current;
			actionLockRef.current = true;
			setActiveAction(action);
			setActionError(null);
			try {
				const next = await operation(profileId);
				if (generation !== profileGenerationRef.current) return;
				setStatus(next);
				if (successMessage) toast.success(successMessage);
			} catch (error) {
				if (generation !== profileGenerationRef.current) return;
				const message = getErrorMessage(
					error,
					t("data_backup.drive_sync.action_failed", {
						defaultValue: "Google Drive sync could not complete that action.",
					}),
				);
				setActionError(message);
				toast.error(message);
			} finally {
				if (generation === profileGenerationRef.current) {
					actionLockRef.current = false;
					setActiveAction(null);
				}
			}
		},
		[profileId, t],
	);

	const revealPairingCode = useCallback(async () => {
		if (profileId == null || actionLockRef.current) return;
		const generation = profileGenerationRef.current;
		actionLockRef.current = true;
		setActiveAction("export-key");
		setActionError(null);
		try {
			const result = await exportGoogleDriveSyncPairingCode({ profileId });
			if (generation !== profileGenerationRef.current) return;
			setPairingCode(result);
		} catch (error) {
			if (generation !== profileGenerationRef.current) return;
			const message = getErrorMessage(
				error,
				t("data_backup.drive_sync.pairing_export_failed", {
					defaultValue: "Could not create a pairing code.",
				}),
			);
			setActionError(message);
			toast.error(message);
		} finally {
			if (generation === profileGenerationRef.current) {
				actionLockRef.current = false;
				setActiveAction(null);
			}
		}
	}, [profileId, t]);

	const copyPairingCode = useCallback(async () => {
		if (!pairingCode) return;
		try {
			await navigator.clipboard.writeText(pairingCode.pairingCode);
			toast.success(
				t("data_backup.drive_sync.pairing_copied", {
					defaultValue: "Pairing code copied. Keep it private.",
				}),
			);
		} catch {
			toast.error(
				t("data_backup.drive_sync.pairing_copy_failed", {
					defaultValue: "Could not copy the pairing code.",
				}),
			);
		}
	}, [pairingCode, t]);

	const phase: GoogleDriveSyncPhase =
		activeAction === "connect"
			? "connecting"
			: activeAction === "import-key"
				? "pairing"
				: activeAction === "sync"
					? "syncing"
					: status?.googleConnected &&
						  status.vaultState !== "ready" &&
						  status.phase !== "error"
						? "pairing"
						: (status?.phase ?? "disconnected");
	const isGoogleConnected = status?.googleConnected === true;
	const isVaultReady = status?.vaultState === "ready";
	const displayedError = actionError ?? status?.error?.message ?? loadError;
	const isBusy =
		activeAction != null || phase === "connecting" || phase === "syncing";
	// Setup actions stay available while a background catch-up runs. The
	// controller queue serializes them behind the running cycle, so they are
	// honoured in order; disabling them can strand a device that has to
	// connect or pair before it can ever stop syncing.
	const isUserActionPending = activeAction != null;
	// Nothing has been determined yet. Rendering the setup UI here claims a
	// disconnection that was never checked and offers a button that cannot work.
	// Not phase-based: a background cycle overwrites the phase with "syncing"
	// while the real status is still unread, which previously brought the whole
	// setup block back on a device that was already paired and working.
	const isStatusLoading = status != null && !status.determined;
	const syncStepLabel =
		status?.syncStep === "scanning"
			? t("data_backup.drive_sync.step_scanning", {
					defaultValue: "Scanning local changes",
				})
			: status?.syncStep === "reading"
				? t("data_backup.drive_sync.step_reading", {
						defaultValue: "Reading remote history",
					})
				: status?.syncStep === "applying"
					? t("data_backup.drive_sync.step_applying", {
							defaultValue: "Applying remote changes",
						})
					: status?.syncStep === "uploading"
						? t("data_backup.drive_sync.step_uploading", {
								defaultValue: "Uploading changes",
							})
						: null;

	const lastSyncLabel = status?.lastSuccessfulSyncAt
		? formatRelativeTime(status.lastSuccessfulSyncAt)
		: t("data_backup.drive_sync.never", { defaultValue: "Never" });

	return (
		<div id={id}>
			<p className="mb-2 px-1 text-xs font-semibold uppercase tracking-widest text-[var(--text-muted)]">
				{t("data_backup.drive_sync.section", {
					defaultValue: "Google Drive Sync",
				})}
			</p>
			<div className="surface-card overflow-hidden">
				<div className="px-4 py-4">
					<div className="flex items-start gap-3">
						<div className="shrink-0 rounded-2xl bg-sky-500/15 p-2.5 text-sky-400">
							<Cloud className="h-5 w-5" />
						</div>
						<div className="min-w-0 flex-1">
							<div className="flex flex-wrap items-center justify-between gap-2">
								<p className="text-sm font-semibold leading-snug">
									{t("data_backup.drive_sync.title", {
										defaultValue: "Keep your devices in sync",
									})}
								</p>
								<StatusBadge
									phase={phase}
									pendingChanges={status?.pendingChanges ?? 0}
								/>
							</div>
							<p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">
								{t("data_backup.drive_sync.description", {
									defaultValue:
										"Automatically exchange encrypted changes between this profile's devices. Manual exports remain available as a separate recovery backup.",
								})}
							</p>
							{syncStepLabel ? (
								<p className="mt-1.5 flex items-center gap-1.5 text-xs text-sky-400">
									<Loader2 className="h-3 w-3 shrink-0 animate-spin" />
									{syncStepLabel}
								</p>
							) : null}
						</div>
					</div>

					{(status == null || isStatusLoading) && !displayedError ? (
						<div className="flex items-center justify-center gap-2 py-7 text-sm text-[var(--text-muted)]">
							<Loader2 className="h-4 w-4 animate-spin" />
							{t("data_backup.drive_sync.loading", {
								defaultValue: "Checking sync status…",
							})}
						</div>
					) : null}

					{displayedError ? (
						<div className="mt-4 flex items-start gap-2.5 rounded-xl border border-red-500/25 bg-red-500/10 p-3 text-red-300">
							<AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
							<p className="min-w-0 text-xs leading-relaxed">
								{displayedError}
							</p>
						</div>
					) : null}

					{status && !status.available && !isStatusLoading ? (
						<div className="mt-4 flex items-start gap-2.5 rounded-xl bg-[var(--surface-2)] p-3">
							<HardDrive className="mt-0.5 h-4 w-4 shrink-0 text-[var(--text-muted)]" />
							<p className="text-xs leading-relaxed text-[var(--text-muted)]">
								{status.unavailableReason ??
									t("data_backup.drive_sync.unavailable", {
										defaultValue:
											"Google Drive sync is not available in this build yet.",
									})}
							</p>
						</div>
					) : null}

					{status && isVaultReady ? (
						<div className="mt-4 grid gap-3">
							<div className="grid gap-2 rounded-xl bg-[var(--surface-2)] p-3 sm:grid-cols-2">
								<div className="min-w-0">
									<p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
										{t("data_backup.drive_sync.account", {
											defaultValue: "Google account",
										})}
									</p>
									<p className="mt-1 truncate text-xs font-medium text-[var(--text)]">
										{status.googleAccountEmail ??
											t("data_backup.drive_sync.connected", {
												defaultValue: "Connected",
											})}
									</p>
								</div>
								<div className="min-w-0">
									<p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
										{t("data_backup.drive_sync.last_sync", {
											defaultValue: "Last successful sync",
										})}
									</p>
									<p className="mt-1 text-xs font-medium text-[var(--text)]">
										{lastSyncLabel}
									</p>
								</div>
								{status.deviceName ? (
									<div className="flex min-w-0 items-center gap-1.5 text-xs text-[var(--text-muted)] sm:col-span-2">
										<Laptop className="h-3.5 w-3.5 shrink-0" />
										<span className="truncate">{status.deviceName}</span>
									</div>
								) : null}
								{status.vaultFingerprint ? (
									<div className="flex min-w-0 items-center gap-1.5 text-xs text-[var(--text-muted)] sm:col-span-2">
										<LockKeyhole className="h-3.5 w-3.5 shrink-0" />
										<span className="truncate">
											{t("data_backup.drive_sync.vault_fingerprint", {
												defaultValue: "Vault ID: {{fingerprint}}",
												fingerprint: status.vaultFingerprint,
											})}
										</span>
									</div>
								) : null}
								{status.pendingChanges > 0 ? (
									<p className="text-xs text-amber-400 sm:col-span-2">
										{t("data_backup.drive_sync.pending_summary", {
											defaultValue: "{{count}} pending changes · {{size}}",
											count: status.pendingChanges,
											size: formatBytes(status.pendingBytes),
										})}
									</p>
								) : null}
							</div>

							<div className="overflow-hidden rounded-xl border border-[var(--border)]">
								<div className="flex items-start gap-3 px-4 py-3.5">
									<div className="mt-0.5 rounded-full bg-emerald-500/15 p-1 text-emerald-400">
										<Check className="h-3.5 w-3.5" />
									</div>
									<div className="min-w-0 flex-1">
										<p className="text-sm font-medium">
											{t("data_backup.drive_sync.core", {
												defaultValue: "Core data",
											})}
										</p>
										<p className="mt-0.5 text-xs leading-relaxed text-[var(--text-muted)]">
											{t("data_backup.drive_sync.core_desc", {
												defaultValue:
													"Chats, settings, rules, saved items, profile index and viewed-me history. Always on while sync is connected.",
											})}
										</p>
									</div>
									<span className="mt-0.5 shrink-0 rounded-full bg-emerald-500/15 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-emerald-400">
										{t("data_backup.drive_sync.always_on", {
											defaultValue: "Always on",
										})}
									</span>
								</div>
							</div>

							<div className="rounded-xl border border-[var(--border)] p-3">
								<div className="flex items-start gap-2.5">
									<KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-violet-400" />
									<div className="min-w-0 flex-1">
										<p className="text-sm font-medium">
											{t("data_backup.drive_sync.pair_another", {
												defaultValue: "Pair another device",
											})}
										</p>
										<p className="mt-0.5 text-xs leading-relaxed text-[var(--text-muted)]">
											{t("data_backup.drive_sync.pair_another_desc", {
												defaultValue:
													"Reveal the encrypted vault's pairing code, then enter it on your other device. Anyone with this code can decrypt your synced data.",
											})}
										</p>
									</div>
								</div>

								{pairingCode ? (
									<div className="mt-3 grid gap-2">
										<textarea
											readOnly
											value={pairingCode.pairingCode}
											aria-label={t("data_backup.drive_sync.pairing_code", {
												defaultValue: "Pairing code",
											})}
											className="min-h-20 w-full resize-none rounded-lg border border-violet-500/30 bg-[var(--surface-2)] px-3 py-2 font-mono text-xs leading-relaxed text-[var(--text)] outline-none focus:border-violet-400"
										/>
										<p className="text-[11px] leading-relaxed text-amber-400">
											{t("data_backup.drive_sync.pairing_secret", {
												defaultValue:
													"Keep this code private. Hide it as soon as the other device is paired.",
											})}
										</p>
										{pairingCode.fingerprint ? (
											<p className="font-mono text-[11px] text-[var(--text-muted)]">
												{t("data_backup.drive_sync.vault_fingerprint", {
													defaultValue: "Vault ID: {{fingerprint}}",
													fingerprint: pairingCode.fingerprint,
												})}
											</p>
										) : null}
										<div className="grid grid-cols-2 gap-2">
											<Button
												variant="secondary"
												size="sm"
												leftIcon={<Copy className="h-4 w-4" />}
												onClick={() => void copyPairingCode()}
											>
												{t("data_backup.drive_sync.copy_pairing", {
													defaultValue: "Copy code",
												})}
											</Button>
											<Button
												variant="ghost"
												size="sm"
												leftIcon={<EyeOff className="h-4 w-4" />}
												onClick={() => setPairingCode(null)}
											>
												{t("data_backup.drive_sync.hide_pairing", {
													defaultValue: "Hide code",
												})}
											</Button>
										</div>
									</div>
								) : (
									<Button
										variant="secondary"
										size="sm"
										className="mt-3 w-full"
										loading={activeAction === "export-key"}
										// A background catch-up must not lock pairing out. The
										// controller queue serializes this behind the running
										// cycle, so the click is honoured as soon as it ends.
										disabled={activeAction != null || phase === "connecting"}
										leftIcon={<KeyRound className="h-4 w-4" />}
										onClick={() => void revealPairingCode()}
									>
										{t("data_backup.drive_sync.reveal_pairing", {
											defaultValue: "Reveal pairing code",
										})}
									</Button>
								)}
							</div>

							<div className="rounded-xl border border-[var(--border)] p-3">
								<p className="text-sm font-medium">
									{t("data_backup.drive_sync.contact_scope", {
										defaultValue: "Profile index to sync",
									})}
								</p>
								<p className="mt-0.5 text-xs leading-relaxed text-[var(--text-muted)]">
									{t("data_backup.drive_sync.contact_scope_desc", {
										defaultValue:
											"Most of this index is profiles you only browsed past. Syncing just your conversations keeps phones fast; widen it if you want your browsing history on every device.",
									})}
								</p>
								<select
									value={contactScope}
									onChange={(event) =>
										setGoogleDriveContactScope(
											event.target.value as ContactIndexSyncScope,
										)
									}
									className="mt-2.5 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-violet-400"
								>
									<option value="conversations">
										{t("data_backup.drive_sync.contact_scope_conversations", {
											defaultValue: "Conversations only (recommended)",
										})}
									</option>
									<option value="conversations-and-recent">
										{t("data_backup.drive_sync.contact_scope_recent", {
											defaultValue: "Conversations and the last 7 days",
										})}
									</option>
									<option value="everything">
										{t("data_backup.drive_sync.contact_scope_everything", {
											defaultValue: "Every profile ever seen (slow on phones)",
										})}
									</option>
								</select>
							</div>

							<label className="flex items-start gap-3 rounded-xl border border-[var(--border)] p-3">
								<input
									type="checkbox"
									className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]"
									checked={autoSyncPaused}
									onChange={(event) =>
										setGoogleDriveAutoSyncPaused(event.target.checked)
									}
								/>
								<span className="min-w-0 flex-1">
									<span className="block text-sm font-medium">
										{t("data_backup.drive_sync.pause_auto", {
											defaultValue: "Pause automatic sync",
										})}
									</span>
									<span className="mt-0.5 block text-xs leading-relaxed text-[var(--text-muted)]">
										{t("data_backup.drive_sync.pause_auto_desc", {
											defaultValue:
												"Stops background catch-up on this device so pairing and Sync now respond immediately. Nothing is lost; changes are still queued and sent on the next sync.",
										})}
									</span>
								</span>
							</label>

							<Button
								variant="primary"
								className="w-full rounded-full"
								loading={activeAction === "sync" || phase === "syncing"}
								disabled={isBusy}
								leftIcon={<RefreshCw className="h-4 w-4" />}
								onClick={() =>
									void runAction("sync", (activeProfileId) =>
										runGoogleDriveSyncNow({ profileId: activeProfileId }),
									)
								}
							>
								{t("data_backup.drive_sync.sync_now", {
									defaultValue: "Sync now",
								})}
							</Button>

							<div className="grid gap-2 sm:grid-cols-2">
								<Button
									variant="secondary"
									size="sm"
									disabled={isBusy}
									leftIcon={<LogOut className="h-4 w-4" />}
									onClick={() => setConfirmation("disconnect")}
								>
									{t("data_backup.drive_sync.disconnect_device", {
										defaultValue: "Disconnect this device",
									})}
								</Button>
								<Button
									variant="danger"
									size="sm"
									disabled={isBusy}
									leftIcon={<Trash2 className="h-4 w-4" />}
									onClick={() => setConfirmation("reset")}
								>
									{t("data_backup.drive_sync.reset_cloud", {
										defaultValue: "Delete cloud sync data",
									})}
								</Button>
							</div>
						</div>
					) : null}

					{status && isGoogleConnected && !isVaultReady ? (
						<div className="mt-4 grid gap-3">
							<div className="rounded-xl bg-[var(--surface-2)] p-3">
								<div className="flex items-start gap-2.5">
									<KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-violet-400" />
									<div className="min-w-0 flex-1">
										<p className="text-sm font-medium">
											{t("data_backup.drive_sync.unlock_vault", {
												defaultValue: "Pair this device",
											})}
										</p>
										<p className="mt-0.5 text-xs leading-relaxed text-[var(--text-muted)]">
											{t("data_backup.drive_sync.unlock_vault_desc", {
												defaultValue:
													"Google is connected, but this device does not have the encryption key. Reveal the pairing code on your already-paired laptop and paste it here.",
											})}
										</p>
										{status.googleAccountEmail ? (
											<p className="mt-2 truncate text-xs font-medium text-[var(--text)]">
												{status.googleAccountEmail}
											</p>
										) : null}
									</div>
								</div>
							</div>

							<textarea
								value={pairingCodeInput}
								onChange={(event) => setPairingCodeInput(event.target.value)}
								placeholder={t("data_backup.drive_sync.pairing_placeholder", {
									defaultValue: "Paste pairing code",
								})}
								aria-label={t("data_backup.drive_sync.pairing_code", {
									defaultValue: "Pairing code",
								})}
								autoCapitalize="none"
								autoComplete="off"
								autoCorrect="off"
								spellCheck={false}
								className="min-h-24 w-full resize-none rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 font-mono text-xs leading-relaxed text-[var(--text)] outline-none transition focus:border-violet-400 focus:ring-2 focus:ring-violet-500/20"
							/>
							<Button
								variant="primary"
								className="w-full rounded-full"
								loading={activeAction === "import-key"}
								disabled={
									pairingCodeInput.trim().length === 0 || isUserActionPending
								}
								leftIcon={<KeyRound className="h-4 w-4" />}
								onClick={() => {
									const code = pairingCodeInput.trim();
									void runAction(
										"import-key",
										async (activeProfileId) => {
											const next = await importGoogleDriveSyncPairingCode({
												profileId: activeProfileId,
												pairingCode: code,
											});
											if (next.vaultState === "ready") setPairingCodeInput("");
											return next;
										},
										t("data_backup.drive_sync.paired_success", {
											defaultValue: "This device is now paired.",
										}),
									);
								}}
							>
								{t("data_backup.drive_sync.import_pairing", {
									defaultValue: "Pair this device",
								})}
							</Button>
							<Button
								variant="ghost"
								size="sm"
								disabled={isBusy}
								leftIcon={<LogOut className="h-4 w-4" />}
								onClick={() => setConfirmation("disconnect")}
							>
								{t("data_backup.drive_sync.disconnect_device", {
									defaultValue: "Disconnect this device",
								})}
							</Button>
						</div>
					) : null}

					{status && isGoogleConnected ? (
						<div className="mt-4 grid gap-2 rounded-xl border border-[var(--border)] p-3">
							<p className="text-xs leading-relaxed text-[var(--text-muted)]">
								{t("data_backup.drive_sync.reauthorize_desc", {
									defaultValue:
										"If Google asks you to sign in again, refresh the connection here. Your encryption key and encrypted vault stay unchanged.",
								})}
							</p>
							<Button
								variant="secondary"
								size="sm"
								loading={activeAction === "reauthorize"}
								disabled={!status.available || isUserActionPending}
								leftIcon={<Cloud className="h-4 w-4" />}
								onClick={() =>
									void runAction(
										"reauthorize",
										(activeProfileId) =>
											connectGoogleDriveSync({ profileId: activeProfileId }),
										t("data_backup.drive_sync.reauthorized_success", {
											defaultValue:
												"Google Drive sign-in was refreshed. Your encrypted vault was kept.",
										}),
									)
								}
							>
								{t("data_backup.drive_sync.reauthorize", {
									defaultValue: "Refresh Google sign-in",
								})}
							</Button>
						</div>
					) : null}

					{status && !isGoogleConnected && !isStatusLoading ? (
						<div className="mt-4 grid gap-3">
							<div className="grid gap-2 rounded-xl bg-[var(--surface-2)] p-3">
								<div className="flex items-start gap-2.5">
									<LockKeyhole className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
									<p className="text-xs leading-relaxed text-[var(--text-muted)]">
										{t("data_backup.drive_sync.encryption", {
											defaultValue:
												"Your laptop creates an end-to-end encrypted vault. Pair another device once with a private pairing code; Google cannot read the contents.",
										})}
									</p>
								</div>
								<div className="flex items-start gap-2.5">
									<ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-sky-400" />
									<p className="text-xs leading-relaxed text-[var(--text-muted)]">
										{t("data_backup.drive_sync.backup_first", {
											defaultValue:
												"Make a fresh manual backup before the first connection. Sync complements backups; it does not replace them.",
										})}
									</p>
								</div>
							</div>
							<Button
								variant="primary"
								className="w-full rounded-full"
								loading={activeAction === "connect" || phase === "connecting"}
								disabled={!status.available || isUserActionPending}
								leftIcon={<Cloud className="h-4 w-4" />}
								onClick={() =>
									void runAction("connect", (activeProfileId) =>
										connectGoogleDriveSync({ profileId: activeProfileId }),
									)
								}
							>
								{status.error?.requiresReauthentication
									? t("data_backup.drive_sync.reconnect", {
											defaultValue: "Reconnect Google Drive",
										})
									: t("data_backup.drive_sync.connect", {
											defaultValue: "Connect Google Drive",
										})}
							</Button>
						</div>
					) : null}
				</div>

				<div className="flex items-start gap-2.5 border-t border-[var(--border)] px-4 py-3">
					<CloudOff className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
					<p className="text-xs leading-relaxed text-[var(--text-muted)]">
						{t("data_backup.drive_sync.ios_note", {
							defaultValue:
								"On iPhone, catch-up starts the next time GrindFlop opens. iOS stops background sync after you swipe the app away.",
						})}
					</p>
				</div>
			</div>

			<ConfirmDialog
				isOpen={confirmation === "disconnect"}
				title={t("data_backup.drive_sync.disconnect_title", {
					defaultValue: "Disconnect this device?",
				})}
				message={t("data_backup.drive_sync.disconnect_message", {
					defaultValue:
						"This removes the Google connection and encryption key from this device. Your local GrindFlop data and encrypted cloud files stay intact. If this is the last paired device and you have not safely retained a pairing code, the cloud vault will become permanently unreadable.",
				})}
				confirmLabel={t("data_backup.drive_sync.disconnect_confirm", {
					defaultValue: "Disconnect device",
				})}
				cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
				isProcessing={activeAction === "disconnect"}
				onConfirm={async () => {
					await runAction(
						"disconnect",
						(activeProfileId) =>
							disconnectGoogleDriveSyncDevice({ profileId: activeProfileId }),
						t("data_backup.drive_sync.disconnected_success", {
							defaultValue: "This device was disconnected.",
						}),
					);
					setConfirmation(null);
				}}
				onCancel={() => setConfirmation(null)}
			/>

			<ConfirmDialog
				isOpen={confirmation === "reset"}
				title={t("data_backup.drive_sync.reset_title", {
					defaultValue: "Delete cloud sync data?",
				})}
				message={t("data_backup.drive_sync.reset_message", {
					defaultValue:
						"Close or disconnect GrindFlop on every other paired device first. The app deletes the encrypted files it can verify and checks that the vault stays empty. If another device keeps uploading, deletion stops and this device keeps its key so you can retry. Local data is never erased.",
				})}
				confirmLabel={t("data_backup.drive_sync.reset_confirm", {
					defaultValue: "Delete cloud data",
				})}
				cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
				confirmTone="danger"
				isProcessing={activeAction === "reset"}
				onConfirm={async () => {
					await runAction(
						"reset",
						(activeProfileId) =>
							resetGoogleDriveSyncCloudData({ profileId: activeProfileId }),
						t("data_backup.drive_sync.reset_success", {
							defaultValue:
								"No sync-vault files remained after verification. This device was disconnected and local data was not changed. Keep other paired devices closed until they are reset or paired to a new vault.",
						}),
					);
					setConfirmation(null);
				}}
				onCancel={() => setConfirmation(null)}
			/>
		</div>
	);
}
