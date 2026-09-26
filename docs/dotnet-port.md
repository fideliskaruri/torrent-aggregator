# TorrentFlow .NET port

TorrentFlow is moving from a Next.js full-stack app to an ASP.NET Core backend with a React SPA,
modeled on CoCo Artifacts: one ASP.NET Core host that serves the JSON API and the built SPA.

## Goals

- Same product, same behaviour. The Next.js app in `src/` is the specification until parity is reached.
- The .NET API keeps the existing `/api/*` routes, query parameters and JSON shapes, so the React UI
  moves over with minimal changes. When a route's behaviour is unclear, read the Next.js route and
  its tests; they are the contract.
- Existing users keep their data: the EF Core model maps the same SQLite tables and columns that
  Prisma created, and `DatabaseInitializer` adopts an existing Prisma database.
- Lower memory and real parallelism: bounded concurrency with `Channel<T>` / `SemaphoreSlim`,
  `IHttpClientFactory`, streaming instead of buffering, no unbounded caches.
- Install and run with `.\run.ps1` (Windows) or `sh ./run.sh` (Linux/macOS). No Docker.
  API builds install the frozen web lockfile and build the SPA incrementally. The CLI's
  `VSTestSessionCorrelationId` skips the web target during `dotnet test`; standalone test-project
  builds pass `SkipWebBuild=true` through references. Tests need no Node/pnpm installation.

## Layout

```text
TorrentFlow.slnx
Directory.Build.props         net10.0, nullable, lock files
Directory.Packages.props      central package versions (add new packages here)
server/
  TorrentFlow.Api/            host: Program.cs, module wiring, SPA hosting, /api/health
  TorrentFlow.Core/           shared contracts (Contracts/<Area>/...), pure helpers
  TorrentFlow.Data/           EF Core SQLite: entities, DbContext, migrations, LocalUser, Ids
  TorrentFlow.Search/         indexer adapters, release parsing, ranking, search cache, /api/search
  TorrentFlow.Metadata/       metadata providers, catalog, browse, artwork, suggest, titles search
  TorrentFlow.Engine/         MonoTorrent engine, download queue, client/torrents API, settings
  TorrentFlow.Library/        watchlist, on-demand grabs, rules, automation, history, activity
  TorrentFlow.Media/          streaming, ffmpeg/HLS, probes, subtitles, playback, prewarm
  tests/TorrentFlow.<X>.Tests xUnit
web/                          Vite + React SPA (built into web/dist, served by the API host)
```

## Conventions

- Each module exposes `Add<X>Module(IServiceCollection, IConfiguration)` in `<X>Module.cs`; the host
  already calls it and discovers the module's controllers. Do not edit `Program.cs` from a module.
- Controllers are thin: `[ApiController]`, attribute routes matching the Next.js paths exactly
  (`[Route("api/search")]`). Logic lives in services registered by the module.
- JSON is camelCase and omits nulls (`JsonIgnoreCondition.WhenWritingNull`). If a Next.js route
  returns an explicit `null`, use `[JsonIgnore(Condition = JsonIgnoreCondition.Never)]` on that field.
- Cross-module calls go through interfaces in `TorrentFlow.Core/Contracts/<Area>/`. The module that
  implements an interface owns its file. Modules never reference each other's projects.
- Data access: inject `IDbContextFactory<TorrentFlowDbContext>` for background or concurrent work,
  or the scoped `TorrentFlowDbContext` in request handlers. The local user id is `LocalUser.Id`.
  New ids come from `Ids.New()`. DateTimes are UTC.
- Schema changes are EF migrations in `TorrentFlow.Data/Migrations` (`dotnet ef migrations add <Name>
  --project server/TorrentFlow.Data --startup-project server/TorrentFlow.Api`). Coordinate: only the
  integrating controller merges schema changes.
- Options: bind a POCO with `services.AddOptions<T>().Bind(config.GetSection("TorrentFlow:<X>"))
  .ValidateDataAnnotations().ValidateOnStart()`.
- Background work: `BackgroundService` plus `Channel<T>`; never fire-and-forget without logging.
- Outbound HTTP: named or typed clients via `IHttpClientFactory`, with explicit timeouts.
- Comments only where the reason is not obvious. Port the reasoning from the TypeScript comments
  when it explains a real constraint.
- Tests: xUnit in `server/tests/TorrentFlow.<X>.Tests`. Port the TypeScript tests' assertions for the
  logic you port. No network in unit tests; use fake `HttpMessageHandler`s and HTML fixtures.
