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
- Install and run with `.\run.ps1` (Windows) or `sh ./run.sh` (Linux/macOS).
  The Windows executable remains the desktop default; [Docker](docker.md) is the recommended
  always-on NAS/Linux/Pi host.
  API builds install the frozen web lockfile and build the SPA incrementally. The CLI's
  `VSTestSessionCorrelationId` skips the web target during `dotnet test`; standalone test-project
  builds pass `SkipWebBuild=true` through references. Tests need no Node/pnpm installation.

## Manual release replacement

The server supports **Find another source** for incomplete built-in movie and episode rows.
The dialog (`web/src/components/releases/release-swap-dialog.tsx`) offers a source picker, one-click
"Find the best one for me", and a manual list. The API returns connected seeders/peers, speed and observed
stall duration, then alternatives sorted best first by `ReleaseSwapService.Rank`. An explicit swap request replaces that release and deletes only its
recorded incomplete payload and partial-file siblings—not shared folders, unrelated or completed files.
When no live bitfield remains, full-length files are conservatively preserved because their completion
cannot be disproved; the swap never guesses folder ownership.

- `GET /api/client/torrents/{hash}/alternatives[?source=<id>]` searches the same work and episode/season scope
  (all enabled sources, or only `source`), retains the current/acquisition quality floor, and excludes current,
  loaded and previously tried hashes. Releases this owner blocked are the exception: when the search finds
  them they come back after every unblocked release, whatever their score, marked `blocked`.
- Ranking is one deterministic score: quality match to the current release (+30 same, +15 higher),
  seeders `min(60, 10·log2(1+seeders))`, size sanity against the current release (+10 within 0.4–2.5×,
  −20 outside), plus search health/10. Ties break on seeders, smaller size, then hash. Each item gets a
  specific `why` ("Most seeders (29)", "Same quality, 40% smaller file", "Only other 1080p release", ...).
- `POST /api/client/torrents/{hash}/alternatives` accepts `{ "token": "..." }`, an opaque selection
  from GET valid for ten minutes. Stale, foreign and already-tried selections are rejected. A blocked
  release also needs `"allowBlocked": true` ("Use it anyway"); the swap then lifts its block.
  `{ "best": true, "source"?: "<id>" }` searches, takes the recommended release and swaps in one step. It never
  takes a blocked release.
- Both routes use the host's default owner-only requester middleware; they are not requester-enabled.
- The engine transaction transfers work/queue/category/path/lane/forced state and updates acquisition,
  grab, watchlist and request hash links. Paused rows remain paused; queued rows retain their enqueue
  timestamp and episode position. Hash locks are ordered under the remove gate, then the queue gate.
- `ReleaseAttempt` persists per-owner/work/scope hashes across restarts and subsequent swaps.
- `ReleaseBlock` is the release blocklist, one row per owner and info hash, keeping the work key and scope
  it was blocked for. `TorrentFlow.Data.ReleaseBlocks` is its only implementation. A swap blocks the
  release it replaced (`replaced`). A release refused by the video check, meaning the finished-file check
  or the file list once a magnet's metadata arrives, is blocked as `failed_video_check`. Unreadable files,
  send failures and language refusals never block. Blocks have no foreign keys, so removing a download or
  a title keeps them. The `AddReleaseBlocks` migration back-fills `replaced` blocks from the swap history
  (`release-swap` rows, "Replaced {hash}") and logs once how many attempts it blocked or left alone.
- Future automatic recovery can call `ReleaseSwapService.Alternatives` and `Swap`; no second ranking
  or deletion implementation is needed. `TransferHealthTracker` is sampled by the engine monitor and
  reports session-observed stalls (reset after restart), not an invented historical duration. Automatic
  decisions, thresholds, cooldowns and consent are deliberately not enabled.

### UI integration contract

Both routes require owner access under the existing host middleware. Requesters receive HTTP 403.
`hash` is the current engine torrent's lowercase info hash, not its `transferId`.
JSON is camelCase; nullable properties are **omitted**, not serialized as `null`.
Examples below are illustrative; obtain a fresh token from GET instead of copying one.

