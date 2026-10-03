# TorrentFlow backend skeleton

Task 2.1, OPS-659 / FEAT-35. This is an isolated foundation, not a working replacement
for the live backend. Modules not yet implemented still contain placeholders.
No old project is referenced. The 93 captured routes remain the subsequent phases'
contract. Health, the static SPA and users/access (OPS-662) are implemented here.

## Run safely

From the `rebuild` worktree, with .NET 10 and the repository's pnpm available:

```powershell
.\backend\run.ps1
```

This builds `backend\TorrentFlow.Backend.slnx`, builds `web` with `pnpm build` if
`web\dist\index.html` is absent, and starts **http://127.0.0.1:3940**, using only
**D:\code\memtest\rebuild-dev\data**. Ctrl+C stops that foreground process.
It does not stop, call, migrate or adopt either existing server.

The equivalent host command after building is:

```powershell
dotnet backend\src\Api\bin\Debug\net10.0\TorrentFlow.dll `
  --urls http://127.0.0.1:3940 `
  --TorrentFlow:DataDirectory D:\code\memtest\rebuild-dev\data `
  --TorrentFlow:Scheduler:Disabled true --background --no-browser
```

`TorrentFlow:DataDirectory` / `TorrentFlow__DataDirectory` is explicit. Without it,
the default is the platform application-data directory's **TorrentFlow-Rebuild**,
never TorrentFlow's old directory, with no legacy auto-adoption. A `portable`
marker next to the executable selects `rebuild-data` there. The executable is
`TorrentFlow`; the default listener is loopback port 3940. `--urls` and
`ASPNETCORE_URLS` may explicitly override it. `--background` and `--no-browser`
are switch-only flags stripped before configuration parsing; `--desktop` optionally
opens the browser unless either suppressing flag is set. Tray/update
integration remains a later task.

`TorrentFlow:Scheduler:Disabled=true` disables the typed scheduler section at
startup, including an existing database; omitting it does not re-enable a saved
disabled section. There are no workers in this skeleton. Other existing settings
are retained on restart.
`TMDB_API_KEY` is written to a private file under `data\secrets`; the metadata
section holds only an opaque file reference. Windows restricts directory access
to the current identity; Unix uses directory 0700 and file 0600. Secret values
are never stored in the database or logged.

## Store and boundaries

- 35 application tables from [the schema](..\docs\design\1.1-data-model.md), plus
  EF migration history and lock. All keys, restrictive/cascading FKs, unique and
  partial indexes, NULL-aware expression identities, enum/boolean/JSON/numeric
  checks and the WorkFolder shape are mapped. Six expression indexes are frozen
  explicitly in the initial migration because EF has no expression-index API.
- Migrations apply before listening. WAL is enabled at initialization; every
  connection gets foreign keys enabled and a 5-second busy timeout. SQLite busy
  errors are not mistaken for missing rows.
- EF property-bag entities and DbContext remain **internal to Store**. Domain
  immutable records are the column/type contract, converted explicitly at the
  boundary. EF's generated initial migration and model snapshot freeze that model;
  changes require a new migration, not silent schema mutation.
- Scoped, keyed `IStore` capabilities: `metadata`, `find`, `targets`, `access`. Their table
  rights are fixed at injection, not selected by `StoreCommit.Owner`. There is
  no runtime converter, Library or Check write capability.
  `access` uses the Targets-owned User/Setting/Attempt tables only; API code never
  receives SQL, EF entities or a DbContext.
- Atomic writes support numeric-version CAS, exact unversioned row-CAS and
  payload-bound immutable Attempt receipts. Current skeletal reads implement
  bounded primary-key pagination and direct named column predicates; traversal,
  age/lease predicates and non-primary orders explicitly refuse unsupported
  operations. Open Attempt mutation and joint Library/Check proposal guards
  also **fail closed** until their implementing phases; Targets cannot forge
  inventory, root, release-enrichment or file-path changes.
