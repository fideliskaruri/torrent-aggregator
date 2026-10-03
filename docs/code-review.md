# Code review (rebuild @ e9272ca)

Done by the coordinator, no sub-agents. Tags: keep, refactor, delete, cut-v1. Severity: high, medium, low.

## Method

- Code graphs (graphify, AST only) for `backend/src` and `web/src`. No import cycles. Backend project references match the module graph in `rebuild-plan.md`.
- Clone detection (jscpd, 8+ lines): under 1% copy-paste in code. **The duplication is conceptual, not textual**: the same idea is written differently in several places, so a clone tool can't catch it.
- Size, comment density and raw `fetch` counts per file.
- Live check on the test copy (port 3968).

## Cross-cutting findings

### X1. The web re-derives title identity that the server should own (high, refactor)

Root cause behind the Little Fires `type=Movies` bug and the "same idea in several places" problem.

- **The server leaves most rows without identity.** On the test copy, 18 of 30 `/api/client/torrents` rows have no `workKey`, `workMediaType`, `season` or `episode`, even when the name is `Little.Fires.Everywhere.S01E01...`. The server has `ReleaseParser` but doesn't apply it to unmatched rows.
- **So the web guesses**, from different inputs in different places:
  - `downloads/grouping.ts:465-540` decides series vs film by parsing the name (`parseEpisode`, `isSeriesDownload`).
  - `downloads/page.tsx:159-174` (`downloadTitleHref`) builds the link from the qBittorrent `category` ("Movies").
  - They disagree, so the card groups as a series but links as a film.
- **Name parsing exists in 8 web files**: `lib/torrents/episodes.ts` (390 lines), `components/title/work-key.ts` (378), `lib/torrents/work-identity.ts` (364), `lib/metadata/release-art.ts`, `lib/metadata/artwork.ts`, `lib/download/smart-category.ts` (243), `components/library/library-state.ts:175`, `app/watchlist/page.tsx:232`. Plus `lib/metadata/clean-torrent-title.ts`, which nothing imports (dead).
- **Fix:** every row the server returns carries a resolved identity: `workKey` (matched, or a parsed fallback key), `kind` (film or series), `season`, `episode` and a display title, all from `ReleaseParser`. The web only reads it. Delete the web parsers except input helpers (magnet and infohash).

### X2. Duplicate copies of the same episode downloaded (high, investigate)

The test copy has 4 or more transfers of Little Fires Everywhere S01E01. Either the converter imported legacy duplicates as separate rows, or nothing stops a second grab of an owned episode. This touches the owner's "avoid redownloading" rule. Trace in the Store and Targets reviews.

### X3. Two ways to call the API (medium, refactor)

- `hooks/use-api-query.ts` (322 lines) and `lib/observability/poll-schedule.ts` (374) exist.
- Yet there are 65 raw `await fetch(` calls across 26 files, 8 of them in `downloads/page.tsx`. Each one handles errors, JSON and polling its own way.
- **Fix:** one typed API client module per area, called only through `useApiQuery` and a matching mutation helper. No raw `fetch` in components.

### X4. God files (high, refactor)

- **Web files over 1,000 lines:**
  - `downloads/page.tsx` (2,032)
  - `title/title-detail.tsx` (1,983)
  - `settings/page.tsx` (1,437)
  - `watchlist/page.tsx` (1,433)
  - `title/episode-list.tsx` (1,267)
- **Backend:** `Engine/MonoTorrentEngine.cs` (1,602), `Store/LegacyConverter.cs` (1,117), `Targets/TargetPipeline.cs` (691).
- **Graph hubs:** MonoTorrentEngine has 112 edges and TargetPipeline 80; Downloads `ClientPage` has 44.
- **Rule from now on:** files of about 300 lines or less, with one job each, split before anything is added.

### X5. Comment essays (low, refactor)

Files at 40 to 52% comment lines:
- `work-identity.ts`
- `title/types.ts`
- `work-key.ts`
- `poll-schedule.ts`
- `use-api-query.ts`

