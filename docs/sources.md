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

Metadata search asks every enabled provider in a category at once and merges the
answers (`WorkSearchService.RegistryProviders`, `SearchRanking.Rank`). A category
fails only when every provider fails; a partial answer lists the failed categories in
`failedProviders` and is never cached as fresh. Ranking rules:

- A hit matches only when one of its own names matches the query. When a provider's
  top hit matches only loosely or not at all, search fetches that one hit's other names
  once (TMDB alternative titles, cached a day per credential and title with failures
  kept a minute; IMDb original title and AKAs for Cinemeta, fetched while Cinemeta
  answers; TVmaze AKAs, only when no name of the hit matches, since TVmaze already
  searches AKAs; AniList returns romaji and synonyms already) and keeps the best one
  that matches as an alias (`WithAlternateTitle`): "Money Heist" finds La Casa de
  Papel, "Gisaengchung" finds Parasite, "Se7en" finds Seven (1995). Hits with no
  matching name only merge into a card; they never add one, so "qwertyuiop" lists
  nothing.
- Work keys never move (`SearchRanking.AssignWorkKeys`). A record that is a stored work
  by its own IDs (`WorkIdentities`: it shares the stored work's provider ID, a canonical
  ID in `IdsJson` or a verified link) takes that work's key, and the other catalogs'
  records of the same work take it too, so a stored The Flash keeps `the-flash`. Records
  are grouped one name and kind at a time: records that share an ID are one work; in an
  era (start years a year apart) that no catalog lists twice, each catalog's record is
  the same work (Doctor Who 2005 at TVmaze and at TMDB); otherwise a record joins another
  only when each is the other's one fit, the same year breaking a tie (The Traitors UK
  2022 and US 2023, Hell's Kitchen UK 2004 and US 2005, in any order), and a record that
  stays unsure gets a card of its own rather than another work's key. A work is keyed
  by its name and the earliest year its records give within a year of the record its
  card shows (series as well as films), so the key always opens that record: Doctor Who
  1963, 2005 and 2023 and Hunter x Hunter 1999 and 2011 are separate cards, and TVmaze's
  Survivor 2023, which shares its IMDb ID with a show IMDb dates 2001, is
  `survivor-2023`. A series with no stored record takes a stored work of its name and era
  only when no ID contradicts it and it is the one work in the results that fits: a
  stored `tmdb:100` never lends its key to `tmdb:200`. When a stored work of the other
  kind or another identity, or another work in the same results, already holds a key,
  the work takes `-tv` or `-film` after it (`WorkKeySlug.KindKey`), then a record's own
  catalog ID (`WorkKeySlug.KeyCandidates`): a stored film `battlestar-galactica-1978`
  and the 1978 series `battlestar-galactica-1978-tv`, or `the-flash-2023-tv-tmdb200`. A
  kind-tagged key still matches release names by its name and year, but never takes a
  catalog row or watchlist row of the other kind.
