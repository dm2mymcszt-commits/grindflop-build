import { type CSSProperties, useRef, useState } from "react";
import {
	Clock3,
	CloudOff,
	Download,
	EyeOff,
	HardDriveDownload,
	MessageCircle,
	RotateCw,
	Trash2,
	UserRound,
	X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import toast from "react-hot-toast";
import { AlbumMediaTile } from "../../../components/AlbumMediaTile";
import { ShowAnywayButton } from "../../../components/ui/ShowAnywayButton";
import { Button } from "../../../components/ui/button";
import { ProfileImage } from "../../../components/ui/profile-image";
import { saveMediaBatch } from "../../../services/saveMedia";
import { appLog } from "../../../utils/logger";
import { cn } from "../../../utils/cn";
import type { AlbumViewer } from "../../../types/shared-albums";
import { formatAlbumCounts, formatTimeLeft } from "./albumFormat";

type AlbumViewerPanelProps = {
	viewer: AlbumViewer;
	avatarUrl: string | null;
	coverUrl: string | null;
	fullScreenIndex: number | null;
	closeViewer: () => void;
	openFullScreen: (index: number) => void;
	/** Puts the items the explicit-photo filter is holding back on show, for this album. */
	onShowHidden: () => void;
	onRetry: () => void;
	onDelete: () => void;
	onMessageProfile: (profileId: number) => void;
	onViewProfile: (profileId: number) => void;
};

/** How long the closing animation runs before the viewer unmounts. */
const CLOSE_MS = 220;

export function AlbumViewerPanel({
	viewer,
	avatarUrl,
	coverUrl,
	fullScreenIndex,
	closeViewer,
	openFullScreen,
	onShowHidden,
	onRetry,
	onDelete,
	onMessageProfile,
	onViewProfile,
}: AlbumViewerPanelProps) {
	const { t } = useTranslation();
	const [isSavingAll, setIsSavingAll] = useState(false);
	const [isClosing, setIsClosing] = useState(false);
	const isClosingRef = useRef(false);
	const { item, content, status } = viewer;

	const handleClose = () => {
		if (isClosingRef.current) return;
		isClosingRef.current = true;
		setIsClosing(true);
		setTimeout(() => closeViewer(), CLOSE_MS);
	};

	const handleSaveAll = async () => {
		const items = content
			// A hidden item's link is the hidden tile, not the item.
			.filter((entry) => !entry.hidden)
			.map((entry) => ({
				url: entry.url || entry.coverUrl || "",
				type: (entry.contentType?.startsWith("video/") ? "video" : "image") as "image" | "video",
			}))
			.filter((entry) => !!entry.url);

		if (items.length === 0) {
			toast.error(t("profile_details.save_all_empty"));
			return;
		}

		setIsSavingAll(true);
		const toastId = toast.loading(
			t("profile_details.save_all_progress", { done: 0, total: items.length }),
		);
		try {
			const result = await saveMediaBatch(items, (done, total) => {
				toast.loading(t("profile_details.save_all_progress", { done, total }), { id: toastId });
			}, item.conversationId);

			if (result.failed === 0) {
				toast.success(t("profile_details.save_all_success", { count: result.succeeded }), {
					id: toastId,
				});
			} else {
				toast.error(
					t("profile_details.save_all_partial", {
						succeeded: result.succeeded,
						total: result.total,
						failed: result.failed,
					}),
					{ id: toastId },
				);
			}
		} catch (error) {
			appLog.error("[AlbumViewerPanel] Save all failed", error);
			toast.error(t("profile_details.save_all_error"), { id: toastId });
		} finally {
			setIsSavingAll(false);
		}
	};

	const counts =
		status === "ready"
			? {
					images: content.filter((entry) => !entry.contentType?.startsWith("video/")).length,
					videos: content.filter((entry) => entry.contentType?.startsWith("video/")).length,
				}
			: { images: item.album.contentCount.imageCount, videos: item.album.contentCount.videoCount };
	const countsLabel = formatAlbumCounts(t, counts.images, counts.videos);
	const subtitle = [
		viewer.albumName?.trim() || null,
		item.totalAlbumsShared && item.totalAlbumsShared > 1
			? t("shared_albums.album_position", { number: item.albumNumber, total: item.totalAlbumsShared })
			: null,
		countsLabel,
	]
		.filter(Boolean)
		.join(" · ");
	const timeLeft = !item.localOnly ? formatTimeLeft(t, item.expiresAt) : null;
	const skeletonCount = Math.min(
		Math.max(item.album.contentCount.imageCount + item.album.contentCount.videoCount, item.savedCount, 3),
		12,
	);

	return (
		<div
			className={cn(
				"fixed inset-0 z-[55] flex items-stretch justify-center no-touch-callout isolate md:items-center md:px-6 md:pb-6 md:pt-[calc(var(--titlebar-height,0px)+24px)]",
				isClosing && "pointer-events-none",
			)}
		>
			<div
				className={cn(
					"absolute inset-0 bg-black/60 backdrop-blur-sm",
					isClosing ? "animate-backdrop-out" : "animate-backdrop-in",
				)}
				onClick={handleClose}
			/>

			<div
				role="dialog"
				aria-modal="true"
				aria-label={item.profileName}
				className={cn(
					"relative flex h-full w-full flex-col overflow-hidden bg-[var(--bg)] md:h-auto md:max-h-full md:max-w-3xl md:rounded-[28px] md:border md:border-[var(--border)] md:shadow-[0_32px_80px_rgba(0,0,0,0.5)]",
					isClosing ? "album-panel-out" : "album-panel-in",
				)}
				onClick={(event) => event.stopPropagation()}
			>
				{/* Ambient backdrop: the album's own cover, heavily blurred. Faded
				    out with a mask: a gradient to the page colour drawn over it
				    left a seam where the blur met the edge. */}
				<div
					className="pointer-events-none absolute inset-x-0 top-0 h-60 overflow-hidden"
					style={{
						maskImage: "linear-gradient(to bottom, black 0%, black 25%, transparent 100%)",
						WebkitMaskImage: "linear-gradient(to bottom, black 0%, black 25%, transparent 100%)",
					}}
					aria-hidden
				>
					{coverUrl ? (
						<img
							src={coverUrl}
							alt=""
							className="h-full w-full scale-125 object-cover opacity-40 blur-3xl"
						/>
					) : (
						<div className="h-full w-full bg-[radial-gradient(ellipse_at_top,color-mix(in_srgb,var(--accent)_24%,transparent),transparent_70%)]" />
					)}
				</div>

				{/* Header */}
				<header className="relative shrink-0 px-4 pb-4 pt-[calc(env(safe-area-inset-top,0px)+14px)] md:px-6 md:pt-6">
					<div className="flex items-start gap-3">
						<div className="relative shrink-0">
							<div className="h-12 w-12 overflow-hidden rounded-full ring-2 ring-white/15 md:h-14 md:w-14">
								<ProfileImage src={avatarUrl} alt={item.profileName} loading="eager" />
							</div>
							{item.isOnline ? (
								<span className="absolute bottom-0.5 right-0.5 h-3 w-3 rounded-full bg-emerald-400 ring-2 ring-[var(--bg)]" />
							) : null}
						</div>

						<div className="min-w-0 flex-1 pt-0.5">
							<h2 className="truncate text-lg font-bold leading-tight tracking-tight text-[var(--text)] md:text-xl">
								{item.profileName}
							</h2>
							<p className="mt-1 truncate text-[13px] text-[var(--text-muted)]">{subtitle}</p>
							{timeLeft || item.localOnly || viewer.isSavedCopy ? (
								<div className="mt-2 flex flex-wrap gap-1.5">
									{timeLeft ? (
										<span className="inline-flex items-center gap-1 rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-[11px] font-semibold text-[var(--text-muted)]">
											<Clock3 className="h-3 w-3" />
											{timeLeft}
										</span>
									) : null}
									{item.localOnly || viewer.isSavedCopy ? (
										<span className="inline-flex items-center gap-1 rounded-full bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] px-2 py-0.5 text-[11px] font-semibold text-[var(--accent-readable)]">
											<HardDriveDownload className="h-3 w-3" />
											{t("shared_albums.saved_copy_badge")}
										</span>
									) : null}
								</div>
							) : null}
						</div>

						<div className="flex shrink-0 items-center gap-1.5">
							{status === "ready" && content.length > 0 ? (
								<button
									type="button"
									onClick={() => void handleSaveAll()}
									disabled={isSavingAll}
									aria-label={t("profile_details.save_all")}
									title={t("profile_details.save_all")}
									className="inline-flex h-10 items-center gap-1.5 rounded-full bg-[color-mix(in_srgb,var(--surface-2)_85%,transparent)] px-3 text-sm font-semibold text-[var(--text)] backdrop-blur-md transition hover:bg-[var(--surface-2)] active:scale-95 disabled:opacity-50"
								>
									<Download className="h-4 w-4" />
									<span className="hidden sm:inline">{t("profile_details.save_all")}</span>
								</button>
							) : null}
							<button
								type="button"
								onClick={handleClose}
								aria-label={t("shared_albums.close_viewer")}
								className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--surface-2)_85%,transparent)] text-[var(--text)] backdrop-blur-md transition hover:bg-[var(--surface-2)] active:scale-95"
							>
								<X className="h-5 w-5" />
							</button>
						</div>
					</div>

					{viewer.isSavedCopy && !item.localOnly ? (
						<p className="mt-3 rounded-2xl bg-[var(--surface)] px-3 py-2 text-xs leading-relaxed text-[var(--text-muted)] ring-1 ring-inset ring-[var(--border)]">
							{t("shared_albums.saved_copy_note")}
						</p>
					) : null}

					{(viewer.hiddenCount ?? 0) > 0 ? (
						<div className="mt-3 flex items-center gap-2 rounded-2xl bg-[var(--surface)] px-3 py-2 text-xs leading-relaxed text-[var(--text-muted)] ring-1 ring-inset ring-[var(--border)]">
							<EyeOff className="h-3.5 w-3.5 shrink-0" />
							<span className="min-w-0 flex-1">
								{t("shared_albums.hidden_by_filter", {
									defaultValue: "{{count}} hidden: explicit, or not checked yet.",
									count: viewer.hiddenCount,
								})}
							</span>
							<ShowAnywayButton onShow={onShowHidden} />
						</div>
					) : null}
				</header>

				{/* Body */}
				<div className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain" data-lenis-prevent>
					{status === "error" ? (
						<div className="flex min-h-[280px] flex-col items-center justify-center gap-3 px-6 py-10 text-center">
							<div className="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--surface-2)] text-[var(--text-muted)]">
								<CloudOff className="h-6 w-6" />
							</div>
							<div className="max-w-sm">
								<p className="text-base font-semibold text-[var(--text)]">
									{t("shared_albums.error_open_title")}
								</p>
								<p className="mt-1 text-sm leading-relaxed text-[var(--text-muted)]">{viewer.error}</p>
							</div>
							<div className="mt-2 flex flex-wrap justify-center gap-2">
								<Button type="button" variant="secondary" size="sm" onClick={onRetry} className="gap-1.5">
									<RotateCw className="h-4 w-4" />
									{t("shared_albums.retry")}
								</Button>
								<Button type="button" variant="danger" size="sm" onClick={onDelete} className="gap-1.5">
									<Trash2 className="h-4 w-4" />
									{t("shared_albums.remove_from_list")}
								</Button>
							</div>
						</div>
					) : status === "ready" && content.length === 0 ? (
						<div className="flex min-h-[240px] flex-col items-center justify-center gap-1 px-6 py-10 text-center">
							<p className="text-base font-semibold text-[var(--text)]">{t("shared_albums.empty_album_title")}</p>
							<p className="text-sm text-[var(--text-muted)]">{t("shared_albums.empty_album_desc")}</p>
						</div>
					) : (
						<div className="grid grid-cols-3 gap-1.5 px-3 pb-4 sm:grid-cols-4 md:gap-2 md:px-6 md:pb-6">
							{status === "loading"
								? Array.from({ length: skeletonCount }, (_, index) => (
										<div
											key={index}
											className="aspect-[3/4] animate-pulse rounded-xl bg-[var(--surface-2)] md:rounded-2xl"
										/>
									))
								: content.map((entry, index) => (
										<button
											key={entry.contentId}
											type="button"
											aria-label={t("shared_albums.content_alt", { index: index + 1 })}
											onClick={() => openFullScreen(index)}
											style={{ "--tile-delay": `${Math.min(index, 16) * 28}ms` } as CSSProperties}
											className={cn(
												"album-tile-in group relative aspect-[3/4] overflow-hidden rounded-xl bg-[var(--surface-2)] outline-none transition-transform duration-200 active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-[var(--accent)] md:rounded-2xl",
												index === fullScreenIndex && "ring-2 ring-[var(--accent)]",
											)}
										>
											<div className="h-full w-full transition-transform duration-300 ease-out group-hover:scale-[1.04]">
												<AlbumMediaTile item={entry} />
											</div>
											<div className="pointer-events-none absolute inset-0 rounded-[inherit] ring-1 ring-inset ring-white/10 transition-colors duration-200 group-hover:bg-white/5" />
										</button>
									))}
						</div>
					)}
				</div>

				{/* Footer */}
				<footer
					className="relative shrink-0 border-t border-[var(--border)] bg-[color-mix(in_srgb,var(--bg)_92%,transparent)] px-4 pt-3 md:flex md:justify-end md:px-6 md:pb-4"
					style={{ paddingBottom: "max(12px, env(safe-area-inset-bottom, 0px))" }}
				>
					<div className="flex gap-2 md:w-auto">
						<Button
							type="button"
							variant="secondary"
							onClick={() => onViewProfile(item.profileId)}
							className="flex-1 gap-1.5 md:flex-none md:px-5"
						>
							<UserRound className="h-4 w-4" />
							{t("chat.view_profile")}
						</Button>
						<Button
							type="button"
							variant="primary"
							onClick={() => onMessageProfile(item.profileId)}
							className="flex-1 gap-1.5 font-semibold md:flex-none md:px-5"
						>
							<MessageCircle className="h-4 w-4" />
							{t("profile_details.message")}
						</Button>
					</div>
				</footer>
			</div>
		</div>
	);
}
