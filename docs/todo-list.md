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

## Next

- QA pass: owner vs requester vs preview, on phone and desktop, using the simulator.
- "Find another release" on title pages, after the unified UI lands.
- Auto-swap: notice an unhealthy torrent and switch releases automatically, reusing the swap service.
- Flaky test CI-FLAKE-001 (`SettingsParityTests.BuiltinListDoesNotAdvertiseAnExternalHost`).
- Check the Requests inbox and "My requests" on a phone.
- Request dialog errors: plain language instead of server wording.
- Installed phone app: behaviour on a lost connection and when the Cloudflare sign-in expires.

## Backlog (needs re-check, may already be fixed)

- Engine RAM about 2.2 GB during a season download; season episodes start one at a time.
- `/api/search` slow (5–16 s) because of enrichment.
- Queued download has no force control; advanced availability panel missing its API.
- Downloads: verified bitfield never written, Ready to Play rail missing completed items, smart save paths, send validation field, unwritable save path error row.
- Sources: keyless results can't open title details, source controls under 44px at desktop, Torznab test accepts HTML.
- pnpm wire encryption patch doesn't apply on clean installs.

## Done recently

- Cinemeta movies can be requested (360f484).
- Local remote-access simulator: 3938 is the owner, 3939 is a requester (dd72e8b, see docs/remote-access.md).

- Mobile fixes, 22 of 23 verified by QA.
- AniList anime episode lists.
- Lowering the download cap re-queues running downloads.
- PWA, auto-approve, timeline, notifications.
