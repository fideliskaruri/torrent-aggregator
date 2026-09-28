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

- FQ-DL-005 remote link remains blocked: webtorrent.io Sintel metadata rejects secure connection from this Windows host across HTTP/TLS variants; HTTP returns 403. Plain host-failure guidance and magnet fallback are covered. Use another host or magnet; no transport workaround is claimed.
- Shared matcher consolidation across acquisition, automation, replacement and playback (deferred from matching fixes).
- Explicit opt-in below-quality-floor fallback (deferred; selected quality remains a hard minimum).
- Browser follow-up for matching diagnostics when Playwright MCP is available (transport closed during both navigation and snapshot). Real isolated API/indexer/persistence checks passed; no browser pass claimed.
- Long-running AniList request pagination beyond the existing 200 episode placeholder cap; aired-evidence fix does not expand that cap.

- QA pass: owner vs requester vs preview, on phone and desktop, using the simulator.
- MCP-verify the fq-ui batch at 390 and 1280 (owner, requester, preview); screenshots were blocked in that run.
- "Find another release" on title pages, after the unified UI lands.
- Auto-swap: notice an unhealthy torrent and switch releases automatically, reusing the swap service.
- Bulk "Find other releases for failed episodes" in the series dialog. There's no bulk swap endpoint yet (only `POST /api/client/torrents/{hash}/alternatives` per torrent), so the header links to the per-episode action on the first failed episode. Add a server bulk swap (owner-only, reusing `ReleaseSwapService`), then one header button.
- MCP-verify the series dialog rollup ("1 downloading · 30 need attention", season "N failed", compact error line, visible Find another release) at 390 and 1280; Playwright MCP transport was closed in that run.
- Frontend code audit: one grok agent per area (shell, title, downloads and library, settings and requests), after the unified UI lands.

## Closed

- pnpm wire encryption patch: obsolete, since the Next.js tree was removed (5824ed5).

## Done recently

- Series download dialog status: the header and overview chips count members once anything fails ("1 downloading · 30 need attention", error-toned when most failed) instead of one member's "Finding files"; the repeated header error line is gone; season tabs show "N failed"; error cards show one line (tap or hover for the full text) and a visible Find another release button. Swap reasons say "1 seeder". Node and ReleaseSwap tests pass; browser pass pending (MCP transport closed).
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