Cut the essays to one-line clarifications.

### X6. Dev and proof code in the product (medium, delete)

- 9 `Api/Dev*.cs` files and 12 `/api/dev` route maps, 5 of which share a copied guard header (`DevPlan.cs:18`).
- `tools/.*-proof/` folders.
- **Fix:** drop the dev routes for v1. Proof rituals are cut.

### X7. Business logic inside Api (medium, refactor)

The following live in the Api project:
- `Api/Requests/RequestService`
- `Api/Automation/Hunter`
- `Api/Notifications/*`

Request logic reads `Targets.CatalogState` directly. Move them into the module that owns them, or into Targets.

### X8. Schema history that never shipped (medium, refactor)

There are 8 EF migrations of about 2.8k lines each. Collapse them into one initial migration before prod.

## Per-component review

### Targets (3,340 lines, 22 files)

The core job is small: an owner asks for a film or episodes, then find, check, plan, fetch and file each one, and skip what's owned. Most of the size comes from v1-cut features woven into that core path.

| # | Finding | Where | Tag | Sev |
|---|---|---|---|---|
| T2 | Queue ranking: `Rank`, `OwnerRanked`, `TargetPriority`, `NowAt`, `RankAsync`, and a priority rewrite of every target on every tick. v1 is FIFO plus Download now (one flag). | `TargetPipeline.cs:299-325,363-368`; `TargetScheduling.cs`; 71 hits in 18 files | cut-v1 | high |
| T3 | Per-target audio-language policy with replan, cancel and policy revisions on each re-request. v1 has one global language rule. | `TargetPipeline.cs:84-85,134-150`; `TargetAudioPolicy.cs`; 35 hits in 11 files | cut-v1 | medium |
| T4 | `AcceptAsync` is one 170-line method that handles 5 origins, scope intents, audio replans, revivals and message text. | `TargetPipeline.cs:66-224` | refactor | high |
| T5 | Scope intents: when the episode list isn't confirmed, the request is parked and retried hourly. The episode number is parsed back out of the row id string. | `TargetPipeline.cs:98-121,394-396` | refactor | medium |
| T6 | Discovery stages (Finding, Checking, Planning) are written to the DB per row through `onStage`, with versions and leases, just to show progress. | `TargetPipeline.cs:494-497` | refactor | medium |
| T7 | Scheduler batches by an 8-field string key. | `TargetPipeline.cs:372-373` | refactor | low |
| T8 | Same "rebuild the engine queue" block copied 3 times. | `TargetPipeline.cs:285-292,312-319,336-339` | refactor | low |
| T9 | Download now auto-approves pending friend requests from inside Targets. That's request logic. | `TargetPipeline.cs:266-279` | refactor | medium |
| T10 | Upgrades, "best available" sweeps and quality evidence. Cut for v1. | `TargetUpgrades.cs` (363) | cut-v1 | medium |
| T11 | Replace, alternatives, live probes and stall swaps. v1 keeps Find another only. | `TargetRecovery.cs`, `TargetSwapTransfers.cs` (161) | cut-v1 | medium |
| T12 | `DiscoveryStopping` digests the candidate pool and verdicts to avoid re-running discovery: a cache on top of a cache. | `DiscoveryStopping.cs` (124) | delete | low |
| T13 | `DiscoveryPlan.RunAsync` is one 320-line method. | `DiscoveryPlan.cs:14-336` | refactor | medium |
| T14 | Raw magnet downloads are a second pipeline with their own queue order, settings, tick and recovery. | `RawDownloads.cs` (359) | refactor | medium |
| T15 | One `LegacyEvent` attempt row written per accepted target to feed the cut activity timeline. | `TargetPipeline.cs:194-195` | cut-v1 | low |

**Simpler shape:** a target has the states Wanted, Searching, Fetching, Filing, Waiting(reason), Done and Removed; `DownloadNow` is a flag. Delete T1, T2, T3, T10, T11, T12 and T15, then split what's left into `Accept`, `Run` and `Actions`, each at most 300 lines. Estimated result: about 1,500 lines, down from 3,340.

