# Metadata

Register `services.AddMetadata(dataDirectory)` after Store registration. Metadata references
only Domain (plus the shared .NET framework for composition). `IMetadata` is implemented
through Domain ports and snapshots. No old server reference, database/ORM access, torrent parsing,
payload file writes, or additional hosted service.

## Catalog facts and storage

- TMDB v3 query credentials and v4 bearer credentials use `TMDB_API_KEY`, otherwise the
  typed metadata setting's protected `secrets\<FileId>.secret` in the supplied data directory.
  Credentials are excluded from HTTP cache keys and diagnostics; the credential digest
  partitions the cache.
- AniList, Cinemeta/IMDb and keyless TVmaze/iTunes share bounded, provider-specific HTTP
  gates. Unified title search queries all enabled catalogs concurrently, preserves remakes,
  normalizes whitespace/Unicode, and uses the legacy alias/typo tiers, native popularity,
  IMDb rank, upcoming/music penalties and explicit-year bonus. Movies, series and AniList
  lists are interleaved before deterministic ranking and cross-provider card merging.
  AniList participates in all/anime scope; IMDb suggestions enrich Cinemeta rather than
  becoming an independent extra catalog. Stored canonical IDs are borrowed without
  replacing a sequel's native name, year or TV/ONA/MOVIE format. Anime cards retain
  AniList precedence. Catalog identity is never inferred from a torrent name.
  Search cards with conflicting provider IDs never merge. Name-only film matches
  require the same release year; adjacent-year names alone cannot verify an ID.
- Work IDs survive verified-link enrichment and refresh. Ordered names retain English,
  original, romaji, native and synonym labels with link provenance. Equal names supplied
  by different providers may retain separate provenance, as the data model specifies.
  Refresh stays anchored to the requested verified identity, including converted works.
  An enrichment identity already claimed by another work remains suggested, rather
  than failing the refresh or silently moving targets between works. A conflicted
  commit is re-read and merged once before a refresh failure is returned.
- Season/episode snapshots include provider identifiers, runtime, nullable air times and
  day/instant precision. Specials have no absolute number. Anime sequel/cour chains
  overlay listing names/stills; incomplete walks and unknown counts are provisional.
  AniList airing schedules supply exact times, not dates invented from aired counts.
- TMDB `release_dates` types 1/2/3, 4 and 5 populate theatrical, digital and physical
  film dates. Browse and extras use one release-window calculation (21-day theatrical
  fallback only when home-release evidence is absent).
- Anime presentation prefers AniList synopsis, score/source, genres and artwork.
  Western presentation and numbering prefer verified TMDB, with keyless fallbacks.
  Premiere dates are read from provider detail caches into `WorkSnapshot.PremiereAt`,
  not inferred from airing schedules or copied into a second persisted fact.
- All catalog and raw provider/Fribb cache persistence uses the keyed Metadata `IStore`
  capability, CAS writes and durable commit receipts. Fribb's last-good map therefore
  lives in the database in the supplied data directory, not a second JSON truth store.
  It loads before resolution and refreshes conditionally in the background; failures,
  invalid responses and the 64 MiB limit leave the previous map intact. Refresh is
  weekly, with at most one maintenance check per six hours.
- Maintenance calls `RefreshAsync`; no independent timer is installed. It refreshes a
  bounded batch of old works and prunes expired non-last-good caches. Rejected links
  survive refresh. Removed map claims lose only their linked names. Episode IDs are
  preserved and renumbering is deferred while acquisition is active.
- A complete refreshed listing retires unreferenced obsolete seasons/episodes.
  Partial answers keep prior rows; referenced episode IDs survive as unavailable
  mappings rather than silently changing the meaning of a saved file/target/follow.
  Browse pools retain covered candidates before limits and replenish TMDB from
  five TMDB pages or two 50-item AniList/Cinemeta pages, yielding 24 featured cards
  or up to 48 genre-grid items.

HTTP calls have a 10-second total queue/network deadline (Cinemeta/TVmaze/iTunes 8s,
IMDb suggestions 5s, IMDb names 4s, Fribb 20s); no inline retry. AniList's one 700ms
start gate stays below 90/minute, background concurrency leaves a foreground slot,
and background network calls have 60s startup grace. Each provider admits at most 64
pending calls. Real 429/503 Retry-After cooldowns are independent; absent 429 headers
start at 30s and back off to 300s. AniList chains have a separate 12s total deadline.
Shared `Lazy<Task>` flights prevent eager duplicate HTTP work; waiter cancellation
does not cancel somebody else's lookup.

