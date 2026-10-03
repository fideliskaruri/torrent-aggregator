# TorrentFlow web contract baseline

Task 0.4, OPS-642 / FEAT-35. Only the sandbox at **http://127.0.0.1:3931** was called.
The live port 3930 and its process were not accessed or stopped. No mutating API
requests were made. This is an owner-local capture, not an authenticated requester capture.

Verified baseline: **93 method/path routes** (83 web, 10 server-only), **45 captured
route patterns**, **63 response captures/schemas**, and **48 source-only mutation
routes**. Five distinct TS field mismatches are tracked as **OPS-648**.
`verification.json` records the artifact checks, not a claim of full behavioural QA.

### Isolated rebuild coverage extension (OPS-842)

Three previously unlisted web routes now have real HTTP captures from port 3966:
`POST /api/library/imports/scan` (202, an owned empty folder, without confirmation),
`GET /api/library/roots` (200), and `GET /api/requester/calendar` (403, owner-local).
These are explicitly labelled **rebuild responses**, not legacy baseline evidence.
The calendar capture proves owner refusal only, not requester success. Existing
capture bodies and schemas are unchanged. Reproduce these additions with
`python tools\.apicontract2-proof\capture-missing.py` against the isolated proof
server; never point the script at the live instance.

The API repair runner in `tools/.apicontract2-proof/measure.py` corrects synthetic
mutation fixtures against the stored legacy handlers. It resolves TypeScript
inheritance and the Downloads-specific `ClientTorrent` nullability without changing
the captured contract or web types. A missing notification/download/link is not a
successful mutation; missing notifications/links return 404, invalid download IDs
return 400, and notification writes return 204. See its report for before/after
counts and the remaining Targets/Library and Metadata failures.

## Files

### Additive owned-quality extension (OPS-857)

The original capture baseline is unchanged. The title read adds optional
`upgrade: {resolution:number, seeders:number}` or
`bestAvailable: {resolution:number|null, checkedAt:string}` at film level and
on each episode. Both are null when the owned quality meets the preference or
the evidence has expired or become invalid. Unknown title responses may omit
these optional additions. Seasons add `upgradeableEpisodes:number`,
counted over all catalog episodes rather than just the rendered 200.
Existing `owned`, availability, transfer and Library fields retain their shapes.
`owned-quality.schema.json` describes these additions without making them required.

Owner-only POST actions `/api/title/{workKey}/check-again` and `/upgrade` accept
`{season?:number,episode?:number}` (empty object means the title).
Check again returns `{items:[{episodeId:string|null,upgrade?,bestAvailable?}]}`;
Upgrade returns the existing TargetActionReply shape. The web types currently
declare `TitleOwned` but not these quality additions; the later web lane should
add optional fields to `TitleDetailPayload`, `TitleEpisode` and `TitleSeason`, not change
any existing required property. Real HTTP evidence: `tools\.upg-proof\report.md`.

- `routes.md`: one row per method/path, including server-only endpoints.
- `routes.json`: the same inventory with capture links and source locations.
- `captures/<family>/<name>.json`: `{method,path,status,contentType,body}` from real HTTP.
- `shapes.json`: observed response schemas per capture, route expectations and parsed
  TypeScript declarations. Schema nodes use JSON Schema `type`, `properties`,
  `required`, `items`, `anyOf` and `$ref`. The containing file is a schema **registry**,
  not a single schema to validate a response against.
- `ts-cross-check.json`: conservative baseline comparisons against TypeScript.
- `source-contracts.json`: exact server handler evidence and inferred request fields,
  especially for mutations and branches not exercised.
- `source-index.json`: exhaustive endpoint registrations, web API/helper references and
  TypeScript declaration locations, for independently auditing inventory coverage.
- `scripts/`: PowerShell 7.5+ capture and derivation scripts, no Node/JS or unit tests.

## Reproduce

From this worktree, with the coordinator's existing sandbox running:

```powershell
& .\backend\contract\scripts\Inventory.ps1
& .\backend\contract\scripts\Capture.ps1
& .\backend\contract\scripts\Capture.ps1 -Details
& .\backend\contract\scripts\Build-Contract.ps1
& .\backend\contract\scripts\Build-Shapes.ps1
& .\backend\contract\scripts\Validate.ps1
```

Capture fails if 3931 is unavailable; it never starts a server. Its hostname/port are
fixed and POSTs are allowlisted: artwork lookup, library backfill estimate, source
health test and TMDB credential test. Those handlers were inspected and do not save
settings or start downloads. Desktop update check **is not treated as read-only**:
it updates check state and is therefore source-only, as are installation, filesystem
open/reveal, recovery, tidy, automation, torrent and request actions.

