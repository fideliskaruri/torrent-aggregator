# User-journey test suite

These are **real user-journey tests**: they boot a Next dev server on a throwaway
copy of the database, drive a real Chromium browser through the app, and
**measure** the thing the user complained about. Every failure message carries the
measured value (e.g. `saw 2 simultaneous loaders`), never a bare `expected true`.

They are deliberately different from the 110 unit tests, which only exercise
pure functions (ranking, parsers, dates) and never open the app.

## Run

```powershell
npm run test:journeys          # report mode — always exits 0, prints a RED/GREEN table
npm run test:journeys:gate     # same, but exits 1 if any journey is RED (CI gate)
```

### Gate integration (base URL as `argv[2]`)

The pre-commit gate (`scripts/probes/gate.mjs`) boots one server on `:3400` against a
**copy** of `dev.db` and runs every probe against it. To be its last stage, the suite
accepts a base URL as `argv[2]` and, in that mode, **skips booting its own dev server**
and **exits non-zero on any RED** (like the sibling probes):

```powershell
node scripts/journeys/run.mts http://127.0.0.1:3400   # gate mode — reuse the gate's server, exit 1 on RED
```

Passing an external base implies gate-exit semantics (a RED fails the gate). `--gate`
and `JOURNEY_GATE=1` give the same exit behaviour when the suite *does* boot its own
server. DB safety in external mode is owned by the gate; the suite still provisions a
scratch temp download dir so J4's save-path guard has a safe target.

Run a subset for fast iteration with `JOURNEY_ONLY` (comma-separated name substrings):

```powershell
$env:JOURNEY_ONLY='J4,J8'; npm run test:journeys   # just those two (discovery still runs)
```

> Matching is a plain substring on the journey name, so `J1` also matches `J10`/`J11`.
> To isolate a single journey use its slug (e.g. `one-loader`, `responsive`,
> `stream-stops`) rather than its `J`-number.

Artifacts (screenshots + measured values) are written to a gitignored scratch
dir: `qa-screens/journeys/<run-id>/`. The dev-server log is `qa-journeys-devserver.log`.

### Database safety

The harness imports `scripts/lib/harness-db.mjs`, which copies `dev.db` to a temp
file and repoints `DATABASE_URL` at the copy. The suite then asserts at startup
that the resolved `DATABASE_URL` is **not** `dev.db` and aborts if it is. The real
user database is never opened.

### J4 fixture safety (the one journey that moves real bytes)

J4 adds a permanently-seeded Creative-Commons torrent (Big Buck Bunny, Blender
Foundation, CC-BY) to prove a **stream stops pulling on close**. It is the only
journey that writes real bytes, so it is fenced four ways:

1. `assertNotLiveDatabase()` is re-run immediately before the add.
2. **The engine's download root is repointed to the scratch temp dir first** — the
   scratch DB inherited the user's *real* `baseDownloadPath`, so a stream would
   otherwise land in the real library. `assertSafeSaveDir()` then asserts the
   persisted root, and the torrent's own `savePath`, are under `os.tmpdir()` and
   **not** under `<repo>/.e2e-instant-play` (the real 7.7 GB media root); it aborts
   rather than "fix" an unsafe path.
3. The download is bounded: as soon as bytes are observed and measured, the torrent
   is removed and its files deleted (kept a few MB, never the full 276 MB).
4. `try/finally` guarantees the torrent + files are removed even if an assertion
   throws. If P2P/webseed networking is unavailable the journey reports **BLOCKED**
   with the observed peer count, never a fake pass.

### Running while another dev server is up (isolation escape hatch)

Next 16 / Turbopack takes a single-instance lock at `<distDir>/lock` and refuses
to start a second `next dev` for the same project directory. If a production or
sibling dev server is already running against this repo, point the suite at an
**isolated copy** of the project (a separate real path → its own `.next` → its own
lock) via `JOURNEY_APP_DIR`. The suite files still live in this repo; only the app
being served is the copy.

```powershell
# one-time: snapshot the project next to the repo and share node_modules
$src='D:\code\torrent-aggregator'; $dst='D:\code\ta-journeys-src'
robocopy $src $dst /E /XJ /XD "$src\node_modules" "$src\.next" "$src\.git" "$src\.e2e-instant-play" "$src\qa-screens"
New-Item -ItemType Junction -Path "$dst\node_modules" -Target "$src\node_modules"
# widen the copy's turbopack root so the shared node_modules is inside it:
#   next.config.ts -> turbopack.root: dirname(dirname(fileURLToPath(import.meta.url)))

# then, from the repo:
$env:JOURNEY_APP_DIR=$dst; npm run test:journeys
```

`ta-journeys-src` is a regenerable scratch copy — safe to delete anytime.

> **Testing current code during concurrent edits.** The served app is the copy, so
> to test the latest `src/` (e.g. while other agents are editing components) refresh
> it before a run and re-point:
>
> ```powershell
> robocopy D:\code\torrent-aggregator\src D:\code\ta-journeys-src\src /E /NFL /NDL /NJH /NJS /NP
> $env:JOURNEY_APP_DIR='D:\code\ta-journeys-src'; npm run test:journeys
> ```
>
> Selectors live in `scripts/journeys/lib/pages.mts` only, so a markup rename during
> a refactor breaks one file, not twenty.

