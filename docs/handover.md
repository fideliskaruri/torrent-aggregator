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
| `adapters/mirrors.ts` | Mirror failover. Public indexers lose hostnames; without this, one dead host silently deletes an entire source (see §4). |
| `target-resolution.ts` | Short-lived memo of the user's quality target. Must be invalidated when settings change or the user sees stale ordering. |

**Indexer reality, as measured.** Adapters do not degrade gracefully by
accident — they degrade because the code says so, and the source-health strip in
search results is the only thing that tells the user the difference between "the
indexers answered and had nothing" and "half of them are down".

| Source | Status | Notes |
|--------|--------|-------|
| `torrentscsv` | working | The only source answering for older TV. |
| `yts` | working **via mirror** | `yts.mx` stopped resolving; `yts.lt` and `movies-api.accel.li` answer. Movies only. |
| `nyaa` | working | Anime. |
| `eztv` | working | TV only, and only recent seasons. Requires `TMDB_API_KEY` — its API filters by IMDb id and **ignores free text**, so titles are resolved through TMDB first. Returns `[]` (not an error) when unconfigured. |
| `apibay` | **down** | Cloudflare interstitial; a browser User-Agent no longer passes it. No working mirror found. Reports honestly rather than pretending to be empty. |
| `1337x` | off by default | Cloudflare-blocked from most networks. `ENABLE_1337X=1`. |

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

### Metadata and suggestions — `src/lib/metadata/`, `src/lib/recommend/`

| File | Role |
|------|------|
| `metadata/enrich.ts` | Title → catalog record. Arbitrates between AniList and TMDB, penalises a media type that contradicts the request, strips release noise from the title, and falls back to progressively shorter prefixes (see §4). |
| `metadata/tmdb.ts`, `metadata/anilist.ts` | The two catalogs. TMDB needs `TMDB_API_KEY`; AniList needs nothing. |
| `recommend/index.ts` | One "Because you're watching X" rail from the catalogs' own `/recommendations`. **No recommender is implemented here and none should be** — TMDB `/similar` is a genre-vector match that returns 320,032 films similar to *Oppenheimer*, and a hand-rolled version over a five-row library would be strictly worse. Cached by `next: { revalidate }`, nothing else. |
| `scripts/backfill-metadata.mts` | One-time repair for library rows created without a real catalog id or artwork. Resolves each row against the catalog its `mediaType` implies, because the schema's `externalId` is "AniList id **or** TMDB id" and `mediaType` is what tells them apart. |

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
  to erroring. **Foreground and background draw on separate budgets** — a
  watchlist pass over twenty shows would otherwise spend the whole minute's
  allowance and throttle the human sitting at the search box. Pass
  `background: true` from anything scheduled.
- **Repeatedly-missing watchlist items back off, but are never dropped.** See
  `huntBackoffMs` in `src/lib/library/cursor.ts`. A cursor parked at S04E01 of a
  three-season show cannot roll over (rollover requires `episode > 1`, because
  at E01 an empty result means "not available", not "season finished"), so it
  would otherwise burn one indexer request per scheduler tick forever. Backoff
  rather than a terminal "give up" is deliberate: an empty result is ambiguous,
  and with apibay down it is frequently a lie. A grab resets `cursorMisses` to
  0, so it self-heals.
- **An adapter that is unconfigured returns `[]`, not an error.** `eztv` without
  `TMDB_API_KEY` is not an outage, and claiming one in the source-health strip
  would be false.
- **Automation dedupes on what the client still holds, not on history.** The
  library check queries `EngineTorrent` by info hash, not `DownloadHistory`.
  That is deliberate in both directions: an episode reappearing on another
  indexer under a different magnet is not downloaded twice (which is how the
  duplicate release folder in §8 was created), but a release the user has
  deleted *is* grabbable again.
- **An auto-rule verifies its own category before grabbing.** The indexer's
  category filter is a request, not a guarantee — a rule named "Weekly anime"
  once grabbed a live-action drama. `matchesRuleCategory` in `rules/runner.ts`
  re-derives the kind from the release itself and deliberately does *not* pass
  the rule's own category in as a hint, which would let the check answer with
  the question. This is why rules run with `enrich: true`: catalog metadata is
  the only thing separating an anime episode from a live-action one when both
  are `SxxEyy` on the same indexer.
