# Handover: how TorrentFlow actually works

Read this before changing anything. It is the map an agent (or a future you)
needs to be productive without re-deriving decisions that were made for
non-obvious reasons. `README.md` is for *running* the app; `AGENTS.md` is the
behavioural contract; this file is the *why*.

---

## 1. What the product is

One install that replaces the *arr stack: **search many indexers → rank the
results → send the best one to a built-in BitTorrent engine → organise the
files into a smart library path**. Single user, no sign-in, bound to
`127.0.0.1`.

The whole product is that pipeline. Every module below is one stage of it.

```
 UI (/search)                    automation (scheduled or manual)
      │                                        │
      └────────────► searchTorrents ◄──────────┘
                     (aggregator.ts)
                            │
        adapters ──► applyFilters ──► rankResults ──► best magnet
     (nyaa, apibay,   (filters.ts)     (ranking.ts +      │
      yts, csv, 1337x)                  quality.ts)       │
                                                          ▼
                                          builtin-engine.ts (WebTorrent)
                                                          │
                                          content-layout*.ts + smart-category.ts
                                                          │
                                              downloads/TV/Show/Season 03/
```

---

## 2. The pipeline, module by module

### Search and ranking — `src/lib/torrents/`

| File | Role |
|------|------|
| `aggregator.ts` | Fans out to every adapter, merges, caches, dedupes. **Owns the indexer budget** (see §4). |
| `adapters/*.ts` | One per indexer. Each returns `SearchResult[]`. Adapter failures are isolated — one dead indexer must never fail the search. |
| `filters.ts` | `applyFilters` — seeders, size, category, `releaseKind` (packs vs episodes). Runs **before** ranking. |
| `ranking.ts` | Orchestrates scoring and attaches `episode` metadata to each result. |
| `quality.ts` | The comparator. Ported from Sonarr's logic. **This is the most subtle file in the repo** — read `docs/architecture/release-ranking.md` before touching it. |
| `episodes.ts` | `parseEpisode(title)` → season/episode/pack detection. Consumed by ranking, filters, path layout and category detection, so a change here ripples everywhere. |
| `search-cache.ts` | TTL cache + the budget counter. |
| `target-resolution.ts` | Short-lived memo of the user's quality target. Must be invalidated when settings change or the user sees stale ordering. |

### Download and layout — `src/lib/clients/` and `src/lib/download/`

| File | Role |
|------|------|
| `builtin-engine.ts` | The in-process WebTorrent engine. The biggest file in the repo. Durable state lives in the `EngineTorrent` table so torrents survive a restart. |
| `content-layout*.ts` | Strips release-name wrapper folders so files land *in* `Show/Season NN`. Three files: policy (what should happen), the applier, and repair (fixing what already landed wrong). |
| `smart-category.ts` | Title → category (Anime / TV / Movies / Software / …). Domain signals beat weak movie heuristics — an app with a year in its name is not a film. |
| `qbittorrent.ts`, `transmission.ts` | Optional external clients. The built-in engine is the default and the supported path. |
| `disk-space.ts` | The storage cap and free-space floor, enforced on **every** send. |

### Library and automation — `src/lib/library/`, `src/lib/automation/`

| File | Role |
|------|------|
| `cursor.ts` | The hunt cursor: which episode a monitored show is waiting for. `advanceCursorAfterMiss` is a data-loss surface — see §3. |
| `runner.ts` | `runUserAutomation(userId)`. The whole automation pass. |
| `run-lock.ts` | Per-user row lock, 15-minute stale window. Prevents two overlapping runs double-grabbing. |
| `scheduler.ts` | The background timer. See `docs/architecture/automation-scheduling.md`. |
| `ondemand.ts` | "Download next" / rewatch from the Library UI. Shares the cursor rules with automation. |

---

## 3. Invariants you must not break

These are all things that were once wrong, shipped, and cost real debugging.

**Nothing is ever rejected for its resolution.** The quality target is a
*target*, not a floor — releases are ordered by closeness to it. If you add a
hard resolution filter, a monitored show with only 720p available silently
starves forever. `docs/architecture/release-ranking.md` has the full ordering.

**Never filter out 0-seeder releases upstream of the viability gate.** A
brand-new episode has 0 seeders for its first minutes. When the search filter
dropped them, automation saw "no results", recorded a hunt miss, and after
three misses `advanceCursorAfterMiss` rolled to the next season — silently
skipping episodes forever. The gate that decides "too thin to finish" must be
the *only* place seeders are judged, and it has a 6-hour escape hatch
(`seederWaitSince`) so a stable 2-seeder swarm is not deferred indefinitely.

**`normalizeTitle` already strips resolution, codec and episode tokens.** So
`"One Piece S01E05 480p WEBRip"` normalises to exactly `"one piece"`. There is
deliberately **no exact-title relevance tier**: it rewarded scene naming and
punished `[SubsPlease]`-style anime releases.

**Bare `4k` is marketing text, not a resolution**, but standalone `UHD` is a
real one. Unknown resolutions rank last, so misparsing a genuine 4K disc put it
below 360p.