- Globalization: ICU is on, so `string.Normalize` matches JS `String.prototype.normalize`. The host
  pins the default culture to invariant; still pass `CultureInfo.InvariantCulture` and use ordinal
  comparisons in code. On Linux, install `libicu` (present on most distros).
- Memory: the host runs workstation GC (`ServerGarbageCollection=false` in `TorrentFlow.Api.csproj`).
  Server GC grows its gen0 budget until GC committed is ~3x the live heap, which alone pushed the
  process past the 200 MB target under 5 live downloads. Watch `runtime` in
  `/api/diagnostics/health` (working set, private bytes, GC heap/committed, threads, handles);
  judge leaks by private bytes and the post-GC heap, not working set (~100 MB of it is shared images).

## Data location and recovery

Both `dotnet run` and the published executable now use the same per-user app data folder:
Windows `%LOCALAPPDATA%\TorrentFlow`, Linux `$XDG_DATA_HOME/TorrentFlow` (or
`~/.local/share/TorrentFlow`), and macOS `~/Library/Application Support/TorrentFlow`.
It contains `torrentflow.db`, engine metadata/resume state, secrets and caches. The host logs
the resolved directory and passes it to every module. The media download folder is separate.

`TorrentFlow__DataDirectory` / `TorrentFlow:DataDirectory` remains the highest-priority override.
A `portable` file beside the application DLL/executable instead selects its adjacent `data` directory.
Use explicit overrides for tests and isolated instances. `TorrentFlow__DatabasePath` still overrides
only the SQLite file, not other app state.

On first use of the new default, if it has no `torrentflow.db`, the host checks the old
`<ContentRoot>/data` then `<application directory>/data`. It snapshots SQLite using the online
backup API (including committed WAL contents; SHM is rebuilt), copies engine/settings state, and
publishes the database last. A migration lock serializes simultaneous launches. Existing destination
files are never overwritten; the source is retained. Errors stop startup rather than silently
opening an empty database. Explicit and portable directories are not automatically migrated.

### My downloads disappeared

1. Open **Downloads → Details** or **Settings → Downloads** and compare the app data folder
   with your previous installation. “Connected” means the engine responds, not that old records
   were located. Changing clones used to select a different database, while the UI suggested the
   same default media folder.
2. If your old data is in another clone, stop TorrentFlow and launch with
   `TorrentFlow__DataDirectory` pointing to that old data directory. Back up the **whole** directory;
   do not copy only an open SQLite database and discard its `-wal`.
3. If only media files remain, choose and **save** the existing download folder, then click
   **Import existing downloads** in Settings (also offered on an empty Downloads page).
   Recovery is repeatable: existing tracked files are skipped. Video files without metadata become
   completed, kept, non-seeding rows; they use the usual Library, playback and deletion paths.
   Playback still requires enabling the existing streaming feature.
4. Matching `.torrent` metadata from `engine/torrents` or `engine/metadata` restores a real torrent
   against existing files for hash checking and seeding. Fast-resume data alone cannot identify
   the original files without torrent metadata. Non-media, links, empty files and `.part` files are
   skipped. Inspect potentially incomplete files before importing: without torrent metadata their
   original checksum/completeness cannot be proven.

Storage diagnostics and recovery are owner-only and not available over remote access.

## External torrent clients

`TorrentFlow.Engine/Clients/External` owns qBittorrent Web API v2 and Transmission RPC adapters.
`AddExternalClients` registers typed HTTP clients with explicit timeouts. Cookie handling and redirects
are disabled on pooled handlers: qBittorrent logs in per operation and retries an expired SID once;
Transmission replays a 409 request once with the supplied session ID and optional Basic authentication.
Saved passwords are decrypted only for connection configuration and are never serialized.

The client routes aggregate the built-in engine and configured external sources. Preferences select
future sends, not ownership of existing transfers. Every list row carries `ownerClientType`,
`ownerClientLabel`, and the normalized `<type>:<hash>` transfer ID. Switching back to built-in retains
the external connection. Controls verify the recorded owner; file deletion refuses unknown or
overlapping other owners, and remote deletion is verified before clearing remembered transfer rows.
Connection tests use the same adapters as sends and controls. The `ITorrentEngine` contract remains
the built-in engine contract for streaming and queue consumers.

`ExternalClientTests` replays the TypeScript adapter fixtures, authentication handshakes, status mappings,
and download-layout assertions. `ExternalRouteTests` uses the API test factory with fake HTTP handlers
to exercise preferences, encrypted credentials, sends, ownership, offline responses, and safe deletion.

## Search sources

Adapters live in `server/TorrentFlow.Search/Adapters`; the [sources registry](sources.md) selects them dynamically. Legacy settings bind
from the `TorrentFlow:Search` configuration section (e.g. `TorrentFlow__Search__TORZNAB_URL`) or the bare
environment variable of the same name.