- A title page and its downloads check that the link's record is the key's title
  (`TitleIdentity.Matches`): one of its names and its year, or the year beside it
  (catalogs date a start a year apart: TVmaze's Doctor Who 2023 is TMDB's 2024), give the
  key; a record that shares an ID with the work stored at the key always passes.
  `POST /api/title/{key}` decides with the same `WorkIdentities` test: the download goes
  to the stored work that shares an ID with the claim, wherever it is keyed (the claimed
  record's own work first, then one whose canonical IDs share it, then the nearest year);
  a work at the key whose ID contradicts the claim keeps its key, and the claim gets the
  first free kind-tagged key, as search names it. The answer carries the `workKey` the
  download went to, and the title page follows it in place (no new history entry), so the
  transfer shows on the page in front of the owner. TVmaze records carry the IMDb and
  TheTVDB IDs TVmaze reports, and TMDB records their TheTVDB ID (`WorkIds.Tvdb`), so a
  download from either finds a work saved from another catalog.
- Rails, similar titles, requests and on-demand still name an unstored series by its
  bare name; opening or downloading one reuses the stored work with the same provider
  ID or verified link, whatever its key. Watchlist rows carry their linked work's key
  (`workKey`) and open that page (`doctor-who-2005`, not `doctor-who`); a row with no
  linked work still opens the page its title names. A title page counts a watchlist row
  as its own when the row is linked to its work, or, unlinked, is of the page's kind,
  named alike, and was saved from this page or with one of the page's IDs; a download
  links only such a row. A legacy "Doctor Who" row saved from the 2023 show never counts
  for the 2005 page, and a Fargo (1996) film row never for the series.
- The same film from several providers is one card (`SameFilmSlot`: same era and
  name, or the same year and a one-letter difference such as Se7en and Seven). Its
  identity prefers an AniList anime film, then TVmaze, TMDB, Cinemeta and iTunes;
  the others add their IDs, aliases, poster and overview.
- Cinemeta years come from IMDb's original year, not a later regional release
  (Spirited Away 2001, not 2003).

Torrent sources fan out in registry order with per-source cancellation deadlines.
Existing work keys are retained; shared external IDs and work keys deduplicate search
results.
Recommendations remain optional and may be empty without a compatible provider.

## Files and merge rules

The embedded `server/TorrentFlow.Core/Sources/sources.default.json` ships the defaults.
`<dataDir>/sources.json` is an array of owner overrides keyed by `id`. A partial entry
replaces only the fields it supplies; arrays and `options` are replaced as a whole.
Entries with new IDs add a source. Disable a built-in source instead of deleting it.
Custom Torznab entries can be removed.

A default can list hosts its site has abandoned under `retired` (YTS: `yts.mx`; AnimeTosho:
`animetosho.org`). When a
saved entry, a legacy `*_BASE_URL` setting or a hand edit still names one as its base URL
or a mirror, the registry puts the shipped base URL in its place, so the live host is
tried first. The file is not rewritten; the next save from Settings stores the live URL.

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
`animetosho`, `subsplease`, `therarbg`, `torrentdownloadinfo`. Metadata types:
`tvmaze`, `anilist`, `cinemeta`, `tmdb`, `itunes`. The UI adds custom Torznab entries;
trusted configuration can reuse the other implementations.

## Torrent indexers

Every indexer is keyless, goes through `IndexerHttp` (per-host pacing, cool-down only
on a real 429 or 503 with Retry-After) and can be switched off in **Settings → Sources**.
Each adapter lives in `server/TorrentFlow.Search/Adapters/` and reuses the shared
`TorrentAdapter` helpers (`BaseUrl`, `Feed`, `V`, `HashFrom`, `Size`, `CategoryHint`).

| Id | Site | Format | Categories | Default | Pacing (per host) |
|----|------|--------|------------|---------|-------------------|
| `nyaa` | nyaa.si | RSS | anime | on | 2 at once, 1000 ms |
| `animetosho` | feed.animetosho.xyz, Anime Tosho NEW (308 to mirror feed.animetosho.net; `animetosho.org` retired) | JSON feed (Nyaa, TokyoTosho, AniDex mirror) | anime | on | 2 at once, 1000 ms |
| `subsplease` | subsplease.org | JSON search API, one row per resolution | anime | on | 1 at once, 1000 ms |
| `apibay` | apibay.org (The Pirate Bay) | JSON | all | on | 2 at once, 2000 ms |
| `torrentscsv` | torrents-csv.com | JSON | all | on | default |
| `knaben` | api.knaben.org | JSON meta-search (POST) over TPB, 1337x, TorrentGalaxy, RARBG caches and more | all | on | 2 at once, 1000 ms |
| `therarbg` | therarbg.com (mirrors therarbg.to, torrentgalaxy.one, torrentgalaxy.info) | JSON (`/get-posts/keywords:…:format:json/`) | all | on | 2 at once, 1000 ms |
| `bitsearch` | bitsearch.to | HTML with magnets in the list | all | on | 1 at once, 1500 ms |
| `limetorrents` | limetorrents.fun (mirror .lol) | search RSS, hash from the itorrents link | all | on | 1 at once, 1500 ms |
| `torrentdownloads` | torrentdownloads.pro | search RSS with `info_hash` | all | on | 1 at once, 1500 ms |
| `torrentdownloadinfo` | torrentdownload.info | search RSS, hash in the description | all | on | 1 at once, 1500 ms |
| `yts` | yts.lt (mirrors movies-api.accel.li, yts.gg) | JSON | movie | on | default |
| `eztv` | eztvx.to, eztv.wf | JSON by IMDb id | series | on | default |
| `1337x` | 1337x.to | HTML + detail pages | all | off | default |
| `archive` | archive.org | JSON | movie, series, anime | off | default |
| `torznab` | your Jackett/Prowlarr | Torznab XML | configurable | custom | default |

EZTV now reports `season`/`episode` as `0`, so the adapter reads them from the release
title and walks up to five pages (newest first) until it passes the wanted season.

### Language hints from AnimeTosho and apibay

Two sites also answer what is inside a release before it downloads (docs/release-language.md, "Hints before download"):

- AnimeTosho: `<base URL>/json?show=torrent&btih=<info hash>` (or `id=<AnimeTosho id>`), on the registry entry's
  hosts, the ones its search uses (default `https://feed.animetosho.xyz`, Anime Tosho NEW; it redirects to
  `feed.animetosho.net`, the mirror). It returns the torrent with `status` and `files[]`. Each file's
  `info.mediainfo` text lists the Video, Audio and Text tracks (Title, Language, Default, Forced): that is read first.
  Subtitle attachments come second: the original feed's per-file `attachments[]` with `info: {codec, lang, name,
  default, enabled, forced, trackid, tracknum}`, or Anime Tosho NEW's per-file or torrent-wide `attachments[]` with
  `info: {default, forced, format, language, language_code}`. An unknown hash answers 404. AnimeTosho mirrors nyaa's
  English-translated anime, so only those (and its own listings) are asked. The original `feed.animetosho.org`
  stopped processing new items in May 2026 and is retired in the registry; Anime Tosho NEW imported its archive
  (same ids, 630440 and 592301 exist there) and lists this week's releases, so the `animetosho` search is live again.
  Old batches the original skipped answer `status: "unknown"` with no files.
- apibay: `https://apibay.org/f.php?id=<TPB id>` returns `[{"name":["Subs/English.srt"],"size":[72229]}]`, or one
  `{"name":{"0":"Filelist not found"}}` entry. The apibay adapter keeps the TPB id on each result (`SiteId`). apibay's
  search answers nothing for some one-word queries (`Dune`, `Sintel`) while `Dune 2021` works.

