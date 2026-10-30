/**
 * Grindr's Spotify integration (GET/POST /v4/spotify/favorites).
 *
 * Captured shape (2026-08, previously WIP upstream):
 *
 *   GET /v4/spotify/favorites/{profileId}
 *   200 {"songIds":["73W9hTjmLXNwWcV9Gh5hmt"]}
 *   200 {"songIds":[]}                          // no favourites / not linked
 *
 * That is *all* the backend stores — bare Spotify track ids, no track name,
 * artist or artwork. So anything worth showing has to be hydrated from
 * Spotify itself; see services/spotifyTrackInfo.ts.
 */

/** A track id plus whatever metadata we have managed to hydrate for it. */
export type SpotifyTrack = {
	/** Spotify track id, e.g. "73W9hTjmLXNwWcV9Gh5hmt". */
	id: string;
	/** Track name, null while loading or if the lookup failed. */
	name: string | null;
	/** Artist name. oEmbed does not expose this, so currently always null. */
	artist: string | null;
	/** Album art URL, null while loading or if the lookup failed. */
	artworkUrl: string | null;
	/** Always derivable from the id. */
	spotifyUrl: string;
};

export type SpotifyFavorites = {
	songIds: string[];
};

export function spotifyTrackUrl(trackId: string): string {
	return `https://open.spotify.com/track/${trackId}`;
}

/**
 * Pulls a track id out of any of the forms Spotify hands people:
 * a bare id, "spotify:track:ID", or an open.spotify.com link with tracking
 * params. Returns "" when there is no id in `value`.
 *
 * Bare ids are Spotify base-62 and always 22 chars, which is what lets us
 * tell "this is already an id" apart from arbitrary junk.
 */
export function parseSpotifyTrackId(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) {
		return "";
	}

	const uriMatch = /^spotify:track:([A-Za-z0-9]+)/.exec(trimmed);
	if (uriMatch) {
		return uriMatch[1];
	}

	const urlMatch = /open\.spotify\.com\/(?:intl-[a-z-]+\/)?track\/([A-Za-z0-9]+)/.exec(trimmed);
	if (urlMatch) {
		return urlMatch[1];
	}

	if (/^[A-Za-z0-9]{22}$/.test(trimmed)) {
		return trimmed;
	}

	return "";
}

/**
 * Reads GET /v4/spotify/favorites/{profileId}. Never throws — an unexpected
 * body yields an empty list, because music is decorative and must not be able
 * to take the profile view down with it.
 */
export function parseSpotifyFavorites(payload: unknown): SpotifyFavorites {
	if (typeof payload !== "object" || payload === null) {
		return { songIds: [] };
	}

	const raw = (payload as { songIds?: unknown }).songIds;
	if (!Array.isArray(raw)) {
		return { songIds: [] };
	}

	const songIds: string[] = [];
	for (const entry of raw) {
		if (typeof entry !== "string") {
			continue;
		}
		const id = parseSpotifyTrackId(entry);
		if (id && !songIds.includes(id)) {
			songIds.push(id);
		}
	}

	return { songIds };
}
