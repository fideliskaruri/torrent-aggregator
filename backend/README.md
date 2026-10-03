# TorrentFlow backend skeleton

Task 2.1, OPS-659 / FEAT-35. This is an isolated foundation, not a working replacement
for the live backend. The other modules intentionally contain only placeholders.
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

Only actual loopback connections on the owner listener are owners. Forwarded
headers never grant identity; Cloudflare headers on the owner port return 421.
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
