import { ExternalLink, Music, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { SpotifyTrack } from "../../../../types/spotify";

type SpotifyEmbedController = {
	addListener: (event: "ready", listener: () => void) => void;
	destroy: () => void;
	play: () => void;
};

type SpotifyIframeApi = {
	createController: (
		element: HTMLElement,
		options: { height: number; uri: string; width: string },
		callback: (controller: SpotifyEmbedController) => void,
	) => void;
};

declare global {
	interface Window {
		onSpotifyIframeApiReady?: (api: SpotifyIframeApi) => void;
	}
}

const SPOTIFY_IFRAME_API_SRC = "https://open.spotify.com/embed/iframe-api/v1";
let spotifyIframeApiPromise: Promise<SpotifyIframeApi> | null = null;

function loadSpotifyIframeApi(): Promise<SpotifyIframeApi> {
	if (spotifyIframeApiPromise) {
		return spotifyIframeApiPromise;
	}

	const promise = new Promise<SpotifyIframeApi>((resolve, reject) => {
		const previousReadyHandler = window.onSpotifyIframeApiReady;
		window.onSpotifyIframeApiReady = (api) => {
			previousReadyHandler?.(api);
			resolve(api);
		};

		const existingScript = document.querySelector<HTMLScriptElement>(
			`script[src="${SPOTIFY_IFRAME_API_SRC}"]`,
		);
		if (existingScript) {
			existingScript.addEventListener(
				"error",
				() => reject(new Error("Spotify iframe API failed to load")),
				{
					once: true,
				},
			);
			return;
		}

		const script = document.createElement("script");
		script.src = SPOTIFY_IFRAME_API_SRC;
		script.async = true;
		script.addEventListener(
			"error",
			() => reject(new Error("Spotify iframe API failed to load")),
			{
				once: true,
			},
		);
		document.body.appendChild(script);
	}).catch((error) => {
		spotifyIframeApiPromise = null;
		throw error;
	});
	spotifyIframeApiPromise = promise;

	return promise;
}

function SpotifyGlyph({ className }: { className?: string }) {
	return (
		<svg viewBox="0 0 24 24" className={className} aria-hidden="true">
			<path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.52 17.34c-.24.36-.66.48-1.02.24-2.82-1.74-6.36-2.1-10.56-1.14-.42.12-.78-.18-.9-.54-.12-.42.18-.78.54-.9 4.56-1.02 8.52-.6 11.64 1.32.42.18.48.66.3 1.02zm1.44-3.3c-.3.42-.84.6-1.26.3-3.24-1.98-8.16-2.58-11.94-1.38-.48.12-1.02-.12-1.14-.6-.12-.48.12-1.02.6-1.14 4.38-1.32 9.78-.66 13.5 1.62.36.18.54.78.24 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.3c-.6.18-1.2-.18-1.38-.72-.18-.6.18-1.2.72-1.38 4.26-1.26 11.28-1.02 15.72 1.62.54.3.72 1.02.42 1.56-.3.42-1.02.6-1.56.3z" />
		</svg>
	);
}

function TrackArtwork({ track }: { track: SpotifyTrack }) {
	const [failed, setFailed] = useState(false);

	if (!track.artworkUrl || failed) {
		return (
			<div className="flex h-10 w-10 items-center justify-center rounded-md bg-[var(--surface)] text-[var(--text-muted)]">
				<Music className="h-4 w-4" aria-hidden="true" />
			</div>
		);
	}

	return (
		<img
			src={track.artworkUrl}
			alt=""
			loading="lazy"
			onError={() => setFailed(true)}
			className="h-10 w-10 rounded-md object-cover"
		/>
	);
}

const ROW_CLASS =
	"flex min-h-11 min-w-0 items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 transition";

function SpotifyPreview({
	label,
	trackId,
}: {
	label: string;
	trackId: string;
}) {
	const hostRef = useRef<HTMLDivElement>(null);
	const [useFallback, setUseFallback] = useState(false);

	useEffect(() => {
		const host = hostRef.current;
		if (!host) {
			return;
		}

		// Spotify replaces the element passed to createController. Keep that
		// mount point outside React's tree so React only ever owns `host` and
		// does not try to remove a node Spotify has already replaced.
		const mountPoint = document.createElement("div");
		mountPoint.style.width = "100%";
		mountPoint.style.height = "80px";
		host.appendChild(mountPoint);

		let controller: SpotifyEmbedController | null = null;
		let disposed = false;
		let handedBackToReact = false;

		void loadSpotifyIframeApi()
			.then((api) => {
				if (disposed) {
					return;
				}

				api.createController(
					mountPoint,
					{
						height: 80,
						uri: `spotify:track:${trackId}`,
						width: "100%",
					},
					(embedController) => {
						if (disposed) {
							embedController.destroy();
							return;
						}

						controller = embedController;
						embedController.addListener("ready", () => {
							if (!disposed) {
								embedController.play();
							}
						});
					},
				);
			})
			.catch(() => {
				if (!disposed) {
					host.replaceChildren();
					handedBackToReact = true;
					setUseFallback(true);
				}
			});

		return () => {
			disposed = true;
			controller?.destroy();
			if (!handedBackToReact) {
				host.replaceChildren();
			}
		};
	}, [trackId]);

	if (useFallback) {
		return (
			<div className="h-20 w-full overflow-hidden rounded-xl bg-[var(--surface-2)]">
				<iframe
					title={label}
					src={`https://open.spotify.com/embed/track/${trackId}?utm_source=freegrind`}
					width="100%"
					height="80"
					frameBorder="0"
					allow="autoplay; clipboard-write; encrypted-media; picture-in-picture"
					className="block h-full w-full border-0"
				/>
			</div>
		);
	}

	return (
		<div
			ref={hostRef}
			className="h-20 w-full overflow-hidden rounded-xl bg-[var(--surface-2)]"
			aria-label={label}
		/>
	);
}

/**
 * A profile's Spotify favourite tracks.
 *
 * Renders nothing at all when the person has no favourites — most profiles
 * will not have Spotify linked, and the caller's section gate relies on this
 * returning null rather than an empty heading.
 *
 * `songIds` comes straight from Grindr; `tracks` is those ids hydrated with
 * names and artwork from Spotify, which arrives a moment later. Between the
 * two we show skeleton rows, so the section does not resize under the reader.
 *
 * Tapping the artwork swaps the row for Spotify's own embed player, which
 * streams a preview without any credentials of ours. We cannot play audio
 * ourselves: the Web API's `preview_url` needs an access token and has been
 * withdrawn for newly registered apps, so the embed is the only no-auth
 * route to actual playback. Tapping the title still opens the full track.
 */
export function ProfileMusicSection({
	tracks,
	songIds,
}: {
	tracks: SpotifyTrack[];
	songIds: string[];
}) {
	const { t } = useTranslation();
	// Only one preview at a time, so opening a second stops the first.
	const [playingId, setPlayingId] = useState<string | null>(null);

	if (songIds.length === 0) {
		return null;
	}

	const heading = (
		<p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.1em] text-[var(--text-muted)]">
			<SpotifyGlyph className="h-3.5 w-3.5 shrink-0 fill-[var(--text-muted)]" />
			{t("profile_details.music", { defaultValue: "Music" })}
		</p>
	);

	// Ids known, metadata still in flight.
	if (tracks.length === 0) {
		return (
			<div className="min-w-0">
				{heading}
				<div className="grid min-w-0 gap-2">
					{songIds.map((songId) => (
						<div key={songId} className={ROW_CLASS}>
							<div className="h-10 w-10 shrink-0 animate-pulse rounded-md bg-[var(--surface)]" />
							<div className="h-3 w-32 animate-pulse rounded bg-[var(--surface)]" />
						</div>
					))}
				</div>
			</div>
		);
	}

	return (
		<div className="min-w-0">
			{heading}
			<div className="grid min-w-0 gap-2">
				{tracks.map((track, index) => {
					const url = track.spotifyUrl;
					// name is null until Spotify's oEmbed lookup resolves, and
					// stays null if it fails — the row is still useful, since
					// tapping it opens the track in Spotify either way.
					const label =
						track.name ??
						t("profile_details.music_unknown_track", {
							defaultValue: "Unknown track",
						});
					const key = track.id || `${label}-${index}`;

					if (playingId === track.id && track.id) {
						return (
							<div key={key} className="min-w-0">
								<SpotifyPreview label={label} trackId={track.id} />
								<button
									type="button"
									onClick={() => setPlayingId(null)}
									className="mt-1 w-full text-right text-[11px] text-[var(--text-muted)] transition hover:text-[var(--text)]"
								>
									{t("profile_details.music_close_preview", {
										defaultValue: "Close preview",
									})}
								</button>
							</div>
						);
					}

					return (
						<div
							key={key}
							className={`${ROW_CLASS} hover:border-[var(--accent)]`}
						>
							<button
								type="button"
								onClick={() => setPlayingId(track.id)}
								disabled={!track.id}
								aria-label={t("profile_details.music_play", {
									defaultValue: "Play preview of {{track}}",
									track: label,
								})}
								className="group relative shrink-0 rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:cursor-default"
							>
								<TrackArtwork track={track} />
								{track.id && (
									<span className="absolute inset-0 flex items-center justify-center rounded-md bg-black/45 opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100">
										<Play className="h-4 w-4 fill-white text-white" />
									</span>
								)}
							</button>

							<a
								href={url}
								onClick={(e) => {
									e.preventDefault();
									e.stopPropagation();
									void openUrl(url).catch(() => window.open(url, "_blank"));
								}}
								target="_blank"
								rel="noopener noreferrer"
								className="flex min-w-0 flex-1 items-center gap-3 hover:opacity-80"
							>
								<span className="min-w-0 flex-1">
									<span className="block truncate text-sm font-medium text-[var(--text)]">
										{label}
									</span>
									{track.artist && (
										<span className="block truncate text-xs text-[var(--text-muted)]">
											{track.artist}
										</span>
									)}
								</span>
								<ExternalLink className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
							</a>
						</div>
					);
				})}
			</div>
		</div>
	);
}
