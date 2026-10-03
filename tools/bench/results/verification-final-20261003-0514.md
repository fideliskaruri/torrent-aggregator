# Baseline verification summary

Server: `http://127.0.0.1:3931`. Live port 3930 and process 3188 were not touched.

## Search-only, all nine titles

From `baseline-search-final-20261003-0509.md`:

| Title | First result ms | Pool |
|---|---:|---:|
| Scorpion | 2153 | 196 |
| Little Fires Everywhere | 1239 | 125 |
| Frieren: Beyond Journey's End | 1492 | 253 |
| A Silent Voice | 4742 | 241 |
| Prison Break | 1376 | 183 |
| Money Heist | 1276 | 168 |
| Rick and Morty | 462 | 245 |
| Sintel | 1213 | 85 |
| Big Buck Bunny | 1187 | 133 |

All nine searches completed. The API is atomic JSON: first-result time is the first nonempty response's completion time. Full runs search first, warming caches before the download action.

## Full runs

| Title | Search ms | Pool | All targets ms | Observation | Outcome | Cleanup |
|---|---:|---:|---:|---:|---|---|
| Sintel | 471 | 85 | 3394 | 120s | Completed, first bytes at 2372ms | Verified |
| Big Buck Bunny | 499 | 133 | Not reached | 120s | Stalled at 0%, zero peers | Verified |
| Rick and Morty S1 | 2551 | 245 | Not measured | Not measured | Blocked by pre-existing S1 downloads | No mutation |

Sintel selected `43f4001de4ab25d521c63684e2b69804193ed9d9`, `Sintel.2010.1080p.WEB.H264-CLASSiCALHD`, 29 listed seeds, peak 6 connected peers, 0 peers after completion at 120 seconds.

Big Buck Bunny first chose `2f24d03eab998ca672b8c1ef567a184609236c02`, `Big.Buck.Bunny.2008.x264.BDRip.1080p.mkv`, then `f84b51f0d2c3455ab5dabb6643b4340234cd036e`, `Big_Buck_Bunny_1080p_surround_frostclick.com_frostwire.com`. Each listed 1 seed; peak and final connected peers were 0. No delivered bytes. The first release failed metadata retrieval; the replacement stalled without an honest wait reason. No unsafe/foreign flags or duplicate rows were observed in the measured scopes.

Rick's requested **new acquisition** verification remains blocked. Before this task, the copied sandbox already had 27 download rows, including all 11 Rick and Morty S1 episodes marked downloaded despite an empty library. The tool correctly refuses overlapping scopes. It did not count those copied "ready" rows as a successful benchmark or delete them.

Per-release detail and CSVs:

- `baseline-sintel-final-20261003-0509.md/.csv`
- `baseline-bunny-final-20261003-0511.md/.csv`
- `baseline-rick-final-20261003-0513.md/.csv`

## Cleanup and crash recovery

`cleanup-verification.json` captures a real interrupted acquisition and recovery:

- Started a separate benchmark process for Big Buck Bunny, observed its wanted/download action, then terminated **only that bench process**, PID 50664.
- Next benchmark invocation recovered `cleanup-pending.json` before running a search.
- Download identities unchanged: 27 before and 27 after, no identity differences.
- Bench-created download rows: **0**. Wanted rows: **0**. Pending cleanup journal: **absent**.
- Library payload files: **0**. Literal empty-library check is **not fully satisfied**: the server leaves `.staging` and its zero-byte `.ignore` marker. The HTTP-only bench did not remove server files directly.
- The initial scope-specific finally-cleanup also verified title-progress acquisition state clear.

## Tool validation and API gaps

- .NET 10 build: zero warnings/errors; nullable and warnings-as-errors enabled. No unit tests, no server references, no added packages.
- CLI refuses live port 3930, non-loopback hosts, traversal labels and zero wait, each with exit 2. Help exits 0.
- Unknown language is not treated as foreign. Only explicit language/CAM/program markers are flagged. A generic "dubbed" label alone is not a language verdict.
- Download listing is `/api/client/torrents`; `/api/downloads` returns 404.
- Public list rows expose connected **peers**, but not separate connected seeds or payload file lists. Those measurements remain unavailable, not fabricated.
- Initial A Silent Voice AniList result carried wrong TMDB crosswalk 1171702; the server's later title-search result provides correct 2016 film ID 378064, now in `titles.json`.
- Findings filed: OPS-649 (Big Buck Bunny stall), OPS-650 (A Silent Voice crosswalk), OPS-651 (leftover staging marker).

All changes are under `tools\bench`; no commits and no solution changes.
