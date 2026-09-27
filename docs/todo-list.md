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
| "Find another release": server API | swap-release (Astra, server only) | Running |
| "Find another release": Downloads dialog UI | req-unify-opus (Opus 5.5) | Waiting on API |
| Request dialog: plain-language errors; requests pages on a phone | req-unify-opus (Opus 5.5) | Running |
| Server QA bugs: keyless title details, Torznab test accepts HTML, Advanced JSON error, Ready to Play rail, send error field, flaky CI test | qa-server (grok-4.5) | Running |
| Engine RAM: reported 2.2 GB season workload | qa-engine (Astra, server only) | Exact workload still needs reproduction; bounded HTTP buffering and documented/shared-cache regression added |
| Search takes 5–16 s | qa-search-perf (Astra, server only) | Running |
| UI QA bugs: source controls under 44px on desktop, queued "Download now", send field errors, Advanced JSON crash, offline and expired sign-in banners, sweep of the other pages | qa-ui (Opus 5.5) | Running |

## Next

- QA pass: owner vs requester vs preview, on phone and desktop, using the simulator.
- "Find another release" on title pages, after the unified UI lands.
- Auto-swap: notice an unhealthy torrent and switch releases automatically, reusing the swap service.
- Frontend code audit: one grok agent per area (shell, title, downloads and library, settings and requests), after the unified UI lands.

## Closed

- pnpm wire encryption patch: obsolete, since the Next.js tree was removed (5824ed5).

## Done recently

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