**GET `/api/client/torrents/{hash}/alternatives`** has no body. Optional `?source=<id>` (an id from
`sources`; `all` or empty means every source) limits the search to one enabled source.
HTTP 200:

```json
{
  "health": {
    "connectedSeeders": 1,
    "connectedPeers": 3,
    "downloadBytesPerSecond": 0,
    "stalledForSeconds": 120,
    "state": "stalledDL"
  },
  "alternatives": [
    {
      "token": "2439b06f437f491cb2b3f809fe088c00",
      "hash": "0012284189aaef2511fcd7ab2eab6ed1a802edd1",
      "title": "Night.of.the.Living.Dead.1968.REMASTERED.REPACK.720p.BluRay.999M",
      "seeders": 10,
      "peers": 1,
      "sizeBytes": 1048105953,
      "quality": 720,
      "source": "apibay",
      "why": "Most seeders (10)"
    }
  ],
  "sources": [
    { "id": "apibay", "name": "apibay", "count": 1 },
    { "id": "torrentscsv", "name": "torrentscsv", "count": 2 },
    { "id": "yts", "name": "yts" }
  ],
  "recommendedToken": "2439b06f437f491cb2b3f809fe088c00"
}
```

`health.connectedSeeders` and `health.connectedPeers` are optional integer connected counts.
`downloadBytesPerSecond` and `stalledForSeconds` are nonnegative integer measurements; stalled duration
is observed in this server session, not the torrent's total age. `state` is the existing engine display
state (for example `metaDL`, `stalledDL`, `downloading`, `paused`, `queued`, `checkingDL`, or `error`).
Candidate `seeders` and `peers` are integer indexer/scrape counts; **candidate `peers` means leechers,
not connected peers**. `sizeBytes` (integer bytes) and `quality` (integer resolution, e.g. 720) are
optional. All other candidate properties are strings. Preserve the array's rank order.
A release this owner blocked carries `blocked`, and is omitted otherwise:

```json
"blocked": { "reason": "replaced", "at": "2026-10-01T16:37:59.089Z", "message": "You replaced this release before." }
```

`reason` is `replaced` or `failed_video_check`, `at` is when it was blocked (UTC), and `message` is the
line to show ("This release failed the video check before." for a failed check). Blocked releases always
come after every unblocked one. Offer "Use it anyway" on them, which POSTs with `allowBlocked: true`.
An empty result is HTTP 200 with `"alternatives": []`; it is not an error. `recommendedToken` is the
token of the first unblocked alternative and is omitted when there is none. `sources` lists the enabled torrent sources
that can search this media type; `count` is how many alternatives that source returned, omitted when that
source has not been confirmed in the last ten minutes. Identical listings collapse onto one source in an all-source search, so `0` is only reported after a `?source=` search of that source found nothing (after a `?source=` search the other sources keep their
last all-source counts). A `source` that is disabled or unsupported for the category returns HTTP 409.
Missing/completed/unsupported downloads and all-source outages return HTTP 409:

```json
{ "message": "Download no longer exists." }
```

**POST `/api/client/torrents/{hash}/alternatives`**, `Content-Type: application/json`:

```json
{ "token": "2439b06f437f491cb2b3f809fe088c00" }
```

The token is bound to this current hash, expires after ten minutes, and is lost on server restart.
Do not POST arbitrary magnets or candidates. HTTP 200:

```json
{
  "ok": true,
  "message": "Using the new release. Safely identified partial files were removed.",
  "hash": "0012284189aaef2511fcd7ab2eab6ed1a802edd1"
}
```

Refresh the downloads list after success. Admission does not promise a healthy swarm or immediate
transfer: paused replacements remain paused, queued replacements obey the queue and download window.
Expected refusals return HTTP 409:

```json
{ "ok": false, "message": "This selection expired. Find releases again." }
```

A token for a blocked release without `"allowBlocked": true` returns HTTP 409
`{ "ok": false, "message": "You blocked this release before. Choose Use it anyway to download it." }`.
With it, the swap goes ahead and the release is no longer blocked.

`{ "best": true }` returns the same 200 shape after swapping. When there are no alternatives, or the
recommended one has no more seeders than the current connected seeders, it returns HTTP 409
`{ "ok": false, "message": "No better release was found on any source. Your current download was kept." }`
(`on <source>` when filtered); search errors return 409 `{ "ok": false, "message" }`.