Both lookups use the adapter's user agent through `IndexerHttp` (cool-down on a real 429 or 503 with Retry-After) and
their own line per site: AnimeTosho starts at least 1 s apart, up to 3 open; apibay 2 s apart, one at a time. Answers
are cached in the `ReleaseHint` table with the host that gave them, and dropped after 90 days (permanent misses stay). A
host that fails 3 times in a row (a plain 503 and a malformed answer count; a 429 or a 503 with Retry-After is a
cool-down) rests behind a breaker for 30 minutes, then gets one probe, so a dead or frozen site never slows a search.

SubsPlease lists only its own releases and reports no swarm counts; the tracker scrape
fills them in. It numbers each season from 01, so `Sousou no Frieren S2 - 01` finds the
episode and `Frieren 29` finds nothing there (Nyaa and AnimeTosho still match it).

TheRARBG's search matches the show name and ignores `SxxEyy`: `Seinfeld S04E11` returns
393 Seinfeld rows, 2 of them that episode. The adapter therefore drops rows that name
another season or episode. Bare anime numbers such as `Frieren 29` are not narrowed,
because `S02E01` can be the same episode; those rows rank below exact matches. Adult rows
are dropped. torrentgalaxy.one and torrentgalaxy.info serve the same index and act as its
mirrors.

TorrentDownload.info is a separate index from torrentdownloads.pro (10 of 50 hashes
overlapped for `Dune 2021`). Its titles come in slug form, for example
`Dune-2021-1080p-BluRay-x265-10bit-AAC5-1-[YTS-MX]`.

### Candidates checked and not added (re-checked 2026-10-01)

| Site | Why not |
|------|---------|
| TorrentGalaxy (torrentgalaxy.to and its older domains) | do not answer; the live torrentgalaxy.one/.info copies are `therarbg` mirrors |
| 1337x mirrors (1337x.to, 1337x.st, 1377x.to) | TLS failure, Cloudflare challenge or dead DNS. 1337xx.to is an unofficial copy that needs a detail page per row. |
| ext.to, idope.se, kickasstorrents.to, uindex.org, AniDex | Cloudflare challenge (403) |
| BT4G (bt4gprx.com) | DHT crawl: fake `EZTV - Downloader.exe` rows, unrelated rows for anime, 15 per page, no swarm counts |
| MagnetDL, GloTorrents (glodls.to) | time out |
| torrentz2.nz, yts.mx | DNS does not resolve |
| btdig.com | answers 429 on the first request |
| AniRena | search answers 404 |
| Rutor | Russian catalogue: nothing for TV or anime queries |
| TokyoTosho | base32 hashes and no swarm counts; AnimeTosho mirrors it with counts |
| Snowfl, Zooqle clones, Torlock, TorrentFunk, YourBittorrent, TorrentProject, tpb.party | token-gated JS, redirect-only, 502, or HTML without hashes in the list |

