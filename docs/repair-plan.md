# TorrentFlow — verified defect repair

## What this document is

A replacement for the previous `plan.md`, which described work that no longer
exists in this repository. Its Phase 1A items were all marked `[x]`, but that
work lived on branch `fix/ui-ux-remediation` (commit `cf99336`), which was
deleted on 2026-08-02. `main` never contained it.

The product model in that plan was confirmed by the repo owner and still
stands. What follows keeps the model and discards the progress claims.

**Every entry below was verified against the code before being written down.**
Where something is unverified, it says so.

## The standard this work is held to

The repository already encodes it in `scripts/check-no-sabotage.mjs`: a new
assertion is not trusted until it has been proven to go RED. That file exists
because three parallel agents were each caught leaving deliberately broken code
in the tree while the suite stayed green, the types checked, and the page
rendered.

So: for each fix below, the test was run against the *unfixed* code and
observed to fail. A gate that cannot fail is not a gate. One written during
this pass (`check-title-hero.mjs`, first version) passed on both the broken and
the fixed code and was rewritten for that reason — the note is kept here rather
than quietly dropped.

---

## Completed

### 1. Stale build output broke the lint gate

`npm run lint` exited 1 on a clean checkout with 2,012 errors. 745 of the 764
linted files were in `.next-rollback` (58 MB) and `.next-proof` (53 MB) —
gitignored build directories that ESLint still scanned. `src` and `scripts` had
**zero** errors.

Removed both directories. Lint: 2,012 errors → 0, exit 0.

### 2. Hydration mismatch on Browse

`hero-banner.tsx` and `rail.tsx` used
`initial={reduceMotion ? false : {...}}`. `useReducedMotion()` returns `false`
during SSR and `true` on a reduced-motion client, so server and client rendered
different style attributes and React logged a hydration mismatch.

Fixed with `initial={false}` and a zeroed transition duration under reduced
motion. `initial={false}` rather than a constant `initial={{opacity: 0}}`
because the latter ships content invisible until JS runs.

- Gate: `scripts/check-hydration.mjs` — 4 routes × reduce/no-preference × 2
  passes = 16 combinations.
- Proven red: reverting `hero-banner.tsx` alone produced exactly 2 failures,
  both on `/` under reduced motion. No-preference stayed green, which is what
  the theory predicts.

### 3. Invented S01E01

`nextUpTarget()` ended in `{season, episode: 1}` whenever the cursor, local
files and catalog were all silent — a Play button pointing at an episode
nothing had established exists, rendered above an empty list saying there were
no episodes.

- `nextUpTarget()` now returns `null` in that case.
- New `DiscoverTitleAction` ("Find episodes") is offered instead, wired to the
  extras refetch.
- The Download control is suppressed for a `discover` primary: it would have to
  name an episode, and the only one it could name is the guess being removed.
- A catalog row *is* evidence — an episode the server sent demonstrably exists,
  so it is a valid target even with nothing held. This was missed in the first
  attempt and caught by an existing test.

Two existing tests asserted the old behaviour (`kind === "stream"` for a series
with no episodes) and were pinning the defect in place. They were rewritten,
not deleted.

- Proven red: restoring the fallback failed exactly the 2 new assertions.

### 4. Transfer state was read at one scope out of three

`detail.ts` queried `where: { userId, workKey, scope: "episode" }`, while
`route.ts` writes targets at `title`, `season` **and** `episode` scope. A film
the user had just sent, or a season pack mid-download, came back with no
transfer at all — so the page offered Download beside a running download and
contradicted the Client.

- The route now reads all scopes and keeps three separate maps. They are never
  merged: a season pack at 40% says nothing about whether episode 3 is
  playable.
- `TitleDetailPayload.transfer` and `TitleSeason.transfer` added.
- The decision was extracted to `acquisition-scopes.ts` because the original
  defect lived in a Prisma `where` clause, which no offline test can reach.
  That is *why* it survived a green suite.

- Gate: `acquisition-scopes.test.ts`, 7 table-driven cases.
- Proven red: disabling the `title` and `season` branches failed 3 of them.

