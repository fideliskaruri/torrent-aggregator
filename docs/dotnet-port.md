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

## Build and test

```powershell
dotnet build TorrentFlow.slnx
dotnet test server/tests/TorrentFlow.<X>.Tests
dotnet run --project server/TorrentFlow.Api -- --urls http://127.0.0.1:5199 --TorrentFlow:DataDirectory=D:\code\memtest\<name>
```

The host listens on `http://127.0.0.1:3000` by default. During development always pass another port.
The root run scripts use http://127.0.0.1:3000 unless you pass `--urls`. `-p:SkipWebBuild=true` skips frontend work for backend-only builds.

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