- **`resolveMetadata` penalises a candidate whose media type contradicts the
  request.** "Severance" is a 2015 film and a 2022 series, both exact title
  matches, so whichever the catalog listed first used to win — and the wrong id
  was then written to the library row. Anime is exempt, since anime is
  legitimately both series and films.
- **The recommendation rail renders nothing rather than an empty shelf.** No
  catalog id, no TMDB key, a provider outage and "everything suggested is
  already in the library" all resolve to *absent*. An empty rail reads as
  "there is nothing for you" when the truth is "we could not ask".
- **Suggestions are added `planned` and unmonitored.** A suggestion has not
  earned disk. `POST /api/watchlist` takes `monitored: false` for exactly this;
  it used to hardcode `true`, which would have made clicking a poster start a
  download.
- **Automation is opt-in and defaults to off.** A timer that downloads files
  while nobody is watching should be switched on, not discovered afterwards.
- **`cleanTorrentTitle` strips a bare season token, and `resolveMetadata`
  retries on shorter prefixes.** Catalogs match literally: TMDB returns *nothing
  at all* for `The Bear S03`, so a season search rendered twenty results with no
  artwork. Release names carry noise no denylist will fully cover, so rather
  than grow the denylist forever, the resolver falls back to everything before
  the first token containing a digit, then the first three words, then two —
  stopping as soon as a candidate scores 55. Only failures pay for the extra
  catalog calls.
- **A failed metadata lookup is remembered for 3 minutes, not 30.** Negative
  answers are usually a rate limit or a blip; caching them as long as real ones
  turned a five-second outage into a page of grey boxes long after it passed.
- **A missing poster renders an initial, never an empty box.** An empty grey
  rectangle is pixel-identical to the loading skeleton, so a fully-loaded list
  of unmatched releases read as "still searching". Library cards, search rows
  and the recommendation rail all use the same initial tile, filling exactly
  the box a real poster would. Every one of them also falls back on `onError`,
  not just on a null URL — the library mixes TMDb and AniList CDNs.
- **The replaced-element reset in `globals.css` lives inside `@layer base`, and
  must stay there.** Tailwind v4 sorts *unlayered* CSS above every `@layer`, so
  while `img, video, svg { height: auto }` sat bare at the bottom of the file it
  beat `@layer utilities` — silently killing `h-full`/`inset-0` sizing on every
  `<img>` in the app. Posters laid out at their intrinsic ratio inside taller
  columns and left grey slabs beneath, and no Tailwind height utility could fix
  it. If images start mis-sizing app-wide, check this first.
- **A season marker with no episode number is a season pack.** `parseEpisode`
  reports `<Show> S04` and `<Show> Season 4` as `isSeasonPack`, because that is
  what every indexer calls a complete season. Treating them as ordinary
  episodes made the `Packs` filter hide real packs. Ambiguous shapes (absolute
  numbering, `Ep 1233 S23`) are matched by earlier branches, so reaching the
  bare-season branch really does mean "whole season".
- **Search results collapse into one show when one show dominates.** At ≥60% of
  rows sharing a metadata title, artwork and name move to a single header and
  every row drops its own copy, its route badge and its path chip. Twenty
  identical posters down the left edge is texture, not information. Mixed
  result pages (a `dune` search spanning four different films) keep per-row
  posters, because there the artwork is doing real work.
- **Seasons are listed newest-first and capped at three releases each.** The
  reason to search a running show is almost always the newest season; ascending
  order buried it under the back catalogue. The rest of each season is one
  honest, counted click away.
- **The search skeleton deliberately draws no per-row poster.** Artwork appears
  on only one of the two result shapes, and a placeholder that vanishes on load
  is a reflow the user reads as the page changing its mind.
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
- **One duplicate left on disk from before the dedupe fix**:
  `downloads/TV/The Bear/Season 03` holds `S03E02` both flattened and inside a
  `www.SceneTime.com …` folder. Deliberately not deleted — it is the user's
  data, and nothing in this app deletes downloaded files on its own. New
  duplicates are prevented (see §4).
- `/client` polls with `setInterval`; it should be a self-scheduling
  `setTimeout` gated on `document.visibilityState` so a hidden tab stops
  polling.
- `src/lib/download/path-organization.test.ts` has an intermittent libuv
  teardown assertion on Windows (`!(handle->flags & UV_HANDLE_CLOSING)`). It
  passes on re-run; the assertion fires after the test body, during cleanup.