- Typed schema-v1 sections: engine, sources, metadata, remoteAccess, desktop,
  quality, requests, scheduler, jellyfin, migration. Defaults use design bounds
  (400/120/40 peers, 12 probe peers, 32 MiB write cache, 40 files, 20-second check,
  256 KiB/64 KiB/s good evidence, 8/2 scopes and 10/2 checks), source tiers and
  start spacing. Unspecified defaults: 4 active downloads, 1080p/English preferred,
  requests manual with 100 open per requester, remote listener disabled on 3939.
  ListenPort=0 is an unbound setting; Engine's later task chooses and saves it
  before binding. Scheduler/import readiness gates start false.
- `Directory.Build.targets` rejects any ProjectReference outside the exact allowed
  paths in [the graph](..\docs\design\1.3-interfaces.md), including old projects.
  Domain also rejects package references. Nullable and warnings-as-errors apply
  to every backend project; MonoTorrent stays at the existing **3.0.2** version.

## Host verification

`GET /api/health` returns version, uptime, migration/table/settings readiness and
database status, with 503 when unready. It never calls providers or starts payload.
Console and daily/10 MiB rolling logs live under `data\logs` (14 files retained).
Numbers/dates use invariant culture; HTTP JSON is camelCase with null omission.
The host resolves `wwwroot` beside the executable or the existing `web\dist` from
repository/content-root ancestors; `TorrentFlow:WebRoot` explicitly overrides it.
Static assets precede SPA routing, unknown `/api` routes return JSON 404 for
every method, and absent assets never return index.html. Old `/activity` and
`/client` bookmarks retain their 308 redirects.

```powershell
curl.exe -i http://127.0.0.1:3940/api/health
curl.exe -i http://127.0.0.1:3940/
curl.exe -i http://127.0.0.1:3940/title/film:test
curl.exe -i http://127.0.0.1:3940/api/does-not-exist
```

Migration authoring (offline, no old data):

```powershell
Set-Location backend
dotnet tool restore
dotnet ef migrations add Name --project src\Store --startup-project src\Store
dotnet ef migrations has-pending-model-changes --project src\Store --startup-project src\Store
```

## Users and remote access

`GET /api/me`, `GET /api/features`, `GET/PUT /api/settings/remote-access`
and `GET /api/settings/remote-access/check` retain captured response shapes,
including explicit nullable fields. The captured contract contains no standalone
user CRUD or application password/sign-in endpoints. A local owner is enrolled
before listening; signed-in requester emails map to durable users. The app's
existing `/cdn-cgi/access/logout` link redirects tunnel sessions to the configured
Cloudflare team's logout endpoint; local use redirects home.

Direct connections on the non-tunnel listener are local owners; listener binding
is the trust boundary (loopback by default, explicitly overridable for LAN/Docker).
Forwarded headers never grant identity; Cloudflare headers on the owner port return 421.
The dedicated tunnel port requires Cloudflare Access RS256 JWTs with the correct
issuer, audience, lifetime and email. Service tokens and forged signatures fail.
Requester access is opt-in through settings (allowed by default when remote access
is enabled); method/path checks deny all other API routes before user persistence.
Shared catalog responses additionally redact owner transfer, filesystem and magnet
details. Caller request-state projections belong to the subsequent Targets/API
request routes, not authentication.

Non-secret remote configuration is a typed, revisioned `Setting.remoteAccess`
row, including `tunnelBindAddress`; saving is CAS-protected and becomes visible
only after the transaction commits. Tokens, passwords and private keys are never
persisted to SQLite. Listener changes require restart; team/audience/owner and
requester changes apply immediately, as does disabling access. Tunnel owners
cannot change these settings or start host file/folder apps. Browser cross-site
writes are refused. `TorrentFlow:RemoteAccess` host configuration can overlay
startup values; the default disabled tunnel port is 3939 to avoid the 3940 owner.

