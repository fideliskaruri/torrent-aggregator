# Metadata

Register `services.AddMetadata(dataDirectory)` after Store registration. Metadata references
only Domain (plus the shared .NET framework for composition). `IMetadata` is implemented
without changing Domain. No old server reference, database/ORM access, torrent parsing,
payload file writes, or additional hosted service.

## Catalog facts and storage

- TMDB v3 query credentials and v4 bearer credentials use `TMDB_API_KEY`, otherwise the
  typed metadata setting's protected `secrets\<FileId>.secret` in the supplied data directory.
  Credentials are excluded from HTTP cache keys and diagnostics; the credential digest
  partitions the cache.
- AniList, Cinemeta/IMDb and keyless TVmaze/iTunes share bounded, provider-specific HTTP
  gates. Unified title search queries all enabled catalogs concurrently, preserves remakes,
  normalizes whitespace/Unicode, and ranks typo/alias matches. Catalog identity is never
  inferred from a torrent name.
- Work IDs survive verified-link enrichment and refresh. Ordered names retain English,
  original, romaji, native and synonym labels with link provenance. Equal names supplied
  by different providers may retain separate provenance, as the data model specifies.
- Season/episode snapshots include provider identifiers, runtime, nullable air times and
  day/instant precision. Specials have no absolute number. Anime sequel/cour chains
  overlay listing names/stills; incomplete walks and unknown counts are provisional.
  AniList airing schedules supply exact times, not dates invented from aired counts.
- TMDB `release_dates` types 1/2/3, 4 and 5 populate theatrical, digital and physical
  film dates. Browse and extras use one release-window calculation (21-day theatrical
  fallback only when home-release evidence is absent).
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

HTTP calls have a 10-second total queue/network deadline (Cinemeta/TVmaze/iTunes 8s,
IMDb suggestions 5s, IMDb names 4s, Fribb 20s); no inline retry. AniList's one 700ms
start gate stays below 90/minute, background concurrency leaves a foreground slot,
and background network calls have 60s startup grace. Each provider admits at most 64
pending calls. Real 429/503 Retry-After cooldowns are independent; absent 429 headers
start at 30s and back off to 300s. AniList chains have a separate 12s total deadline.
Shared `Lazy<Task>` flights prevent eager duplicate HTTP work; waiter cancellation
does not cancel somebody else's lookup.

Confirmed misses are memoized 3m, search 5m fresh/24h stale, AniList queries 60s, work
details up to 7 days in Store, and season/airing answers 1h. Failed/partial answers
are never stored as successful negative results. Stale search is used only when all
catalogs fail. Browse caches ordered work IDs, refreshes daily, keeps its provider on
failure, and claims only actually visible cards when deduplicating rails. Unconfigured
TMDB-only top-rated film/series rails are omitted rather than mislabeled keyless lists.

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
