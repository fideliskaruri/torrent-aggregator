# AGENTS.md — TorrentFlow (torrent-aggregator)

> Global behavior rules (phased flow, don''t over-act on questions, examples aren''t the whole spec, MCP verification, owner overrides harness) live in the owner''s global `~/.copilot/copilot-instructions.md` and apply to EVERY repo. This file holds only TorrentFlow-specific rules.

## Design (READ BEFORE ANY UI WORK)
**`docs/design-system.md`** is the source of truth for UI decisions — tokens, component patterns,
responsive rules, and the **UI Definition of Done checklist ("the 100 things")**. Apply it to every
UI change so the owner doesn't have to describe each detail. Every UI change MUST verify at **390 /
768 / 1280 px** and pass the checklist before it's "done".

## Repo-specific hard rules
1. **The OWNER runs the dev server** at http://127.0.0.1:3000. NEVER start / stop / restart / rebuild it. Only READ from it. It hot-reloads edits itself.
2. **Browser verification = Playwright MCP tools only** (`browser_navigate` / `_snapshot` / `_click` / `_type` / `_hover` / `_press_key` / `_wait_for` / `_select_option` / `_evaluate` / `_resize` / `_take_screenshot` / `_console_messages` / `_network_requests`). No ad-hoc JS puppeteer/playwright scripts. The MCP is pinned to the public-npm build in `~/.copilot/mcp-config.json` (the corporate feed proxy froze `@playwright/mcp` at an old alpha with no screenshot/resize). "Confirm a feature works" = drive the real control and assert the next state renders; for visual/mobile use `_resize` (390/768/1280) + `_take_screenshot`.
3. **Bugs** are tracked in the session SQLite `bugs` table (id, title, area, symptom, root_cause, status, verified, reported_by, notes). `root_cause` stays UNCONFIRMED until proven by reading code + reproducing; `verified=0` until proven fixed via MCP.

## Pages (13)
| # | Route | File |
|---|-------|------|
| 1 | `/` (home) | `src/app/page.tsx` |
| 2 | `/search` | `src/app/search/page.tsx` |
| 3 | `/everything` | `src/app/everything/page.tsx` |
| 4 | `/watchlist` | `src/app/watchlist/page.tsx` |
| 5 | `/title/[workKey]` | `src/app/title/[workKey]/page.tsx` |
| 6 | `/downloads` | `src/app/downloads/page.tsx` |
| 7 | `/activity` | `src/app/activity/page.tsx` |
| 8 | `/history` | `src/app/history/page.tsx` |
| 9 | `/notifications` | `src/app/notifications/page.tsx` |
| 10 | `/client` | `src/app/client/page.tsx` |
| 11 | `/rules` | `src/app/rules/page.tsx` |
| 12 | `/settings` | `src/app/settings/page.tsx` |
| 13 | `/about` | `src/app/about/page.tsx` |

## Per-page owner expectations (owner''s words — filled in as we go)
- **1. Home (`/`):** _TBD_
- **2. Search (`/search`):** Search must be **fuzzy / typo- & whitespace-tolerant** (finds the title despite misspellings/extra spaces). Results are **unified** — films, series and anime surface together for one query, NOT siloed behind category tabs you must switch between (owner: tabs-as-a-wall is the complaint; BUG-007 open for final contract confirmation). No vestigial dead "Open search" screen. Clicking a result must load its title page (never "Unsupported title provider").
- **3. Everything (`/everything`):** _TBD_
- **4. Watchlist (`/watchlist`):** _TBD_
- **5. Title (`/title/[workKey]`):** Episode list must not flash on the 5s poll. Every season the user selects must show THAT season's episodes (from the provider when there are no local files) — never a blank list. **Season selection persists in the bounded per-title `tf_season` cookie; title URLs stay free of `?s=`.** Every episode card reports its exact episode torrent/file transfer, never season-level or inferred pack progress. Play/Download offered honestly; Play gated until actually streamable.
  **A selected download quality is a hard minimum, not a fallback preference:** lower and unknown resolutions are ineligible; a higher resolution may be used when no exact-quality release exists. Monitored automation must keep the episode cursor pinned when only sub-floor releases exist.
- **6. Downloads (`/downloads`):** Owner's explicit spec: press **Download** on a season or single episode → **start immediately** (auto-pick one exact torrent per episode; do not acquire season packs). **Delete** = gone immediately, no caching/lingering after the confirm dialog. **No banner** ("Active Now" band removed).
  **Series detail is a scrollable dialog, not an inline accordion** (this supersedes any earlier "expand a show → Season N → episode cards inline" wording — BUG-004 is the owner naming that shallow rearrangement for what it was; do not revert to it). The main page stays compact: one `SeriesOverviewRow` per work — poster/title, honest combined state/progress/counts/size, a selection checkbox, an explicit **Details** button (`data-group-details`) that opens the dialog, and an overflow for whole-series pause/resume/delete. Films keep their own direct row + Play button (never routed through the dialog).
  Clicking **Details** opens `SeriesDownloadDialog` (`src/app/downloads/series-download-dialog.tsx`), built on the general-purpose Radix Dialog primitive (`src/components/ui/dialog.tsx` — distinct from `alert-dialog.tsx`, which stays reserved for yes/no destructive confirms). Layout: full-height sheet on mobile, centered/capped on desktop (`max-h-90dvh`). Header = poster/title/aggregate progress-counts-size-speed + close + whole-series overflow. Immediately below, a **shrink-0 horizontally-scrollable season rail** (`data-season-rail`, `role="tablist"`, one `role="tab"` per season with arrow-key/Home/End navigation, a percent readout and a thin truthful per-season progress fill) — this rail is the redesign's signature. Only the body below it (`data-season-panel`) scrolls vertically; nothing in the ancestor chain sets `overflow-x: hidden` (breaks the rail's scroll + any sticky header). Episode/release cards (`data-episode-card`) render one column below `md`, two at `md+`: identity, one quality chip + source, state badge, exact percent + progress bar, size, live speed/ETA/peers, a completed check, a Play button gated to built-in + `canStreamTransfer`, and an overflow (copy stream URL, open folder, pause/resume, delete, raw release/path details) — plus a modal-scoped selected-action bar when episodes are multi-selected.
  **Data contract:** the dialog always derives from every download row for that work (excluding stream/prewarm), independent of the page's search/status/media-tab filters — narrowing those filters must never hide a season/episode from an already-open dialog. Default season = the first actively-downloading/incomplete season, else the first ordered season; an already-picked season survives every 5s poll. If the group disappears (deleted / filtered to nothing), the dialog closes itself and announces it.
  **Never two focus traps:** `PlayOverlay` is a hand-rolled trap, not Radix — the series dialog unmounts while a video is playing and remounts on the same series/season when playback closes. See `season-selection.ts` for the pure default/poll-stability helpers and `page-source.test.ts` / `season-selection.test.ts` for the tests guarding this contract.
- **7. Activity (`/activity`):** _TBD_
- **8. History (`/history`):** _TBD_
- **9. Notifications (`/notifications`):** _TBD_
- **10. Client (`/client`):** _TBD_
- **11. Rules (`/rules`):** _TBD_
- **12. Settings (`/settings`):** _TBD_
- **13. About (`/about`):** _TBD_