Cloudflare signing keys are fetched over HTTPS with a one-hour cache, bounded
24-hour last-good fallback, five-minute unknown-key refetch and 30-second
failed-fetch backoff. `TorrentFlow:RemoteAccess:DevJwksPath` reads public JWKS from
a file **only in Development**; production ignores it. No private key is required
by the server.

HTTP-only proof (stop any other rebuild test server first):

```powershell
dotnet build backend\TorrentFlow.Backend.slnx --nologo
.\tools\Test-AccessContract.ps1
```

The script owns/stops its processes by PID, uses 3940 and a temporary dedicated
3941 tunnel listener in the scratch data directory, validates capture shapes,
signs test tokens in memory, proves a real non-loopback requester/owner connection,
and restores saved remote settings. Evidence and public test JWKS remain under
ignored `tools\.access-proof`. It never calls the old server or live installation.

## Raw sources (OPS-680 / OPS-686)

`ISources` implements apibay, Nyaa, EZTV, YTS (films, provisional), TorrentsCSV,
Knaben and AnimeTosho. It returns raw names/hashes, nullable listed counts/size/date,
and magnets/torrent URLs, without work matching, episode parsing or health decisions.
EZTV requires `SourceQuery.Identity = new("imdb", "tt…", "series")` supplied by
Metadata/Find; Sources never does a second catalog lookup or trusts EZTV coordinates.

The typed `Setting.sources` array is read on every call, in an independent short
Store scope so concurrent calls on the singleton port never share an EF operation.
Store remains the single owner of tier/enabled/concurrency/spacing defaults.
Core and Fallback defaults are enabled; OptIn defaults are disabled. Fallback adapters
are TheRARBG JSON, BitSearch HTML, LimeTorrents RSS, TorrentDownloads RSS and
TorrentDownloadInfo RSS. Opt-ins are 1337x, SubsPlease (anime), Internet Archive
(explicit public-domain movies only) and configured Torznab endpoints.
Find, not Sources, selects the fallback tier.
Host configuration `TorrentFlow:Sources:<id>:BaseUrl` and `…:Enabled` can overlay
settings for a local benchmark. HTTPS is required except for explicitly configured
loopback HTTP stubs. No certificate validation bypass exists.

One host gate is shared across adapters and redirect hosts, with FIFO owner/background
lanes, owner-first queued admission and the strictest registered host courtesy policy.
Global adapter concurrency is 24 with at most eight background calls. Each logical
call has at most six seconds **from enqueue**, including settings, admission, spacing,
redirects and all pagination. There is no inline retry or mirror fallback after errors.
429/503 Retry-After delays/dates are honored without a larger-delay cap; missing/invalid
429 headers back off 30, 60, 120, 240, then 300 seconds. Success resets strikes.
503 without Retry-After/transport failure invents no cooldown. Cooling sites skip
immediately with RetryAt; queued calls are also released when cooldown is imposed.
Other sites continue independently.

`SearchStreamAsync` yields cumulative immutable snapshots while pages arrive;
`SearchAsync` returns the final snapshot. A pool/window cap, deadline, failed page,
or cooldown is never Complete. The pool asks for at least 50 and retains at most
80 unique hashes. TorrentsCSV follows `next` using `after`; AnimeTosho/EZTV/YTS have
bounded pagination. Knaben's nested total and Nyaa's fixed RSS window keep truncation
honest. RSS parsing prohibits DTDs/resolvers and malformed XML is SourceFailure.
CDN scripts after a completed RSS document are ignored, not malformed interior XML.
TorrentDownloads' known malformed `Prison Break S01` feed (OPS-653) remains a failure,
with XML line/column diagnostics. HTML detail fanout and Torznab capability negotiation
and pagination share the original enqueue deadline; no inline retry or TLS bypass.
Torznab requires `BaseUrl` and negotiates advertised text-search capabilities before
search. Its optional API key is host `…:ApiKey` configuration or an opaque
`Credential.FileId` pointing to `DataDirectory\secrets\<id>.secret`, never saved
as plaintext settings. Missing endpoints/credentials are Unconfigured.
Public-domain Archive rows retain webseeds and unknown listed counts, never synthetic
seeders. Human relative dates such as `6am` remain unknown, not guessed from today's date.
Responses are bounded to 8 MiB. Diagnostics include queue wait, first start, request
count, last HTTP status, returned count, truncation and `upstreamElapsed` (headers/body
I/O including connection setup, excluding gate wait); listed seeders are not health.
The first call on an idle gate has no courtesy delay. Sequential apibay searches can
spend nearly two seconds waiting for the previous call's start-spacing window.
EZTV/YTS defaults point directly at their live canonical API hosts; a short TorrentsCSV
page ends its cursor traversal rather than fetching an unnecessary empty page.

