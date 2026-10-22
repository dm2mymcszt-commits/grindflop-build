import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, Loader2, Music, Plus, X } from "lucide-react";
import toast from "react-hot-toast";
import { CategoryHeader } from "./ProfileEditorComponents";
import {
	useSetSpotifyFavorites,
	useSpotifyTracks,
} from "../../../hooks/queries/useProfileQueries";
import { fetchSpotifyTrack, getCachedSpotifyTrack } from "../../../services/spotifyTrackInfo";
import { parseSpotifyTrackId } from "../../../types/spotify";
import type { SpotifyTrack } from "../../../types/spotify";

/**
 * One row in the editable list. Metadata is looked up per id so that a track
 * the user has only just pasted resolves without refetching the whole list.
 */
function TrackRow({
	songId,
	index,
	total,
	onMove,
	onRemove,
}: {
	songId: string;
	index: number;
	total: number;
	onMove: (from: number, to: number) => void;
	onRemove: (songId: string) => void;
}) {
	const { t } = useTranslation();
	const [track, setTrack] = useState<SpotifyTrack | null>(() => getCachedSpotifyTrack(songId) ?? null);

	useEffect(() => {
		if (track) {
			return;
		}
		let cancelled = false;
		void fetchSpotifyTrack(songId).then((resolved) => {
			if (!cancelled) {
				setTrack(resolved);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [songId, track]);

	return (
		<div className="flex min-h-14 items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2">
			{track?.artworkUrl ? (
				<img src={track.artworkUrl} alt="" loading="lazy" className="h-10 w-10 shrink-0 rounded-md object-cover" />
			) : (
				<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-[var(--surface)] text-[var(--text-muted)]">
					<Music className="h-4 w-4" aria-hidden="true" />
				</div>
			)}

			<div className="min-w-0 flex-1">
				<p className="truncate text-sm font-medium text-[var(--text)]">
					{track === null
						? t("profile_editor.sections.music.resolving", { defaultValue: "Loading…" })
						: (track.name ??
							t("profile_editor.sections.music.unknown_track", { defaultValue: "Unknown track" }))}
				</p>
				<p className="truncate text-xs text-[var(--text-muted)]">{songId}</p>
			</div>

			<div className="flex shrink-0 items-center gap-1">
				<button
					type="button"
					onClick={() => onMove(index, index - 1)}
					disabled={index === 0}
					aria-label={t("profile_editor.sections.music.move_up", { defaultValue: "Move up" })}
					className="rounded-lg p-1.5 text-[var(--text-muted)] transition hover:bg-[var(--surface)] disabled:opacity-30"
				>
					<ArrowUp className="h-4 w-4" />
				</button>
				<button
					type="button"
					onClick={() => onMove(index, index + 1)}
					disabled={index === total - 1}
					aria-label={t("profile_editor.sections.music.move_down", { defaultValue: "Move down" })}
					className="rounded-lg p-1.5 text-[var(--text-muted)] transition hover:bg-[var(--surface)] disabled:opacity-30"
				>
					<ArrowDown className="h-4 w-4" />
				</button>
				<button
					type="button"
					onClick={() => onRemove(songId)}
					aria-label={t("profile_editor.sections.music.remove", { defaultValue: "Remove" })}
					className="rounded-lg p-1.5 text-[var(--text-muted)] transition hover:bg-[var(--surface)] hover:text-[var(--text)]"
				>
					<X className="h-4 w-4" />
				</button>
			</div>
		</div>
	);
}

type MusicSectionProps = {
	profileId?: string | number | null;
};

/**
 * Edits the signed-in user's Spotify favourites.
 *
 * Tracks are added by pasting a Spotify link rather than through an in-app
 * search: Spotify's search API needs client credentials the user would have to
 * register themselves, whereas "Share -> Copy Song Link" needs nothing at all.
 * Pasted links are resolved through the same public oEmbed lookup the profile
 * view uses, so the user sees the real track name before saving.
 *
 * Saving is separate from the main profile form because it is a separate
 * endpoint (POST /v4/spotify/favorites), which replaces the whole list.
 */
export function MusicSection({ profileId }: MusicSectionProps) {
	const { t } = useTranslation();
	const { songIds: savedSongIds, isLoading } = useSpotifyTracks(profileId);
	const saveFavorites = useSetSpotifyFavorites(profileId);

	const [draft, setDraft] = useState<string[] | null>(null);
	const [input, setInput] = useState("");

	// Adopt the server list once, then leave the user's edits alone.
	useEffect(() => {
		if (draft === null && !isLoading) {
			setDraft(savedSongIds);
		}
	}, [draft, isLoading, savedSongIds]);

	const songIds = draft ?? savedSongIds;
	const isDirty = useMemo(
		() => draft !== null && draft.join(",") !== savedSongIds.join(","),
		[draft, savedSongIds],
	);

	const handleAdd = () => {
		const trackId = parseSpotifyTrackId(input);
		if (!trackId) {
			toast.error(
				t("profile_editor.sections.music.invalid_link", {
					defaultValue: "That does not look like a Spotify track link.",
				}),
			);
			return;
		}
		if (songIds.includes(trackId)) {
			toast.error(
				t("profile_editor.sections.music.already_added", {
					defaultValue: "That track is already in your list.",
				}),
			);
			return;
		}
		setDraft([...songIds, trackId]);
		setInput("");
	};

	const handleMove = (from: number, to: number) => {
		if (to < 0 || to >= songIds.length) {
			return;
		}
		const next = [...songIds];
		const [moved] = next.splice(from, 1);
		next.splice(to, 0, moved);
		setDraft(next);
	};

	const handleSave = () => {
		saveFavorites.mutate(songIds, {
			onSuccess: () => {
				setDraft(null);
				toast.success(t("profile_editor.sections.music.saved", { defaultValue: "Music saved" }));
			},
			onError: (error) => {
				toast.error(
					error instanceof Error
						? error.message
						: t("profile_editor.sections.music.save_failed", {
								defaultValue: "Could not save your music",
							}),
				);
			},
		});
	};

	return (
		<div className="surface-card p-4 sm:p-5">
			<CategoryHeader
				title={t("profile_editor.sections.music.title", { defaultValue: "Music" })}
				description={t("profile_editor.sections.music.description", {
					defaultValue: "Songs shown on your profile",
				})}
				icon={Music}
			/>

			{isLoading && draft === null ? (
				<div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
					<Loader2 className="h-4 w-4 animate-spin" />
					{t("profile_editor.sections.music.loading", { defaultValue: "Loading your music…" })}
				</div>
			) : (
				<div className="grid gap-3">
					{songIds.length > 0 ? (
						<div className="grid gap-2">
							{songIds.map((songId, index) => (
								<TrackRow
									key={songId}
									songId={songId}
									index={index}
									total={songIds.length}
									onMove={handleMove}
									onRemove={(id) => setDraft(songIds.filter((existing) => existing !== id))}
								/>
							))}
						</div>
					) : (
						<p className="text-sm text-[var(--text-muted)]">
							{t("profile_editor.sections.music.empty", {
								defaultValue: "No songs yet. Paste a Spotify track link below to add one.",
							})}
						</p>
					)}

					<div className="flex flex-col gap-2 sm:flex-row">
						<input
							type="text"
							value={input}
							onChange={(e) => setInput(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									e.preventDefault();
									handleAdd();
								}
							}}
							placeholder={t("profile_editor.sections.music.placeholder", {
								defaultValue: "Paste a Spotify song link…",
							})}
							className="min-h-11 flex-1 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
						/>
						<button
							type="button"
							onClick={handleAdd}
							className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-4 text-sm font-medium text-[var(--text)] transition hover:border-[var(--accent)]"
						>
							<Plus className="h-4 w-4" />
							{t("profile_editor.sections.music.add", { defaultValue: "Add" })}
						</button>
					</div>

					<p className="text-xs text-[var(--text-muted)]">
						{t("profile_editor.sections.music.hint", {
							defaultValue: "In Spotify: Share, then Copy Song Link.",
						})}
					</p>

					{isDirty && (
						<div className="flex items-center gap-2">
							<button
								type="button"
								onClick={handleSave}
								disabled={saveFavorites.isPending}
								className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl bg-[var(--accent)] px-4 text-sm font-semibold text-[var(--accent-contrast)] transition disabled:opacity-60"
							>
								{saveFavorites.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
								{t("profile_editor.sections.music.save", { defaultValue: "Save music" })}
							</button>
							<button
								type="button"
								onClick={() => setDraft(null)}
								disabled={saveFavorites.isPending}
								className="min-h-11 rounded-xl px-3 text-sm text-[var(--text-muted)] transition hover:text-[var(--text)] disabled:opacity-60"
							>
								{t("profile_editor.sections.music.discard", { defaultValue: "Discard" })}
							</button>
						</div>
					)}
				</div>
			)}
		</div>
	);
}