**`overflow-x: hidden` belongs on `html` only.** Per CSS Overflow 3, a
non-`visible` value on one axis forces the other to `auto`. It used to sit on
`html`, `body`, `.app-shell` and `.app-main`, which stopped the UA propagating
`body`'s overflow to the viewport — so `body` became its own scroll container,
nothing scrolled, **every** `position: sticky` element was broken, and the
mobile modal's scroll lock was inert. One cause, three symptoms. `globals.css`
carries the full rationale in comments. Do not re-add it lower down.

**Automation grabs one episode at a time, in order.** The Library UI says so
explicitly. If you change that, change the copy in the same commit.

**The app must never claim something it does not do.** The watchlist said
"monitoring" for months while nothing ran on a timer. Honest copy is a feature.

---

## 4. Things that look wrong but are deliberate

- **The rate limiter is an *indexer* budget, not a request limit.** It lives
  inside `aggregator.ts` at the upstream fan-out, not on the API route.
  Reasoning: on a no-auth localhost app there is no adversary to throttle; what
  needs protecting is the indexers, which ban IPs. A route-level limiter also
  charged cache hits (which contact nobody) and missed automation entirely
  (which calls `searchTorrents` directly). Stale cache is served in preference
  to erroring.
- **Automation is opt-in and defaults to off.** A timer that downloads files
  while nobody is watching should be switched on, not discovered afterwards.
- **`.app-shell` *is* `body`.** Confusing, but true, and it matters when
  reasoning about scroll containers.
- **There is no auth and that is the design.** `src/lib/auth.ts` returns a
  constant local session. Every table still carries a `userId`, so real user
  management is a two-file change rather than a migration.

---

## 5. How to verify a change

Run the smallest thing that covers what you touched, then the gates.

```powershell
npx tsc --noEmit          # types
npm run lint              # eslint
npm run test:unit         # 24 suites, offline, no network
npm run build             # production build
```

**UI changes additionally require the two probes**, against a *running* server.
Static gates pass while real visual bugs ship; these measure the properties
that were actually broken:

```powershell
npm run start                                            # in another shell
node scripts/check-layout.mjs   --base http://127.0.0.1:3000
node scripts/check-ui-fixes.mjs --base http://127.0.0.1:3000
```

- `check-layout.mjs` — sticky positioning and horizontal overflow, 7 routes ×
  3 widths. It ignores content an ancestor deliberately clips (a Radix progress
  bar legitimately has a negative x).
- `check-ui-fixes.mjs` — contrast sweep on real rendered text for every route
  (WCAG AA, with the large-text threshold), the quality control, and the mobile
  sheet's scroll lock and focus trap.

Neither replaces **looking**. The `visual-qc` agent drives the running app with
Playwright and reads screenshots; it has repeatedly found real defects that all
four static gates passed.

### Test conventions

- `scripts/run-unit-tests.mjs` auto-discovers `src/**/*.test.ts` and reports
  every suite, so one failure does not hide the rest. Indexer-backed tests are
  excluded — they fail on networks that block those hosts, which says nothing
  about the code.
- Tests are hand-rolled: a `check(name, fn)` helper, `node:assert/strict`, and
  a `failures` counter. No test framework.
- Encode the **rule class**, not the reported example. Table-driven cases over
  many shows and title formats. See `AGENTS.md`.
- Assert on a dedicated `data-*` attribute, not a generic tag. A Playwright
  assertion on `h3` once matched card titles instead of section headers and
  produced a false pass.

---

## 6. Local environment gotchas

- **npm must use the private Azure Artifacts feed** pinned in `.npmrc`. Never
  the public registry.
- **`prisma migrate dev` does not work here.** Write the migration SQL by hand:
  create `prisma/migrations/<timestamp>_<name>/` (the directory must exist
  first), write `migration.sql`, then `npx prisma migrate deploy` and
  `npx prisma generate`.
- `path-organization.test.ts` occasionally crashes at *process exit* with a
  libuv `UV_HANDLE_CLOSING` assertion. Pre-existing, unrelated to its
  assertions, and it passes.
- The dev server binds `127.0.0.1`. `Get-NetTCPConnection -LocalPort 3000
  -State Listen` finds the PID to stop.

---

## 7. Where the deeper docs are

| Document | Covers |
|----------|--------|
| `docs/architecture/release-ranking.md` | The full ranking design: affinity curve, seeder gate, junk sources, relevance keys |
| `docs/architecture/download-engine.md` | Pluggable engine design (builtin → external → future sidecar) |
| `docs/architecture/automation-scheduling.md` | The background timer, and why every guard exists |
| `docs/ui.md` | Design tokens and layout rules |
| `AGENTS.md` | Behavioural contract: generalise from examples, never example-patch |

---

## 8. Open work

Tracked here because it is real, not because it is planned:

- **Prefer complete season packs** in automation instead of one episode at a
  time (requested; needs a cursor-jump story and a size guard against a
  500 GB One Piece pack eating the whole 100 GB cap).
- **Series-completion detection** — stop hunting a series that has ended
  instead of burning three misses per run forever.
- **Recommendations** from the existing library. `/api/suggest` is search
  autocomplete, not this.
- Two known filing bugs: a YTS movie landing under `Anime` via a rule's blind
  `results[0]`, and a surviving duplicate release-root folder under
  `TV/The Bear/Season 03`.
