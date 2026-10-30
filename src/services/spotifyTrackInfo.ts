import type { SpotifyTrack } from "../types/spotify";
import { spotifyTrackUrl } from "../types/spotify";
import { appLog } from "../utils/logger";

/**
 * Grindr only stores bare Spotify track ids (see types/spotify.ts), so track
 * names and album art have to come from Spotify.
 *
 * This uses Spotify's public oEmbed endpoint rather than the Web API: it needs
 * no client id, no secret and no OAuth, and it sends
 * `access-control-allow-origin: *`, so a plain fetch from the webview works
 * with no Tauri HTTP capability entry and no risk of attaching Grindr's
 * session token to a third-party host.
 *
 * The tradeoff is that oEmbed returns only `title` and `thumbnail_url` — there
 * is no artist field. Artist names would need GET /v1/tracks?ids= on the Web
 * API, which does require credentials.
 *
 * Track metadata is immutable, so results are cached for the session and
 * in-flight lookups are shared.
 */

type OEmbedResponse = {
	title?: unknown;
	thumbnail_url?: unknown;
};

const cache = new Map<string, SpotifyTrack>();
const inFlight = new Map<string, Promise<SpotifyTrack>>();

/** Track with no metadata — what we render while loading, or on failure. */
function bareTrack(trackId: string): SpotifyTrack {
	return {
		id: trackId,
		name: null,
		artist: null,
		artworkUrl: null,
		spotifyUrl: spotifyTrackUrl(trackId),
	};
}

async function lookup(trackId: string): Promise<SpotifyTrack> {
	const endpoint = `https://open.spotify.com/oembed?url=${encodeURIComponent(
		spotifyTrackUrl(trackId),
	)}`;

	try {
		const response = await fetch(endpoint);
		if (!response.ok) {
			// 404 here means the id is not a track we can resolve (deleted,
			// region-locked, or never valid). Cache the bare form so we do not
			// re-request it all session.
			appLog.warn(`Spotify oEmbed lookup failed for ${trackId}: ${response.status}`);
			const fallback = bareTrack(trackId);
			cache.set(trackId, fallback);
			return fallback;
		}

		const payload = (await response.json()) as OEmbedResponse;
		const track: SpotifyTrack = {
			id: trackId,
			name: typeof payload.title === "string" && payload.title.trim() ? payload.title.trim() : null,
			artist: null,
			artworkUrl:
				typeof payload.thumbnail_url === "string" && payload.thumbnail_url.trim()
					? payload.thumbnail_url.trim()
					: null,
			spotifyUrl: spotifyTrackUrl(trackId),
		};
		cache.set(trackId, track);
		return track;
	} catch (error) {
		// Offline or blocked: return the bare track but do NOT cache it, so a
		// later attempt can still succeed once connectivity returns.
		appLog.warn(`Spotify oEmbed lookup error for ${trackId}:`, error);
		return bareTrack(trackId);
	}
}

export function getCachedSpotifyTrack(trackId: string): SpotifyTrack | undefined {
	return cache.get(trackId);
}

export async function fetchSpotifyTrack(trackId: string): Promise<SpotifyTrack> {
	const cached = cache.get(trackId);
	if (cached) {
		return cached;
	}

	const existing = inFlight.get(trackId);
	if (existing) {
		return existing;
	}

	const promise = lookup(trackId).finally(() => {
		inFlight.delete(trackId);
	});
	inFlight.set(trackId, promise);
	return promise;
}

/**
 * Hydrates a list of ids, preserving order. Individual failures degrade to a
 * bare track rather than failing the whole list.
 */
export async function fetchSpotifyTracks(trackIds: string[]): Promise<SpotifyTrack[]> {
	return Promise.all(trackIds.map((trackId) => fetchSpotifyTrack(trackId)));
}
