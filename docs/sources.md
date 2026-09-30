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
`archive`, `torznab`, `knaben`, `bitsearch`, `limetorrents`, `torrentdownloads`,
`animetosho`. Metadata types: `tvmaze`, `anilist`, `cinemeta`, `tmdb`,
`itunes`. The UI adds custom Torznab entries; trusted configuration can reuse the
other implementations.

## Torrent indexers

Every indexer is keyless, goes through `IndexerHttp` (per-host pacing, cool-down only
on a real 429 or 503 with Retry-After) and can be switched off in **Settings → Sources**.
Each adapter lives in `server/TorrentFlow.Search/Adapters/` and reuses the shared
`TorrentAdapter` helpers (`BaseUrl`, `Feed`, `V`, `HashFrom`, `Size`, `CategoryHint`).

| Id | Site | Format | Categories | Default | Pacing (per host) |
|----|------|--------|------------|---------|-------------------|
| `nyaa` | nyaa.si | RSS | anime | on | 2 at once, 1000 ms |
| `animetosho` | feed.animetosho.org | JSON feed (Nyaa, TokyoTosho, AniDex mirror) | anime | on | 2 at once, 1000 ms |
| `apibay` | apibay.org (The Pirate Bay) | JSON | all | on | 2 at once, 2000 ms |
| `torrentscsv` | torrents-csv.com | JSON | all | on | default |
| `knaben` | api.knaben.org | JSON meta-search (POST) over TPB, 1337x, TorrentGalaxy, RARBG caches and more | all | on | 2 at once, 1000 ms |
| `bitsearch` | bitsearch.to | HTML with magnets in the list | all | on | 1 at once, 1500 ms |
| `limetorrents` | limetorrents.fun (mirror .lol) | search RSS, hash from the itorrents link | all | on | 1 at once, 1500 ms |
| `torrentdownloads` | torrentdownloads.pro | search RSS with `info_hash` | all | on | 1 at once, 1500 ms |
| `yts` | yts.lt, movies-api.accel.li | JSON | movie | on | default |
| `eztv` | eztvx.to, eztv.wf | JSON by IMDb id | series | on | default |
| `1337x` | 1337x.to | HTML + detail pages | all | off | default |
| `archive` | archive.org | JSON | movie, series, anime | off | default |
| `torznab` | your Jackett/Prowlarr | Torznab XML | configurable | custom | default |

EZTV now reports `season`/`episode` as `0`, so the adapter reads them from the release
title and walks up to five pages (newest first) until it passes the wanted season.

### Candidates checked and not added (2026-09-30)

| Site | Why not |
|------|---------|
| TorrentGalaxy (torrentgalaxy.one), TheRARBG | list pages have no hash; each row needs a detail fetch. Knaben already caches both. |
| 1337x mirrors (1337x.to, 1337x.st, 1377x.to) | TLS failure, Cloudflare challenge or dead DNS |
| ext.to, idope.se, kickasstorrents.to, uindex.org | Cloudflare challenge (403) |
| MagnetDL, GloTorrents (glodls.to) | time out |
| torrentz2.nz, yts.mx | DNS does not resolve |
| btdig.com | answers 429 on the first request |
| Rutor | Russian catalogue: nothing for TV or anime queries |
| TokyoTosho | base32 hashes and no swarm counts; AnimeTosho mirrors it with counts |
| SubsPlease | only its own releases; AnimeTosho and Nyaa carry them |
| Snowfl, Zooqle clones, Torlock, TorrentFunk, YourBittorrent, TorrentProject, tpb.party | token-gated JS, redirect-only, or HTML without hashes in the list |

### Live matrix (2026-09-30, `/api/search?...&sources=<id>&skipCache=true&enrich=0`)

Counts are raw adapter results; time is the whole API call. `1337x` and `archive` were
switched on in a scratch instance for this run only.

| Source | Scorpion S01E05 | Scorpion S02E03 | Dune 2021 | Frieren 05 | Seinfeld S04E11 |
|--------|-----------------|-----------------|-----------|------------|-----------------|
| nyaa | 0 (1.1 s) | 0 | 0 | **53** (1.0 s) | 0 |
| animetosho | 0 | 0 | 0 | **62** (0.8 s) | 0 |
| apibay | 429 from apibay.org | 429 | 429 | 429 | 429 |
| torrentscsv | 0 | **1** (0.9 s) | **25** (0.6 s) | **22** (0.7 s) | 0 |
| knaben | **19** (3.2 s) | **4** (1.1 s) | **80** (1.0 s) | **14** (0.8 s) | **10** (0.8 s) |
| bitsearch | **20** (2.1 s) | **20** (1.9 s) | **20** (1.1 s) | **20** (1.8 s) | **6** (1.6 s) |
| limetorrents | **40** (1.3 s) | **17** (0.9 s) | **40** (0.9 s) | **18** (1.7 s) | **3** (0.5 s) |
| torrentdownloads | **50** (0.9 s) | **50** (0.8 s) | **50** (0.5 s) | **50** (0.7 s) | **50** (0.8 s) |
| yts | 0 | 0 | **16** (0.9 s) | 0 | 0 |
| eztv | 0 (EZTV has no S01) | **2** (1.6 s) | 0 | 0 | 0 (not on EZTV) |
| 1337x (off) | TLS failure | TLS failure | TLS failure | TLS failure | TLS failure |
| archive (off) | 0 | 0 | **50** (3.5 s) | **7** (6.2 s) | 0 |

apibay.org answered 429 to plain `curl` from the test machine for the whole run as
well, so it was the site limiting this IP, not the adapter; the cool-down skipped it as
designed. Sample titles: `Scorpion.S01E05.Plutonium.Is.Forever.720p.WEB-DL` (knaben),
`Scorpion S02E03 720p HDTV X264-DIMENSION EZTV` (eztv), `Dune (2021) [1080p] [WEBRip]
[5.1] [YTS.MX]` (bitsearch), `[Erai-raws] Sousou no Frieren - 05 [1080p]` (animetosho),
`Seinfeld S04E11 The Contest 1080p HEVC x265-MeGusta` (limetorrents).

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
  `unavailable`. Torznab requires valid XML with a `caps` root; an HTML login page
  or API error is a failure even with HTTP 200. This checks the configured endpoint,
  not every search operation.
- Existing `/api/settings/tmdb` GET/PUT/DELETE and `/test` remain compatible.

Title links accept `provider` and `providerId` (`externalId` remains a compatibility
alias) for TVmaze, Cinemeta, iTunes, AniList and TMDB. The same by-ID lookup verifies
acquisition claims. TVmaze season/episode details work without a TMDB credential.

Mutations reject cross-site and same-site browser writes. These are local-owner
settings; do not expose an unauthenticated host to untrusted networks.
