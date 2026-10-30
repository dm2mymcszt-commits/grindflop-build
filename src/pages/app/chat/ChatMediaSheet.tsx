import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, CircleCheck, Download, EyeOff, Images, LayoutGrid, Loader2, Play, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import toast from "react-hot-toast";
import { ProfileImage } from "../../../components/ui/profile-image";
import { BottomSheet, SheetClose } from "../../../components/ui/bottom-sheet";
import { PhotoViewer, type PhotoViewerMedia } from "../../../components/PhotoViewer";
import { useApiFunctions } from "../../../hooks/useApiFunctions";
import { useContentChecks } from "../../../hooks/useContentChecks";
import { getAlbumCover } from "../../../services/albumContentCheck";
import { ShowAnywayButton } from "../../../components/ui/ShowAnywayButton";
import { HIDDEN_MEDIA_PLACEHOLDER } from "../../../utils/hiddenMediaPlaceholder";
import {
	checkMediaBytes,
	getCachedCheckForMediaKey,
	getCachedCheckForMessage,
	isExplicitGalleryHidingEnabled,
	verdictOf,
} from "../../../services/contentCheck";
import { saveMediaBytesBatch } from "../../../services/saveMedia";
import { fetchAndEncode, toDataUri } from "../../../services/mediaStore";
import { captureAlbum, getLocalAlbum } from "../../../services/albumStore";
import * as chatDb from "../../../services/chatDb";
import { extractImageHashFromSignedUrl } from "./chatUtils";
import type { MediaSelectionItem } from "./mediaSelection";
import { appLog } from "../../../utils/logger";

const IMAGE_HASH_KEY_PREFIX = "image:hash:";

/**
 * Content fingerprint for de-duping the local/live merge below. A local
 * image captured via the chat-message flow can end up keyed by mediaId or
 * messageId instead of a hash (whenever getMessageImageHash/
 * extractImageHashFromSignedUrl couldn't derive one at capture time) — so
 * the URL-hash check alone can miss real duplicates. Hashing the actual
 * base64 content is key-scheme-independent and always catches them.
 */
async function hashBase64(base64: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(base64));
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

type Tab = "albums" | "media";

type SharedAlbum = {
	albumId: number;
	albumName: string | null;
	coverUrl: string | null;
	contentCount: { imageCount: number; videoCount: number };
};

type LocalMediaItem = {
	mediaKey: string;
	/** The message it came in, when the app saved it from the chat. */
	messageId: string | null;
	kind: "image" | "video";
	dataUri: string;
	mimeType: string | null;
	base64: string;
	/** Held back by the explicit-photo filter: `dataUri` is the hidden tile, not the item. */
	hidden?: boolean;
};

type Props = {
	conversationId: string;
	senderProfileId: string | null;
	userId: number | null;
	isDesktop: boolean;
	senderPhotoUrl?: string | null;
	onClose: () => void;
	openAlbumViewerById: (albumId: number) => void | Promise<void>;
	openFullScreenImage: (imageUrl: string) => void;
	onSaveMediaItems: (items: readonly MediaSelectionItem[]) => Promise<void>;
	/** Resolves with the message ids that were deleted. */
	onDeleteMediaItems: (items: readonly MediaSelectionItem[]) => Promise<string[]>;
};