### Live matrix (2026-10-01)

One call per cell, `GET /api/search?q=<query>&sources=<id>&refresh=1&enrich=0&pageSize=200`,
against a freshly started scratch instance. `refresh=1` bypasses the search cache; the API
has no `skipCache` parameter. Counts are raw adapter results; time is the whole API call.
`1337x` and `archive` are off by default and were switched on for their rows only;
`archive` was measured on a second fresh instance after one warm-up query.

| Source | Dune 2021 | Scorpion S01E01 | Frieren 29 | Sousou no Frieren |
|--------|-----------|-----------------|------------|-------------------|
| `nyaa` | 0 (1.0 s) | 0 (0.4 s) | **24** (0.8 s) | **75** (0.9 s) |
| `animetosho` | 0 (0.8 s) | 0 (0.3 s) | **2** (0.7 s) | **75** (0.8 s) |
| `subsplease` (new) | 0 (0.6 s) | 0 (0.2 s) | 0 (0.2 s) ¹ | **80** (0.8 s) |
| `apibay` | **80** (0.6 s) | **24** (0.5 s) | 0 (<0.1 s) | **75** (0.5 s) |
| `torrentscsv` | **25** (0.9 s) | 0 (0.2 s) | 0 (0.2 s) | **25** (0.6 s) |
| `knaben` | **80** (1.4 s) | **19** (0.8 s) | **8** (0.6 s) | **80** (1.1 s) |
| `therarbg` (new) | **50** (1.0 s) | **20** (0.6 s) | **50** (0.6 s) ² | **50** (0.6 s) |
| `bitsearch` | **20** (1.3 s) | **20** (0.8 s) | **20** (0.9 s) | **20** (0.8 s) |
| `limetorrents` | **40** (1.1 s) | **38** (0.5 s) | **20** (0.6 s) | **40** (1.0 s) |
| `torrentdownloads` | **50** (0.9 s) | **50** (0.8 s) | **50** (0.7 s) | **50** (0.7 s) |
| `torrentdownloadinfo` (new) | **50** (1.1 s) | **33** (0.8 s) | **19** (0.4 s) | **50** (0.9 s) |
| `yts` (yts.lt) | **16** (1.4 s) | 0 (0.4 s) | 0 (0.4 s) | 0 (0.5 s) |
| `eztv` | 0 (0.6 s) | 0 (<0.1 s) ³ | 0 (0.2 s) | 0 (0.4 s) |
| `1337x` (off) | no valid response | no valid response | no valid response | no valid response |
| `archive` (off) | **50** (3.5 s) | 0 (0.4 s) | **1** (0.8 s) | **28** (2.1 s) |

1. SubsPlease numbers each season from 01; `Sousou no Frieren S2 - 01` returns 6 rows.
2. Other Frieren episodes and packs, none of them episode 29. In an all-source search the
   top 10 are episode 29 rows from nyaa, animetosho, torrentdownloads (a 29-38 batch) and
   bitsearch.
3. EZTV has no Scorpion S01. `Scorpion S02E03` returned 2 rows (0.6 s) and
   `The Bear S03E01` 11 rows (2.0 s).

YTS `Dune 2021` lists `Dune: Part One (2021)` (7 encodes) beside smaller films with the
same words. 1337x.to fails the TLS handshake from the test machine. On 2026-09-30
apibay.org answered 429 to every request, plain `curl` included; on 2026-10-01 it
answered normally. Internet Archive is the slowest source (up to 3.5 s here) and stays off
by default.

Five more queries for each new source, same call:

| Source | Query: count (time) |
|--------|---------------------|
| `therarbg` | The Bear S03E01: **24** (1.1 s); Oppenheimer 2023: **44** (0.7 s); Seinfeld S04E11: **2** (0.6 s); One Piece 1100: **50** (0.6 s); Shogun S01E01: **20** (0.7 s) |
| `torrentdownloadinfo` | The Bear S03E01: **16** (1.1 s); Oppenheimer 2023: **50** (0.9 s); Seinfeld S04E11: **4** (0.8 s); One Piece 1100: **2** (0.9 s); Shogun S01E01: **27** (0.9 s) |
| `subsplease` | One Piece 1100: **3** (0.8 s); Sousou no Frieren S2 - 01: **6** (0.9 s); Dandadan: **72** (1.4 s); Kaiju No. 8: **15** (0.7 s); Solo Leveling: **78** (1.1 s) |

