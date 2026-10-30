import { useEffect, useRef, useState } from "react";
import { Check, Copy, Loader2, MapPin, TriangleAlert, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import toast from "react-hot-toast";
import { estimateLocationFinderSeconds } from "../../../../utils/locationFinderSettings";

export type LocationFinderStage = "confirm" | "running" | "finished";

export type LocationFinderEvent = {
	id: number;
	tone: "info" | "success" | "error";
	text: string;
};

export type LocationFinderResult = {
	lat: number;
	lon: number;
	errorMeters: number;
};

type LocationFinderDialogProps = {
	isOpen: boolean;
	stage: LocationFinderStage;
	profileName: string;
	/** The distance the profile currently shows, for the time estimate only. */
	distanceMeters: number | null | undefined;
	events: readonly LocationFinderEvent[];
	result: LocationFinderResult | null;
	startedAt: number | null;
	onStart: () => void;
	/** Cancels before a run, hides the pop-up during one, closes it after. */
	onClose: () => void;
};

function formatClock(totalSeconds: number): string {
	const seconds = Math.max(0, Math.round(totalSeconds));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * The location finder's own pop-up: the warning before it starts, its
 * progress while it runs, and the result. Replaces the browser confirm box,
 * which the iOS app never shows (it silently answers "cancel"), and the
 * stream of toasts the finder used to report through.
 */
export function LocationFinderDialog({
	isOpen,
	stage,
	profileName,
	distanceMeters,
	events,
	result,
	startedAt,
	onStart,
	onClose,
}: LocationFinderDialogProps) {
	const { t } = useTranslation();
	const dialogRef = useRef<HTMLDialogElement | null>(null);
	const [now, setNow] = useState(() => Date.now());
	const [copied, setCopied] = useState(false);

	useEffect(() => {
		const dialog = dialogRef.current;
		if (!dialog) return;
		if (isOpen && !dialog.open) {
			try {
				dialog.showModal();
			} catch {
				dialog.show();
			}
		} else if (!isOpen && dialog.open) {
			dialog.close();
		}
	}, [isOpen]);

	useEffect(() => {
		const dialog = dialogRef.current;
		if (!dialog) return;
		const handleCancel = (event: Event) => {
			event.preventDefault();
			onClose();
		};
		dialog.addEventListener("cancel", handleCancel);
		return () => dialog.removeEventListener("cancel", handleCancel);
	}, [onClose]);

	// The elapsed clock only ticks while the pop-up is showing a run.
	useEffect(() => {
		if (!isOpen || stage !== "running") return;
		setNow(Date.now());
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, [isOpen, stage]);

	useEffect(() => {
		if (stage !== "finished") setCopied(false);
	}, [stage]);

	const estimate = estimateLocationFinderSeconds(distanceMeters);
	const estimateLabel =
		estimate == null
			? t("location_finder.duration_unknown", { defaultValue: "up to about 2 minutes" })
			: estimate < 90
				? t("location_finder.duration_seconds", {
						defaultValue: "about {{count}} seconds",
						count: Math.round(estimate / 5) * 5,
					})
				: t("location_finder.duration_minutes", {
						defaultValue: "about {{count}} minutes",
						count: Math.round((estimate / 60) * 2) / 2,
					});
	const elapsed = startedAt != null ? (now - startedAt) / 1000 : 0;
	const lastError = [...events].reverse().find((event) => event.tone === "error");
	const coordinates = result ? `${result.lat.toFixed(6)}, ${result.lon.toFixed(6)}` : "";

	const copyCoordinates = async () => {
		try {
			await navigator.clipboard.writeText(coordinates);
			setCopied(true);
		} catch {
			toast.error(t("location_finder.copy_failed", { defaultValue: "Could not copy the location." }));
		}
	};

	const secondaryButton =
		"inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 text-sm font-medium text-[var(--text-muted)] transition hover:border-[var(--accent)] hover:text-[var(--text)]";
	const primaryButton =
		"inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-[var(--accent)] bg-[var(--accent)] px-4 text-sm font-semibold text-[var(--accent-contrast)] transition hover:brightness-110";

	return (
		<dialog
			ref={dialogRef}
			className="fixed inset-0 m-auto h-fit max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md overflow-y-auto rounded-2xl border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface)_92%,black_8%)] p-0 text-[var(--text)] shadow-2xl backdrop:bg-black/50"
			onClick={(event) => {
				if (event.target === dialogRef.current && stage !== "running") onClose();
			}}
		>
			<div className="p-5">
				<div className="flex items-start justify-between gap-3">
					<div className="flex items-center gap-3">
						<span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-[color-mix(in_srgb,var(--accent)_15%,transparent)] text-[var(--accent)]">
							<MapPin className="h-5 w-5" />
						</span>
						<div className="min-w-0">
							<p className="text-base font-semibold">
								{t("location_finder.title", { defaultValue: "Location finder" })}
							</p>
							<p className="truncate text-xs text-[var(--text-muted)]">{profileName}</p>
						</div>
					</div>
					<button
						type="button"
						onClick={onClose}
						className="rounded-lg p-1.5 text-[var(--text-muted)] transition hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
						aria-label={
							stage === "running"
								? t("location_finder.hide", { defaultValue: "Hide" })
								: t("chat.actions.cancel")
						}
					>
						<X className="h-4 w-4" />
					</button>
				</div>

				{stage === "confirm" ? (
					<>
						<p className="mt-4 text-sm leading-relaxed text-[var(--text-muted)]">
							{t("location_finder.explain", {
								defaultValue:
									"Finds roughly where this person is. Your location on Grindr is moved to three points around them and their distance is measured from each one, over several rounds.",
							})}
						</p>
						<ul className="mt-3 grid gap-2 text-sm leading-relaxed">
							<li className="rounded-xl bg-[var(--surface-2)] px-3 py-2">
								{t("location_finder.duration", {
									defaultValue: "Takes {{duration}}. Your real location is put back at the end.",
									duration: estimateLabel,
								})}
							</li>
							<li className="rounded-xl bg-[var(--surface-2)] px-3 py-2">
								{t("location_finder.keep_open", {
									defaultValue:
										"Keep GrindFlop open until it finishes. If it closes early, your location is not put back.",
								})}
							</li>
							<li className="flex gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-red-400">
								<TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
								<span>
									{t("location_finder.risk", {
										defaultValue: "Moving your location over and over could get your account flagged or banned.",
									})}
								</span>
							</li>
						</ul>
						<div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
							<button type="button" onClick={onClose} className={secondaryButton}>
								{t("chat.actions.cancel")}
							</button>
							<button type="button" onClick={onStart} className={primaryButton}>
								{t("location_finder.start", { defaultValue: "Start" })}
							</button>
						</div>
					</>
				) : null}

				{stage === "running" ? (
					<>
						<div className="mt-4 flex items-center gap-3 rounded-xl bg-[var(--surface-2)] px-3 py-3">
							<Loader2 className="h-5 w-5 shrink-0 animate-spin text-[var(--accent)]" />
							<div className="min-w-0 flex-1">
								<p className="text-sm font-semibold">
									{result
										? t("location_finder.restoring", { defaultValue: "Putting your location back…" })
										: t("location_finder.running", { defaultValue: "Finding their location…" })}
								</p>
								<p className="text-xs tabular-nums text-[var(--text-muted)]">
									{t("location_finder.elapsed", {
										defaultValue: "{{elapsed}} · {{duration}} in total",
										elapsed: formatClock(elapsed),
										duration: estimateLabel,
									})}
								</p>
							</div>
						</div>
						<p className="mt-3 text-xs leading-relaxed text-[var(--text-muted)]">
							{t("location_finder.keep_open", {
								defaultValue:
									"Keep GrindFlop open until it finishes. If it closes early, your location is not put back.",
							})}
						</p>
					</>
				) : null}

				{stage === "finished" && result ? (
					<div className="mt-4 rounded-xl bg-[var(--surface-2)] px-4 py-3">
						<p className="text-xs text-[var(--text-muted)]">
							{t("location_finder.result", { defaultValue: "Approximate location" })}
						</p>
						<p className="mt-1 break-all font-mono text-base font-semibold tabular-nums">{coordinates}</p>
						<p className="mt-1 text-xs text-[var(--text-muted)]">
							{t("location_finder.accuracy", {
								defaultValue: "Within about {{error}} m",
								error: result.errorMeters,
							})}
						</p>
					</div>
				) : null}

				{stage === "finished" && !result ? (
					<div className="mt-4 flex gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-3 text-sm text-red-400">
						<TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
						<span>
							{lastError?.text ??
								t("profile_details.location_finder_error_general")}
						</span>
					</div>
				) : null}

				{stage !== "confirm" && events.length > 0 ? (
					<ol className="mt-4 grid max-h-48 gap-1.5 overflow-y-auto text-xs leading-relaxed" data-lenis-prevent>
						{events.map((event) => (
							<li
								key={event.id}
								className={
									event.tone === "error"
										? "text-red-400"
										: event.tone === "success"
											? "text-[var(--text)]"
											: "text-[var(--text-muted)]"
								}
							>
								{event.text}
							</li>
						))}
					</ol>
				) : null}

				{stage === "running" ? (
					<div className="mt-5 flex justify-end">
						<button type="button" onClick={onClose} className={secondaryButton}>
							{t("location_finder.hide", { defaultValue: "Hide" })}
						</button>
					</div>
				) : null}

				{stage === "finished" ? (
					<div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
						<button type="button" onClick={onClose} className={secondaryButton}>
							{t("location_finder.close", { defaultValue: "Close" })}
						</button>
						{result ? (
							<button type="button" onClick={() => void copyCoordinates()} className={primaryButton}>
								{copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
								{copied
									? t("location_finder.copied", { defaultValue: "Copied" })
									: t("location_finder.copy", { defaultValue: "Copy location" })}
							</button>
						) : null}
					</div>
				) : null}
			</div>
		</dialog>
	);
}