Storage refusals additionally include `"storageLimit"` (`setup`, `inventory`, `cap`, `reserve`, or
`wont-fit`). GET again after an expired selection. Malformed JSON returns standard HTTP 400 ProblemDetails;
a body with neither `token` nor `best: true` returns HTTP 400 `{ "message" }`. Other transport/server failures must remain errors in the UI,
not an empty alternatives list. The successful swap currently omits nullable `details` and
`storageLimit`; failure responses also omit nullable `hash`.

## Downloads list JSON (`GET /api/client/torrents`)

Built-in rows follow the Next `ClientTorrent` shape plus:

| Field | Type | Meaning |
|-------|------|---------|
| `state` | string | `downloaded` \| `downloading` \| `stalledDL` \| `metaDL` \| `checkingDL` \| `paused` \| `queued` \| **`error`** |
| `error` | string? | Plain message when `state` is `error` (metadata timeout, client fault, layout refusal). **Not** a paused state — UI must group `error` separately from paused. |
| `forced` | bool | `true` when the owner pressed Download now (`ForcedAt` set). |
| `forcedReason` | string? | Why a forced row passes the cap: `now` (Download now), or `legacy` for a row an older build's Resume forced (backfilled by the migration). Omitted when not forced. |
| `verified` | bool | `true` after on-disk verification (`VerifiedAt`); survives restart without a live client. |
| `progress` | 0..1 | For verified/parked rows stays `1` after restart. |
| `workKey` / `season` / `episode` | string? / int? / int? | Acquisition intent when known (owner targets or request-lane `QueueKey`). |

## Project layout

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
  logic you port. Prefer real host/network-gated tests; fake HttpMessageHandler unit tests were removed (docs/test-audit.md).
- Globalization: ICU is on, so `string.Normalize` matches JS `String.prototype.normalize`. The host
  pins the default culture to invariant; still pass `CultureInfo.InvariantCulture` and use ordinal
  comparisons in code. On Linux, install `libicu` (present on most distros).
- Memory: the host runs workstation GC (`ServerGarbageCollection=false` in `TorrentFlow.Api.csproj`).
  Server GC grows its gen0 budget until GC committed is ~3x the live heap, which alone pushed the
  process past the 200 MB target under 5 live downloads. Watch `runtime` in
  `/api/diagnostics/health` (working set, private bytes, GC heap/committed, threads, handles);
  judge leaks by private bytes and the post-GC heap, not working set (~100 MB of it is shared images).

### Built-in engine memory budgets

One singleton `MonoTorrentBackend` owns one `ClientEngine` and one disk cache, **not a cache per
torrent or per file**. Defaults under `TorrentFlow:Engine`:

| Setting | Default | Budget |
| --- | --- | --- |
| `DiskCacheBytes` | 33,554,432 (32 MiB) | Shared write-only disk cache; 2,048 16-KiB blocks across all torrents |
| `MaxOpenFiles` | 40 | Shared open-file cap |
| `MaxConnections` / `MaxConnectionsPerTorrent` | 400 / 120 | Global and per-torrent peer caps |
| `MaxActiveDownloads` | 2 | Kept torrents loaded at once; queued rows own no client cache |
| `MaxWebSeedResponseBytes` | 33,554,432 (32 MiB) | Per-response HTTP buffering limit, separate from the disk cache |

MonoTorrent 3.0.2's `HttpPeerConnection` uses buffering `HttpClient.SendAsync` for webseeds.
Its default HTTP limit is nearly 2 GiB: a server ignoring `Range` can therefore buffer a whole
video before the piece reader sees it. The engine's HTTP factory now caps this at 32 MiB, including
chunked responses. Large webseed responses fail instead of exhausting memory; ordinary 2-MiB
webseed blocks still work. Torrents using pieces larger than this limit may require raising
`MaxWebSeedResponseBytes` (up to 256 MiB) or another peer source. Downloaded `.torrent` metadata
is separately limited to 20 MiB even when `Content-Length` is absent.