| Id | Name | Default | Notes |
| --- | --- | --- | --- |
| `nyaa` | Nyaa | on | RSS; `NYAA_BASE_URL` |
| `apibay` | ThePirateBay | on | JSON; `APIBAY_BASE_URL` |
| `torrentscsv` | TorrentsCSV | on | JSON; `TORRENTS_CSV_BASE_URL` |
| `yts` | YTS | on | Movies; mirror list via `YTS_BASE_URL` |
| `eztv` | EZTV | on (TV) | Keyless IMDb lookup through TVmaze |
| `1337x` | 1337x | off | `ENABLE_1337X=1`; `X1337_USE_PLAYWRIGHT=1` for the Cloudflare fallback |
| `archive` | Internet Archive | off | `ENABLE_ARCHIVE=1`; public-domain/CC films, TV, animation (`ArchiveAdapter.cs`) |
| `torznab` | Torznab (Jackett/Prowlarr) | off until configured | `TORZNAB_URL` + `TORZNAB_API_KEY` (`TorznabAdapter.cs`) |

### Optional TMDB credentials

Settings → Sources → TMDB accepts a TMDB API key or read-access token without restarting.
Save stores the normalized credential in the TMDB entry of `<dataDir>/sources.json`; protect this
file like any other secret (it is not encrypted). The saved setting takes precedence
over `TorrentFlow:Metadata:TmdbApiKey`, then the legacy `TMDB_API_KEY` configuration.
Remove deletes only the saved override and immediately restores that fallback.
TVmaze, Cinemeta and AniList are the keyless defaults. Existing `tmdb-settings.json`
credentials are migrated automatically. See [Sources](sources.md) for merge rules.

`GET /api/settings/tmdb` returns only `configured`, `source` (`settings`,
`environment`, or `none`) and a masked last-four-character `hint`.
`PUT` accepts `{ "apiKey": "..." }`; `DELETE` removes the override.
`POST /api/settings/tmdb/test` checks a supplied key (or the effective saved/config key)
against TMDB without saving it; results are `ok`, `invalid`, or `unavailable`.
Mutations use the local-owner same-origin write guard. Test is separate from Save:
Save validates credential shape, not whether TMDB accepts it.

**Internet Archive.** One `advancedsearch.php` request per search:
`title:(<query>) AND mediatype:movies` sorted by `downloads desc`, with `fl[]=btih` so the torrent info-hash
comes straight from the index (no per-item metadata calls; items without `btih` are skipped). Each result
carries `TorrentUrl = https://archive.org/download/{id}/{id}_archive.torrent` (the engine fetches it first,
so webseeds are known immediately) and a magnet with the Archive trackers
(`http://bt{1,2}.archive.org:6969/announce`) and `ws=https://archive.org/download/`. The torrent's name is the
identifier, so the webseed is the download root (BEP 19 appends `{id}/{path}`), matching the `url-list` in
the Archive's own `.torrent`. The Archive reports no seeders: results use `Seeders = 1` plus the `Webseed` tag
and rank on their scraped swarm like any other result (webseed downloads were unreliable in testing, so they
get no ranking boost). `tv` and `anime` searches add Archive collection filters. The source is opt-in because
its swarms are small, magnet-only metadata fetches often stall, and the reported size covers every derivative
file in the item. `ARCHIVE_BASE_URL` overrides the host (tests only).

**Ranking and swarm health.** `ReleaseRanking.Rank` orders results by relevance and quality first, then by swarm class (dead, 1 to 9
seeders, 10+), then resolution affinity, then log2 swarm size, so a healthy swarm beats a small swarm that only
wins on preferred resolution or language. Every adapter is asked for at least 50 results. Before ranking,
`TorrentSearchService` scrapes the top 60 info hashes on public UDP/HTTP trackers (`TrackerScraper`, BEP 15,
10 minute cache, early exit once 3 trackers answer; 1.8 s budget interactive, 3.5 s background) and replaces
indexer seed counts with live ones (`IndexerSeeders` keeps the original, `SwarmChecked` marks scraped rows).
Every returned magnet is widened with the public tracker list (`PublicTrackers`), which
`TrackerListRefreshService` refreshes daily from ngosang/trackerslist and caches in the data directory, so a
copied magnet also finds peers quickly in other clients.

**Torznab.** Point `TORZNAB_URL` at a full Torznab api endpoint and set `TORZNAB_API_KEY`:

```powershell
# Jackett (all indexers)
$env:TORZNAB_URL = "http://127.0.0.1:9117/api/v2.0/indexers/all/results/torznab/api"
# Prowlarr (one indexer; id from the Prowlarr UI)
# $env:TORZNAB_URL = "http://127.0.0.1:9696/1/api"
$env:TORZNAB_API_KEY = "<api key>"
```

or in `appsettings.json` under `TorrentFlow:Search`. While `TORZNAB_URL` is empty the source is listed with
`enabledByDefault: false` and never queried. Requests use `t=tvsearch` (tv/anime) or `t=movie` (movies) with
standard `cat=` roots, falling back to `t=search` when the indexer rejects the typed function. Items map
`torznab:attr` `seeders`, `peers` (leechers = peers − seeders), `infohash`, `magneturl`, `grabs`, and
`category`; the magnet is `magneturl`, a magnet `link`, or one built from `infohash`, and an http(s) `link`
or enclosure becomes `TorrentUrl`.

## Streaming (off by default)

In-app streaming (players, prewarm, swarm probes, subtitles) is switched off by `TorrentFlow:Engine:Streaming`
(default `false`; env `TorrentFlow__Engine__Streaming=true` turns it back on). With it off:
- The engine adds torrents with MonoTorrent's standard piece picker (`AddAsync`) rather than `AddStreamingAsync`.
  On the same Ubuntu ISO swarm through `/api/torrent/send`, that went from 5.9 MB/s to 14.4 MB/s over 120 s.
- Stream and prewarm adds are refused, and `retention: "stream"` becomes a normal kept download.
- `/api/stream`, `/api/playback`, `/api/prewarm` and `/api/subtitles` answer 404 with `streamingDisabled: true`,
  and the pre-probe scheduler isn't registered.
- `GET /api/features` returns `{ "streaming": false }`. The SPA's `FeaturesProvider` hides all playback UI
  and redirects `/watch/*` home.

The streaming code is kept (and still tested with the flag on) so it can be reworked later.

## Build and test

```powershell
dotnet build TorrentFlow.slnx
dotnet test server/tests/TorrentFlow.<X>.Tests
dotnet run --project server/TorrentFlow.Api -- --urls http://127.0.0.1:5199 --TorrentFlow:DataDirectory=D:\code\memtest\<name>
```

The host listens on `http://127.0.0.1:3000` by default. During development always pass another port.
The root run scripts use http://127.0.0.1:3000 unless you pass `--urls`. `-p:SkipWebBuild=true` skips frontend work for backend-only builds.

## Parity harness

```powershell
node scripts/parity/run.mjs
# Reuse the isolated build; optionally filter by request/route regex:
node scripts/parity/run.mjs --no-next-build --only "health|watchlist"
# Override the source database (never prisma\dev.db, which may be empty):
node scripts/parity/run.mjs --db D:\code\torrent-aggregator\dev.db
node --test scripts/parity/parity.test.mjs
```

Install root dependencies first (`pnpm install --frozen-lockfile`). On the controller machine set
`PNPM_CONFIG_REGISTRY=http://127.0.0.1:4873` and
`PNPM_CONFIG_STORE_DIR=D:\code\memtest\pnpm-store` before installing.
The harness discovers every source GET route and refuses newly discovered routes until their
safe request is added to `scripts/parity/cases.mjs`. IDs come from the snapshot; empty tables use
explicit missing-resource IDs. Media-byte endpoints exercise errors rather than starting playback.

After sanitizing, the harness seeds one inert fixture into both copies: a Work, a completed
on-demand WatchListItem, a paused Big Buck Bunny (CC) EngineTorrent with no magnet, and a failed
title AcquisitionTarget linked to it. The library, title, progress, stream, subtitles and
client/torrents reads therefore run against real rows. The .NET stream index resumes a paused
transfer to serve it, and the magnet-less fixture then errors, so stream index reads run last.

Mutation routes are covered only by reviewed rejecting probes: missing/invalid/wrong-type
bodies, malformed JSON, wrong content type, cross-site origin and invalid hashes. Each is
rejected before any write, engine start, provider call or filesystem change. Non-GET requests
carry a same-origin `origin` header. A Next 2xx on a probe aborts the run; a .NET 2xx fails the
case and is flagged as unsafe. Never add a probe without checking the Next handler.

The source defaults to `D:\code\torrent-aggregator\dev.db`. A consistent SQLite snapshot, including
committed WAL changes, produces two copies under `D:\code\memtest\parity\<run>`. Both are sanitized
identically: unfinished transfers paused, restore magnets/URLs removed, paths isolated, external
clients/automation/pre-probing disabled, and retention origins protected. No source media is copied.
This tests API contracts over an inert library, not live download or media-byte parity.