In **Development only**, the owner-only, loopback-only read hook is:

```text
GET /api/dev/sources/search?q=Sintel&source=apibay&lane=owner
GET /api/dev/sources/search?q=Scorpion&source=eztv&imdb=tt3514324
GET /api/dev/sources/search?q=Frieren&source=nyaa&stream=true
```

The last form returns NDJSON snapshots. Both projections redact sensitive URI query
values (including nested tracker/webseed parameters), while internal raw releases
remain unchanged. Optional category accepts the existing
`tv`/`movies` names and the typed `series`/`films` names. The hook is registered
through Targets -> Find -> Sources composition; Api adds no forbidden references.

HTTP-only verification, using isolated output so another rebuild server isn't locked:

```powershell
dotnet build backend\TorrentFlow.Backend.slnx --artifacts-path backend\.sources-build --nologo
$env:ASPNETCORE_ENVIRONMENT = "Development"
dotnet backend\.sources-build\bin\Api\debug\TorrentFlow.dll `
  --urls http://127.0.0.1:3945 `
  --TorrentFlow:DataDirectory D:\code\memtest\rebuild-dev\data `
  --TorrentFlow:Scheduler:Disabled true --background --no-browser
# From another shell while this server is running:
python tools\sources-check.py
python tools\sources-check.py --tier fallback
# Stop that exact server PID before running the self-owned stub proof:
python tools\sources-http-proof.py
python tools\sources-fallback-proof.py
# With 3945 free: one fresh host/gate per Core source, then a warm idle comparison:
python tools\sources-cold-check.py
```

`sources-check.py` writes the applicable nine-title live matrix, raw snapshots,
listed maxima, latency/diagnostics and comparable Phase 0 counts to ignored
`tools\.sources-proof\core.json`. Audit limits/queries differed (50 vs 80, season
filters/aliases), and audit medians excluded courtesy waiting; counts are only
rough comparisons. `sources-http-proof.py` owns/stops its 3945 process by PID and
uses a loopback site on 3946. It proves the enqueue deadline with zero-I/O expired
waiters, owner queue priority, partial-page timeout/streaming, disabled/OptIn defaults,
malformed RSS/DTD refusal, insecure redirect refusal, independent-site/shared-host
cooldown, queued cooldown release, 503-without-header, delay/date/default/exponential
429 cooldown and an uncapped 500-second Retry-After. Evidence is
`tools\.sources-proof\infrastructure.json`. Neither script calls 3930 or stable data.
`sources-cold-check.py` records queue, upstream and HTTP elapsed time, request count,
comparison with the queued matrix and owned PIDs in `tools\.sources-proof\cold.json`.
The Fallback matrix is `fallback.json`. `sources-fallback-proof.py` exercises all nine
new protocols against real loopback HTTP and the actual host, including Torznab
caps/search and credential redaction, base32 magnets, nullable counts, public-domain
filtering, charset/CDN trailers, malformed interior XML, streaming 1337x detail
deadline and BitSearch 429/cooldown. Its process is stopped by PID; evidence is
`tools\.sources-proof\fallback-infrastructure.json`. Live 1337x TLS failures are reported,
not worked around; a Torznab endpoint must be explicitly configured to contact one.