September 27, 2026 (UTC) verification: four generated multi-file torrents (32 MiB total, 16 files)
completed over a legal local loopback swarm; test-process private memory including the seeder
went from 41,926,656 to a sampled peak of 43,044,864 bytes. Shared cache use stayed within 32 MiB.
A generated 64-MiB HTTP response allocated 79,770,944 bytes with the original client and
349,760 bytes with the bounded client (known length rejected before reading); unknown-length
2-GiB synthetic responses stopped after at most 32 MiB. These are isolated synthetic measurements,
not a reproduction of the reported 2.2-GB season workload. The cache was already bounded before
this change; the HTTP buffering path is a confirmed additional risk, not proof of that report's
root cause. Reproduce with the same torrents/settings before claiming the reported spike resolved.
The regression tests are `TorrentHttpLimitsTests` and
`LoopbackSwarmTests.MultipleMultiFileDownloadsShareOneBoundedDiskCache`.
An isolated real host on port 3925 reported workstation GC, 44,806,144 private bytes and
21,299,200 GC-committed bytes at idle; `dotnet-counters` captured its `System.Runtime` counters.
These settings are component budgets, not a process-wide memory ceiling.

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
   completed, kept, non-seeding rows; they use the usual Library, open-file and deletion paths.
4. Matching `.torrent` metadata from `engine/torrents` or `engine/metadata` restores a real torrent
   against existing files for hash checking and seeding. Fast-resume data alone cannot identify
   the original files without torrent metadata. Non-media, links, empty files and `.part` files are
   skipped. Inspect potentially incomplete files before importing: without torrent metadata their
   original checksum/completeness cannot be proven.

Storage diagnostics and recovery are owner-only and not available over remote access.

## Watchlist check scheduling

Monitored watching/planned rows persist `nextCheckAt` and `nextCheckReason`. The automation
loop checks due items (up to 50 per pass), keeps rules on the configured automation interval,
and wakes after watchlist edits. The existing automation RunLock also guards subset runs.
Legacy rows with no due time are initialized on their next pass; disabling the automation
interval still disables scheduled runs.

Metadata's exact cursor episode air date defers searches before airing and selects 15-minute
checks during the following 12 hours, without prematurely rolling the season on a miss.
Date-only provider values mean midnight UTC, an estimate rather than an exact broadcast time.
Unknown dates (including anime without episode dates) use the existing miss backoff, with the
configured interval (minimum 15 minutes) as a floor. Existing quality-floor and exact-episode
selection rules remain unchanged.

Optional `TorrentFlow:Library` configuration (environment prefix `TorrentFlow__Library__`):

| Setting | Default | Meaning |
| --- | --- | --- |
| `MinimumSeeders` | `3` | Wait below this floor; `0` disables swarm waiting |
| `SeederWaitTimeoutMinutes` | `360` | Grace before taking the best available; `0` skips grace |
| `SeederRecheckMinutes` | `15` | Thin-swarm recheck interval, capped at the remaining grace |
| `ItemSpacingMilliseconds` | `1000` | Serial spacing between title searches in a pass |

Defaults retain the prior three-seeder/six-hour grace. Wait starts survive restarts and repeated
checks; changing the episode cursor or quality preference resets obsolete waits. The watchlist
shows the next check in local time with a quiet “Not aired yet” or “Waiting for seeders” reason.

Explicit season downloads and approved season requests share a four-worker search/send fanout.
Ready episodes no longer wait for earlier episodes' searches or metadata before admission.
The engine enforces the saved download cap atomically, orders queued episodes by their episode
keys, and monitors metadata deadlines after accepting kept downloads. Result lists remain in
episode order even when searches finish out of order; only download admission, not whole grabs,
is serialized.
Future air dates are revalidated at least daily in case a provider corrects its schedule. Manual
“Run now” bypasses stored due times but still honors known future air dates and legacy miss backoff.
With a backlog, additional batches drain at the scheduler's one-minute minimum delay, with serial
spacing inside each batch. Verify SPA regressions from `web/` with `pnpm typecheck` and `pnpm test`.
The page refreshes scheduling data quietly every 30 seconds; monitoring/status changes use the
returned server row immediately, and disabled automation does not display future-check promises.