### Library (2,495 lines)

| # | Finding | Where | Tag | Sev |
|---|---|---|---|---|
| L1 | `ScanFilesAsync` is one 157-line loop doing four jobs: walk files, parse name plus up to 4 parent folders, bare-episode guesses, metadata match (year-less fallback, file vs folder disagreement, runtime check, per-scan caches). The matching is wanted; it belongs in one pure `Match(evidence) -> candidates + confidence` function. | `MediaImport.cs:83-240` | refactor | high |
| L3 | `AdoptAsync` builds a 35-argument `MediaFileRow` that repeats the track-in-place path. Two ways to record one file. | `MediaImport.cs:43-79` | refactor | medium |
| L6 | Hand-written MKV/AVI/MP4 parsers (284 lines) just to read runtime and size. | `NativeContainerDetails`, `VideoDimensions`, `VideoSignature` | keep | low |
| L7 | `LibraryLayout.Names`: 121 lines of regex guessing which torrent folders to keep or strip. Name from catalog identity instead: `Title (Year)/Season 01/Title S01E02.ext`, subtitles share the stem. No guessing. | `LibraryLayout.cs` | refactor | high |
| L8 | Root management (add, check, remove, configure, seed from legacy, ~200 lines) and a 142-line `PlaceAsync` with priority, reservations, volume-serial grouping, caps, pins and Replace suffixes. One root makes this ~40 lines. | `LibraryPlacement.cs:11-204,283-425` | cut-v1 | high |
| L9 | `RawDownloadFiles` belongs to the second raw-magnet pipeline (T14). | `RawDownloadFiles.cs` | refactor | low |

**Simpler shape:** `Scan` (walk + parse), `Match` (pure), `Track` (one write path), `Place` (one root, identity-named path). About 900 lines.

### Store (20,789 lines, ~16k generated)

| # | Finding | Where | Tag | Sev |
|---|---|---|---|---|
| S1 | A home-made row store on EF Core: `Set<Dictionary<string,object>>`, a reflection `Schema`, per-module "capabilities" with writable-table lists, Library "write proposals" validated in `CommitAsync`, a 500-row read cap with base64 cursors. 243 `ReadAsync<` and 109 `CommitAsync(` call sites. Replace with a typed `DbContext` and LINQ. | `Schema.cs` (158), `StoreCapabilities.cs` (239), `FindSelection` | refactor | critical |
| S2 | Legacy conversion is dead (data wiped, fresh start): `LegacyConverter` (1,103), `tools/Convert`, `LegacyTorrentVerifier`, `LegacyActivityText`, `conversion-complete.json` checks, `AdoptConvertedAsync`, `ReadLegacySettingsAsync`, `SeedAsync`. Also makes the rehearsal/switchover phase moot. | `Store/Legacy*`, `HostPaths.cs:25`, `ImportEndpoints.cs:137` | delete | high |
| S3 | 7 migrations + snapshot for an app that never shipped. Collapse to one `InitialSchema` after S1/S4. | `Migrations/` | delete | medium |
| S4 | Wide positional records built with runs of nulls: `TargetRow` 33 fields, `MediaFileRow` 32, `WorkRow` 24, `RawIntentRow` 22, `FileOperationRow` 20, `AttemptRow` 17, `StorageRootRow` 17, `AutoRuleRow` 16. Use named properties; drop cut-feature fields. | `Store/Rows*` | refactor | high |

### Engine (2,448 lines; `MonoTorrentEngine.cs` 1,532)

