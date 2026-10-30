# Heatmap

Explore's heatmap: a rainbow flag on each gay neighbourhood Grindr knows, and heat where its users gather around it. The activity is historical, not live, and only exists for a few dozen cities. The request format was read from the official Android app (26.20.0, `com.grindrapp.android.explore.impl.heatmaps`).

## Every flagged place

`GET /v1/explore_heatmaps/all_locations` → `ExploreHeatmapsResponse` with `locations` only.

## Flags and heat around a point

`POST /v1/explore_heatmaps`

```json
{
  "coordinates": { "lat": 48.8566, "lng": 2.3522 },
  "searchSquareSide": 0.1,
  "includeHeatmaps": true
}
```

All three fields are required; a body without them gets `400 urn:gr:err:internal_error`, which names no field. The official app sends the centre of the visible map, `searchSquareSide = max(north - south, east - west)` of the visible bounds in degrees, and `includeHeatmaps: true`. It asks again only once the view leaves the last bounds it fetched.

## ExploreHeatmapsResponse

```json
{
  "locations": [
    {
      "id": 45,
      "type": "Neighbourhood",
      "name": "Le Marais",
      "nameDecoration": "🇫🇷",
      "containedInId": 44,
      "displayCoordinates": { "lat": 48.8607, "lng": 2.3574 },
      "exploreCascadeCoordinates": { "lat": 48.8607, "lng": 2.3574 }
    }
  ],
  "heatmaps": [
    { "heatmapId": 1400, "coordinates": { "lat": 48.8625, "lng": 2.3563 }, "intensity": 5 }
  ]
}
```

- `type` — `City` or `Neighbourhood`
- `name` — in the request's language (`Londres`, `Philadelphie`)
- `nameDecoration` — the country's flag emoji
- `containedInId` — the city a neighbourhood belongs to, `0` for a city
- `displayCoordinates` — where the flag is drawn
- `exploreCascadeCoordinates` — where Explore's profile search is pointed when the flag is picked
- `heatmaps[].intensity` — 1 to 5 in every answer seen so far; points sit a few hundred metres apart