Scheduling verification (September 26, 2026): Library 149, Metadata 287, Engine 257, Api 72,
Media 487 tests passed (7 existing Engine/Media integration skips); SPA TypeScript and all 23
web tests passed. Migration downgrade/upgrade retains existing watchlist rows. Playwright MCP
against the isolated real host verified all three schedule labels at actual CSS widths
390/768/1280 without horizontal overflow, and monitoring pause/resume updated API and rendered
schedule together. Fixtures used legal Blender film titles; no torrent acquisitions were made.
## Importing from other clients

Choose **Import from another client** in Settings or on an empty Downloads page. The owner-only
picker lists discovered transfers grouped by source, with their size, original save path, data
presence and advisory complete/partial state. Select all or individual torrents and acknowledge
that the other client is closed, or that you removed the torrent there **without deleting data**.
Never let two clients write the same payload simultaneously.

Discovery reads the following Windows sources without changing their files or settings:

| Source | Discovery |
| --- | --- |
| TorrentFlow Next.js | `dev.db` / `prisma\dev.db` under the content root; `DATABASE_URL` from environment or `.env`; additional roots via `TorrentFlow:Import:LegacyRoots`. The `nextjs-final` app resolves relative file URLs against its project root. |
| qBittorrent | Saved WebUI connection (list and metadata export) and `%LOCALAPPDATA%\qBittorrent\BT_backup` torrent/fastresume pairs. |
| Transmission | Saved RPC connection and `%LOCALAPPDATA%\transmission\torrents` / `resume`. |
| uTorrent / BitTorrent | `%APPDATA%\uTorrent` / `%APPDATA%\BitTorrent`, pairing `resume.dat` entries with adjacent torrent files. |
| Deluge | `%APPDATA%\deluge\state`, pairing torrent metadata with `torrents.fastresume`; pickle state is never loaded. |

Only found torrents are shown. Unreadable/malformed entries produce warnings rather than losing
the rest of the scan. Torrent metadata with no recoverable save path is not offered; the importer
never guesses that a client's backup directory is its download directory. Legacy SQLite is opened
only from a disposable private snapshot (including WAL), so scanning does not change its SHM.
For a consistent snapshot, close the old app before scanning.

Selected torrents become built-in transfers, deduplicated by info hash across sources and existing
rows. Payload files are neither copied nor moved. Existing files are hash-checked: complete torrents
seed, partial torrents resume, and missing data remains **paused** with a message until you restore
the files or explicitly resume downloading. Standard partial suffixes (`.!qB`, `.part`, `.!ut`) and
libtorrent file mappings are retained without renaming the payload. Ambiguous or unsafe layouts
are refused. Metadata-less entries preserve magnets and trackers; verification waits for metadata.

For isolated fixtures, set `TorrentFlow__Import__ScanRoot` to a private directory containing
`qBittorrent\BT_backup`, `transmission\torrents`, `transmission\resume`, `uTorrent`, `BitTorrent`,
`deluge\state`, and `nextjs\dev.db`. This **replaces** native discovery and disables configured APIs
unless `TorrentFlow__Import__AllowConfiguredApis=true` is explicitly set. Set it to `false` to
disable API discovery outside fixture mode too. The normal `TorrentFlow__DataDirectory` override
still controls the new database and private import snapshots.

## External torrent clients

Built-in sends create the resolved download directory and perform a disposable write/flush probe
before queue admission. An unusable directory returns HTTP 400 with `field: "savePath"` and does
not create a transfer row, including when the active queue is full. External-client destinations
are interpreted on the remote client and are not probed on the TorrentFlow host.

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
the built-in engine contract for queue consumers.

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

## Streaming (removed)

In-app streaming (players, HLS/VOD, prewarm, swarm probes, subtitles, watch progress) has been removed, along with
`TorrentFlow.Media` and the ffmpeg/ffprobe tooling. The engine adds every torrent with MonoTorrent's standard piece
picker (`AddAsync`). A finished download opens in the owner's own player or file manager through
`POST /api/downloads/{id}/open`. [api-open-file.md](api-open-file.md) lists that contract, the routes and fields that
went away, and the `RemoveStreaming` migration.

