# Spotify

Grindr surfaces a set of Spotify *favourite songs* on a profile. These do not
come back on `GET /v7/profiles/{profileId}` — `socialNetworks` there carries
only `instagram`/`twitter`/`facebook`. The tracks live behind their own
endpoint below, so displaying them costs one extra request per profile.

## Get Spotify favorites

```
GET /v4/spotify/favorites/{profileId}
```

Response: `SpotifyBackendResponse`

- `songIds` — array of Spotify track ids (base-62, 22 chars)

Observed responses:

```json
{"songIds":["73W9hTjmLXNwWcV9Gh5hmt"]}
```

```json
{"songIds":[]}
```

Notes:

- Status is **`200` in both cases** — a profile with no linked Spotify (or no
  chosen songs) returns an empty `songIds`, not `404`.
- Readable for **any** profile id, not just your own.
- The backend stores **ids only** — no track name, artist, album or artwork.
  Clients must resolve metadata against Spotify themselves. Spotify's public
  oEmbed endpoint does this with no credentials and sends
  `access-control-allow-origin: *`:

  ```
  GET https://open.spotify.com/oembed?url=https://open.spotify.com/track/{id}
  ```

  returning `title` and `thumbnail_url` (no artist — that needs the Web API's
  `GET /v1/tracks?ids=`, which requires an access token).

## Post Spotify favorites

```
POST /v4/spotify/favorites
```

Body: `SpotifyPostRequest`

```json
{"songIds":["73W9hTjmLXNwWcV9Gh5hmt"]}
```

Replaces the whole list — send the full desired set, not a delta.

## Auth, WIP

`grant_type` string, `refresh_token` string
| `grant_type` string, `code` string, `redirect_uri` string
| `grant_type` string

## Tracks, WIP

- GET /v1/search?q=string&type=string . SpotifySearchTrackResponse
- GET /v1/tracks?ids=string . SpotifyGetTrackResponse
- GET /v1/me/player/recently-played . SpotifyRecentlyPlayedResponse

