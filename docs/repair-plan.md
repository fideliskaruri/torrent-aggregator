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

### 0. Series detection and title matching are wrong for most titles tried

Found while browser-verifying the Add to Library questions. Of six well-known
series probed on their title pages, **five resolve as `isSeries: false` with a
film `mediaType`**:

| `/title/…` | `isSeries` | note |
|---|---|---|
| `breaking-bad` | `false` | `externalId: 1396` is the TMDB **TV** id, stored as `mediaType: "movie"` |
| `the-wire` | `false` | |
| `arcane` | `false` | |
| `attack-on-titan` | `false` | |
| `the-bear` | `false` | |
| `severance` | `true` | but matched `externalId: 348669`, a **short film** of the same name — synopsis reads "A short film made by the B TEAM" |

This is pre-existing and was not introduced by this pass, but it is more
serious than anything fixed in it. Every series-shaped behaviour in the app —
season lists, episode hunting, the start-point question, the Series tab, the
next-episode cursor — is gated on `isSeries`, so for these titles all of it is
silently inert. The app does not appear broken; it appears to have decided the
show is a film.

The Severance case is a different failure from the other five: detection is
right, identification is wrong. `title-identity-accuracy.test.ts` already
encodes the rule that a same-name mismatch is a defect (its Dune 2021 vs 2017
case), so this is a live example of a rule the suite states and the running app
does not keep.

Not fixed here because it is a metadata-resolution problem, not a UI one, and
guessing at it late in a long session is how the wrong fix gets committed with
a green suite behind it. It should be the next thing looked at.

### A. Migration `20260731120000_acquisition_target` — applied

`prisma migrate status` reported it pending, and without it every title page
returned 500 (`SQLITE_ERROR: no such table: main.AcquisitionTarget`).

**This was pre-existing on `main`** — the code called `acquisitionTarget`
before any change in this pass.

Applied to the live `dev.db` on owner instruction. A pre-migration backup was
taken first (`%TEMP%\opencode\dev.db.pre-migration.bak`, 9,134,080 bytes). The
migration is additive — one new table — and no existing row was touched.

Worth recording against the deleted plan's claim of a "title-correctness
milestone… 52/52 passed on 2026-08-02": on this database, title pages did not
load at all.

### B. `/api/client/torrents` 502 — not a defect

Seen on every page load during early browser runs. On investigation the
endpoint returns 200 with a live torrent list; the 502s were the built-in
engine still warming up at server start. Nothing to fix. Noted here because a
recurring 502 in a console log is exactly the sort of thing that gets
rediscovered and re-investigated six months later.

### C. Navigation rebuild — done

See "Completed" items 7 and 8.

---

## Completed (continued)

### 7. Navigation: five destinations, honest names

Browse, Library, Downloads, Notifications, Settings. Search left the
destination list to become a global affordance — a box in the desktop header,
full-screen on mobile — because it is something you do, not somewhere you are.

- **Client → Downloads.** "Client" named the subsystem. Nobody opens a media
  app to look at a torrent client.
- **Activity → Notifications.** Activity was a wall of everything that had
  happened, which is why nobody read it.
- Both old paths redirect. Each was a header entry for the app's whole life.
- **Rules leaves the navigation but keeps its route.** Its replacement — the
  per-title Add to Library flow — does not exist yet, and removing the only
  route to automation before building what replaces it would be a regression
  sold as a cleanup.
- The Compact density toggle is gone: it answered an implementation question,
  and every viewer paid header space for it.

One layout fact decided the design: the mobile bar drops its More tab when
nothing was demoted to it. At six columns each tab gets 65px at 390px and
"Notifications" truncates to a half-word; at five it gets 78px and renders.
The pre-existing tab-fit test caught this, which is the system working.

- Gate: `scripts/check-navigation.mjs` — rendered labels, redirects, 44px
  targets, truncation, no empty More tab. Plus the updated `flow.test.ts`
  contracts.

### 8. Library tabs: what a thing is, not how far through it you are

All / Movies / Series / Anime, All by default, replacing status chips. Status
is a property of one title and stays on that title's card, where it is still
editable.

- A row the app cannot classify is **never** guessed into Movies. It stays
  under All and claims no narrower home.
- Counts do not pretend the parts add up: `all` is the total, so `all`
  exceeding the sum means some row has no media type — a fact about the
  library, not a rounding error.
- Empty tabs are hidden; All is always present as the way back.

- Gate: `library-tabs.test.ts`, 8 cases. Verified to go red: defaulting the
  unknown case to `movies` fails 4 of them. Browser-checked at 390px for 44px
  targets and no overflow.