Next builds only into `.next-parity`; `tsconfig.json` is restored with `git checkout` after the build
(the harness refuses a dirty tsconfig). Hosts use loopback ports **3110** and **5110**, never 3000/5100.
Occupied ports fail closed. Both owned process trees stop and database copies are deleted even on
failure. `--no-next-build` requires an existing `.next-parity` build; rebuild after source changes.

Each run writes private, gitignored `scripts/parity/reports/<run>/report.md` and `report.json`,
plus host/build logs. Reports include statuses, exact content-type/cache-control headers and
structural JSON differences. JSON content types ignore a `charset=utf-8` parameter, since JSON is
always UTF-8 (RFC 8259). Any other media type or parameter difference still fails.
Normalization masks volatile values while retaining keys/types;
ranked and paginated arrays keep their ordering. Bare .NET 404s mean **not ported**; application JSON
404s remain comparable. Exit codes: **0** parity (including not-ported), **1** differences/request
errors, **2** setup/harness failure. Provider-backed reads can vary with live upstream data; inspect
their diffs rather than masking meaningful results. Reports contain local library data: never commit.

Known, accepted diffs: `/api/diagnostics/health` has no .NET counterpart for Node-only sections
(named cache registry, component health registry, completion sweep, event-loop delay). It also
reports .NET process memory under `runtime`, and `enginePressure.clientPresent` is always true
because MonoTorrent starts eagerly, while Next's WebTorrent client is lazy. For the same reason,
the stream index for a paused fixture returns 404 on Next (no live client) and 425 on .NET (it
resumes the transfer, and metadata is pending).

### Settings and Downloads parity

`SettingsParityTests` covers typed settings validation, nullable/reset semantics, external-client
retention, folder navigation/reveal validation, and the complete storage-usage payload returned by
settings, retention preview, and untracked-file deletion. The inventory is bounded to 50,000 entries
and 12 directory levels; incomplete scans are explicitly non-authoritative. Tracked claims include
unverified release paths, so preallocated downloads cannot be offered as untracked cleanup.

Browser verification uses isolated database copies and non-default ports, with `NEXT_DIST_DIR` set
for the reference build. Settings and Downloads were exercised at 390/768/1280 px, including a real
Sintel/Big Buck Bunny transfer, pause/resume, cap-one queuing, API force, and browser delete-with-files.
The SPA queue action and preprobe panel depend on their separate UI/prewarm port work; diagnostics
retain runtime-specific .NET memory metrics rather than inventing Node event-loop measurements.

### Deleting downloads

- Downloads sends a multi-select or whole-series delete as one request:
  `POST /api/client/torrents {action:"delete", hashes:[...], ownerClientType:"builtin", deleteFiles}`.
  The response lists `results[]` per hash. External clients still get one request per transfer.
- `RemoveManyAsync` removes every row first and deletes files after, so a season folder that only the
  batch uses is removed whole, sidecar files included. A folder that a download outside the batch still
  records is kept. The queue is refilled once at the end, so a sibling about to be deleted never starts.
- Deletes are serialized. A file the client is still releasing after a stop is retried for up to 3 s.

### Download queue and speed

- Downloads at once: Settings saves `maxActiveDownloads` (1 to 20) on `ClientSettings`; null falls
  back to `TorrentFlow:Engine:MaxActiveDownloads` / `TORRENTFLOW_MAX_ACTIVE_DOWNLOADS` (default 2).
  Raising it starts queued rows immediately; lowering it never stops a running transfer.
- Resume is an owner override, unlike the Next engine: it starts the transfer now (marked forced,
  like Download now) even when every slot is taken, including a queued row. Nothing is preempted.
- Speed defaults: 120 peers per torrent, 400 overall, 40 half-open, 32 MB disk cache, UPnP/NAT-PMP
  and local peer discovery on, and the public tracker list added to every non-private torrent.
