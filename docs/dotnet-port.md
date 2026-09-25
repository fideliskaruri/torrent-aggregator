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
dotnet run --project server/TorrentFlow.Api -- --urls http://127.0.0.1:5106 --TorrentFlow:DataDirectory=D:\code\memtest\<name>
```

The host listens on `http://127.0.0.1:3000` by default. During development always pass another port.
The root run scripts select port 5106. `-p:SkipWebBuild=true` skips frontend work for backend-only builds.

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

Ship the entire folder and run `TorrentFlow.Api.exe --urls http://127.0.0.1:5106`.
No SDK, .NET runtime, Node, pnpm, or Docker is needed on the recipient's machine.
Use `linux-x64` or `osx-arm64` for other platforms (Linux still needs native dependencies such as ICU).
Publish includes `web/dist` under `wwwroot`; the host resolves `TorrentFlow:WebRoot` first,
then `wwwroot` beside its executable, then the development `web/dist` directory.
See the root README for data migration and environment configuration.