All enabled sources together (no `sources=`, `refresh=1`): `Seinfeld S04E11` 2.1 s,
`Oppenheimer 2023` 1.5 s, `Frieren 28` 2.3 s, `Frieren 29` 1.5 s. With SubsPlease pointed
at a non-routable address, `Dandadan 12` still answered in 6.5 s: SubsPlease reported
`exceeded the 6000ms search budget` and the other twelve sources returned their results.

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

## Browse cards and catalog ids

Catalog rows (`CatalogEntry`: the home rails and the Because you're watching lists)
store the provider and id of the title they list, for example
Cinemeta with an IMDb `tt` id. Migration `AddCatalogProviderId` clears the old rows
once so they rebuild with ids. `GET /api/browse` cards carry `workKey`, `year`,
`provider` and `providerId`, and a card's link passes them to the title page.

`GET /api/title/{workKey}` returns `provider` and `providerId`: the link's id once the
provider confirms it, else the work's, else the catalog row's, else the link's
unconfirmed id; both are null when none is known. Request uses that id. With no id
the page says "Couldn't match this title to a catalog entry. Search for it to
request it." instead of showing a Request button.

The home page shows each title once. `BrowseService.DistinctAcrossRails` keeps one
seen set across the rails in order: your own rails first, then Because you're
watching, then the home rails in `HomeRails` order. The first card for a
work stays. Cards are the same work when they share a provider id, a work key, or a
normalised title and type (plus year for films), so a show listed by both Cinemeta
and TMDB still appears once. Each catalog rail claims only the cards it shows (24 on
a rail, 48 on a genre page) from up to 96 stored, so a rail stays full even when
earlier rails list the same titles.

## Home rails

`HomeRails` (`server/TorrentFlow.Metadata/Browse/HomeRails.cs`) is the one list of
home rails. Each rail has an id (`films-popular`, `series-crime`), a title, a kind
(films, series or anime), an optional genre and its feeds in order:

| Rails | With a TMDB key | Without a key |
|---|---|---|
| Popular films, Popular series | TMDB `trending/{movie,tv}/week` | Cinemeta `movie/top`, `series/top` |
| New films | TMDB discover: US digital or physical release in the last 90 days | Cinemeta `movie/year`, this year |
| New series | TMDB discover: first aired in the last 180 days | Cinemeta `series/year`, this year |
| Top rated films, Top rated series | TMDB discover by rating with a vote floor | none: the rail is left out |
| Film and series genres | TMDB discover `with_genres` | Cinemeta `top` with the genre |
| Anime this season, Trending anime, Top rated anime, anime genres | AniList | AniList |

`GET /api/browse` takes `type` (`films`, `series`, `anime`) and `genre` (a genre
rail's genre id) and answers 400 with a plain `error` for anything else. All shows
the featured rails, a type shows its featured rails then its genre rails, and a
genre page shows one rail of up to 48. `genres` lists the type's genre chips.

Rails refresh once per local day. A rail is refetched when it has no rows, its rows
are from an earlier day, or its preferred provider changed (a key was added or
removed). Only a feed that returns at least 6 titles replaces a rail, so a failed
or thin refresh keeps yesterday's rows. Nothing is shuffled. A request waits (up to
12 s) only for its view's rails that have no rows; the rest refresh in the
background, and the hourly worker refreshes every stale rail. Plan and proof:
`docs/home-categories-plan.md`.

Rows lead with what can be fetched now (`BrowseService.LeadWithAvailable`), judged by
the card gate that draws the "In cinemas" and "Coming" chips (`ReleaseGates.Gate`).
A film in cinemas moves to one In cinemas row, last on All and Films; a film not out
yet leaves home; an unaired series or anime moves to the end of its row. The hero is
the first ungated title, Because you're watching first. "In cinemas" follows TMDB
release dates (`HomeReleaseCache`, keyed by the card's TMDB id, or its work key when it
has none, so namesakes never share evidence; checked dates cached 6 h, misses kept in
memory 15 min and dropped as soon as the key changes). With no dates (no key, or TMDB
lists none) a film counts as in cinemas for 21 days after its release date
(`HomeRelease.UncheckedCinemaDays`). A film released more than 180 days ago is never
in cinemas, even when TMDB lists no home release for it (`HomeRelease.LongestCinemaRunDays`;
Se7en 1995 lists only theatrical dates). Title pages use the same gate
(`HomeRelease.TheatricalGateFromSignal`) and evidence, so a card and its title page
always agree.
