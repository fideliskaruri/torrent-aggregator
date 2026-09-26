# Sources

TorrentFlow works without a TMDB key. **Settings → Sources** controls metadata
providers and torrent indexers. Changes apply immediately; no restart is needed.

## Keyless defaults

- **Series:** TVmaze search, show details and episodes. Episodes retain the exact
  `airstamp` as well as the calendar air date. TVmaze IMDb and TVDB external IDs
  accompany search hits. Calls are paced at least 550 ms apart and cached for
  15 minutes.
- **Movies and series fallback:** Cinemeta search, IMDb-based details and charts;
  posters and backgrounds come from its responses.
- **Anime:** AniList.
- **TMDB:** optional. It cannot run without a usable credential. Its password-style
  key controls live inside the TMDB source card. Existing environment keys remain
  supported; saving a key overrides them and removing it restores the fallback.
- **EZTV:** obtains a show's IMDb ID from TVmaze, not TMDB.

Metadata search walks enabled providers by priority within each category and falls
back when a provider is unavailable or has no relevant result. Torrent sources fan
out in registry order with per-source cancellation deadlines. Existing work keys
are retained; shared external IDs and work keys deduplicate search results.
Recommendations remain optional and may be empty without a compatible provider.

## Files and merge rules

The embedded `server/TorrentFlow.Core/Sources/sources.default.json` ships the defaults.
`<dataDir>/sources.json` is an array of owner overrides keyed by `id`. A partial entry
replaces only the fields it supplies; arrays and `options` are replaced as a whole.
Entries with new IDs add a source. Disable a built-in source instead of deleting it.
Custom Torznab entries can be removed.

The file is re-read on registry access. Invalid external edits keep the last valid
snapshot and show an error in Settings. Correct or remove the invalid file before
writing through the UI. Writes use atomic replacement. Registry revisions isolate
caches, including changes made while older requests are still in flight.

```json
[
  { "id": "tvmaze", "priority": 5, "timeoutMs": 10000 },
  { "id": "yts", "enabled": false },
  {
    "id": "my-indexer",
    "kind": "torrent",
    "type": "torznab",
    "categories": ["movie", "series", "anime"],
    "enabled": true,
    "priority": 25,
    "baseUrl": "http://127.0.0.1:9117/api/v2.0/indexers/all/results/torznab/api",
    "mirrors": [],
    "timeoutMs": 15000,
    "options": {},
    "credential": "replace-with-your-indexer-key"
  }
]
```

Use the full Torznab API endpoint supplied by Jackett or Prowlarr. Do not put
credentials in URLs or `options`; use `credential`. Base URLs and mirrors must use
HTTP(S), without query strings, fragments or embedded user credentials. Timeouts
are 500–60000 ms. Lower priorities run first. Supported category aliases include
`movies` → `movie` and `tv` → `series` at the search boundary.

Adapters are implementations in code, not executable plugins loaded from JSON.
Supported torrent types: `nyaa`, `apibay`, `torrentscsv`, `yts`, `eztv`, `1337x`,
`archive`, `torznab`. Metadata types: `tvmaze`, `anilist`, `cinemeta`, `tmdb`,
`itunes`. The UI adds custom Torznab entries; trusted configuration can reuse the
other implementations.

## Credentials and local owner API

Protect the data directory: `sources.json` stores credentials **unencrypted**.
Registry responses contain only configured flags and masked hints, never saved
credential values. The old `tmdb-settings.json` key is migrated to the TMDB source
and the old file removed on startup.

TMDB precedence: source credential → `TorrentFlow:Metadata:TmdbApiKey` →
`TMDB_API_KEY`. Setting the TMDB source disabled overrides all credentials.
Legacy indexer base URL overrides are applied below the owner overlay for
compatibility; prefer the Sources page for new configuration.

- `GET /api/settings/sources`: safe source list and optional load error.
- `PUT /api/settings/sources/{id}`: partial update; new entries must be Torznab.
- `DELETE /api/settings/sources/{id}`: remove a custom entry.
- `POST /api/settings/sources/{id}/test`: bounded connectivity test, `ok` or
  `unavailable`. This checks the configured endpoint, not every search operation.
- Existing `/api/settings/tmdb` GET/PUT/DELETE and `/test` remain compatible.

Mutations reject cross-site and same-site browser writes. These are local-owner
settings; do not expose an unauthenticated host to untrusted networks.