The scripts discover work keys and library IDs from the captured library, and a
download hash from the captured transfers. Detail captures cover real series,
progress, linked records, extras, release lists, deletion previews and alternatives.
Sintel supplements series examples with a film. Owner/request lists, settings and
notifications are also captured. There are no GET request-ID detail endpoints.

Bodies retain JSON values, including ISO dates as strings (`-DateKind String`).
Only formatting changes and **every array longer than 20 is recursively capped at
its first 20 entries**. Pagination, counts and other scalar fields are not rewritten.
Consequently a captured `hasMore`, count or cursor may describe the full server
response, not the 20 stored elements. Data is deliberately not anonymized.

## How a later checker should use this

1. Match method plus route pattern in `routes.json`; bind real IDs from the new server,
   not necessarily these old IDs. Query/body fields and source references are recorded.
2. Select the expected **status-specific** schema in `shapes.json.captures` and validate
   the new response body. Keep error schemas separate from successful response schemas.
   Do not interpret requester-only 403 captures as requester success contracts.
3. Use `shapes.json.routes[].expectedResponse` and `typescript` for the intended web
   contract, resolving `#/typescript/<name>` references in this registry.
4. Compare structural types, nullability and field presence, not example IDs, timestamps,
   URLs, tokens, cache contents, search order or live progress. Numbers are JSON
   `number`; the observations alone cannot prove an integer-only requirement.
5. Treat `x-unobserved` (empty arrays), `x-unresolved`, inheritance (`x-extends`),
   `unknown` and unsupported TS generic/indexed expressions as **unproven**, not as
   empty objects, an absent field requirement or a successful validation.
6. `required` in an observed schema means present in every captured sample, **not**
   globally required by the API. Null-only observations establish observed nullability,
   not the underlying non-null type. Consult TS and source for uncaptured variants.
   Extra server fields are allowed; TS optional fields are not required.
7. For mutations, use the source-derived expected response and request field evidence;
   evidence is explicitly `from source, not captured`. Handler code remains the
   authoritative fallback where generic/conditional return types cannot be inferred.

The scripts generate and cross-check a baseline only. They are not the future
`tools/contract-check` implementation.

## Rebuild settings routes

The rebuild exposes the owner-only TMDB GET/PUT/DELETE/test routes and source
GET/PUT/DELETE/test routes. Credentials are represented in typed settings only by
opaque references to restricted files under the data directory's `secrets` folder;
responses contain configuration status and a masked hint, never the credential.
A saved TMDB key overrides the environment key, and removing it restores the
environment fallback. Testing never saves a key.

Torrent source settings remain in the Sources section. Metadata provider settings
use the same typed `SourceSettings` contract inside `MetadataSettings.Sources`,
so metadata providers never enter Find's torrent-source pool. Older metadata rows
gain the provider defaults at startup. Provider enablement, base URLs and timeouts
take effect on subsequent requests, including cache reads. Built-in sources cannot
be deleted; custom Torznab sources can.

OPS-800's client-settings projection is separate and remains in
`Api/DownloadEndpoints.cs`; that file was excluded from the settings-route lane.
The settings proof records its outstanding GET and PUT shape mismatches separately.

## Baseline findings and limitations

- The requester endpoints deliberately refuse the owner (`403`, `requester_only`).
  Their success payloads remain source/TS-derived; no fake requester identity was used.
- Actual title detail responses omit null `ids.tmdb`, `ids.anilist` and `ids.mal`,
  although `WorkIds` declares required nullable properties.
- Actual linked-record responses omit null `mediaType` and `season`, although
  `WorkLink` declares required nullable properties. These are five distinct
  field-level contract mismatches across two route patterns, not five independent bugs.
- The app consumes `{rules: Rule[]}`, selecting `body.rules`; the hook's `Rule[]`
  generic is its **post-selection** type. Settings similarly selects a count. Neither
  is a wire-array or wire-number contract mismatch.
- Legacy `/api/search`, `/api/suggest`, `/api/history` and `/api/requester/titles` exist
  but are not current web network calls. Search uses `/api/search/titles`; History
  reuses the activity feed with a sent filter.
- No EventSource, Hono/RPC, axios or React Query query-key clients were found under
  `web/src`. URL and `dataIdentity` drive the polling fetch hook.
- Source parsing is intentionally conservative; it is not a TypeScript compiler.
  See `ts-cross-check.json` and manual findings above rather than treating zero findings
  for an unresolved expression as proof. Role projections, empty collections and
  provider/network-dependent variants need additional samples during phase review.