- First download on a fresh install: instead of refusing with "finish setup in Settings", the SPA
  asks for the folder and space limit in place (`DownloadSetupProvider`, mounted in the root
  layout, reusing Settings' `DownloadLocationFields`), saves them, then sends. Direct keep sends
  call `ensureDownloadSetup()` first; `useStorageCapOverride` answers a server `setup` refusal the
  same way and retries once. Streams never ask.

## Single-exe distribution

```powershell
.\scripts\publish-exe.ps1
```

The script builds `web/` with pnpm, then publishes `server/TorrentFlow.Api` as
`artifacts\exe\TorrentFlow.exe`. No SDK, .NET runtime, Node, pnpm, or Docker is needed on the
recipient's machine. The exe serves the SPA from embedded `web/dist` resources when no physical
`wwwroot` folder is present, but still prefers on-disk web roots for development.

By default it stores the database and settings in `%LOCALAPPDATA%\TorrentFlow`. If a `portable`
marker file sits next to the exe, it instead keeps data in `data\` beside the exe so the whole
folder stays self-contained. Pass `--urls http://127.0.0.1:3000` to override the port, or
`--no-browser` to suppress the automatic browser launch.

## Folder distribution

```powershell
dotnet publish server/TorrentFlow.Api -c Release -r win-x64 --self-contained true -o artifacts/publish/win-x64
```

Ship the entire folder and run `.\TorrentFlow.exe --urls http://127.0.0.1:3000` from that
folder. Use `linux-x64`, `linux-arm64`, `osx-arm64`, or `osx-x64` with a matching output
directory for those platforms.

See the root README for data migration and environment configuration.

## Library module

`TorrentFlow.Library` implements watchlist CRUD/check, on-demand acquisition, deletion plans and
confirmed deletion, backfill estimates, rules CRUD/run, automation/run and its hosted scheduler,
history, activity/unread, playback progress, and title detail/acquisition/progress.
Feature slices live in `server\TorrentFlow.Library\Features`; there are no schema migrations.

Acquisition calls `ITorrentEngine.AddAsync` with the canonical work ID, expected bytes and sortable
episode queue key. Engine remains responsible for storage admission and content layout. Season
acquisition uses four workers, ordered sends, a 60-second order wait and a 10-second send hold.
Episode outcomes remain distinct (downloading/queued/failed); cursor updates use compare-and-set.
Deletion requires confirmation and refuses an episode cut out of a multi-episode release.
Title pack coverage requires persisted completion/verification evidence, ignores extras, and
does not invent episode transfers for a pack.

Optional cross-module integrations are `ILibraryArtworkResolver`, `ILibraryAnimeLookup` and
`ILibraryPlaybackObserver` in `TorrentFlow.Core\Contracts\Library`. All have safe
`TryAddSingleton` defaults. Metadata replaces the first two with `services.Replace`.
`LibraryArtworkResolver` wraps `ArtworkResolver`, and title detail calls it only when there is
neither a poster nor a backdrop. The call has a 1,200 ms budget and fills both fields, which is
how Next's remote fallback works. `LibraryAnimeLookup` wraps `AniListClient`.

Media overrides the no-op playback observer with `PrewarmPlaybackObserver` (registered with
`services.Replace` in `PrewarmFeature`). It forwards each progress ping to
`PrewarmService.OnPlaybackProgressAsync`, as the TS progress route calls `onPlaybackProgress`.

Episode grabs use a port of the TypeScript on-demand ladder (`Features\Grabs\EpisodeLadder.cs`). Rungs
come in this order:
- exact
- rescue alias
- absolute or quality-absolute
- alt
- second alias
- extra categories
- relaxed zero-seeder

Each distinct search runs once, with 40 results per rung. A candidate that fails to send falls
through to the next candidate. Work identity is checked by slug, not by normalized text.

Title-page episode grabs first run the guarded AniList alias recovery (`EpisodeSearchIdentity`,
a port of `resolveEpisodeSearchIdentity`). A match must have an exact normalized name and must
not contradict the year. A failed lookup keeps the identity that was already known.

Film grabs are one identity-checked search. They return the TypeScript rejection summary and
outage messages (`FilmSelection`).

Background automation keeps its single search with seeder-wait. `ReleaseNames` ports these parts
of the legacy parser:
- `parseEpisode`
- the range detector
- `cleanDisplayTitle`
- `workIdentity`
- `workKeyFor`/`workKeyMatches`, including legacy size-key aliases

The scheduler reads the saved automation interval, respects run locks, and can be disabled for
isolated verification with `--TorrentFlow:Library:DisableScheduler=true`.

Rules that hold across the module:
- Verified file lists come in two shapes: TS rows store an absolute `path`, while the .NET engine
  stores a torrent-relative `path` plus an absolute `fullPath`. After the Engine content layout,
  `fullPath` is the moved location, or null for discarded duplicate junk, and `path` keeps the original
  name. `VerifiedFiles` uses the same rule as the engine: `fullPath`, else `path` only when it is rooted.
  Unlocated files still contribute their names to coverage. Pack mapping checks for episode ranges in the file name only, never in folder names.
- Title detail loads linked torrents that fall outside its 400-row scan (TS `missingLinkedHashes`),
  so they are not marked failed.
- A target whose engine row is waiting in the built-in download queue stays `queued`, not a 0% download (TS 446bff0).
- The title POST seeds and settles targets like TS `seedSeasonEpisodeTargets` and
  `settleSeasonEpisodeTargets`:
  - Season retries reset only failed targets.
  - A failed outcome settles only rows that are still queued.
  - The grab runs on `ApplicationStopping`, not `RequestAborted`, and settles in a `finally`.
- Deletion plans read coverage from the release name and every file name (TS `statedCoverage` and
  `coverageWithin`). Episode ranges count as season-wide, which is deliberately stricter than TS.

### Verification and remaining parity work

The Library suite has 113 tests. They include:
- SQLite-backed `WebApplicationFactory` route tests
- pure ordering, bounded concurrency, cursor, selection and automation policy tests
- `ReviewFixTests`, one regression test per code-review fix
- table-driven `LadderParityTests`, which compare rungs, title variants, alias forms, episode
  matching, display titles, work identity/keys and film messages against
  `TsOracle\ts-oracle.json`

`ts-oracle.json` holds outputs captured from the TypeScript original on real-looking release names.
`TsOracle\oracle.ts` regenerates it. Test hosts replace the artwork and AniList contracts with fakes,
so tests never touch the network. The full solution build has zero warnings/errors and all 9,012
tests pass (6 skipped in Media/Engine).

`server\tests\TorrentFlow.Library.Tests\verify-parity.py` compares running isolated Next (3102)
and .NET (5102) hosts. It refuses port 3000 and ignores only generated timestamps and volatile
disk-free measurements. `parity-results.json` records the comparison, run with
`--work-keys breaking-bad dune-2021 attack-on-titan library-parity-fixture`: all 17 of 17 requests
match. That includes the remote-fallback artwork for Breaking Bad, Dune (2021) and Attack on Titan.
It also covers a seeded watchlist/progress fixture, history/activity, cursor pagination, rules and
backfill estimates.

The requested `prisma\dev.db` source was empty, so verification used copies of the populated root
`dev.db` instead. Before startup, the copies had their engine rows removed, automation/preprobe
disabled, and one identical watchlist item plus progress row seeded. No real downloads were
requested. Next ran with `NEXT_DIST_DIR=.next-libgaps`.

This is not certification of full mutation/provider parity. Remaining integration work includes
exhaustive offline/throttling diagnostics and
request-validation edge cases. Storage reclamation
and admission remain Engine-owned; refusal details are remeasured for the response rather than
being an atomic snapshot of Engine's admission decision.

## Content layout (Engine)

`server/TorrentFlow.Engine/Layout/` ports `content-layout*.ts`. MonoTorrent downloads a multi-file torrent into
`<save>/<release name>/` (`CreateContainingDirectory`), so releases never overwrite each other mid-download.
After completion, once the torrent is detached and no stream is open (a `TrackedStream` close runs a deferred
layout), `CompletedLayoutFinalizer`:

1. Optionally validates with ffprobe (`TorrentFlow:Media:FfprobePath`, then `FFPROBE_PATH`, then
   `node_modules/ffprobe-static`, then `PATH`; if none is found, it logs once and skips). When no playable
   video is found, the row becomes an error and the matching acquisition targets become `failed`.
2. Applies the TypeScript planner decisions and log lines: wrapper removal and `Season NN` renames. A
   collision (a file another torrent owns, a file of a different size, or a directory in the way) keeps the
   release folder. Tracker spam (`Torrent Downloaded From….txt`, `RARBG.txt`) never blocks, and a duplicate
   copy is discarded.
3. Records the new paths in `verifiedFilesJson` (`fullPath`) before moving the files. The move is
   all-or-nothing and rolls back on failure. Other rows' manifests are the ownership record.

The smart `TV/<Show>/Season NN` / `Movies/<Title>` save path is chosen by the caller when the download is
sent. The layout only works inside the row's save path.

## Subtitle endpoint

`TorrentFlow.Media/Features/Subtitles` owns GET/HEAD/DELETE `/api/subtitles/{infoHash}`.
Track discovery uses cached `MediaProbe` streams and engine file metadata; content is produced only
when requested. Sidecars preserve the existing UTF-8 `TextDecoder` behavior (including BOM stripping
and replacement of malformed bytes), rather than guessing a legacy encoding. SRT conversion is
in-process; ASS/SSA conversion and embedded 10-minute windows use ffmpeg. Windows start on an
8-minute stride, independently of the playback offset.
Embedded extraction retains source timestamps (`-copyts`) and uses an absolute window end
(`-to`). Input seeking alone can return subtitle preroll rather than window-relative cues,
including with the original TypeScript arguments. The service drops expired cues, clamps cues
crossing the start, and rebases once before caching. Embedded cache keys are versioned so
previously cached, incorrectly timed results are not reused; sidecar keys remain unchanged.

Embedded extraction exposes the engine's seekable streams through an ephemeral, token-addressed
loopback HTTP input; it never stages a whole video or trusts a request Host header. Extractions share
in-flight work, retain per-consumer cancellation, and run at most two jobs with sixteen queued.
Derived VTTs use a 512 MiB LRU disk cache under the data directory's `.sessions/subtitles`.

ffmpeg/ffprobe come from the shared `Media/Tools/FfmpegLocator` (see the Media module section); a
missing binary surfaces as an `IOException` inside the feature.
Route tests use an in-memory host and fake engine, with no swarms or external requests.
Optional ffmpeg fixture tests skip explicitly when the executable is unavailable.

## Media module (`server/TorrentFlow.Media`)

Ports `src/app/api/{stream,playback}` and the media, playback and HLS/VOD logic in `src/lib`.
Subtitles (`Features/Subtitles`) and prewarm (`Features/Prewarm`: `/api/prewarm`, swarm probe,
`EngineSwarmProbeEngine`, pre-probe scheduler) are separate features registered from the same `MediaModule`.
Streaming and playback reuse prewarm's `ForegroundTracker` and `SwarmMeasurements` and subtitles'
`SubtitleRules` (srt→vtt, embedded tracks) rather than keeping copies.

Endpoints: `GET/HEAD /api/stream/{infoHash}` (file index; 425 while metadata loads),
`GET/HEAD /api/stream/{infoHash}/{**filePath}` (Range serving through `ITorrentEngine.OpenFileStreamAsync`;
same parser semantics as npm `range-parser`, open-ended ranges capped, `.srt` sidecars converted to
WebVTT), `POST /api/stream/{infoHash}/select`, `POST /api/playback/{plan,candidates,failover,switch}`,
`GET /api/playback/status`, `GET/HEAD /api/playback/hls/{sessionId}/{**segment}`,
`GET/HEAD /api/playback/vod/{vodId}/{**file}`.

Registration: `MediaModule.AddMediaModule` only calls per-feature extension methods: `AddMediaCore`,
`AddMediaProbing`, `AddMediaStreaming`, `AddMediaPlayback` (`Common/MediaServiceCollectionExtensions.cs`)
and `AddMediaSessions` (`Hls/MediaSessionHost.cs`). New media features add their own `AddMedia<Feature>()`
method and one call line there. `AddMediaCore` uses TryAdd throughout and registers the shared services:
options, `IProcessRunner`, `FfmpegLocator`, `MediaPaths` and `MediaSettings`. The Engine's content layout
keeps its own `FfprobeLocator` (same order) because Engine cannot reference Media.

ffmpeg/ffprobe resolution is `TorrentFlow.Media.Tools.FfmpegLocator` (`ResolveFfmpeg`/`ResolveFfprobe`,
or the `TryResolve*` variants; register it with `services.AddFfmpegLocator()`). First hit wins:

1. `TorrentFlow:Media:FfmpegPath` / `TorrentFlow:Media:FfprobePath`
2. `FFMPEG_PATH` / `FFPROBE_PATH`
3. The binaries the TypeScript app ships: `node_modules/ffmpeg-static/ffmpeg[.exe]` and
   `node_modules/ffprobe-static/bin/<platform>/<arch>/ffprobe[.exe]`, searched upward from the content
   root, the working directory, the app base directory and `TorrentFlow:Media:NodeModulesRoot`
4. `PATH`

A missing binary throws `FfmpegBinaryMissingException`. Direct playback still works; plans that need a
session report the error.

Options (`TorrentFlow:Media`): `SessionsDirectory` (default `<DataDirectory>/.sessions`),
`MaxConcurrentSessions` (4), `SessionIdleTimeoutSeconds` (120) and `SwarmWatchEnabled`.
`MediaSessionHost` removes stale session directories at startup, reaps idle HLS sessions and kills every
ffmpeg process on shutdown.

Engine additions for this module:

- `ITorrentEngine.GetDownloadedRangesAsync` (default: empty) and `EngineTorrent.BytesReceived`
  (`[JsonIgnore]`), used by the probe and swarm measurements.
- The engine multiplexes MonoTorrent's single `StreamProvider` stream (`SharedTorrentStreams`), so
  concurrent readers such as the player, ffprobe and ffmpeg can share one file.

Known gaps compared with TS: no hybrid disk+engine serving or completed-media recovery, and a simplified
`rankResultsForTarget`/work filter.
