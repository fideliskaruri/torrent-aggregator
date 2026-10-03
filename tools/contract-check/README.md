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

| Captured catalog route | Pass | Deferred |
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
The remaining saved-links fixture `/api/title/family-guy/links` is deferred to
phase 7.1 converter verification (OPS-681), not a 2.4 failure: phase 1.6 preserves
workKey, but the scratch database has not migrated that work. Before deferring,
the checker verifies its title is unknown. Known-work links failures still fail;
unknown slugs retain 404. Null-only/empty-array and missing migrated-link state
variants remain unproven where noted. Final total: 22 pass, 38 deferred, zero fail.

All nine hard titles match title and kind. Catalog season/episode lists match
for Scorpion, Little Fires Everywhere, Frieren, A Silent Voice, Prison Break,
Money Heist, Sintel and Big Buck Bunny. Rick and Morty excludes empty S10 under
the coordinator's populated-season rule. Empty future seasons remain in Metadata.
The detailed old/new lists, including the inventory-dependent base-page season
summaries, are in `title-comparison.json`.

Twenty headless full-page screenshots cover home, films browse, search, Frieren
and Sintel at 390/1280 pixels: `old|new-{page}-{width}.png`. No document has
horizontal overflow. Browse headings match; the new home honestly omits
Downloaded, and notifications are deferred. Search now matches the legacy merge/rank
(OPS-678; follow-up evidence below). Title ownership/download controls differ because
the scratch inventory is empty. The missing service-worker MIME is OPS-676. Browse years were restored in the
wire subtitle (OPS-683).

The coordinator follow-up overwrites all new screenshots with a cookie-clean
390/768/1280 walk, scrolling to load lazy artwork before full-page capture.
Frieren now matches AniList 9.1, overview/genres, September 29 premiere, seasons
1/2, default S1 and 12 covered recommendations. Selecting S2 and refreshing
retains S2 on both servers. The earlier S2 screenshot default was a retained
`tf_season` cookie, not the API default.

Money Heist is the same entity: old primary TMDB 71446, new primary Cinemeta
tt6468322 with verified TMDB 71446. A fresh direct TMDB response confirms
S1:15/S2:16/S3:10 (provider season IDs 87809/122186/201800).
S4:8/S5:10 were stale rows retained by the union-on-refresh bug; they are removed
by complete-list replacement. Raw proof: `tmdb-money-heist-current.json`.
All visited images load, with zero broken posters and no horizontal overflow.
Featured rails contain 24 covered cards; refreshed browse took 10.79 seconds,
warm browse 1.32 seconds. Provider/cache data still changes which titles appear.

## Search and home-query follow-up

```powershell
tools\contract-check\Compare-Catalog.ps1
```

This HTTP-only comparator checks the ordered top three title/year/category
identities for six queries and records every home rail's first six titles.
Rail differences are informational counts, not silently converted into passes.
Query recipes and visible dedup/release rules were compared to the old source.

| Query | Ordered top three |
|---|---|
| frieren | PASS: main anime, Season 2, ONA shorts |
| a silent voice | PASS |
| money heist | PASS |
| scorpion | PASS |
| rick and morty | PASS |
| sintel | PASS: both servers have only two results |

| Rail | Same position / 6 | Shared / 6 |
|---|---:|---:|
| Because you're watching Sintel | 6 | 6 |
| Popular films | 6 | 6 |
| Popular series | 6 | 6 |
| Anime this season | 6 | 6 |
| New films | 6 | 6 |
| New series | 6 | 6 |
| Trending anime | 4 | 6 |
| Top rated films | 6 | 6 |
| Top rated series | 5 | 5 |
| Top rated anime | 4 | 5 |
| In cinemas | 6 | 6 |

Trending anime swaps live provider positions. The old Downloaded rail claims
Rick and Morty, so old top series shows The Sopranos at six; empty-library new
shows Rick and Morty. Fresh old trending also claims Fullmetal Alchemist:
Brotherhood later in its 24 cards, shifting old top anime; new trending does
not contain it. The original cached old top-anime first six match new exactly.
The isolated old catalog cache was refreshed for same-day comparison; its
original response is retained as `rail-old-browse.json`. No owner inventory or
stable data was changed. No rail uses a different query to explain these differences.

Final build: zero warnings/errors. Contract replay: 22 pass, 38 documented
deferred, zero fail. Nine title/kind identities and eight season layouts match;
Rick and Morty still intentionally omits empty S10. Real HTTP behavior/restart:
26 + 3 pass. TVmaze-selected western title details retain verified TMDB
presentation/numbering; anime search selections retain AniList presentation.

All fifteen `new-{home,browse,search,frieren,sintel}-{390,768,1280}.png`
screenshots are refreshed under `tools\.catalog-proof`. Search visually matches
main anime / Season 2 / ONA / 1996 film ordering and posters. Clicking Best match
opens the AniList title with default S1. Frieren's hero, overview, 9.1 rating,
premiere, episodes and recommendations match the old capture. All visited
images load and all widths have zero horizontal overflow. Home differs by the
expected missing Downloaded rail/notification count and live provider cards;
all-time top-rated rails now contain the correct classics rather than recent
releases. Paired top-section review images are `{page}-comparison-1280.png`.

Final HTTP startup readiness: 1.886 seconds. Working set after the browser walk:
347.77 MiB. Warm home browse: 1.658 seconds. An earlier cold listing migration
took 36.77 seconds before the partial-listing persistence safeguard; that is not
presented as the final warm timing. Full search/rail pairs, contract bodies and
measurements remain in the ignored proof directory.