| # | Finding | Where | Tag | Sev |
|---|---|---|---|---|
| E1 | Pre-download probing: metadata probes, piece observation, admission claims, probe-to-download handover, `ProbeIO`, `ProbeSampling`, `NetworkObservation`, plus Check (`SwarmCheck` 285, `CheckRepository` 110). ~1,200 lines. The download itself is the probe: start the best-seeded candidate, detect stalls, Find another. **Owner decision.** | `MonoTorrentEngine.cs:281-676`; `Check/` | delete? | critical |
| E2 | Reflection into a MonoTorrent internal (`MetadataStart.Invoke`). Breaks on any library update. Goes with E1. | `MonoTorrentEngine.cs:273` | delete | high |
| E3 | Filing permit protocol across Engine, Library, Store (`PrepareFilingAsync`, `PublishFilingAsync`, `PrepareDeleteAsync`, `CompleteFilingAsync`). Files already land at the final path + `.partial`: stop, rename, record. | `MonoTorrentEngine.cs:1055-1170` | refactor | high |
| E4 | Dev-only engine code: `SaveDevStateAsync`, `RemoveDevAsync`, `PrioritizeDevFileAsync`, piece diagnostics. | `MonoTorrentEngine.cs:1292,1491` | delete | medium |
| E5 | DHT tuning: `DhtBootstrap` (104, node cache), `ReliableDhtEngine` (35). Keep only the idempotent-start fix if still needed. | `Engine/Dht*` | cut-v1 | low |
| E6 | `ExternalDownloadScanner` (181) reads other clients' resume files; `ExternalMediaAdoption` (99). A second import path. **Owner decision:** fold into folder import unless continuing other clients' partial downloads matters. | `Engine/External*` | delete? | medium |

### Api (6,851 lines)

| # | Finding | Where | Tag | Sev |
|---|---|---|---|---|
| A1 | Production wiring lives in files named Dev*: `AddDevEngine` registers the real engine, `AddDevLibrary` the real import, `MapDevLibraryAsync` maps real routes. Rename to `EngineModule`, `LibraryModule`, etc. | `DevEngine.cs:22-34`, `DevLibrary.cs:19-22`, `Program.cs:78-100` | refactor | high |
| A2 | `DevFiling`: a separate dev add/read/remove pipeline with its own host; production endpoints inject it only for its semaphore; writes fake `LegacyEvent` receipts. Dev route files (`DevCheck`, `DevDiscoveryPlan`, `DevDownloads`, `DevFind`, `DevPlan`, `DevSources`, engine/filing routes) ~1,100 lines. | `DevFiling.cs`, `CatalogEndpoints.cs:466`, `LibraryEndpoints.cs:60` | delete | high |
| A3 | `Hunter` (151) is a second scheduler beside `TargetPipeline`. Following a show should just create Wanted targets. Auto rules (`/api/rules`, 816-line web page) overlap with following; quality watches are cut. **Owner decision on rules.** | `Hunter.cs`, `RuleEndpoints` | refactor | medium |
| A4 | Cut-v1 routes still mapped: calendar, request auto-approve, web push (`WebPush`, `VapidKeyStore`, `/push/*`). | `RequestEndpoints.cs:96,99,159-160` | cut-v1 | medium |
| A5 | Business logic in Api: `RequestService` (258), `Hunter`, notifications. Move into modules. Desktop shell (~900) is fine. | `Api/` | refactor | low |

### Find, Sources, Check, Plan, Parser

| # | Finding | Where | Tag | Sev |
|---|---|---|---|---|
| F1 | Two near-identical two-lane priority schedulers (`SearchBudget` 62, `PriorityGate` 155) plus three cache/dedupe layers (`SourceFlights` 260 in-flight + memory cache + retry revisions, `SearchCache` 133 DB cache + release observations). One user. Replace with one TTL cache + one per-host rate limiter (~250 lines). | `Find/`, `Sources/PriorityGate.cs` | refactor | high |
| F2 | `CandidatePool` (137) is fine. | `Find/CandidatePool.cs` | keep | - |
| F3 | Fallback sources (`AdditionalAdapters` 193) are off by default in v1; remove from the default path. | `Sources/AdditionalAdapters.cs` | cut-v1 | low |
| P1 | `ReleasePlanner.Choose` is pure (good) but 160 lines; health bands rely on probe evidence (E1); audio-language parts belong to the cut per-target policy (T3). Split into filter, score, pick. | `ReleasePlanner.cs:13-172` | refactor | medium |
| R1 | Parser (418) is the single name parser. Keep; the web should consume its output instead of re-parsing (W3). | `Parser/` | keep | - |

