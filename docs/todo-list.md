# Todo list

The working list the orchestrator keeps alongside its own tracking. Update it when work starts, lands or gets verified. Standing rules are in [rules.md](rules.md).

## In progress

| Item | Owner (model) | Status |
|---|---|---|
| One UI for all roles: delete RequesterShell, capability helper, requester read endpoints | req-unify-opus (Opus 5.5) | Running |
| Owner-only "View as requester" toggle | req-unify-opus (Opus 5.5) | Running |
| Episode card download button: restore neutral pill, fix contrast (regressed in 156877b) | req-unify-opus (Opus 5.5) | Running |
| MOB2-001: mobile nav label 11px, needs 12px or more | req-unify-opus (Opus 5.5) | Running |
| MOB2-002: first episode row under the bottom nav at the fold | req-unify-opus (Opus 5.5) | Running |
| Request dialog: plain-language errors; requests pages on a phone | req-unify-opus (Opus 5.5) | Running |
| Server QA bugs: keyless title details, Torznab test accepts HTML, Advanced JSON error, Ready to Play rail, send error field, flaky CI test | qa-server (grok-4.5) | Running |
| Engine RAM: reported 2.2 GB season workload | qa-engine (Astra, server only) | Exact workload still needs reproduction; bounded HTTP buffering and documented/shared-cache regression added |
| Search takes 5–16 s | qa-search-perf (Astra, server only) | Running |
| UI QA bugs: source controls under 44px on desktop, queued "Download now", send field errors, Advanced JSON crash, offline and expired sign-in banners, sweep of the other pages | qa-ui (Opus 5.5) | Running |
| One request made two Frieren download groups (38 releases, 58 GB) | req-dup-grab (Astra, server) | Fixed and simulator/MCP verified: 38 distinct episodes, not duplicate grabs; canonical request identity merges both groups. Approval/decline/cancel races are guarded. |

## Next

