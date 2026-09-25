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

Optional cross-module integrations are `ILibraryArtworkResolver` and `ILibraryPlaybackObserver`
in `TorrentFlow.Core\Contracts\Library`. Both have safe `TryAddSingleton` defaults. The default
artwork resolver returns no remote fallback artwork; the default playback observer does no
Media prewarming. Implementations can replace them without module-to-module project references.
The scheduler reads the saved automation interval, respects run locks, and can be disabled for
isolated verification with `--TorrentFlow:Library:DisableScheduler=true`.

### Verification and remaining parity work

The Library suite has 81 tests, including SQLite-backed `WebApplicationFactory` route tests and
pure ordering, bounded concurrency, cursor, selection and automation policy tests. The full
solution build has zero warnings/errors and all 8,466 tests pass.

`server\tests\TorrentFlow.Library.Tests\verify-parity.py` compares running isolated Next (3102)
and .NET (5102) hosts. It refuses port 3000 and ignores only generated timestamps and volatile
disk-free measurements. `parity-results.json` records the comparison: 14 of 17 requests match;
the other three differ only in the two poster fields populated by Next's remote artwork fallback.
Those titles are Breaking Bad, Dune (2021), and Attack on Titan. A populated watchlist/progress
fixture also matches, as do history/activity, cursor pagination, rules and backfill estimates.

The requested `prisma\dev.db` source was empty; verification used copies of the populated root
`dev.db` instead. Engine rows were removed and automation/preprobe disabled in the copies before
startup; no real downloads were requested. Next ran with `NEXT_DIST_DIR=.next-lib`.

This is not certification of full mutation/provider parity. Remaining integration work includes
the optional artwork/prewarm implementations, the complete TypeScript search alias/rung ladder
(including guarded AniList alias recovery), exhaustive offline/throttling diagnostics and
request-validation edge cases, and the full legacy release-name/pack parser. Storage reclamation
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

Embedded extraction exposes the engine's seekable streams through an ephemeral, token-addressed
loopback HTTP input; it never stages a whole video or trusts a request Host header. Extractions share
in-flight work, retain per-consumer cancellation, and run at most two jobs with sixteen queued.
Derived VTTs use a 512 MiB LRU disk cache under the data directory's `.sessions/subtitles`.

The feature-local binary resolver is intentionally temporary pending consolidation with
`Media/Tools/FfmpegLocator`: `TorrentFlow:Media:FfmpegPath` / `FfprobePath`, then `FFMPEG_PATH` /
`FFPROBE_PATH`, PATH, and the existing `node_modules/ffmpeg-static` / `ffprobe-static` layouts.
Route tests use an in-memory host and fake engine, with no swarms or external requests.
Optional ffmpeg fixture tests skip explicitly when the executable is unavailable.
