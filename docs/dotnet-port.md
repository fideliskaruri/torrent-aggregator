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

## Build and test

```powershell
dotnet build TorrentFlow.slnx
dotnet test server/tests/TorrentFlow.<X>.Tests
dotnet run --project server/TorrentFlow.Api -- --urls http://127.0.0.1:5100 --TorrentFlow:DataDirectory=D:\code\memtest\<name>
```

The host listens on `http://127.0.0.1:3000` by default. During development always pass another port.

## Media module (`server/TorrentFlow.Media`)

Ports `src/app/api/{stream,playback}` and the media, playback and HLS/VOD logic in `src/lib`.
Subtitles (`/api/subtitles`) and prewarm (`/api/prewarm`, swarm probe, `ISwarmProbeEngine`, pre-probe
scheduler) are separate features.

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
options, `IProcessRunner`, `FfmpegLocator`, `MediaPaths`, `MediaSettings`, `ForegroundTracker` and
`SwarmMeasurements`.

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