# Search module

The read-only `search-latency` working tree is the TypeScript specification
(base commit `4520a6554993933abfb8c476d5a60ff05a60989f`, including its uncommitted changes).
The API host discovers `SearchController`; no host or other module changes are required.

## Port map

| TypeScript | C# |
|---|---|
| `torrents/types.ts` | `TorrentFlow.Core/Contracts/Search/SearchContracts.cs` |
| `torrents/aggregator.ts` | `TorrentSearchService.cs` |
| `torrents/search-cache.ts` | `SearchCacheStore.cs` |
| `torrents/target-resolution.ts` | `TorrentSearchService.cs` (local settings and validated per-call override) |
| `torrents/adapters/{nyaa,apibay,torrentscsv,yts,eztv,x1337}.ts` | `Adapters/TorrentAdapters.cs` (six individual adapter classes) |
| `torrents/adapters/{mirrors,timeouts}.ts` | `Adapters/IndexerHttp.cs`, adapter-specific request budgets |
| `torrents/browser.ts` | `Adapters/BrowserFetcher.cs` |
| `torrents/quality.ts` | `ReleaseQuality.cs` |
| `torrents/ranking.ts` | `ReleaseRanking.cs` |
| `torrents/episodes.ts` | `EpisodeParser.cs` |
| `torrents/filters.ts` | `SearchFilters.cs` / `TorrentFilters` |
| `torrents/infohash.ts` | `InfoHash.cs` |
| `torrents/{work-identity,work-match,media-alias}.ts` | `WorkIdentity.cs` |
| `torrents/{pack-preference,pack-episode-files,season-plan}.ts` | `EpisodeSelection.cs` |
| `torrents/swarm-probe.ts` | `SwarmHealth.cs`, `Core/Contracts/Search/SwarmContracts.cs` |
| `torrents/{source-labels,search-scopes}.ts` | `SearchVocabulary.cs` (backend vocabulary; navigation/display scope tables remain SPA concerns) |
| `download/{attach-route,smart-category}.ts` | `DownloadRouting.cs`, `ContentClassifier.cs` |
| `app/api/search/route.ts` | `SearchController.cs` |

Neither reference worktree contains `src/lib/search/pagination.ts`. The actual
pagination implementation lives in `aggregator.ts` and is ported into the service:
20 default, 200 maximum, clamped page, complete filtered-pool totals.

## Public integration contracts

```csharp
Task<SearchResponse> ITorrentSearchService.SearchAsync(
    SearchOptions options, CancellationToken cancellationToken = default);

Task<IReadOnlyList<TorrentResult>> ISearchResultEnricher.EnrichAsync(
    string query, IReadOnlyList<TorrentResult> results,
    CancellationToken cancellationToken = default);

Task<SwarmLiveState> ISwarmProbeEngine.FindLiveAsync(
    string infoHash, CancellationToken cancellationToken);
Task<IIsolatedSwarmProbe> ISwarmProbeEngine.OpenIsolatedAsync(
    string magnet, CancellationToken cancellationToken);
// IIsolatedSwarmProbe exposes Snapshot and implements IAsyncDisposable.
```

`SearchOptions` includes query, category, limit, page/pageSize, sources, target
resolution, filters, skipCache, enrich, background, adapterDeadlineMs and routing.
DTOs are immutable records and use the host's camelCase/null-omission policy,
with explicit-null annotations where required.

The default result enricher is registered with `TryAddSingleton` and leaves rows
unchanged. Metadata can register its implementation using `AddSingleton` or
`Replace`. The same pattern applies to the engine-owned swarm seam. Without an
engine backend, liveness is **unknown**, never assumed absent; no torrent is added.
Probe sessions must be isolated from real downloads and dispose their own data.

## Concurrency, cache and bounds

- All selected indexers start concurrently. Only the HTTP route opts into the
  six-second per-adapter display deadline; background searches ignore it.
- Late adapters continue within a bounded 24-slot execution pool, update mirror
  health, and have failures observed/logged. Deadline-truncated pools are never
  persisted or placed in the memory cache.
- Identical calls share one in-flight fan-out. At most 64 distinct fan-outs are
  retained, and a caller cancelling its wait does not cancel other waiters.
  Fresh/background/deadline policies never coalesce with one another.