### Metadata (3,013 lines)

| # | Finding | Where | Tag | Sev |
|---|---|---|---|---|
| M1 | `MetadataService` is one partial class over 7 files (Browse, Catalog, CatalogFacts, CatalogPersistence, AnimeSeasons, ProviderMapping, core). A god class split by file, not by job. Split into `Catalog` (lookup + persistence), `Browse` (rails), `AnimeSeasons`. | `Metadata/*.cs` | refactor | high |
| M2 | `Browse.cs` (488): rails, home-release cache, recommendations, extras, genre map; `RailAsync` alone ~110 lines. | `Browse.cs:164-276` | refactor | medium |
| M3 | Three providers (TMDB, AniList, Cinemeta) + Fribb anime map behind `ProviderHttp` with stale/complete answers. Layering is reasonable; keep. | `Providers.cs`, `ProviderHttp.cs`, `FribbMap.cs` | keep | - |

### Web (40,146 lines, 259 files)

| # | Finding | Where | Tag | Sev |
|---|---|---|---|---|
| W1 | God components. `downloads/page.tsx` 1,957 lines (24 `useState`, 11 `useMemo`, 8 raw fetches, 9 inline components); `title-detail.tsx` 1,904 (18 inline components); `settings/page.tsx` 1,376 (22 `useState`); `watchlist/page.tsx` 1,373 (9 fetches); `episode-list.tsx` 1,218; `rules/page.tsx` 816. Rule: page = data hook + layout, components ≤ 300 lines. | listed files | refactor | critical |
| W2 | No single API layer: raw `fetch(` in 34 files beside 47 `useApiQuery` uses and `sessionAwareFetch`. Error handling, timeouts and session expiry differ per screen. One typed client + `useApiQuery`/`useApiMutation`. | 34 files | refactor | high |
| W3 | Identity guessed in the browser: `work-key.ts` (`workKeyFor`, `displayTitleFromWorkKey`, `titleHrefForName`), `work-identity.ts` (335), `episodes.ts` `parseEpisode`, `quality.ts` `parseResolution`/`parseSource`, `media-alias.ts`. Because 18 of 30 torrent rows arrive without a `workKey`. Server sends resolved identity, quality and episode on every row; delete these. | `components/title/work-key.ts`, `lib/torrents/*` | delete | critical |
| W4 | `downloads/grouping.ts` (591) + `release-display.ts` (306): 30+ small state predicates and labels (`isDownloading`, `isHeld`, `stateLabel`, `waitReasonLabel`, `rollupChip`...) re-deriving server state. Server sends one `state` + `label`; grouping keys on `workKey`. | `app/downloads/` | refactor | high |
| W5 | Essay comments: 35-50% of lines in `poll-schedule.ts` (166/374), `availability.ts` (230/604), `storage-override.ts` (119/376), `work-key.ts` (179/378), `types.ts` (256/503). Comments argue design instead of the code being obvious. | listed | delete | medium |
| W6 | Polling policy module (350 lines) + `visible-poller.ts` + `connection-watch.ts` for "skip ticks when hidden or in flight". `useApiQuery` with `refetchInterval` and visibility check does this in ~30 lines. | `lib/observability/poll-schedule.ts` | refactor | medium |
| W7 | `availability.ts` (548) decides which rail-card action is allowed from many fields. Server should send `action` + `disabledReason`. | `components/browse/availability.ts` | refactor | medium |
| W8 | Cut-v1 UI still present: release swap dialog (565), storage override (354), upcoming/calendar (369), push/PWA (451), auto-approve, duplicate review, ranking/priority controls. | `components/releases`, `lib/library/storage-override.ts`, `app/upcoming`, `components/pwa` | cut-v1 | high |
| W9 | `components/title/types.ts` (473) hand-mirrors server DTOs. Generate from the contract (OpenAPI) or keep one `api-types.ts`. | `components/title/types.ts` | refactor | medium |
| W10 | No reusable list primitives: each page builds its own filter bar, row, bulk bar and empty state. Build `DataList<T>`, `FilterBar<T>`, `BulkBar`, `useSelection<T>` once; Downloads, Watchlist, Requests, Library use them. | pages | refactor | high |
| W11 | `components/tf/*` is a decent start (empty, error, confirm, page header, query boundary). Keep and extend. | `components/tf` | keep | - |