## What each journey encodes

| # | Journey | Bug it catches |
|---|---------|----------------|
| J1 | one-loader | More than one loading indicator — or one that flickers/hands off — between Play and first frame. Installs a `MutationObserver` + capture-phase `animationstart` listener + per-`requestAnimationFrame` visibility sampler **before** the click. **Node identity is tracked across the whole `document.body`, not the player subtree** — because the user's bug IS the handoff: the animated node changes owner from the pressed button's spinner to the overlay's spinner, a sequential swap that `peak` can never see (it stays 1 the whole time). The loader union is `[data-player-loader]`(preferred hook) ∪ `[data-stream-loading]` ∪ `.animate-spin`, **excluding** the swarm chip (a static `role=status` dot, not a spinner). First frame ends at the video's `requestVideoFrameCallback`, else the `data-playback-started` hook, else a **headless-safe `canplay`/`readyState>=3` proxy labelled `firstFrame=…ms (proxy:canplay)`** in the output so it is never mistaken for a true presented frame. FAILS on: `uniqueNodes>1` (identity handoff/remount — the primary defect, reported as `nodes=2` with the full transition `#1 owner@[a..b]ms → #2 owner@[c..d]ms (handoff:+Nms gap)`), `animStarts>1` (a different node's animation restarted), `peak>1` (two on screen at once), or a drop-to-0 gap before first frame. `peak==0`/no-loader is BLOCKED (proved nothing), never a pass. Logs which selector path it took (`loaderHook=data-player-loader` vs `fallback(...)`). Covers three surfaces: the on-disk home-rail Play, the grab-first button-spinner→overlay handoff, and **Path C — a title-page `Resume`/`Play` hero (the user's `/title/dune` repro), which is the exact surface where the button's own spinner hands off to the overlay's spinner.** The title hero renders only after the client payload resolves, so Path C waits for `[data-title-primary]` to become *visible* before pressing. Node identity being body-scoped is what makes this catch the handoff the live-build probe measured as `nodes=3 · animationstarts=2` while `peak` never exceeded one glyph. |
| J2 | no-mechanism-copy | Player leaking mechanism strings ("Checking whether", "Getting it ready", "Remuxing", "peers", raw Windows paths) |
| J3 | stream-not-a-download | A Play-only title showing up badged Downloading / counted in the DOWNLOADING stat |
| J4 | stream-stops-on-close | Torrent keeps pulling bytes after the player is closed. Adds a live CC-BY fixture (Big Buck Bunny) as a **stream**, pulls real bytes from the swarm via ranged GETs, confirms `downloaded` strictly climbs while open, then closes (the exact `releaseStream` → prewarm `released` POST the player fires) and samples again. **Asserts the intended stop-on-close** (`builtin-engine.ts:1863`/`:1880` `parkBuiltinStreamTorrent`; `inline-player.tsx:2024` "storage without consent"): RED if it still pulls >1 MB in the 4 s *after* close, GREEN if it goes flat. Measures verified `downloadedRanges` from the live bitfield (NOT the zeroed `/api/client/torrents` figures). BLOCKED (never faked) if the swarm never delivers bytes offline. |
| J5 | responsive | Horizontal scroll, text squeezed <120px (one-word-per-line), or sub-44px tap targets on mobile, across every route |
| J6 | search-releases-distinguishable | Release rows all rendering identical text |
| J7 | result-click-closes-overlay | Title click must close+navigate; inner Play/Download must not close the overlay. Waits for the real navigation post-condition (`waitForURL **/title/**`), not a fixed delay, so first-hit dev route-compile latency does not false-RED it. |
| J8 | no-layout-shift-on-action | A Play/Download button changing size while pending |
| J9 | default-season-sane | The primary action offering an episode from a different season than the list shows |
| J10 | no-dead-ends | Play becoming inert after a failed attempt + close |
| J11 | shared-sending-spinner | Press **Play** on a search result and the **Download** button spins too (a shared `sending`/`pending` flag driving both buttons' spinners in `torrent-card` / `title-result-card`) |

See the final report / `scripts/journeys/run.mts` for the current RED/GREEN status
and the `data-*` hooks that would make the blocked journeys runnable.

### Why some journeys report BLOCKED (library-content dependence)

The scratch DB is a copy of `dev.db` taken **at the moment the run starts**, and the
live app plus concurrent agents mutate `dev.db` continuously. Several journeys need
specific library content to exercise their surface — J2/J3/J8/J9/J10 need a
ready-to-play or Play-only title on disk; J1's on-disk and title-Resume paths need the
same. When the copy taken for a given run happens to have a minimal library (e.g.
`titles=0` on the home rails, no `/title/<slug>` hero), those journeys report **BLOCKED**
rather than a fake pass — the `discovery:` line at the top of each run records exactly
what was found. A run against a content-rich copy (or the gate's warmed `:3400` server)
exercises them. BLOCKED is an honest "could not set up", never GREEN.
