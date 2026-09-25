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
Safe invalid-body POSTs cover progress, torrent send, and playback planning.

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
structural JSON differences. Normalization masks volatile values while retaining keys/types;
ranked and paginated arrays keep their ordering. Bare .NET 404s mean **not ported**; application JSON
404s remain comparable. Exit codes: **0** parity (including not-ported), **1** differences/request
errors, **2** setup/harness failure. Provider-backed reads can vary with live upstream data; inspect
their diffs rather than masking meaningful results. Reports contain local library data: never commit.

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

## Folder distribution

```powershell
dotnet publish server/TorrentFlow.Api -c Release -r win-x64 --self-contained true -o artifacts/publish/win-x64
```

Ship the entire folder and run `TorrentFlow.Api.exe --urls http://127.0.0.1:3000`.
No SDK, .NET runtime, Node, pnpm, or Docker is needed on the recipient's machine.
Use `linux-x64` or `osx-arm64` for other platforms (Linux still needs native dependencies such as ICU;
see the README's "Linux and macOS" section, verified on Ubuntu 24.04/WSL with a Windows-built publish).
Publish includes `web/dist` under `wwwroot`; the host resolves `TorrentFlow:WebRoot` first,
then `wwwroot` beside its executable, then the development `web/dist` directory.
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
