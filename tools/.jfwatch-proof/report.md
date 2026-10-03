# OPS-852 / OPS-834: real Jellyfin watch-state proof

## Change and root cause

The Library list (`GET /api/watchlist`) projected ownership and watch intent but
never composed the existing Jellyfin read. The web already expects `watchState`
and `jellyfinNextUp`; no web field changes were needed.

`LibraryRead.WatchAsync` reads inventory once when connected and passes all list
works to the same Jellyfin reader used by title pages. `ReadBatchAsync` loads one
shared snapshot (paged Items plus NextUp), then applies the existing unambiguous
provider/path matching and progress projection. Its **entire batch** shares one
1.5-second deadline, including waiting for the existing snapshot gate. It retains
the existing 15-second in-memory refresh and five-second negative cache.

There is no new database row, stored progress, background service or copied watch
history. Disconnected/unavailable/unmatched rows omit both optional fields.

The actual list registration lived in `CatalogEndpoints.cs`, not
`LibraryEndpoints.cs`. Its mechanical handoff now delegates to
`LibraryEndpoints.List`; the existing catalog projection is reused unchanged.
Store, Engine, Targets and web source were not edited.

## Isolation and real media

- Test worktree: `D:\code\memtest\wt-jfw`, detached from branch `rebuild` because
  Git cannot attach the same branch to two worktrees.
- Backend output: `D:\code\memtest\bin-jfw`; fresh data:
  `D:\code\memtest\jfw-data`; HTTP port **3961**, Development, scheduler disabled.
- Portable Jellyfin **12.1.0**, fresh data/config/cache/logs under
  `D:\code\memtest\jf-watch-data`, HTTP **8097**. Created only a test administrator
  and a real test API key. TorrentFlow never writes playback state.
- Licensed full Blender Sintel from `.filing-proof\seed\Sintel\Sintel.mp4`,
  **129,241,752 bytes**, actually downloaded from the local seeder and filed
  by `/api/dev/filing` as
  `D:\code\memtest\jfw-media\Movies\Sintel (2010)\Sintel.mp4`.
- Full source/final SHA-256 matched:
  `1dc6f2ca9762dfcc7d1b1843129a3e4f351d1fe935dea2241c7b359c11ebc1d8`.
- Actual Jellyfin scan found that path and runtime **8,880,640,000 ticks**.
  The real Jellyfin API marked it played, then set unplayed plus half-runtime
  playback position. No title/library response interception was used.

The original proof seeder waited for a hash in public Engine diagnostics, which
does not include the metadata probe; the first admission timed out. A proof-only
seeder copied from `.jelly-proof` continuously advertised the licensed hash to the
local Engine listener instead. Production Engine was not changed or bypassed.
It hash-checked all **494/494 pieces** and the actual filing then completed.

## Real headless browser verification

Playwright MCP launched dedicated **headless Edge** browsers, never changed its
shared browser's page, and drove the real controls on 3961.

| Flow | 390 px | 1280 px |
| --- | --- | --- |
| Settings: fill URL, actual API key, actual user; Save | Pass | Pass |
| Settings: Test renders “Connected to Jellyfin.” | Pass | Pass |
| Real played film: title “Watched” chip | Pass | Pass |
| Real played film: Library “Watched” chip | Pass | Pass |
| Real half-played film: title “50% watched” chip | Pass | Pass |
| Real half-played film: Library DOM “50% watched” chip | Pass, visual clipping below | Pass, poster-width clipping below |
| Settings Disconnect through real confirmation | Pass | Pass |
| Title and Library after Disconnect: zero chips | Pass | Pass |
| Horizontal page overflow | None | None |

Screenshots: `settings-connected-*`, `title-watched-*`, `library-watched-*`,
`title-partial-*`, `library-partial-*`, `settings-disconnected-*`,
`title-disconnected-*`, `library-disconnected-*` (390 and 1280 PNGs).

Actual HTTP evidence: `library-watched.json`, `library-disconnected.json`,
`title-disconnected.json`, `jellyfin-scanned.json`, `filed.json`, `summary.json`,
`timeout.json`.
The disconnected Library read took **44.71 ms** in the recorded run
(another measurement was 31.41 ms); the title read took **5.58 ms**.
Both omit the fields entirely, rather than returning null-valued watch fields.

After stopping the real test Jellyfin, a separately identified proof-only TCP
listener on the same owned 8097 accepted HTTP but deliberately did not respond.
This is a timeout test, **not simulated watch-state evidence**. The Library read
returned without optional watch fields in **1,569.47 ms**; its next read took
**6.73 ms**, and the title read sharing the negative cache took **18.12 ms**.
Thus neither an unavailable server nor each card in the list adds another wait.
The controlled listener was stopped by its recorded PID too.

## Validation and limitations

- Final backend build: **0 warnings, 0 errors** (`backend-build.txt`).
- `web\npm run build`: passes (TypeScript and Vite); no web source changed.
- No unit tests, production credentials, owner data, port 3930 or stable instance
  were used.
- **OPS-854 filed:** Library embeds its chip within the narrow poster's
  overflow-hidden box. Real partial-watch DOM text is correct, but its text is
  visually clipped, especially on mobile. This is an existing web placement
  defect exposed by the real fields; web styling is outside this lane's
  explicitly allowed edits. OPS-834 is not claimed visually perfect.
- Real-series NextUp/episode-chip journeys were not repeated in this lane.
  The shared reader's existing series matching was preserved, not reimplemented.
- The controlled stalled-server deadline passed. Very large libraries and
  multiple Jellyfin paging requests were not load-tested in this lane.

Cleanup and commit identities are recorded in the final handoff. Screenshots and
JSON evidence remain here; payloads, test credentials, data, processes and the
isolated worktree are removed. `tools/.gitignore` is left untouched.