Provider JSON is parsed directly from a byte-limited response stream, without an
extra whole-response buffer. Fresh and last-good responses live in Store only:
there is no second process-resident cache of raw JSON documents. The Fribb lookup
index retains only its parsed ID/season columns in a dictionary, not an additional
full entry collection or raw response. Refresh builds a replacement index before
publishing it, so concurrent readers continue to see the previous complete map.
The home-server host uses concurrent workstation GC and memory-conservation level
9 to favor a smaller steady-state heap over peak throughput. No GC heap hard limit
is imposed: accepted provider responses can still require substantial transient
space during deserialization and persistence.

Confirmed misses are memoized 3m, search 5m fresh/24h stale, AniList queries 60s, work
details up to 7 days in Store, and season/airing answers 1h. Failed/partial answers
are never stored as successful negative results. Search preserves usable last-good
provider answers and reports partial/stale state. Browse caches ordered native listing
projections alongside canonical work IDs, refreshes daily, and keeps last-good rows on
failure. A newly configured preferred provider replaces a prior keyless fallback.
Listing reads never overwrite an existing canonical work with partial entry facts.
Only visible cards are claimed when deduplicating rails.

Featured queries match the old server: weekly TMDB trending; regional type 4/5 home
releases in the last 90 days; series premieres in the last 180 days; all-time
vote-average sorting with 5,000 film / 2,000 series votes. Series discovery excludes
news, talk, soap and the anime keyword. Genre vote floors are 300 films / 100 series.
AniList uses seasonal popularity, trending and score sorts without invented origin,
language or format restrictions. Unset AniList variables are omitted.
The personal home rail uses the latest watch intent and TMDB recommendations, even
for anime; anime title-page recommendations remain AniList. Checked release evidence
uses the old theatrical/home-date gate and 180-day maximum; unchecked evidence uses
21 days. Native listing projections retain the gate without duplicating canonical
release facts. Unconfigured TMDB-only top-rated film/series rails are omitted rather
than mislabeled keyless lists.

## Real-call verification

`tools\Test-MetadataContract.ps1` is an HTTP-only benchmark. A small separate diagnostic
composition host exposes `/resolve`, `/work/{id}`, `/search`, `/browse`, `/extras`,
`/links` and `/recommend` on loopback 3940, using real providers and a separate
`metadata-bench.db` in the scratch data directory. It is not part of the production API:

```powershell
dotnet run --project tools\metadata-host\MetadataHost.csproj
# In another terminal:
tools\Test-MetadataContract.ps1
```

`--DataDirectory` overrides the scratch directory, which the host creates when missing.
`/health` returns the exact process ID for cleanup. Do not run alongside the API on 3940.
`/proof/tmdb/{kind}/{id}` reads successful TMDB detail/season cache responses through
Store for verification; it excludes credentials and their cache-key digest. These
diagnostic routes are loopback-only and are not registered by the production API.
This is a diagnostic host, not a
benchmark with production references: the benchmark script talks HTTP only. The catalog
API phase should expose Domain operations through the preserved web contract, not retain
these diagnostic routes.

Nine-title evidence and full labelled names are in `tools\.metadata-proof\` (ignored
local artifacts), with times and provider IDs recorded on OPS-661. Nine titles passed
real kind/anime/identity checks, including Money Heist's original label and Frieren
S2E1 = absolute 29. Frieren's announced S3 has no confirmed count and is correctly
provisional; known S1/S2 retain their coordinates.

`tools\Test-MetadataTmdb.ps1` (PowerShell 7.5+) verifies the authenticated matrix,
successful applied TMDB responses rather than mapped IDs alone, and earliest type
4/5 dates against raw `release_dates`. Start a host with a fresh scratch directory
and inject the credential only into that child's `TMDB_API_KEY` environment; never
put it in arguments, evidence, logs or repository files. `-UseExistingResults`
checks an already-recorded matrix without replacing its cold/warm timings.

Authenticated evidence is in `tools\.metadata-proof\authenticated\`. All nine titles
used successful TMDB details. A Silent Voice has digital 2017-09-26 and physical
2017-05-17; Big Buck Bunny has digital 2008-04-10 and no physical evidence. Sintel
has neither type 4 nor type 5 evidence, so both dates correctly remain unknown.
All ten Frieren S2 air dates match TMDB's current continuous S1 episodes 29-38,
while the Domain snapshot presents S2E1-E10 / absolute 29-38 and retains AniList's
more precise airing instants. The supplied credential's authentication path was
tested; the alternate credential shape was not independently tested.

For missing-key verification, start another fresh host with `TMDB_API_KEY` removed
from its child environment, then run `tools\Test-MetadataTmdb.ps1 -Mode Keyless`.
It checks an actionable `unconfigured` TMDB failure, successful keyless Scorpion
fallback and the same healthy server PID after both requests.
