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
- Install and run with `pnpm install` (web) and `dotnet run` (server). No Docker.

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
dotnet run --project server/TorrentFlow.Api -- --urls http://127.0.0.1:5100 --TorrentFlow:DataDirectory=D:\code\memtest\<name>
```

The host listens on `http://127.0.0.1:3000` by default. During development always pass another port.

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
