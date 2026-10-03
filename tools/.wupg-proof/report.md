# OPS-857 UI proof: owned quality, upgrade, check again

## Change
- `web/src/components/title/owned-quality.tsx` (new): one shared `OwnedQuality` component (variants `title` for the film hero, `row` for episode cards) plus `useOwnedQualityActions` (POST `/api/title/{workKey}/check-again` and `/upgrade` with `{}`, `{season}` or `{season,episode}`).
  - Upgrade offered: "In your library, 480p" + "Upgrade to 1080p (4 seeders)".
  - Best available: "480p is the best available, checked 2 hours ago" + "Check again".
  - Owned at preferred quality (both null): just "In your library, 1080p".
  - Check again shows "Checking for a better copy" with a spinner, then refetches the title.
  - Upgrade results are honest: "Upgrade queued", "N upgrades queued", "Already queued", or the server refusal ("No healthy upgrade is available. Check again.").
  - Actions render only when the viewer can download (owner); requester sees the line only.
- `episode-list.tsx`: owned rows use `OwnedQuality` (quality badge + own Upgrade pill or icon Check again); season header reads "10 of 10 in your library, 4 can be upgraded to 1080p" from `seasons[].upgradeableEpisodes`, with an owner-only "Upgrade 4" button (`{season}`).
- `title-detail.tsx`: film owned branch uses `OwnedQuality`; passes `workKey` and refresh callback to `EpisodeList`.
- `types.ts`: `upgrade`, `bestAvailable`, `upgradeableEpisodes` (additive, from backend a7e683f).
- `npm run build` passes.

## Isolated server
`start.ps1`: worktree `D:\code\memtest\wt-wupg` at a7e683f, binary `D:\code\memtest\bin-wupg`, port 3967, Development, scheduler disabled, TMDB key in child env only, web root = rebuild `web/dist`.
Owned 480p Sintel via the real import path (`root.json`, `scan.json`, `import.json`, `title-owned.json`: owned 480, upgrade/bestAvailable null).

## Evidence
| State | Proof |
|---|---|
| Upgrade offered | Real API check again (`check-again-1.json`, 6.4s) gave `upgrade {1080, 4 seeders}` (`title-upgrade-offered.json`). Screenshots `upgrade-offered-{390,768,1280}.png`; `upgrade-offered.dom.json`: Upgrade button 44px tall at 390. |
| Check again in UI | `check-again-*.png` and `check-again.dom.json`: clicking `[data-owned-check]` ran a real check; the title refetched and changed from best available to "Upgrade to 1080p (4 seeders)". |
| Best available | `best-available-{390,768,1280}.png`, `best-available.dom.json` (Check again 44px at 390). **Labelled fixture:** `shots.ts` with `BEST_ONCE=1` rewrites only the first title GET to `upgrade:null, bestAvailable:{480, now-2h}`; later reads are real. I could not get a real bestAvailable: quality watch 2160, title POST 4320 and a dev target at 4320 all left the 1080 offer in place (`floor-*.json`, `check-again-*.json`, `title-best-available.json`). |
| After Upgrade click | `after-upgrade-1280.png` / `after-upgrade-1280.dom.json`: "Upgrade queued". `after-upgrade-{390,768}.png` / `after-upgrade-repeat.dom.json`: a repeat click shows "Already queued". `targets-after-upgrade.json`: a replace target `upgrade:...:film`, origin upgrade, pinned hash 43f4001d..., replaceMediaFileId set. |
| Requester | `requester-1280.png`, `requester.dom.json`: "In your library, 480p", zero buttons. |

## Unproven
- **Replacement download first bytes:** with the scheduler disabled the replace target stays `wanted`. `download-now.json` was accepted as "Wanted", but no torrent appeared in 2 minutes (`downloads-first-bytes.json`).
- **Real bestAvailable state:** shown with the labelled fixture above. A real one needs an at-or-above-floor shape that this owned film could not produce cheaply. The "In your library, 1080p" only state was not screenshotted; it is the code path when both fields are null.
- **Series episodes** (season header count, Upgrade N, per-episode row Upgrade and Check again): not proven. Copying the reh3 Rick and Morty data did not fit in the time limit. The code builds and follows the same shared component.
- Polish: after a successful Upgrade the server still returns the offer, so the button stays visible (a repeat click honestly says "Already queued").

## Cleanup
Server PID 22244 stopped. Worktree `D:\code\memtest\wt-wupg` removed; `bin-wupg`, `data-wupg`, `import-wupg`, `lib-wupg` deleted. Port 3930 / PID 3188 and `memtest\stable` untouched.