- API responses are capped at 8 MiB. Adapter limits, four-way 1337x details,
  mirror state (32 preferred / 128 failed), and EZTV IMDb answers (500 / one-day
  TTL) are bounded.
- Search results use a three-minute TTL and at most 500 memory entries and
  persisted `SearchCache` rows. Stable SHA-256 keys retain the TS canonical
  object ordering, nested filters and target resolution.
- Two fixed rate buckets budget real fan-outs: interactive 40/minute and
  background 15/minute. Cache hits do not consume budget. Stale fallback is
  allowed under throttling, except when `skipCache` requests freshness.
- Failed mirrors are demoted for five minutes, not excluded. Good hosts lead;
  network/403/429/5xx/unproven-404 failures and HTML challenges fail over.
- All persistence uses the shared EF context factory and original table schema.
  There are no schema changes or new package dependencies.

## Optional browser configuration

1337x remains opt-in (`ENABLE_1337X=1`, or explicitly requested as a source).
`X1337_USE_PLAYWRIGHT=1` retains the existing opt-in name. In .NET the fallback
uses an isolated Chromium DevTools session rather than Node/Playwright.
Set `TorrentFlow:Search:BrowserExecutable` to an installed Chromium executable;
Windows Edge/Chrome installations are also detected. No browser is bundled or
downloaded. Its profile is confined to the configured data directory, and its
own process tree/profile are cleaned up. One browser at a time, 40-second total
budget, 14-second plain search and 10-second detail budgets.

All indexer base URL environment overrides are preserved. Corresponding
`TorrentFlow:Search:<ENV_NAME>` configuration keys take precedence. EZTV remains
optional when no TMDB credential is available. Settings → Metadata saves a key in
the data directory and takes precedence over `TorrentFlow:Metadata:TmdbApiKey` /
`TMDB_API_KEY`. Metadata and EZTV share the same live provider; saving or removing
the override takes effect immediately, including cached lookups. Standalone Search
module deployments retain the legacy Search configuration fallback.

## Verification

On September 25, 2026:

- `dotnet build TorrentFlow.slnx`: succeeded, zero warnings/errors.
- `dotnet test server/tests/TorrentFlow.Search.Tests`: **8,222 passed**.
  This includes **8,160 TS-derived pure parity cases** and **62** adapter,
  SQLite cache, concurrency, rate-limit, route and swarm-safety cases.
- The gzip JSON fixture is approximately 113 KB, not an eight-megabyte duplicated
  matrix. `GenerateFixtures.cjs` runs the original assertions, records their pure
  calls, and refuses to replace the fixture if the reference assertions fail.
  Unit tests require neither Node nor any network access.
- Live API: port **5101**, data directory `D:\code\memtest\port-search`.
  Reference: TS aggregator with a separate copied SQLite database under
  `D:\code\memtest`. Calls used `pageSize=200&category=all`, no torrent downloads.

| Query | .NET results / ms | TS results / ms | Matching info hashes |
|---|---:|---:|---:|
| dune | 127 / 2920 | 127 / 3073 | 127 |
| ubuntu | 91 / 1414 | 91 / 1972 | 91 |
| big buck bunny | 23 / 1915 | 23 / 3446 | 23 |

All top-level JSON keys, per-source counts and complete result hash sets matched.
`tests/TorrentFlow.Search.Tests/live-parity.json` preserves the detailed report;
`LiveParity.cjs` is an explicit opt-in reproduction script, never a unit test.
Both API hosts started during verification and all TS processes were stopped.
Port 3000 and the main repository were never touched.

### Integration boundaries / unverified paths

- Metadata enrichment intentionally remains the requested no-op. The reference
  emits an extra optional `metadata` property for enriched rows; full metadata
  and artwork parity requires the Metadata module's implementation.
- Real swarm attachment requires the Engine implementation of `ISwarmProbeEngine`.
  Classification, persistence, expiry and safe lifecycle behavior are tested with
  fakes; no live swarm or torrent download was used for verification.
- All six adapters have fixture coverage. The opt-in Chromium/1337x fallback is
  fake-tested, not a live claim that this network can bypass a Cloudflare wall.
  EZTV's live count was zero without a TMDB key; keyed behavior is fake-tested.
