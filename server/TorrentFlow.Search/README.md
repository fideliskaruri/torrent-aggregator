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
    string query, string? category, IReadOnlyList<TorrentResult> results,
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
- With the Metadata module registered, only the first page's first 20 rows are
  enriched. Query and up to six distinct release lookups run together within
  one 450 ms budget (500 ms outer safety deadline); completed identity-compatible
  answers survive slower lookups. Unfinished metadata is optional, not a failed
  search. Pagination, totals, magnets and all response fields stay unchanged.
- Resolver work shares four process-wide lookup slots, including priming and
  work finishing after an HTTP waiter leaves. Queue waits are bounded to 450 ms.
  Existing provider timeouts bound active requests; slots stay held until those
  requests actually finish. Identical normalized title/year/category lookups
  share a flight and the bounded 1,000-entry cache (30-minute hits, three-minute
  definitive misses). Bracketed years remain part of the identity. Late answers
  warm the cache for subsequent searches.
- Structured timing logs separate indexer fan-out, tracker scrape, cached-pool
  loading and metadata enrichment. Slow indexers still have their own deadline;
  the metadata budget is not a whole-search timeout.

### Enrichment latency regression (September 28, 2026)

Live API on `127.0.0.1:3926`, isolated data at
`D:\code\memtest\search-perf-data`, library scheduler disabled. For each query,
`enrich=0` first warmed the indexer pool, then the default enriched request
measured cold metadata. The API was restarted between baseline and changed code.
These are client wall-clock milliseconds, not a synthetic delay benchmark.

| Query | Before | After | Results (both) |
|---|---:|---:|---:|
| big buck bunny | 7,029 | 555 | 23 |
| night of the living dead | 5,113 | 474 | 64 |
| sintel | 8,691 | 468 | 40 |

The three-query median fell from **7,029 ms to 474 ms**. Later enriched
`refresh=1` requests (warm upstreams/metadata, re-fetching indexers) took
446 / 946 / 929 ms, median 929 ms. Cold indexer-only requests still varied:
1,763 / 2,474 / 3,228 ms after the change; this fix does not promise sub-2.5 s
responses when indexers themselves are slow.

Root cause: enrichment awaited the query's entire catalog-provider ladder before
starting release lookups, then awaited the slowest release ladder with no
interactive deadline. Existing single-flight caching helped repeat requests but
did not bound a cold miss; the WorkSearch resolver path also did not cache misses.

Run `dotnet test TorrentFlow.slnx -p:SkipWebBuild=true` from the repository root
(`dotnet test server` cannot discover the solution because it lives at the root).
Regression tests cover timeout, caller cancellation, partial metadata, concurrency
after timeout, normalized single-flight/cache hits, year separation, miss expiry,
release/row caps and pagination without later-page enrichment.

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
keyless in the monolith: TVmaze supplies its IMDb lookup. Settings → Sources and
the `<dataDir>/sources.json` overlay select adapters, enabled state, category scope,
priority, mirrors and timeouts without restarting. Embedded `sources.default.json`
provides defaults. Multiple custom `torznab` entries can target Jackett/Prowlarr
indexers with separate credentials. See [Sources](../../docs/sources.md).
Standalone Search module deployments retain the legacy TMDB configuration fallback
when no `IKeylessSeriesLookup` is supplied.

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

- Standalone Search has a no-op enricher. The API host registers the Metadata
  module's bounded, best-effort implementation described above.
- Real swarm attachment requires the Engine implementation of `ISwarmProbeEngine`.
  Classification, persistence, expiry and safe lifecycle behavior are tested with
  fakes; no live swarm or torrent download was used for verification.
- All six adapters have fixture coverage. The opt-in Chromium/1337x fallback is
  fake-tested, not a live claim that this network can bypass a Cloudflare wall.
  EZTV's live count was zero without a TMDB key; keyed behavior is fake-tested.