- Live anime leftovers: Cowboy Bebop E5 now rejects the live-action remake, but the selected 1080i anime magnet had zero peers/no metadata; find a healthy preferred-quality alternative. See `anime-live-results.md` for exact failures and evidence. (Haibane Renmei only ships as a pack: its episodes stay wanted, and `/api/wanted` and the Activity log record "all season packs" as the reason, so the owner can decide later whether packs are ever needed.)
- Wanted queue leftovers (dl-onepath): retry timing lives in memory, so a restart makes every wanted row due again (the owner notification is deduped by unread notifications); the season click still waits on the title detail lookup before queuing (about 0.1 to 1.5 s measured); automation watchlist catch-up doesn't use the queue; a season with many dead releases spends up to the 90 s metadata timeout per candidate, so it can run for an hour before its first retry.
- Download leftovers (dl-onepath): no audio/subtitle language preference; deleted torrents leave `AcquisitionTarget` rows marked downloaded; background automation failures have no UI log (the activity Inbox isn't routed); the no-release 409 still carries the large `mapping` payload; title-page Library adds store a null `workId`.
- DRY leftovers (dl-onepath): three `EncodeUriComponent` copies (`TorrentAdapters`, `TextUtil`, `WorkKeySlug`); `ArtworkResolver` slug; `EpisodeRejections.IsPack` vs the `EpisodeLadder` episode-shape check vs `TitleService.PackSeason`/`MultiSeason`; three release-year parsers (`ReleaseSelection.Year`, `ReleaseNames.ReleaseYear`, `TitleService.ReleaseYear`); `EpisodeLadder.NormalizeTitle` vs `ReleaseSelection.Normalize`; the `ReleaseSelection.ExactEpisode` wrapper.
- FQ-DL-005 remote link remains blocked: webtorrent.io Sintel metadata rejects secure connection from this Windows host across HTTP/TLS variants; HTTP returns 403. Plain host-failure guidance and magnet fallback are covered. Use another host or magnet; no transport workaround is claimed.
- Shared matcher consolidation across acquisition, automation, replacement and playback (deferred from matching fixes).
- Explicit opt-in below-quality-floor fallback (deferred; selected quality remains a hard minimum).
- Browser follow-up for matching diagnostics when Playwright MCP is available (transport closed during both navigation and snapshot). Real isolated API/indexer/persistence checks passed; no browser pass claimed.
- Virtualized/paginated long-running anime episode presentation; server now exposes verified counts up to 5,000 rather than hiding everything after episode 200.

- QA pass: owner vs requester vs preview, on phone and desktop, using the simulator.
- MCP-verify the fq-ui batch at 390 and 1280 (owner, requester, preview); screenshots were blocked in that run.
- "Find another release" on title pages, after the unified UI lands.
- Auto-swap: notice an unhealthy torrent and switch releases automatically, reusing the swap service.
- Bulk "Find other releases for failed episodes" in the series dialog. There's no bulk swap endpoint yet (only `POST /api/client/torrents/{hash}/alternatives` per torrent), so the header links to the per-episode action on the first failed episode. Add a server bulk swap (owner-only, reusing `ReleaseSwapService`), then one header button.
- MCP-verify the series dialog rollup ("1 downloading · 30 need attention", season "N failed", compact error line, visible Find another release) at 390 and 1280; Playwright MCP transport was closed in that run.
- Frontend code audit: one grok agent per area (shell, title, downloads and library, settings and requests), after the unified UI lands.
- BUG-T web (fix/no-stream-web) reads `effectiveMaxActive` and `maxActiveSource` from `GET /api/settings/client`, which only fix/queue-cap (a17f4a7) sends. Until that merges, the Downloads stepper treats the saved value as the one in force, so while download hours hold their own cap it still shows the saved value and stays editable instead of reading "up to N at once (download hours)". Recheck the read-only state once both are on main.

## Closed

- pnpm wire encryption patch: obsolete, since the Next.js tree was removed (5824ed5).

## Done recently

- App-level search rate limits removed: no 40/min interactive or 15/min background `Spend` budget, no requester `SearchesPerMinute` / `CreatesPerMinute`. Searches queue on `MaxConcurrentSearches` / adapter slots; interactive callers wait for capacity under their own cancellation. Per-site cool-down lives only in `IndexerHttp` on real HTTP 429 (or 503 with Retry-After). Title-search/suggest 60/min per-client keystroke guard kept. See `rules.md` ("No app-level rate limits for the owner").
- One download path (dl-onepath): Download season, approved requests and request retries go through `GrabService.Season`, which is the single-episode grab run once per episode, batched (the owner ruled out a season-pack preference; the pack-first step was removed). Request identity now carries provider aliases and `BD1080p` parses. No season packs in any form (owner's rule): the pack-first step, pack queue keys and the picker's pack listing were all removed; each missing episode records why ("12 results, all season packs") in the Activity log and `/api/wanted`. Failures say what happened with one next step, and title toasts, request rows and Library toasts offer **Pick a release yourself** (one shared picker, prefilled with the query we used). One work-key slug and one queue-key parser. Verified live on a data copy (before the pack step was removed): Mushoku Tensei S3 started singles and no-result shows the new message; screenshots at 390/1440.
- Fire and forget Download season (dl-onepath): the click answers "Season N queued." (202) at once, never an error; `WantedQueue` runs the single-episode grab for every episode, one unit per season, seasons side by side, keeps missing episodes wanted and retries them in the background forever, and only asks the owner (one notification, Pick a release yourself) after repeated real misses. Approved requests share the queue and fulfil from the hashes it starts. Verified: Scorpion S1 to S4 clicked back to back, all four 202 at once, and every episode ended up started or wanted.
- Season failure recovery: title season responses aggregate actionable quality, source, metadata, seeder, folder and storage reasons instead of generic failure copy. Shared searches wait for concurrency capacity and retry transient source failures; persistent toasts retry only missing episodes. Source 503/timeout recovery remains. Fixture-driven UI checks passed at 390/768/1280, including partial retry and double-click protection. See `one-pipeline.md`.
- Live anime matrix (September 28, 2026): 23 episode-specific title cases plus five watchlist cases against Nyaa/apibay/torrents-csv. Original title matrix improved from **17/22 to 21/22 actual file-list passes**; watchlist **2/5 to 5/5**. Fixed long-running episode visibility, wrong-cour identity, remake rejection, watchlist provider/mapping/alias queries and transient AniList identity reuse. Five code commits pushed; **10,179 tests passed / 9 skipped**. Results and sanitized query/candidate/file evidence are in `anime-live-results.md` and `anime-live-evidence.json`. Browser pass remains blocked by Playwright MCP transport.
- Series download dialog status: the header and overview chips count members once anything fails ("1 downloading · 30 need attention", error-toned when most failed) instead of one member's "Finding files"; the repeated header error line is gone; season tabs show "N failed"; error cards show one line (tap or hover for the full text) and a visible Find another release button. Swap reasons say "1 seeder". Node and ReleaseSwap tests pass; browser pass pending (MCP transport closed).
- Live One Piece title reachability: removed anime-only 200-episode truncation in provider extras and local targets. Real 1,180-episode payload now includes E1100/E1180; western placeholder bound unchanged.
- Server remainder completed and pushed: seven fixes, four already-fixed items reverified, and the webtorrent.io transport blocker documented with improved plain error handling. Final solution validation: **10,152 passed / 9 skipped / 0 failed**. Per-item commit map and verification limits are in `search-matching.md`.
- FQ-DL-005 error handling: removed TLS/SSL jargon from secure-connection failures; regression tests cover remote HTTP errors and working magnet fallback.
- FQ-SET-006: extended `a863a9b`'s shared quality/size preference to both watchlist and auto-rule downloads; selected quality and swarm safeguards remain intact.
- MAGNET-NOMETA server: no-metadata magnets keep their display name after timeout and expose a plain error explaining how to recover; no UI changes.
- UNI-007: tunnel owners have download-recovery access (including real Cloudflare headers); requester GET/POST recovery routes remain 403. Table-driven HTTP role regressions cover both.
- MATCH-UNICODE-SLUG: native-only work keys now match exact releases and provider identities regardless of URI escape case or route decoding; existing native fallback IDs remain stable.
- MATCH-APPROVAL-RESTART: approved requests interrupted before grab hashes persist are resumed by startup sweep; concurrent sweeps cannot duplicate an active approval grab.
- MATCH-CONCURRENT-TARGETS: title grabs recover SQLite unique-key races on both Work and AcquisitionTarget insertion; concurrent requests share one durable identity rather than returning 500.
- MATCH-BARE-RANGE: bare `01-12` (including brackets, spacing, Unicode dashes and filename suffixes) is a batch, never the final single episode.
- Server remainder baseline: MATCH-ANIME-COORDINATES already fixed by `5c328c2`; MATCH-QUALITY-PARSER and MATCH-SEASON-RANGE by `c52f4e1`; MATCH-DIAGNOSTICS by `964ecf8`. Reran 98 matching regression cases successfully; no UI changes.
- FQ-REQ-001/002 and FQ-DL-006: aired AniList episodes can be requested without invented dates; request grabs prefer selected resolution/non-remux/smaller encodes while retaining the quality floor; title GET/POST reject mismatched provider identities and valid AniList season fanout keeps mapped coordinates. Full .NET suite: 10,123 passed / 9 skipped; web: 133 passed + typecheck. Browser verification remains blocked by MCP transport.
- "Find another release": source picker (All sources + each enabled source with counts), one-click "Find the best one for me" (`POST {best:true}`), one deterministic ranking with a specific reason per release, and only the recommended card highlighted. API verified live on a real download (best-swap and filtered search); Playwright visual check at 390/1280 still pending (MCP was down).
- Flow QA server (FQ-DL/REQ/SET): movie year folders; list prefers durable queued/error; forced/verified flags; torrent URL plain errors; fulfilled blocks re-request; partial grab honesty; QueueKey season/episode; Amazon posters; create rate-limit after validate; source test messages; TMDB key shape; build version; decline empty body.
- FQ UI batch (fq-ui): Sintel and other IMDb shorts now found by keyless title search (FQ-UI-101); SxxEyy releases never classify as films and downloads prefer the server's canonical media type (Frieren duplicates); search overlay inside `<main>` (FQ-UI-103); requester search cards show request status (UNI-003); one "View as requester" control per surface (FQ-UI-102); preview shows the season picker with sending off (UNI-004); /about stays shared but hides owner setup (UNI-005); nav badges 12px (UNI-006); title actions follow transfer state and library add/remove is always visible (FQ-UI-104); errored transfers show Error with the server's `error` text, forced rows say Starting now instead of offering Download now again, and verified finished rows get a Verified badge (FQ-DL-004); magnet field validates inline (FQ-UI-040). Unit/source tests only: Playwright MCP was unavailable ("Transport closed"), so MCP verification at 390/1280 is still owed.
- MOB2-002b: shell already pads `main` for the bottom nav + safe area; no title-page change made. Needs an MCP look at 390 to confirm whether the complaint is the first row at the fold (would need a shorter mobile hero).
- Search-to-torrent matching: cached AniList episode offsets and franchise seasons, parser/quality consistency, distinct provider/franchise aliases, and persisted two-sentence rejection summaries. Regression corpus and real isolated API test cover the reproduced sequel failure; see `search-matching.md`.

- Engine QA: DL-1 verified already fixed in e2cfde7; DL-3 verified already ported in ea1f829.
- DL-5: save-path write probe before admission; real API returns 400 / `savePath` with no transfer.
- Season starts: removed send barriers, shared fanout with approved requests, metadata waits moved to monitor.
- Engine memory: bounded webseed and metadata HTTP buffers; four generated multi-file torrents stayed near 41 MiB private including the test seeder. See `dotnet-port.md`; this does not close the original 2.2 GB report.

- Cinemeta movies can be requested (360f484).
- Local remote-access simulator: 3938 is the owner, 3939 is a requester (dd72e8b, see docs/remote-access.md).

- Mobile fixes, 22 of 23 verified by QA.
- AniList anime episode lists.
- Lowering the download cap re-queues running downloads.
- PWA, auto-approve, timeline, notifications.