export function ChatMediaSheet({
	conversationId,
	senderProfileId,
	userId,
	isDesktop,
	senderPhotoUrl,
	onClose,
	openAlbumViewerById,
	onSaveMediaItems,
	onDeleteMediaItems,
}: Props) {
	const { t } = useTranslation();
	const service = useApiFunctions();
	const [tab, setTab] = useState<Tab>("media");
	const [albums, setAlbums] = useState<SharedAlbum[]>([]);
	const [albumsLoading, setAlbumsLoading] = useState(true);
	// Everything saved from this chat. What is shown is `media` below.
	const [allMedia, setAllMedia] = useState<LocalMediaItem[]>([]);
	const explicitFilterOn = useContentChecks();
	// Who sent each saved message, to tell this account's own photos apart.
	// Null until read: until then nothing is known to be this account's own.
	const [senderByMessageId, setSenderByMessageId] = useState<ReadonlyMap<string, string> | null>(null);
	const [mediaLoading, setMediaLoading] = useState(true);
	const [failedCovers, setFailedCovers] = useState<Set<number>>(new Set());
	const [viewerIndex, setViewerIndex] = useState<number | null>(null);
	const [isSavingAll, setIsSavingAll] = useState(false);
	// Picked tiles, by media key; null when not picking.
	const [selected, setSelected] = useState<ReadonlySet<string> | null>(null);
	const [isWorkingOnSelection, setIsWorkingOnSelection] = useState(false);
	const longPressTimerRef = useRef<number | null>(null);
	const longPressFiredRef = useRef(false);

	const clearTileLongPress = () => {
		if (longPressTimerRef.current != null) {
			window.clearTimeout(longPressTimerRef.current);
			longPressTimerRef.current = null;
		}
	};

	const pickTile = (mediaKey: string) => {
		setSelected((current) => new Set([...(current ?? []), mediaKey]));
	};

	const toggleTile = (mediaKey: string) => {
		setSelected((current) => {
			const next = new Set(current ?? []);
			if (next.has(mediaKey)) next.delete(mediaKey);
			else next.add(mediaKey);
			return next;
		});
	};

	const startTileLongPress = (mediaKey: string) => {
		longPressFiredRef.current = false;
		clearTileLongPress();
		longPressTimerRef.current = window.setTimeout(() => {
			longPressTimerRef.current = null;
			longPressFiredRef.current = true;
			navigator.vibrate?.(30);
			pickTile(mediaKey);
		}, 420);
	};

	useEffect(() => () => {
		if (longPressTimerRef.current != null) window.clearTimeout(longPressTimerRef.current);
	}, []);

	useEffect(() => {
		if (!explicitFilterOn) return;
		let cancelled = false;
		const messageIds = allMedia.flatMap((item) => (item.messageId ? [item.messageId] : []));
		void chatDb
			.getMessageSenderIds(messageIds)
			.then((senders) => {
				if (!cancelled) setSenderByMessageId(senders);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [allMedia, explicitFilterOn]);

	const isOwnMedia = (item: LocalMediaItem): boolean => {
		const senderId = item.messageId ? senderByMessageId?.get(item.messageId) : undefined;
		return userId != null && senderId != null && Number(senderId) === Number(userId);
	};

	// With the explicit-photo filter on, a received photo is only listed once
	// a check has cleared it. The rest are left out altogether rather than
	// covered: the viewer swipes through this list, and "Save all" exports it.
	const isClearedMedia = (item: LocalMediaItem): boolean =>
		verdictOf(getCachedCheckForMessage(item.messageId) ?? getCachedCheckForMediaKey(item.mediaKey)) === "clear";
	// Asked for by the user for this sheet; closing it hides them again.
	const [showHiddenMedia, setShowHiddenMedia] = useState(false);
	const isHiddenMedia = (item: LocalMediaItem): boolean =>
		explicitFilterOn &&
		isExplicitGalleryHidingEnabled() &&
		!showHiddenMedia &&
		!isOwnMedia(item) &&
		!isClearedMedia(item);
	// Every item keeps its place; a hidden one is drawn as the hidden tile.
	const media: LocalMediaItem[] = allMedia.map((item) =>
		isHiddenMedia(item)
			? { ...item, kind: "image", dataUri: HIDDEN_MEDIA_PLACEHOLDER, hidden: true }
			: item,
	);
	const hiddenMediaCount = media.filter((item) => item.hidden).length;

	// Anything received and not yet checked gets checked from the copy already
	// loaded here.
	useEffect(() => {
		if (!explicitFilterOn || senderByMessageId == null) return;
		for (const item of allMedia) {
			if (isOwnMedia(item)) continue;
			if (getCachedCheckForMessage(item.messageId) ?? getCachedCheckForMediaKey(item.mediaKey)) continue;
			void checkMediaBytes({
				mediaKey: item.mediaKey,
				messageId: item.messageId,
				conversationId,
				kind: item.kind,
				base64: item.base64,
				mimeType: item.mimeType,
			});
		}
		// isOwnMedia reads senderByMessageId and userId, both listed.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [allMedia, explicitFilterOn, senderByMessageId, userId, conversationId]);

	// A hidden item is neither saved nor deleted from here: what would go out is the real file.
	const pickedMedia = () => media.filter((item) => !item.hidden && selected?.has(item.mediaKey));

	const handleSaveSelected = async () => {
		const picked = pickedMedia();
		if (picked.length === 0 || isWorkingOnSelection) return;
		setIsWorkingOnSelection(true);
		try {
			await onSaveMediaItems(
				picked.map((item) => ({
					messageId: item.messageId,
					mine: false,
					kind: item.kind,
					source: { base64: item.base64, mimeType: item.mimeType },
				})),
			);
			setSelected(null);
		} finally {
			setIsWorkingOnSelection(false);
		}
	};

	const handleDeleteSelected = async () => {
		const picked = pickedMedia();
		if (picked.length === 0 || isWorkingOnSelection) return;
		setIsWorkingOnSelection(true);
		try {
			// The grid only knows the message; who sent it is in the saved history.
			const senders = await chatDb
				.getMessageSenderIds(picked.flatMap((item) => (item.messageId ? [item.messageId] : [])))
				.catch(() => new Map<string, string>());
			const deleted = await onDeleteMediaItems(
				picked.map((item) => {
					const senderId = item.messageId ? senders.get(item.messageId) : undefined;
					return {
						messageId: item.messageId,
						mine: userId != null && senderId != null && Number(senderId) === Number(userId),
						kind: item.kind,
						source: { base64: item.base64, mimeType: item.mimeType },
					};
				}),
			);
			if (deleted.length > 0) {
				const gone = new Set(deleted);
				setAllMedia((previous) => previous.filter((item) => !item.messageId || !gone.has(item.messageId)));
				setSelected(null);
			}
		} finally {
			setIsWorkingOnSelection(false);
		}
	};

	const handleSaveAll = async () => {
		const savable = media.filter((item) => !item.hidden);
		if (savable.length === 0) {
			toast.error(t("profile_details.save_all_empty"));
			return;
		}

		setIsSavingAll(true);
		const toastId = toast.loading(
			t("profile_details.save_all_progress", { done: 0, total: savable.length }),
		);
		try {
			const result = await saveMediaBytesBatch(
				savable.map((m) => ({ base64: m.base64, mimeType: m.mimeType, type: m.kind })),
				(done, total) => {
					toast.loading(t("profile_details.save_all_progress", { done, total }), {
						id: toastId,
					});
				},
				conversationId,
			);

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
			appLog.error("[ChatMediaSheet] Save all failed", error);
			toast.error(t("profile_details.save_all_error"), { id: toastId });
		} finally {
			setIsSavingAll(false);
		}
	};

	// Load this conversation's albums from the local cache first — durable
	// even once a share expires/exhausts server-side — then merge in the
	// live list (exact albumId match, no heuristic needed here) so covers/
	// counts stay fresh when reachable, and so albums surfaced only via this
	// profile-wide endpoint (not necessarily backed by a message in this
	// conversation's own history) still get captured for permanent access.
	useEffect(() => {
		let cancelled = false;
		setAlbumsLoading(true);

		void (async () => {
			let localAlbumIds = new Set<number>();
			try {
				const stored = await chatDb.getAlbumsForConversation(conversationId);
				const withCovers = await Promise.all(
					stored.map(async (a) => {
						const albumId = Number(a.albumId);
						const local = await getLocalAlbum(albumId);
						const first = local?.content[0] ?? null;
						const videoCount =
							local?.content.filter((c) => c.contentType?.startsWith("video/")).length ?? 0;
						return {
							albumId,
							albumName: a.albumName,
							coverUrl: first?.thumbUrl ?? first?.coverUrl ?? first?.url ?? null,
							contentCount: {
								imageCount: (local?.content.length ?? 0) - videoCount,
								videoCount,
							},
						};
					}),
				);
				localAlbumIds = new Set(withCovers.map((a) => a.albumId));
				if (!cancelled) setAlbums(withCovers);
			} catch (error) {
				appLog.warn("[ChatMediaSheet] failed to load local albums", error);
			} finally {
				if (!cancelled) setAlbumsLoading(false);
			}

			if (!senderProfileId) {
				return;
			}

			try {
				const sharedAlbums = await service.getSharedAlbumsForProfile({
					profileId: Number(senderProfileId),
				});
				if (cancelled) return;
				const liveAlbums: SharedAlbum[] = sharedAlbums.map((a) => ({
					albumId: a.albumId,
					albumName: a.albumName ?? a.name ?? null,
					coverUrl: a.content?.thumbUrl ?? a.content?.url ?? a.content?.coverUrl ?? null,
					contentCount: a.contentCount,
				}));
				setAlbums((previous) => {
					const map = new Map(previous.map((a) => [a.albumId, a] as const));
					for (const a of liveAlbums) {
						map.set(a.albumId, a); // live metadata wins when reachable
					}
					return [...map.values()];
				});

				for (const album of liveAlbums) {
					if (localAlbumIds.has(album.albumId)) continue;
					void (async () => {
						try {
							const details = await service.getAlbum(album.albumId);
							await captureAlbum({
								albumId: details.albumId,
								albumName: details.albumName,
								content: details.content,
								ownerProfileId: senderProfileId,
								conversationId,
								sharedViaMessageId: null,
								remainingViews: null,
								isViewable: null,
							});
						} catch (error) {
							appLog.warn(
								`[ChatMediaSheet] failed to eagerly capture album ${album.albumId}`,
								error,
							);
						}
					})();
				}
			} catch (err) {
				console.error("[ChatMediaSheet] getSharedAlbumsForProfile failed", err);
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [conversationId, senderProfileId, service]);

	// Load this conversation's media from the local cache (chatDb) first — it
	// stays viewable forever, even after the server no longer serves it
	// (expired signed URLs, view-once exhausted, conversation
	// archived/blocked) — then merge in anything the live API still has that
	// isn't cached yet (e.g. an older conversation predating this cache).
	// The live endpoint exposes no messageId/hash to cross-reference chatDb
	// with directly, so de-duping uses the content hash embedded in
	// Grindr's signed CloudFront URLs instead — a heuristic, not a
	// guaranteed-exact match, but the same hash this codebase already
	// relies on elsewhere to identify images across re-signed URLs.
	useEffect(() => {
		let cancelled = false;
		setMediaLoading(true);

		void (async () => {
			let knownUrlHashes = new Set<string>();
			let knownContentHashes = new Set<string>();
			try {
				const files = await chatDb.getMediaFilesForConversation(conversationId);
				if (cancelled) return;
				setAllMedia(
					files.map((f) => ({
						mediaKey: f.mediaKey,
						messageId: f.messageId,
						kind: f.kind === "video" ? "video" : "image",
						dataUri: toDataUri(f.mimeType, f.dataBase64),
						mimeType: f.mimeType,
						base64: f.dataBase64,
					})),
				);
				knownUrlHashes = new Set(
					files
						.filter((f) => f.mediaKey.startsWith(IMAGE_HASH_KEY_PREFIX))
						.map((f) => f.mediaKey.slice(IMAGE_HASH_KEY_PREFIX.length)),
				);
				// Robust fallback, independent of which media_key scheme a given
				// local image happened to be captured under (hash/mediaId/
				// messageId) — covers the cases the URL-hash pre-check below
				// would otherwise miss.
				knownContentHashes = new Set(
					await Promise.all(files.map((f) => hashBase64(f.dataBase64))),
				);
			} catch (error) {
				appLog.warn("[ChatMediaSheet] failed to load local media", error);
			} finally {
				if (!cancelled) setMediaLoading(false);
			}

			try {
				const liveImages = await service.getSharedConversationImages(conversationId);

				for (const img of liveImages) {
					if (cancelled) return;
					if (!img.url) continue;

					const urlHash = extractImageHashFromSignedUrl(img.url);
					if (urlHash && knownUrlHashes.has(urlHash)) {
						// Fast path: definitely already local, skip the download.
						continue;
					}

					const fetched = await fetchAndEncode(img.url);
					if (!fetched || cancelled) continue;

					const contentHash = await hashBase64(fetched.base64);
					if (knownContentHashes.has(contentHash)) {
						// Already local under a different media_key scheme — don't
						// add a visible duplicate, but it's still worth recording
						// the URL hash now so a future load can take the fast path.
						if (urlHash) knownUrlHashes.add(urlHash);
						continue;
					}
					knownContentHashes.add(contentHash);
					if (urlHash) knownUrlHashes.add(urlHash);

					const mediaKey = urlHash
						? `${IMAGE_HASH_KEY_PREFIX}${urlHash}`
						: `image:media:${img.mediaId}`;

					await chatDb.upsertMediaFile({
						mediaKey,
						conversationId,
						messageId: null,
						kind: "image",
						mimeType: fetched.mimeType,
						dataBase64: fetched.base64,
						viewOnce: false,
						sizeBytes: fetched.sizeBytes,
						fetchStatus: "ok",
					});

					if (!cancelled) {
						setAllMedia((previous) => {
							if (previous.some((m) => m.mediaKey === mediaKey)) {
								return previous;
							}
							return [
								...previous,
								{
									mediaKey,
									messageId: null,
									kind: "image" as const,
									dataUri: toDataUri(fetched.mimeType, fetched.base64),
									mimeType: fetched.mimeType,
									base64: fetched.base64,
								},
							];
						});
					}
				}
			} catch (error) {
				appLog.warn("[ChatMediaSheet] failed to merge live shared images", error);
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [conversationId, service]);

	const tabs: { id: Tab; label: string; icon: React.ReactNode; count: number; loading: boolean }[] = [
		{
			id: "media",
			label: t("chat.media_sheet.tab_media"),
			icon: <Images className="h-4 w-4" />,
			count: media.length,
			loading: mediaLoading,
		},
		{
			id: "albums",
			label: t("chat.media_sheet.tab_albums"),
			icon: <LayoutGrid className="h-4 w-4" />,
			count: albums.length,
			loading: albumsLoading,
		},
	];

	const viewerPhotos: PhotoViewerMedia[] = media.map((m) => ({ url: m.dataUri, type: m.kind }));

	return (
		<>
		<BottomSheet onClose={onClose} isDesktop={isDesktop} panelClassName="max-h-[82dvh]">
			<div className="flex flex-col" style={{ minHeight: "60vh" }}>
				{/* Header */}
				{selected ? (
				<div className="flex items-center justify-between gap-2 px-4 pb-3">
					<p className="min-w-0 truncate text-sm font-semibold text-[var(--text)]">
						{selected.size === 0
							? t("chat.media_selection.pick_hint", { defaultValue: "Tap photos to select" })
							: t("chat.media_selection.count", { defaultValue: "{{count}} selected", count: selected.size })}
					</p>
					<div className="flex shrink-0 items-center gap-2">
						<button
							type="button"
							onClick={() => void handleSaveSelected()}
							disabled={selected.size === 0 || isWorkingOnSelection}
							className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs font-medium text-[var(--text)] transition hover:border-[var(--accent)] disabled:opacity-40"
						>
							{isWorkingOnSelection ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
							{t("chat.media_selection.save", { defaultValue: "Save" })}
						</button>
						<button
							type="button"
							onClick={() => void handleDeleteSelected()}
							disabled={selected.size === 0 || isWorkingOnSelection}
							className="inline-flex items-center gap-1.5 rounded-lg bg-red-500/10 px-2.5 py-1.5 text-xs font-medium text-red-400 transition hover:bg-red-500/20 disabled:opacity-40"
						>
							<Trash2 className="h-3.5 w-3.5" />
							{t("chat.actions.delete")}
						</button>
						<button
							type="button"
							onClick={() => setSelected(null)}
							aria-label={t("common.cancel", { defaultValue: "Cancel" })}
							className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--text-muted)] transition hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
						>
							<X className="h-4 w-4" />
						</button>
					</div>
				</div>
				) : (
				<div className="flex items-center justify-between px-4 pb-3">
					<p className="text-sm font-semibold text-[var(--text)]">{t("chat.media_sheet.title")}</p>
					<div className="flex items-center gap-2">
						{tab === "media" && media.length > 0 && (
							<button
								type="button"
								onClick={() => setSelected(new Set())}
								className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs font-medium text-[var(--text)] transition hover:border-[var(--accent)]"
							>
								<CircleCheck className="h-3.5 w-3.5" />
								{t("chat.media_selection.select", { defaultValue: "Select" })}
							</button>
						)}
						{tab === "media" && media.length > 0 && (
							<button
								type="button"
								onClick={() => void handleSaveAll()}
								disabled={isSavingAll}
								className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs font-medium text-[var(--text)] transition hover:border-[var(--accent)] disabled:opacity-50"
							>
								<Download className="h-3.5 w-3.5" />
								{t("profile_details.save_all")}
							</button>
						)}
						<SheetClose className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--text-muted)] transition hover:bg-[var(--surface-2)] hover:text-[var(--text)]">
							<X className="h-4 w-4" />
						</SheetClose>
					</div>
				</div>
				)}

				{/* Tab bar */}
				<div className="flex border-b border-[var(--border)] px-2 pb-0 pt-1">
					{tabs.map((tab_item) => (
						<button
							key={tab_item.id}
							type="button"
							onClick={() => {
								setTab(tab_item.id);
								if (tab_item.id !== "media") setSelected(null);
							}}
							className={`flex items-center gap-1.5 px-3 py-2.5 text-sm font-medium transition border-b-2 -mb-px ${
								tab === tab_item.id
									? "border-[var(--accent)] text-[var(--accent)]"
									: "border-transparent text-[var(--text-muted)] hover:text-[var(--text)]"
							}`}
						>
							{tab_item.icon}
							{tab_item.label}
							{!tab_item.loading && tab_item.count > 0 && (
								<span className="min-w-[18px] rounded-full bg-[var(--accent)] px-1.5 py-0.5 text-center text-[10px] font-semibold leading-none text-white">
									{tab_item.count}
								</span>
							)}
						</button>
					))}
				</div>

				{/* Content */}
				<div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4" data-lenis-prevent>
					{tab === "albums" ? (
						albumsLoading ? (
							<div className="flex items-center justify-center py-16">
								<Loader2 className="h-6 w-6 animate-spin text-[var(--text-muted)]" />
							</div>
						) : albums.length === 0 ? (
							<div className="flex flex-1 flex-col items-center justify-center gap-3 text-[var(--text-muted)]">
								<LayoutGrid className="h-10 w-10 opacity-30" />
								<p className="text-sm font-medium">{t("chat.media_sheet.albums_empty_title")}</p>
								<p className="text-xs opacity-60">{t("chat.media_sheet.albums_empty_desc")}</p>
							</div>
						) : (
							<div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
								{albums.map((album) => {
									const coverFailed = failedCovers.has(album.albumId);
									// These are the other person's albums: no cover until
									// every item has been checked and cleared.
									const showCover =
										!!album.coverUrl &&
										!coverFailed &&
										!(explicitFilterOn && getAlbumCover(album.albumId) != null);
									return (
										<button
											key={album.albumId}
											type="button"
											onClick={() => void openAlbumViewerById(album.albumId)}
											className="group relative aspect-square overflow-hidden rounded-xl bg-[var(--surface-2)]"
										>
											{showCover ? (
												<img
													src={album.coverUrl!}
													alt=""
													className="absolute inset-0 h-full w-full object-cover scale-110"
													style={{ filter: "blur(3px)" }}
													onError={() => setFailedCovers((p) => new Set([...p, album.albumId]))}
												/>
											) : (
												<div className="absolute inset-0 flex items-center justify-center">
													<LayoutGrid className="h-8 w-8 text-[var(--text-muted)] opacity-40" />
												</div>
											)}
											<div className="absolute inset-0 bg-black/20" />
											<div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-2">
												<div
													className="h-10 w-10 overflow-hidden rounded-full ring-2 ring-white/60"
													style={{ filter: "drop-shadow(0 2px 6px rgba(0,0,0,0.5))" }}
												>
													<ProfileImage src={senderPhotoUrl} />
												</div>
												<p className="line-clamp-2 max-w-full text-center text-[11px] font-medium leading-tight text-white drop-shadow">
													{album.albumName ?? `#${album.albumId}`}
												</p>
											</div>
										</button>
									);
								})}
							</div>
						)
					) : mediaLoading ? (
						<div className="flex items-center justify-center py-16">
							<Loader2 className="h-6 w-6 animate-spin text-[var(--text-muted)]" />
						</div>
					) : media.length === 0 ? (
						<div className="flex flex-1 flex-col items-center justify-center gap-3 text-[var(--text-muted)]">
							<Images className="h-10 w-10 opacity-30" />
							<p className="text-sm font-medium">{t("chat.media_sheet.media_empty_title")}</p>
							<p className="text-xs opacity-60">
								{t("chat.media_sheet.media_empty_desc")}
							</p>
						</div>
					) : (
						<>
						{hiddenMediaCount > 0 ? (
							<div className="mb-3 flex items-center gap-2 text-xs text-[var(--text-muted)]">
								<EyeOff className="h-3.5 w-3.5 shrink-0" />
								<span className="min-w-0 flex-1">
									{t("chat.media_sheet.hidden_by_filter", {
										defaultValue: "{{count}} hidden: explicit, or not checked yet.",
										count: hiddenMediaCount,
									})}
								</span>
								<ShowAnywayButton onShow={() => setShowHiddenMedia(true)} />
							</div>
						) : null}
						<div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4">
							{media.map((item, idx) => {
								const isPicked = selected?.has(item.mediaKey) ?? false;
								return (
								<button
									key={item.mediaKey}
									type="button"
									onTouchStart={() => startTileLongPress(item.mediaKey)}
									onTouchMove={clearTileLongPress}
									onTouchEnd={clearTileLongPress}
									onTouchCancel={clearTileLongPress}
									onContextMenu={(event) => {
										event.preventDefault();
										if (isDesktop) {
											if (selected) toggleTile(item.mediaKey);
											else pickTile(item.mediaKey);
										}
									}}
									onClick={() => {
										if (longPressFiredRef.current) {
											longPressFiredRef.current = false;
											return;
										}
										if (selected) toggleTile(item.mediaKey);
										else setViewerIndex(idx);
									}}
									aria-pressed={selected ? isPicked : undefined}
									className={`no-touch-callout group relative aspect-square select-none overflow-hidden rounded-lg bg-[var(--surface-2)] ${
										isPicked ? "ring-2 ring-inset ring-[var(--accent)]" : ""
									}`}
								>
									{item.kind === "video" ? (
										<>
											<video
												src={item.dataUri}
												muted
												playsInline
												className="h-full w-full object-cover transition group-hover:scale-105"
											/>
											<div className="absolute inset-0 flex items-center justify-center bg-black/15">
												<Play className="h-6 w-6 text-white drop-shadow" fill="white" />
											</div>
										</>
									) : (
										<img
											src={item.dataUri}
											alt=""
											draggable={false}
											className={`h-full w-full object-cover transition group-hover:scale-105 ${isPicked ? "scale-95 rounded-md" : ""}`}
										/>
									)}
									{selected ? (
										<span
											aria-hidden
											className={`pointer-events-none absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full shadow ${
												isPicked
													? "bg-[var(--accent)] text-[var(--accent-contrast)]"
													: "border-2 border-white/90 bg-black/30"
											}`}
										>
											{isPicked ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : null}
										</span>
									) : null}
								</button>
								);
							})}
						</div>
						</>
					)}
				</div>
			</div>
		</BottomSheet>

		{viewerIndex !== null && createPortal(
			<PhotoViewer
				isOpen
				onClose={() => setViewerIndex(null)}
				photos={viewerPhotos}
				initialIndex={viewerIndex}
				conversationId={conversationId}
			/>,
			document.body,
		)}
		</>
	);
}