## Remote access

Opt-in owner access from a phone or away from home through Cloudflare Tunnel + Access: a second listener
(default `127.0.0.1:3940`) meant only for `cloudflared`, where every request needs a valid Access token for
an owner email. The local listener stays the trusted owner and refuses Cloudflare-proxied requests (421).
Opening files on this computer is off on the tunnel. See [remote-access.md](remote-access.md) for setup and the security model.
Other signed-in emails are requesters: they can only search titles and request them (see
[requests.md](requests.md)).

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
see docs/test-audit.md (web unit tests removed)
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
Streaming has since been removed from the .NET app (see "Streaming (removed)"), so its progress, stream and
subtitles reads no longer have a .NET counterpart.

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
- `RemoveManyAsync` returns without waiting on the client or the disk. One save removes every row and
  writes an `EngineDeletion` tombstone per hash (name, save path, file list, `deleteFiles`, batch), so a
  deleted row never lists again in `/api/client/torrents` and a crash cannot lose the delete. Each
  transfer leaves the client through the shared detach (no wait on tracker announces; resume data
  dropped) and the freed slots are refilled in the background.
- The cleanup worker (`DeletionCleanupService`) finishes a batch: it waits for its transfers to leave the
  client, deletes the files, the saved `.torrent` and the engine cache, then drops the tombstones. The
  batch is cleaned up together, so a season folder that only the batch uses is removed whole, sidecar
  files included. A folder that a download outside the batch still records is kept.
- A file still held after a 3 s inline retry (another program has it open) keeps the batch's tombstones
  and is retried after 5 s, doubling up to 15 min. On start the worker first takes every tombstone left
  from before a restart. Every step is safe to repeat. Recovery never re-imports a hash whose delete is
  pending; adding the same hash again before the cleanup runs ends that delete without touching the
  files (they belong to the new transfer).
- The library delete (`POST /api/library/delete`) uses the same batch delete.

### Download queue and speed

- Downloads at once: Settings saves `maxActiveDownloads` (1 to 20) on `ClientSettings`; null falls
  back to `TorrentFlow:Engine:MaxActiveDownloads` / `TORRENTFLOW_MAX_ACTIVE_DOWNLOADS` (default 2).
  Raising it starts queued rows immediately; lowering it immediately returns the running non-forced
  tail to the queue (they keep their row, files and fast-resume data). Rows forced by Download now keep their slot until they finish, fail or are paused. `GET /api/settings/client` also
  returns `effectiveMaxActive` (the cap the queue enforces now) and `maxActiveSource` (`schedule` when
  an open download window sets its own limit, else `setting`).
- Resume and Resume all join the queue: a resumed row starts only when a slot is free and nothing
  waits ahead of it, else it is queued in order (`Queued, #n in line`). Only Download now passes the
  cap: it stores `ForcedAt` with `ForcedReason` `now`, starts at once even when every slot is taken,
  and nothing is preempted. Rows an older build's Resume forced are backfilled as `legacy` and keep
  their slot until they finish. Pause clears the forced flag.
- Pause and cap demotion take the transfer out of the client through the one detach
  (`ITorrentBackend.RemoveAsync`), which does not wait on tracker announces, so they return at once;
  the files and fast-resume data stay, so the next start skips the hash check. A loaded transfer that
  is stopped is one being started and lists as `metaDL`; `paused` only ever comes from the row.
- Download hours (`ClientSettings.downloadWindows`, JSON; Settings → Downloads): weekly rules of
  days + start/end hour in the server's local time (end ≤ start runs overnight; days are the start
  day). With no rules nothing changes. With rules, outside every window the queue holds new kept
  starts (an explicit gate in `ShouldQueueNewDownload`, promotion and rehydrate — never cap = 0);
  running transfers keep going, a restart outside the window starts only forced rows, Download now
  still starts immediately and Resume waits for the window. The engine tick promotes when the window
  opens. The first matching rule is active; its optional `maxActiveDownloads` beats the saved
  override, and its
  optional `maxDownloadRate` / `maxUploadRate` (bytes/s; the UI edits MB/s) are applied with
  `ClientEngine.UpdateSettingsAsync` on a copy of the live settings (the listen port is never
  rebuilt). Effective rate = the stricter of the base option and the window cap; the base (download
  unlimited, `MaxUploadRate`) returns when the window ends. Rates are re-evaluated every tick.
