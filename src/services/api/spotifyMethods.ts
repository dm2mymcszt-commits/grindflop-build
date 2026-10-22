import type { RestFetcher } from "../../types/chat-service";
import type { SpotifyFavorites } from "../../types/spotify";
import { parseSpotifyFavorites } from "../../types/spotify";
import { assertSuccess, parseJsonSafe } from "../apiHelpers";
import { appLog } from "../../utils/logger";

/**
 * Grindr's Spotify favourites. Schema captured and documented in
 * docs/content/grindr-api/third-party-integrations/spotify.md.
 *
 * Returns bare Spotify track ids only — {"songIds":["73W9h..."]} — with an
 * empty list for people who have not linked Spotify. Track names and artwork
 * are hydrated separately in services/spotifyTrackInfo.ts.
 *
 * This data is decorative: a profile is perfectly usable without it, and most
 * profiles will not have Spotify linked at all. So unlike getProfileDetail
 * (which throws so the modal can show an error), the read path here degrades
 * to an empty list on anything unexpected.
 */
export function createSpotifyMethods(
	fetchRest: RestFetcher,
	_t: (key: string, options?: any) => string,
) {
	return {
		async getSpotifyFavorites(profileId: number | string): Promise<SpotifyFavorites> {
			try {
				const response = await fetchRest(
					`/v4/spotify/favorites/${encodeURIComponent(String(profileId))}`,
				);

				// Observed behaviour is 200 with an empty songIds for people who
				// have not linked Spotify, but treat an empty-ish status the
				// same way rather than logging it as a failure.
				if (response.status === 404 || response.status === 204) {
					return { songIds: [] };
				}

				if (response.status < 200 || response.status >= 300) {
					appLog.warn(`Spotify favorites request failed: ${response.status}`);
					return { songIds: [] };
				}

				return parseSpotifyFavorites(await parseJsonSafe(response));
			} catch (error) {
				appLog.warn("Spotify favorites request error:", error);
				return { songIds: [] };
			}
		},

		/**
		 * POST /v4/spotify/favorites — replaces the whole favourites list.
		 *
		 * SpotifyPostRequest was never documented upstream; the body mirrors
		 * what GET returns for the same resource ({"songIds":[...]}), which is
		 * the shape the server itself hands us.
		 *
		 * Unlike the read path this deliberately throws on failure — it writes
		 * to the user's real profile, so a silent no-op would be worse than an
		 * error they can see.
		 */
		async setSpotifyFavorites(songIds: string[]): Promise<void> {
			const response = await fetchRest("/v4/spotify/favorites", {
				method: "POST",
				body: { songIds },
			});
			await assertSuccess(response, "Failed to save Spotify favorites");
		},
	};
}