**Simpler shape:** `lib/api` (typed client + query hooks), `ui/` primitives, `features/<area>/` with one data hook each, no identity or state parsing in the browser. Target about 22k lines, down from 40k.

## Totals

| Area | Now | After | Main levers |
|---|---|---|---|
| Backend (excl. migrations) | ~27k | ~13k | S1, S2, E1, A2, T-cuts, L2/L8, F1 |
| Migrations | ~16k | ~3k | S3 |
| Web | ~40k | ~22k | W1, W3, W4, W8, W10 |

## Owner decisions (4 Oct)

1. **E1:** yes. Drop pre-download probing and Check. Start the best-seeded release, detect stalls, Find another.
2. **E6:** keep both. Continue other clients' partial downloads and import finished files from folders. Both feed one track path (L3), not two.
3. **A3:** keep the auto-download rules page. `Hunter` still becomes "create Wanted targets", and rules drive it.

## Fix plan

| Phase | Content | Gate |
|---|---|---|
| 1 Delete | S2 legacy converter, A2 Dev* pipelines and routes, E4 dev engine code, E1/E2 probing + Check, cut-v1 features (T1, T2, T3, T10, T11, T12, T15, L2, L4, L5, A4, E5, W8) | builds, app starts, request -> download -> file works |
| 2 Store | S1 typed `DbContext` module by module, S4 named rows, then S3 one `InitialSchema` | same journeys on a fresh DB |
| 3 Core backend | Targets 7 states + Download now (T4-T9, T13, T14); Library Scan/Match/Track/Place (L1, L3, L7, L8); E3 filing = stop, rename, record; F1 one cache + rate limiter; P1 split; M1/M2 split; A1 rename modules, A3 Hunter -> Wanted targets, A5 | per-module run, then journeys |
| 4 Contract | Server sends resolved identity, quality, episode, state label and card action on every row (W3, W4, W7); types from the contract (W9) | contract tests against a real server |
| 5 Web | `lib/api` + query hooks (W2, W6), generic `DataList<T>`/`FilterBar<T>`/`BulkBar`/`useSelection<T>` (W10), split god pages (W1), delete parsers and essays (W3, W5), Searching badge | Playwright headless at 375-1440 px per journey |
| 6 Safety + ship | OPS-656, 655, 657, 651, 681; push to GitHub | full journey walk, critic pass |

Rehearsal/switchover is dropped (no legacy data).
## Web decomposition approach (Phase 5)

1. **Inventory first, across all six god pages at once** (Downloads, Title, Settings, Watchlist, Episode list, Rules). List repeated patterns: filtered selectable list + bulk bar, media row, loading/empty/error, confirm-then-mutate, polled fetch, settings section. Seen twice = shared; seen once = stays in the feature.
2. **Shared pieces built first, once, before any page is touched:** `lib/api` (typed client, `useApiQuery`/`useApiMutation` with polling), `DataList<T>`, `FilterBar<T>`, `useSelection<T>` + `BulkBar`, `MediaRow`, `StatusChip` (renders server label), `ConfirmAction`, `SettingsSection`. Extend `components/tf`.
3. **Server contract before pages (Phase 4):** identity, status label and allowed action come from the server, so browser parsers are deleted, not split.
4. **Each page = one data hook + layout (≤150 lines) + feature components (≤300 lines).** Agent briefs name the shared components to use and forbid new primitives; a needed primitive comes back to the coordinator.

**Guards:** lint fails files over 300 lines and raw `fetch` outside `lib/api`; status words and labels defined once; per-page review rejects any hook/component duplicating a shared one; jscpd plus a concept grep (second grouping, second state predicate) after each page.