- Priority lanes: `EngineTorrent.lane` (0 owner, 1 request, 2 automation) is the first queue sort
  key; a work's group anchor only counts rows in its own lane. `EngineAddRequest.Lane` / send's
  `lane` default to owner; background grabs and automation rules send automation. A re-add can raise
  a row's lane but never lowers it. Rows that existed before the lane column start in the owner lane
  (the migration cannot tell who added them), so the order of an existing queue is unchanged.
- Each queued row carries one `waitReason` on `/api/client/torrents` — `outside-window`, then
  `lower-lane` (a better-lane row is waiting too), else `queue-full` — shown on the Downloads row.
- Speed defaults: 120 peers per torrent, 400 overall, 40 half-open, 32 MB disk cache, UPnP/NAT-PMP
  and local peer discovery on, and the public tracker list added to every non-private torrent.
- First download on a fresh install: instead of refusing with "finish setup in Settings", the SPA
  asks for the folder and space limit in place (`DownloadSetupProvider`, mounted in the root
  layout, reusing Settings' `DownloadLocationFields`), saves them, then sends. Direct keep sends
  call `ensureDownloadSetup()` first; `useStorageCapOverride` answers a server `setup` refusal the
  same way and retries once.

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

On Windows the published exe has no console window: it runs from a tray icon, can start with
Windows and checks GitHub for updates. `.\scripts\publish-exe.ps1
-Version 1.2.3 -Installer` also builds the per-user installer. See [windows-install.md](windows-install.md).

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
history, activity/unread, and title detail/acquisition/progress.
Feature slices live in `server\TorrentFlow.Library\Features`; there are no schema migrations.

Acquisition calls `ITorrentEngine.AddAsync` with the canonical work ID, expected bytes and sortable
episode queue key. Engine remains responsible for storage admission and content layout. Season
acquisition uses four workers, ordered sends, a 60-second order wait and a 10-second send hold.
Episode outcomes remain distinct (downloading/queued/failed); cursor updates use compare-and-set.
Deletion requires confirmation and refuses an episode cut out of a multi-episode release.
Title pack coverage requires persisted completion/verification evidence, ignores extras, and
does not invent episode transfers for a pack.

Optional cross-module integrations are `ILibraryArtworkResolver` and `ILibraryAnimeLookup` in
`TorrentFlow.Core\Contracts\Library`. Both have safe `TryAddSingleton` defaults, and Metadata replaces
them with `services.Replace`.
`LibraryArtworkResolver` wraps `ArtworkResolver`, and title detail calls it only when there is
neither a poster nor a backdrop. The call has a 1,200 ms budget and fills both fields, which is
how Next's remote fallback works. `LibraryAnimeLookup` wraps `AniListClient`.

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

`server/TorrentFlow.Engine/Layout/` ports `content-layout*.ts`. Like the Next.js engine (depth-0 wrapper always
dropped), a kept download writes without its release folder: once metadata is known, the stopped manager points
each file at `<save>/<torrent path>` (`BackendAddSpec.FlattenWrapper`, `MonoTorrentBackend.DropWrapperAsync`), and
the paths are recorded (`CompletedLayoutManifestStore.Place`) so a restart resumes them. A file stays in
`<save>/<release name>/` only when its flat path is taken (on disk, or written by another loaded torrent), so
releases never overwrite each other mid-download. Magnets resumed without a metadata wait keep the release folder
until completion. After completion, once the torrent is detached, `CompletedLayoutFinalizer`:

1. Checks the files with the built-in `CompletedMediaValidator` (no ffprobe or other process; the rules are in
   [api-open-file.md](api-open-file.md), "Checking downloads"). A fake release becomes an error row, its matching
   acquisition targets become `failed`, and another release is picked. A file that still can't be read after two
   retries leaves an error row that says "Couldn't check this download"; nothing is accepted or deleted, and Retry
   checks it again. The same program-file and no-video rules (`MediaFileRules`) refuse a release from its file list
   before anything downloads.
2. Plans the layout file by file (`ContentLayoutPlanner`). The goal is that every video lands directly in
   the save path (`TV/<Show>/Season 01/Show.S01E03….mkv`).
   - Wrapper folders are dropped and multi-season packs get `Season NN` folders, as in the TypeScript planner.
   - A folder named after the one episode it holds (`Pack/Show.S01E01.x/…`) is hoisted.
   - A subtitle belongs to a video when it is named after the video, sits in `Subs/<video name>/`, or sits in
     a `Subs` folder of a release with a single video. It moves beside that video as
     `<video>.<name>.srt`, so a desktop player picks it up.
   - An extra (sample, `.nfo`, screenshots, `.txt`) that would collide with a file another release owns, a
     file of a different size, or a directory is moved aside under the release name, for example
     `Sample/<release>/sample.mkv` or `<release>.<name>.nfo`. When even that path is taken, the extra stays
     in its release folder.
   - Only a video collision keeps a video in its release folder. That applies to that one file only, and it
     is logged as `keeping "<path>" in its release folder — <reason>`. Two copies of the same episode are
     never merged, and another torrent's file is never overwritten.
   - Tracker spam (`Torrent Downloaded From….txt`, `RARBG.txt`) never blocks, and a duplicate copy is
     discarded.
3. Records the new paths in `verifiedFilesJson` (`fullPath`) before moving the files. The move is
   all-or-nothing and rolls back on failure. Other rows' manifests are the ownership record. The layout
   works out which files are still where MonoTorrent put them (`InferTorrentLayout`). Files already moved or
   discarded are pinned, so re-running it is safe.
4. Remembers each file's final path by torrent file index in `layout-manifest.json`. A re-add of the same
   torrent loads in its release folder and points each file at its recorded path (`BackendAddSpec.FilePaths`,
   `TorrentManager.MoveFileAsync` while stopped). The files are re-checked where they are, not downloaded
   again, and a neighbour's file at the flat path is never touched. This needs the saved `.torrent`; a
   magnet-only re-add of a laid-out torrent downloads into its release folder again and is laid out afterwards.

**Tidy folders.** Downloads that finished before this layout existed, or before a restart, can still be
nested. The Downloads page button **Tidy folders** calls `POST /api/client/torrents/tidy`
(`ILayoutTidy`). It re-runs the layout over every parked, verified download, oldest first. It skips
transfers the client still holds, and it does not re-check media. It returns
`{ checked, tidied, filesMoved, stillNested, skipped }` and updates the manifests, so Open and Show in
folder keep working. Finished downloads are detached from MonoTorrent rather than seeded; a later re-add
uses the recorded paths.

The smart `TV/<Show>/Season NN` / `Movies/<Title (Year)>` save path is built by one function,
`SmartSendTargets.BuildPath`. Every grab (film, episode, season pack, request, wanted queue, picked release) sends its
catalog work (`WorkPlacement`), so the show folder is the catalog title the UI shows and the season is the catalog's
own season, never read from the torrent's name; sends with no work (search page, automation) read both from the
release. Anime is decided by the one shared rule `AnimeIdentity`. Metadata from an anime source (AniList, Kitsu,
MyAnimeList, AniDB, an anime addon id such as `kitsu:123`, catalog type anime, or a release from a site's anime
category such as nyaa) is anime with no other check. Only TMDB or Cinemeta metadata falls back to genres: an Anime
genre, or Animation made in Japan (TMDB original language ja with genre 16). Anime keeps the single `Anime` category but goes to
`Anime Series/<Show>/Season NN` or `Anime Movies/<Title (Year)>`. Every library is flat under the download root
(`Movies`, `TV`, `Anime Series`, `Anime Movies`), one Jellyfin library each, never nested in another; with no download
root the anime libraries sit beside the Anime path rule's folder. `TV` keeps its existing folder name. A send with no
catalog work tells a film from a series by the catalog type (AniList format `MOVIE` counts), else by a release with no
season or episode that names a year or "movie"; a site's Live Action category is never anime. The layout only works inside the row's save path. Transfers handled by an external client
(qBittorrent / Transmission) are not laid out.