### 9. Notifications actually became an inbox

The rename shipped in item 7; the behaviour did not. The page was still the
Activity feed wearing a new name — which is worse than leaving it called
Activity, because the name implied someone was telling you things worth
knowing.

A notification must be news, and news is two things: something you wanted is
ready, or something you wanted failed in a way only you can resolve. Progress
belongs on the thing making progress.

- One release failing is not news; the app tries other releases and sources
  first. Only the terminal outcome is the user's to act on.
- One recovery action per failure, not a menu.
- Failure messages are translated out of machinery. `ECONNREFUSED
  127.0.0.1:8080` names a port the user never chose. Unrecognised messages are
  kept verbatim rather than replaced by "Something went wrong" — a specific
  unknown is more use than a vague known.
- Unread count in the nav, stored as a timestamp in `localStorage`. Computed in
  an effect and starting at 0, because reading storage during render is the
  hydration defect fixed in item 2.

**A note on a guard that could not fail.** The first version of `inbox.ts` had
a `NOT_NEWS` set listing `skipped`, `queued`, `searching`. Deleting it failed
no test — anything absent from the two allowlists already returns null. It was
removed rather than left implying a protection it never provided. Breaking the
allowlist instead (adding `skipped` to `COMPLETED`) fails 4 tests, which is
what a real guard looks like. This is the second time in this pass that a
check turned out to be decoration; both are recorded rather than quietly
fixed.

- Gate: `inbox.test.ts`, 10 cases. Verified end to end against this database:
  50 feed rows (14 sent, 35 failed, 1 skipped) → 49 notifications → badge 49 →
  clears to nothing once read. Zero console errors.

### 10. Library tabs

See item 8.

---

## Verification status

| Gate | Result |
|---|---|
| `npm run test:unit` | 156/156 |
| `npm run typecheck` | 0 errors |
| `npm run lint` | 0 errors, 44 warnings |
| `npm run build` | succeeds |
| `check:sabotage` | pass |
| `scripts/check-hydration.mjs` | 24/24 |
| `scripts/check-title-controls.mjs` | 6/6 titles |
| `scripts/check-title-hero.mjs` | 4/4 titles, 0px drift |
| `scripts/check-navigation.mjs` | pass, badge included |

The four browser scripts need a running server (`PROBE_BASE`, default
`http://127.0.0.1:3100`). They are deliberately repository scripts rather than
MCP-only checks, so CI can reproduce them.

## Phase 1B — where it actually stands

| Item | State |
|---|---|
| All/Movies/Series/Anime tabs | done |
| Notifications inbox + unread count | done |
| Add to Library questions, per-title preferences | done |
| Automatically download new episodes | **not started** |
| Watching + update/download state on cards | done |
| Stop-tracking and granular confirmed deletion | **not started** |

The two remaining items were left deliberately rather than rushed. Both act on
the world rather than the screen: automatic episode downloading starts real
transfers of real files without being asked, and granular deletion removes
media from disk. Both deserve their own test design and a fresh start, not the
tail of a long session — which is exactly the condition under which the work
this document replaces was produced.

Note also that automatic downloading now depends on `isSeries` being right,
and section 0 shows it usually is not. Building it before fixing series
detection would produce a feature that appears to work, is tested green, and
does nothing for most of the library.

## What has *not* been verified

- **No screenshots were reviewed by a human.** The browser gates assert
  measurable facts — mismatch counts, control presence, pixel heights, label
  truncation, badge text. They do not establish that the result looks right.
  This remains the single largest gap and is not one an agent can close.
- Notification failure translation is tested against the message shapes found
  in this database. A cause not in that set falls through to the raw text,
  which is the intended behaviour but means the phrase list is incomplete by
  construction.
- The unread count is per-browser (`localStorage`). Opening the app in a second
  browser shows everything as unread. Correct for a single-user local app;
  worth knowing before anyone puts it behind a reverse proxy.

## What *was* verified end to end

The duplicate-Download fix was checked against a **real in-flight torrent**,
not only against the payload contract. With a title-scope target reconciled
against the live engine, the page rendered:

- `data-transfer-status="downloading"`, "Downloading 0%" (engine reported
  0.068%, floored — a running torrent must not print a number that says it
  finished)
- no Download control
- primary action "Play", enabled — a partial file stays watchable
- zero console errors

The notification inbox was checked against the real feed: 50 rows in, 49 out,
badge matching, clearing on read.