### 5. Duplicate Download

- `offersDownload()` — one intent, one control. `failed` is the exception,
  where pressing again is the correct move.
- `transferStatusLine()` — "Queued", "Downloading N%", "Downloaded",
  "Failed — reason". Progress floored, not rounded: 99.6% must not print 100%.
- Retry labels are contextual. "Try again" was the same four characters whether
  a search found nothing, a send was refused, or a file failed to open.
- Play survives an in-flight download. Sequential piece selection makes a
  partial file watchable, so removing Play mid-download would be a regression.

- Gates: 5 new cases in `title.test.ts`; `check-title-controls.mjs` drives a
  real browser over 6 titles.
- Proven red: stubbing `offersDownload` to `true` failed 2 cases.

### 6. Title hero sized itself from the screen

`grow` plus `min-h: clamp(360px, 56vh, 560px)` meant the same title rendered a
404px hero at 720p and **561px** at 1080p — 157px of empty band bought purely
by having a taller screen.

Replaced with fixed responsive minimums. Measured after: 391px at both heights,
drift 0px.

- Gate: `scripts/check-title-hero.mjs`.
- **Note on this gate.** Its first version asserted "hero ≤ 72% of viewport".
  That passed on the broken code (52%) *and* the fixed code (36%) — decoration,
  not a gate. Rewritten to assert the hero does not grow with viewport height,
  which separates them cleanly.
- Proven red: the old CSS fails all 4 titles with "hero grew 157px with the
  screen".

---

## Open — found during this work, not yet fixed

### A. Migration `20260731120000_acquisition_target` is not applied

`prisma migrate status` reports it pending. Without it every title page returns
500 (`SQLITE_ERROR: no such table: main.AcquisitionTarget`).

**This is pre-existing on `main`** — the code called `acquisitionTarget` before
any change in this pass. It was applied to a scratch copy of the database for
testing; **the live `dev.db` has not been touched.**

Worth noting against the deleted plan's claim of a "title-correctness
milestone… 52/52 passed on 2026-08-02": on this database, title pages do not
load at all.

Fix: `npm run db:migrate:deploy`. Not run against live data without
instruction.

### B. `/api/client/torrents` returns 502 on every page load

Seen on `/` and `/client` in every browser run. Not investigated. Unknown
whether it is configuration (no external client connected) or a defect.

### C. Navigation rebuild — not started

From the confirmed model: five destinations (Browse, Library, Downloads,
Notifications, Settings); remove Rules and Compact; Activity becomes
Notifications with an unread count.

**The Client page is to be renamed Downloads** (owner instruction, 2026-08-02).

`src/lib/navigation.ts` is the single source of truth and currently lists Rules
twice; `/rules`, `/activity` and `/history` routes all still exist.

Deferred deliberately: it changes routes and product surfaces, and wants eyes
on the result rather than a green unit suite.

---

## Verification status

| Gate | Result |
|---|---|
| `npm run test:unit` | 152/152 |
| `npm run typecheck` | 0 errors |
| `npm run lint` | 0 errors, 42 warnings |
| `npm run build` | succeeds |
| `check:sabotage` | pass |
| `scripts/check-hydration.mjs` | 16/16 |
| `scripts/check-title-controls.mjs` | 6/6 titles |
| `scripts/check-title-hero.mjs` | 4/4 titles, 0px drift |

The three browser scripts need a running server (`PROBE_BASE`, default
`http://127.0.0.1:3100`). They are deliberately repository scripts rather than
MCP-only checks, so CI can reproduce them.

## What has *not* been verified

- Nothing here was checked against a real in-flight download. The duplicate-
  Download fix is proven by unit tests over the payload contract and by a
  browser run against titles that happened to have no active transfer. The
  states `queued` / `downloading` / `downloaded` were not observed end to end.
- No screenshots were reviewed by a human. The browser gates assert measurable
  facts (mismatch counts, control presence, pixel heights); they do not
  establish that the result looks right.
- The 502 in (B) is unexplained.
