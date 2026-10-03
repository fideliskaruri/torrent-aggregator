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
