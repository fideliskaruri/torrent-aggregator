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

(Next: Targets, Library, Store, Engine, Api, Find/Sources/Check/Plan/Parser, Metadata, then the web areas.)

### Targets (3,340 lines, 22 files)

The core job is small: an owner asks for a film or episodes, then find, check, plan, fetch and file each one, and skip what's owned. Most of the size comes from v1-cut features woven into that core path.

| # | Finding | Where | Tag | Sev |
|---|---|---|---|---|
| T1 | Import-review holds ("switchover") checked in 6 code paths: accept, action, read, recover, tick, run. `ReadAsync` even rewrites rows to Waiting in memory. This is the cut duplicate review. | `TargetPipeline.cs:77,152-155,234,317-320,327-349`; `TargetAdmission.cs`; 35 hits in 7 files | cut-v1 | high |
| T2 | Queue ranking: `Rank`, `OwnerRanked`, `TargetPriority`, `NowAt`, `RankAsync`, and a priority rewrite of every target on every tick. v1 is FIFO plus Download now (one flag). | `TargetPipeline.cs:299-325,363-368`; `TargetScheduling.cs`; 71 hits in 18 files | cut-v1 | high |
| T3 | Per-target audio-language policy with replan, cancel and policy revisions on each re-request. v1 has one global language rule. | `TargetPipeline.cs:84-85,134-150`; `TargetAudioPolicy.cs`; 35 hits in 11 files | cut-v1 | medium |
| T4 | `AcceptAsync` is one 170-line method that handles 5 origins, scope intents, holds, audio replans, revivals and message text. | `TargetPipeline.cs:66-224` | refactor | high |
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
