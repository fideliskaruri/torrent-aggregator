# HTTP catalog contract checks

PowerShell 7.5+; no production project references and no unit tests.

```powershell
tools\contract-check\Check.ps1 -BaseUrl http://127.0.0.1:3940 -AllReads
tools\contract-check\Test-Catalog.ps1
# Restart your sandbox, keeping its data directory:
tools\contract-check\Test-Catalog.ps1 -AfterRestart
tools\contract-check\Compare-Titles.ps1
```

`Check.ps1` replays the actual captured paths against the supplied base URL,
including the safe artwork lookup POST. It compares status, required keys,
primitive types, nullable unions and every returned array element against
`backend\contract\shapes.json`. TypeScript schemas supplement observed state
variants and fields absent/null in captures. Extra fields are allowed.
Null-only observations and empty arrays are explicitly noted as unproven,
not treated as evidence of a non-null type or element shape.

With `-AllReads`, every other captured GET is also sent and its actual status
recorded, with a phase-specific reason for deferral. It is not mislabeled PASS.
Captures for mutations that acquire media, change settings or affect files are
never replayed. Tools default only to loopback 3940/3931, not the owner's instance.

`Test-Catalog.ps1` uses a real HTTP server and its real SQLite Store: validation,
category filters, artwork, selected/remembered seasons, honest no-transfer state,
duplicate/concurrent WatchItem saves, partial intent patches and restart
persistence/deletion. It leaves one Scorpion row for the restart stage, which
then deletes only that row. Run on scratch data, never live data.

`Compare-Titles.ps1` compares all nine hard-set works, recording title, kind,
base-page season summaries and the count of each season's actual extras rows.
It does not truncate episode lists, equate different provider numbering schemes,
or normalize away announced seasons. Freely licensed films use TMDB identities;
the anime entries use their known AniList identities accepted by the old server.

Results and captured HTTP bodies are saved under ignored `tools\.catalog-proof\`.
Browser screenshots come from the headless Playwright MCP walk at 390 and 1280 px.
The scripts never start/stop servers, read credentials, call production services
directly or write a secret.

## Task 2.4 sandbox result

Build: zero warnings and errors. Real HTTP behavior: 26 checks passed, plus three
restart checks proving WatchItem, Follow and WorkPreference persistence/deletion.

| Captured catalog route | Pass | Fail |
|---|---:|---:|
| browse | 4 | 0 |
| recommendations | 1 | 0 |
| search/titles | 1 | 0 |
| suggest | 1 | 0 |
| artwork POST | 1 | 0 |
| title | 4 | 0 |
| title/extras | 4 | 0 |
| title/links | 2 | 1 |
| title/progress | 3 | 0 |
| watchlist GET | 1 | 0 |

The remaining 37 noncatalog GET captures are replayed but deferred to their
own phases, with reasons and observed HTTP status in `contract-results.json`.
The links failure is specifically `/api/title/family-guy/links`: its yearless
legacy slug cannot safely select a canonical work after an ambiguous title
search (OPS-681). The checker returns failure, not a waived green result.
Null-only/empty-array state variants remain unproven where noted.

All nine hard titles match title and kind. Catalog season/episode lists match
for Scorpion, Little Fires Everywhere, A Silent Voice, Prison Break, Rick and
Morty, Sintel and Big Buck Bunny. Frieren adds a provisional S3 with zero
episodes; Money Heist has provider/cache numbering differences (OPS-677).
The detailed old/new lists, including the inventory-dependent base-page season
summaries, are in `title-comparison.json`.

Twenty headless full-page screenshots cover home, films browse, search, Frieren
and Sintel at 390/1280 pixels: `old|new-{page}-{width}.png`. No document has
horizontal overflow. Browse headings match; the new home honestly omits
Downloaded, and notifications are deferred. Search ranks the anime fourth
rather than first (OPS-678). Title ownership/download controls differ because
the scratch inventory is empty. The missing service-worker MIME is OPS-676.
Startup readiness was 3.09 seconds; after the new-server walk, working set was
255.7 MiB and private memory 180.1 MiB (`final-metrics.json`).
