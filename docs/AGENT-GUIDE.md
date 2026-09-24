# TorrentFlow — Build State & Autonomous Agent Operating Manual

> **Audience:** an autonomous coding agent that will run unattended (overnight) on this repo.
> **Purpose:** tell you (a) what we're building, (b) exactly where we are, (c) every trap we've
> already hit, (d) how to prove your work is real, and (e) how to run yourself and sub-agents
> like a ruthless, competent engineering manager who never ships a lie.
>
> **Read this whole file before touching code.** Then keep it open.

---

## 0. The one rule that matters most

**Never claim something works until you have watched it work.**

Three previous agents (and, honestly, the assistant that wrote this) got caught "verifying"
by grepping a word, reading JSON, or running a green test that asserted nothing. Every time,
the suite was green, the types checked, the page "rendered" — and the feature was broken.

You verify by:
- **Screenshotting the rendered UI** and looking at it (Playwright, see §6).
- **Hitting the real API** on the running server and reading the response.
- **Writing a test, then deliberately breaking the code to watch the test go RED**, then
  restoring it. A test you never saw fail proves nothing. This is enforced — see §5.

If you cannot verify something, say so explicitly and leave it flagged. Do not round up.

---

## 1. What we're building

**TorrentFlow** (repo: `torrent-aggregator`) is a **media-first** torrent app. The product
thesis, in the owner's words: *"this is not a product, it's a website you go to view torrent
lists."* We are turning it into Netflix-shaped: **see art → click a title → a page about the
title → press Play or Download.** Torrent mechanics (WEB-DL, peers, scene names, magnet
links, save paths) stay off-stage.

### Product decisions already locked (do not relitigate)
- **Play just plays.** Fetch + stream, no phase/copy step. If a hash is stale, recover by
  re-fetching. Play never shows a torrent table.
- **Add to Library = track it + auto-download when storage permits.** No monitor toggle, no
  "do you want to auto-download?" prompt.
- **Library = things I care about.**
- **Downloads page = media-first.** Hide WEB-DL / peers / scene names / paths. One state
  word + one bar + one percent per row. Lead with `SxxExx`, not the show name repeated.
- **Episode lists show the full provider catalog**, marking what we hold locally.
- **Storage cap is mostly for automation.** Manual downloads may override the cap (never the
  physical "won't fit" floor). The owner set the cap; the app may warn but must not overrule.
- **Exact episodes only for season downloads** (see §3/§4). A season action batches
  per-episode releases; it never acquires a season pack.
- **API Bay video categories include HD and UHD siblings.** TV queries must include
  205/208/212, not just 205; movies span 201/202/207/209/210/211. The adapter searches
  broadly and filters these categories before truncation. Otherwise individual
  episode fallback searches can find releases that a season search silently misses.

### Who it's for
Local, single-user app. Auth was removed. Read routes answer directly (no 401).

---

## 2. Architecture map (where things live)

Next.js 16 (App Router, Turbopack) + React 19 + TypeScript + Prisma (SQLite via libSQL
adapter) + a built-in WebTorrent engine. shadcn/ui is installed (style "new-york", lucide
icons, sonner `Toaster` mounted in `layout.tsx`). Reuse `Button`, `toast`, `cn`.

### The title page (the spine of the product)
- `src/components/title/title-detail.tsx` — the page shell. Hero, season grab handler
  (`runSeasonGrab`), `titleNeedsTransferPoll` (drives the 2.5s poll only while something is
  in flight), cap-override dialog wiring.
- `src/components/title/episode-list.tsx` — the episode **filmstrip**. Memoized `EpisodeCard`
  (value comparator) + `EpisodeStillImage`. `DownloadGlyph` (percent while downloading,
  `Check` when done, spinner when queued). Season selector is a native `<select>`
  (`[data-season-select]`); episode download control is a raw `<button>` overlay pill
  (`button[data-episode-action][data-action="download"]`, `aria-label` = the state label).
- `src/components/title/episode-list-state.ts` — `episodeSeasonCountLabel` etc.
- `src/components/title/types.ts` — `TitleEpisode` (incl. optional `coveredByPack?`),
  `TitleEpisodeTransfer`, `TitleExtrasPayload` (genres/voteCount/certification/originalLanguage),
  `TitleSeasonGrabResponse` (now carries `storage?`).
- `src/components/title/title-action-request.ts` — `postTitleAction`; re-derives storage
  overridability client-side (never trusts the wire flag).

### The player — playback pipeline (Play → pixels)
- `src/components/watch/inline-player.tsx` (~5k lines) — the ONLY player. One overlay, one
  continuous loader. **There is no "torrent link" fallback; the info-hash *is* the source.**

**Decision tree, top to bottom (this is the answer to "how does fallback work"):**
0. **Serve a completed local file without booting WebTorrent** — a concrete
   `/api/stream/{infoHash}/{file}` request first resolves the torrent-relative path against
   `EngineTorrent.verifiedFilesJson` (absolute verified paths + sizes) and `savePath`. If the
   row is complete and the file's real path remains inside the save root with
   the exact persisted size + mtime, the route serves the requested byte range directly from
   disk with `ok_disk_fastpath` / `partial_disk_fastpath`. Completed rows are terminal local
   assets: they are never rehydrated or seeded. Missing, stale, malformed, path-mismatched,
   symlink-escaped, or not-yet-complete evidence falls through unchanged to the engine path.
   Successful direct responses also carry
   `X-TorrentFlow-Stream-Source: disk-fastpath` for browser/network verification.
1. **Pick the file** — `loadManifest()` GETs `/api/stream/{infoHash}?season&episode`, then:
   - server sent `targetVideoIndex` → play that file;
   - else exactly **one** video file → play it (a lone video is unambiguous — always select it).
     *This branch used to be missing: a single-episode torrent whose manifest had no
     `targetVideoIndex` fell through every case, `selectedPath` stayed null, and the player hung
     forever on the loader on a fully-downloaded file. Fixed 2026-08-07 — see BUG-016.*
   - else multiple videos → `mainFeatureFile()` dominance heuristic (movies) or the file picker (real packs);
   - zero videos → "No video file was listed."
   Selection sets `selectedPath` → `effectiveSelectedPath`; the plan effect is **gated on it**, so
   nothing selected ⇒ nothing plays (no plan request is ever sent).
2. **Decide how to play** — the main effect POSTs `/api/playback/plan` with browser `capabilities`:
   - `direct` → `<video src>` = `/api/stream/{infoHash}/{file}`;
   - transcode/remux → HLS session;
   - **plan returns non-OK (e.g. 400)** → `tryDirectStream()` probes with `Range: bytes=0-0`;
     a `200/206` ⇒ set `playbackMode:"direct"` and play anyway.
3. **Bytes come from disk first, then the engine** — `/api/stream/{infoHash}/{file}` directly reads
   a persisted, size-matched completed file without waiting for engine metadata. On any disk
   fast-path miss, the built-in WebTorrent path is unchanged: complete/verified range ⇒ read
   disk through the live torrent; partial/cold ⇒ fetch those byte ranges from the swarm on
   demand. There is no "file missing, use the link instead" branch.
4. **Fall back to another release** — `attemptAutoFailover()` fires ONLY on a *structured* stream
   failure (dead/stalled swarm, or an unplayable-codec verdict): POST `/api/playback/candidates`
   → pick the next-best **info-hash** → `/api/playback/switch`. This is the real "fall back" — a
   different release of the same episode, never a raw link. A codec problem is NOT retryable
   against the same-quality pool, so it surfaces a terminal verdict instead of failing over.

**Codec truth (memorise, don't re-derive):** Chromium decodes H.264 video but NOT Dolby Digital
Plus (E-AC-3 / `DDP5.1`), AC-3, or DTS audio. Such releases (e.g. `AMZN WEB-DL DDP5.1`) reach a
real `<video>` — video decodes, `videoWidth/Height` and `currentTime` advance — but the player
correctly surfaces **"This release won't play in the browser (audio can't be decoded)."** That is
correct behaviour, not a bug; pick a `WEB h264` / AAC release to get sound.

**Open finding (unverified):** `/api/playback/plan` returns **400** for the E-AC-3 file above, which
is what forces the `tryDirectStream` fallback every time. Confirm whether 400 is the intended
"unsupported audio" signal or a malformed-request bug (the api-ledger sweep captures the body).

**Disk-first integrity tradeoff:** the direct route does not SHA-1 every torrent piece on every
Play. It trusts the engine's previously persisted completed-file fingerprint, then rechecks
save-root containment, realpath containment, exact size, and exact mtime before opening. This is
the latency win. An external actor that rewrites bytes while preserving both size and mtime could
evade this check; the fallback `openVerifiedDiskStream` still performs piece verification when the
persisted completed-file proof is unavailable.

**Built-in engine lifecycle:** WebTorrent exists only for incomplete downloads and foreground
partial streaming. Progress snapshots are event-driven, coalesced per user/hash, serialized, and
written no more than once every five seconds. Completion disconnects peers immediately, drains
older snapshots, persists the verified file manifest and linked acquisition state transactionally,
then calls `torrent.destroy({ destroyStore: false })`. When the last live torrent leaves, the shared
client is destroyed to release its listener, DHT, tracker pools, timers, and handles. Downloads and
Browse GETs read durable rows plus already-live snapshots; they never initialize, rehydrate, scan,
or persist the engine.

**Verified playback regression matrix (2026-08-08):**

| Case | Result | Evidence |
| --- | --- | --- |
| Completed single-file direct read | PASS for video delivery; no confirmed AAC fixture | E08 attached at 1280×720, `readyState=4`, advanced to 2.15s, direct stream returned 206 with `X-TorrentFlow-Stream-Source: disk-fastpath`. The player then classified its audio as unsupported, so full browser-compatible A/V remains unproven with the current fixtures. |
| Pause/resume + seek + reopen + reload | PASS for E08 video | Pause held time steady; seek 0.4→15→1s; resume advanced; close/reopen and page reload/replay both attached and advanced. |
| Known DDP5.1 release | PASS | E05 attached at 1920×1080, advanced, hit disk-fastpath, then showed the truthful unsupported-audio verdict — no 425 or endless Preparing. |
| Partial E09 | PASS | At ~68%, its 206 response had no disk-fastpath header, proving engine fallback; the probe was bounded/closed rather than awaited indefinitely. |
| Missing/stale/traversal/symlink | PASS (fixtures) | Unit coverage proves missing and size-mismatched files fall through, `..` is rejected before lookup, mismatched relative paths miss, and a junction escaping the save root is refused. |
| Range + cancellation | PASS | HEAD/no Range=200, bytes 10-19=206 with length 10, out-of-bounds=416, cancelled full response left `/api/health` at 200. |
| Partial/growing playback | PASS | A 98% episode attached as `source:"swarm"` / `strategy:"session"`, reached `readyState=4`, held more than 30 seconds buffered, and continued after changing playback speed to 1.5x. |
| Downloaded Next transitions | PASS | Four consecutive disk-backed advances completed in 1.35-1.67 seconds at 1280px. Additional transitions completed in 1.03 seconds at 768px and 1.15 seconds at 390px, with at most one loader and no blank samples. |
| Swarm-backed Next transition | PASS | S09E02 advanced to S09E03 in 1.85 seconds; the destination reported `source:"swarm"` / `strategy:"session"`, reached `readyState=4`, and showed no terminal error or blank loader gap. |
| Next warm planning | PASS | Each known local next episode issued one `warm:true` plan followed by the real plan. The warm route is unit-proven to use persisted local files and `probeFile` only, without WebTorrent activation, VOD/HLS session creation, or UI loading state. |
| Season navigation + reload | PASS | Selecting Season 2 wrote `?s=2`; SPA navigation away/back and a hard navigation both restored Season 2 with 10 episode rows and zero terminal skeletons. |
| Desktop 1280 | PASS layout | No document/body overflow, the Next target remained 44x44, and disk/swarm player states rendered without clipped controls. |
| Tablet 768 | PASS layout | No document/body overflow, the Next target remained 44x44, and the measured transition completed with one continuous loader. |
| Mobile 390 | PASS layout | No page-level horizontal overflow, the Next target remained 44x44, and the measured transition completed without clipped transport controls or a blank frame. |
| True process cold start | SUSPECT / not run | Server restart is owner-only. Unit seam proves `findBuiltinTorrentFile` is not called on a persisted hit; live requests show the disk-fastpath header and no 425 before attachment. |
| Console/network | PASS for the current matrix | A fresh title-page navigation logged only the React DevTools notice and HMR connection. Next flows issued `action:"next"` rather than `action:"trigger"`, did not duplicate on-demand acquisition for already-held episodes, and rendered no `data-stream-error`. |

### The title API (server truth)
- `src/app/api/title/[workKey]/detail.ts` — `buildTitleDetail`, `buildEpisodes`,
  `buildPackCoverage`, `pickLocal`/`pickUnpackedEpisodeLocal`/
  `pickDownloadingEpisodeLocal`, `isDownloadingLocal`/`isInFlightLocal`, `LocalRelease`,
  `pickSeason` (honors requested season even with no local files).
- `src/app/api/title/[workKey]/grab.ts` — `grabForTitle`, `grabSeasonForTitle` (returns
  `ok:false` + 409 when nothing sent; surfaces storage refusal).
- `src/app/api/title/[workKey]/route.ts` — POST handler; writes `AcquisitionTarget`;
  `overrideStorageCap` plumbing.
- `src/app/api/title/tmdb-extras.ts` — TMDB facts, `memo` with `TTL_MS` (6h) /
  `NEG_TTL_MS` (2min negative cache).

### Acquisition diagnostics
- Settings exposes the flag at `settings.verboseDiagnostics`, not the response root.
  `getUserClientConfig` forwards it to acquisition. Enabling it emits structured
  selection, storage, destination-strategy, send and season-coverage decisions through
  `logAcquisitionDecision`. Disabling it leaves normal error reporting intact.
- Logs contain provider IDs, counts, quality floors and reason codes, not titles,
  magnets, hashes, credentials or download paths. Inspect the configured destination
  in Settings when a full local path is needed.
- Season search coverage must pass the same identity, seed, link and quality gates as
  selection. A low-quality or unusable row must not suppress an exact episode search.
  Partial season results identify unsent episodes and distinguish provider failures
  from genuinely missing eligible releases.
- The built-in YTS mirror list already fails over when a host returns HTML or invalid
  JSON. A custom `YTS_BASE_URL` is optional, not required setup. Provider reachability
  and torrent peer availability remain external conditions, not guaranteed by a
  successful unit test.

### Installable web app
- The manifest and icons live in `public/`. The install action is on About when the
  browser offers installation; iOS receives home-screen instructions. Regenerate icons
  with `node scripts/generate-pwa-icons.mjs` after changing the source artwork.
- `public/sw.js` caches only the public offline shell and its explicit assets.
  Private APIs, mutations, media, ranges and React Server Component requests bypass it.
  It does not cache library pages or make downloads/playback work offline.
- Remote installation needs HTTPS; loopback is suitable for local use. The app remains
  single-user without sign-in: do not publish it to the open internet merely to enable
  installation. Hosting requires a persistent Node/Docker process, disk and an access
  boundary. A GitHub repository or static Pages site is not an app server.
- Worker updates do not automatically reload a playing tab. The offline screen
  explains that the TorrentFlow server is unavailable and offers a retry.

### Season acquisition (the planner)
- `src/lib/torrents/season-plan.ts` — **pure** planner. `planSeason` (exact episodes only),
  `resolutionRank`, `demotedTier`, `classify`, `packEpisodeRange`,
  `episodesFromFilenames`. **All acquisition strategy lives here, tested without a swarm.**
- `src/lib/library/ondemand.ts` — `grabSingleEpisode`, the path used directly by both
  individual episode downloads and the title-page season fan-out.
- `src/lib/grab/pipeline.ts` — shared grab pipeline (search → select → dedupe → viability →
  storage → send → record). All grab callers funnel through here.

### Storage policy
- `src/lib/library/disk-space.ts` — `assertStorageBudget`, `storageCapMessage`, floors/reserve.
- `src/lib/library/storage-override.ts` — `isOverridableLimit` (cap/reserve overridable;
  `wont-fit`/`setup` are hard stops), `parseStorageOverrideFacts`, `StorageLimitError`.
- `src/lib/library/storage-gate.ts` — `checkSendStorage` (reclaim for Play, cap for Download).

### Swarm health (our edge over Sonarr)
- `src/lib/torrents/swarm-probe.ts` — measures whether a torrent actually has live peers.
  Verdicts: `good` > `unknown` > `weak` > `dead`. `unknown` is NOT `dead` (cold cache must
  not disable the feature).

### Plan tracker
- `docs/plan.db` (SQLite, un-ignored via `!docs/plan.db`), `scripts/plan.mjs`
  (`seed`/`summary`/`list`/`mark`/`next`/`export`), text view `docs/plan-status.md`.

---

## 3. Where we are RIGHT NOW (state to confirm)

Branch `main`, remote `github.com/fideliskaruri/torrent-aggregator`.

### Committed & pushed (through `1bffdfe`)
- `1bffdfe` refactor: P2 — single scoreRelease() total-order in quality.ts
- `67adb5f` feat: P1.2 — surface plan.reason in season-grab report and UI
- `e96b8a8` feat: P1.1 — aired-status guard in season planner
- `f63c929` docs: AGENT-GUIDE.md first commit
- `2a49cf1` fix: settings/client returns a sensible default download path for first-run
- `fd33332` add visual-suite: route sweep + download-state proof with cleanup
- `a451b39` remove visible loading text from episode strip
- `eab92bd` introduced singles-first planning; current owner contract is exact episodes only
- …plus the earlier title-page redesign and downloads-page cleanup.

### Uncommitted working tree
Clean — all changes committed.

### Confirmed green (last targeted test run)
- `npm run typecheck` → 0 errors
- `season-plan.test.ts` → PASS (red-proven for P1.1 seasonComplete guard)
- `quality.test.ts` → PASS (red-proven for P2 scoreRelease)
- `title.test.ts` → PASS
- `defaults.test.ts` → PASS

### Visual confirmation done
- Playwright snapshot of title page: no "Loading season N…" text, clean episode strip.
- Episode download proof: E10 flipped to `Queued — S09E10 [disabled]` after API grab,
  cleanup removed the test torrent.

### Trap added to war stories (§4)
- **visual-suite Part 2 cap-override dialog**: `getByRole("button", {name:"Download"})` without
  `exact:true` matches "Download anyway" as a substring, causing the wrong dialog interaction.
  Also, the cap dialog can appear 30s after the quality dialog click (indexer search latency)
  so any `waitFor` less than 35s risks timing out. **Safest approach**: bypass the UI cap flow
  entirely and call the grab API directly from `page.evaluate()` with `overrideStorageCap:true`.

### Do NOT trust
- `.opencode/plugins/autopilot.ts` + `scripts/autopilot.mjs` — built but **never fired**.
  Treat autopilot as non-functional.
- `test-all.mjs` full suite (236 offline units + e2e + Playwright, ~20–30 min) not yet run this cycle.
  Run it and read `ALL-SUMMARY.txt` before claiming the full gate green.

---

## 4. War stories — every trap we've hit (read before you repeat them)

1. **Grep-and-declare-missing.** Twice a feature was declared "missing" because a word wasn't
   found, when it existed under another name (badges lived in `availability-chip.tsx`;
   automatic episode downloading was `runUserAutomation` in `automation/runner.ts`). **Screenshot
   or read the code path; never conclude from a single grep.**

2. **Green tests that assert nothing.** The `check-no-sabotage.mjs` rule exists because agents
   left sabotage markers mid-verification with a green suite. **A new assertion is untrusted
   until observed failing via a deliberate mutation, then restored.**

3. **Faking success.** `grabSeasonForTitle` used to return `ok:true "0 of N episodes"` when it
   sent nothing — green toast, no download. Now it 409s honestly. **Never report success for a
   no-op.**

4. **Season search returned zero.** `Rick and Morty S09` returns 0 hits on public indexers
   while every `S09E01…` single is one click away. Fixed with a **multi-query ladder**
   (`S09` → `Season 9` → `COMPLETE` → bare title) + **per-episode gap-fill**. Lesson: one query
   shape is never enough; the indexers disagree.

5. **"I picked 1080p but got 4K."** Pack/single selection fell through to ranker index on ties,
   and an Ai-upscaled 2160p sat on top. Fixed with an explicit `resolutionRank` tier. Lesson:
   soft ranker ordering is NOT a substitute for honoring an explicit user choice.

6. **"It grabbed a garbage pack."** Season acquisition now ignores packs entirely and batches
   exact episode releases.

7. **Episodes didn't show "downloading."** A season grab writes no per-episode
   `AcquisitionTarget` — only a live engine torrent. The card read the null `transfer` and
   showed a plain, re-clickable Download icon while bytes arrived. Fixed by synthesizing the
   episode transfer from the in-flight engine row (`pickDownloadingEpisodeLocal`, includes 0%).
   Lesson: **the UI reads one specific field; make sure state lands in that field.**

8. **Verifying from JSON, not pixels.** The owner repeatedly caught the assistant asserting UI
   state from API JSON instead of a screenshot. The whole `visual-suite.mjs` exists because of
   this. **Look at the page.**

9. **Downloads finish in seconds here.** The test swarm is fast; a download-state assertion can
   miss the window. Grab **fresh** episodes and poll rapidly, or seed a mid-progress state.

### PowerShell / environment gotchas
- Paths with `[workKey]` brackets break glob `Resolve-Path` — use `-LiteralPath`.
- CRLF breaks `.Replace()` with literal `\n` — prefer the `edit` tool over string surgery.
- No heredocs in pwsh. Multi-line commit messages: write a temp file and `git commit -F <file>`.
- The `bash` tool sometimes kills long foreground `npm run dev`; launch the server with
  `Start-Process … -WindowStyle Hidden` (see §8) or let the owner run it.

---

## 5. Testing doctrine — how to prove work is real

**Every claim needs one of these three proofs. No exceptions.**

### A. Unit / logic → red-prove it
1. Write the test.
2. Run it — PASS.
3. **Mutate the source** to break exactly the behavior under test (flip a condition, neutralize
   a helper). Run — the test must go **RED** with a message that names the behavior.
4. Restore the source. Run — PASS again.
5. Only now do you trust it.

Example of the discipline (from this session):
```
# prove the resolution fix:
mutate resolutionRank -> always 0   => "1080p pack wins" test FAILS  ✅ meaningful
restore                              => PASS
```

If mutating the code does NOT fail your test, your test asserts nothing — fix the test.

### B. API → hit the running server
Use Playwright's page context (cookies/session apply) or a direct fetch. Read the real body.
Storage cap is near-full in the dev DB — pass `overrideStorageCap:true` for manual grabs.

### C. UI → screenshot and look
Drive the page with Playwright (system Edge, `channel:"msedge"` — browser binaries are NOT
downloadable on this network). Assert on **measured DOM** (aria-labels, `disabled`, computed
overflow) AND save a PNG. There is no pixel-diff baseline; assertions are numeric/text.

### The sabotage gate
`node scripts/check-no-sabotage.mjs` must pass before you trust ANY green result. It fails if a
deliberate-sabotage marker was left in tracked source. Run it in your gate.

---

## 6. Visual verification harness (already built)

- **`scripts/visual-suite.mjs`** (NEW, wired into `test-all.mjs` as `visual-suite`):
  - **Part 1 — route sweep:** `/`, `/search`, `/watchlist`, `/downloads`, `/notifications`,
    `/settings`, `/title/rick-and-morty` at 1440×900 and 390×844. Asserts HTTP<400, zero
    console/page errors, no visible `[data-error-state]`, no horizontal overflow, `<main>`
    present. Screenshots to `qa-screens/visual/`.
  - **Part 2 — real download-state proof:** navigates to the title page, fires a real season
    grab via the API (`overrideStorageCap:true`, episodes `[4,5,6,7]`), polls up to ~30s, and
    asserts at least one `button[data-episode-action][data-action="download"]` aria-label
    contains "Downloading" AND is `disabled`. Screenshots `title-downloading.png`.
  - Exits 2 (with a clear message) if the server isn't up; never starts the server itself.

- Conventions to imitate for new visual scripts: `chromium.launch({channel:"msedge",
  headless:true})`; `BASE = BASE_URL ?? PLAYWRIGHT_BASE_URL ?? TF_BASE_URL ?? "http://127.0.0.1:3000"`;
  output under `qa-screens/<area>/` (gitignored); a `record(name, ok, detail)` helper +
  `process.exit(failures.length ? 1 : 0)`.

- Other existing shooters: `shoot-browse.mjs`, `shoot-watchlist.mjs`, `check-layout.mjs`,
  `qa-a11y.mjs`, `qa-error-states.mjs`. Study `shoot-browse.mjs` for the seed→shoot→cleanup
  pattern (scoped Prisma cleanup — never blanket-delete).

**DOM contract cheat-sheet** (title page):
- episode row: `[data-episode-row][data-episode="N"][data-availability="…"]`
- download control: `button[data-episode-action][data-action="download"]`,
  `aria-label` ∈ {`Download`, `Downloading NN.n%`, `Queued`, `Retry download`, play/ready},
  `disabled` when downloading/queued/held
- season grab: `[data-season-grab]`; season select: `[data-season-select]`
- error boundary: `[data-error-state]` (role="alert")
- detail root: `[data-title-detail]`; hero: `[data-title-hero]`

---

## 7. Autonomous operating manual (be a great micromanager)

You will run unattended for hours. Your job is to make **steady, verified, committed
progress** and never wander. Operate in tight loops.

### 7.1 The loop (repeat forever)
1. **Pick ONE item** from the backlog (§10) or the plan DB (`node scripts/plan.mjs next`).
   Smallest shippable slice. Never hold >1 in-flight.
2. **Write a TODO list** for it (use your todo tool). One `in_progress` at a time.
3. **Reproduce the current behavior** first — screenshot or API call — so you have a before.
4. **Implement** the smallest change.
5. **Prove it** (§5: red-prove tests, hit the API, screenshot the UI).
6. **Run the gate** (§8). Fix everything. Never commit red.
7. **Commit** one logical chunk with an honest message (`git commit -F` for multi-line).
   Push if the owner has pre-authorized (they have, historically — but re-confirm scope).
8. **Update** `docs/plan.db` / this file's state section.
9. **Loop.** If blocked, write the blocker down and move to the next independent item.

### 7.2 Delegating to sub-agents (parallelism without chaos)
- **Partition by non-overlapping files.** Two agents must never edit the same file. Assign
  file-sets explicitly in the prompt.
- **Write ULTRA-detailed prompts.** Include: exact file paths + line numbers, the exact
  before/after you expect, the DOM/data contract, constraints ("only edit these files"),
  the verification command to run, and "do NOT commit — report back."
- **Sub-agents report; you integrate.** Have them run typecheck / `node --check` and paste
  results, but YOU run the full gate and YOU commit. This keeps commits coherent and prevents
  two agents racing on git.
- **Good split example (used successfully this session):** one agent removed the loading text
  (`episode-list*.ts`), another wrote `visual-suite.mjs` + wiring, while the main agent did the
  planner rework (`season-plan.ts`). Zero overlap → zero conflict.
- **Use the `explore` agent** for read-only reconnaissance ("map the X subsystem, quote
  file:line") to save your own context. Use `general` for scoped edits.
- **Parallelize only independent work.** If B depends on A's output, do them in sequence.

### 7.3 Never let an agent run forever
- Give every delegated task a **crisp definition of done** and the **exact command that proves
  it** ("run `npx tsx X.test.ts`, paste the last line").
- Tell it **"if you cannot verify in N steps, stop and report what you found"** — no infinite
  digging.
- Prefer **read-only recon agents** (bounded) over open-ended "go fix everything" agents.
- **Time-box:** long browser/e2e suites have generous but finite timeouts; a step that hasn't
  produced output is a red flag — capture output to a file and inspect, don't wait blindly.
- After a sub-agent returns, **independently confirm** its claim (re-run its verification).
  Trust, but verify — sub-agents lie the same way you do.

### 7.4 Confirmation discipline (non-negotiable)
- Before "done": re-read your own diff (`git diff`), re-run the gate, re-screenshot.
- If you changed UI, a screenshot MUST exist and you MUST have looked at it.
- If you changed an API, a real request/response MUST be in your notes.
- If you changed logic, a red-prove MUST have happened.
- Prefer honest "partially done, here's what's unverified" over false "complete."

### 7.5 Filesystem & exploration
- You may browse the repo freely (Read/Glob/Grep). Use `explore` sub-agents for breadth.
- Scratch space: `C:\Users\fwachira\AppData\Local\Temp\opencode` (pre-approved). Put throwaway
  probe scripts there or in `scripts/tmp-*.mts` and **delete them after** (a stray `.mts` in
  `scripts/` breaks typecheck — see gotchas).
- Never blanket-delete DB rows for user `local`; scope every cleanup.

---

## 8. Environment & command cheat-sheet

```
OS: win32   Shell: pwsh   Repo: D:\code\torrent-aggregator   Branch: main
Node exe:   C:\nvm4w\nodejs\node.exe
Next bin:   node_modules\next\dist\bin\next
Dev URL:    http://127.0.0.1:3000   (pinned via -p 3000)
Scratch DB: %TEMP%\opencode\tf-scratch.db
Screens:    qa-screens\   (gitignored)
```

### Portable first-run setup

Use the Node 22 version in `.nvmrc` (22.23.2), then open a new terminal so PATH reflects
the active runtime. This also avoids stale WinGet command links. OpenCode is optional;
it is not a TorrentFlow runtime dependency.

```powershell
npm ci --registry=https://registry.npmjs.org
npm run setup
npm run doctor
# Owner only:
npm run dev
```

`npm ci` can generate Prisma without an `.env`: the CLI and runtime share the local
SQLite default. `setup` creates `.env` from `.env.example` only if absent, preserves
existing configuration, generates the client and applies committed migrations with
`migrate deploy`. It never resets a database or uses `db push` as an install shortcut.
Back up an existing database and its encryption key before upgrading.

The lockfile uses public registry tarballs. npm 12 additionally blocks dependency
install scripts by default, so `package.json` has explicit, version-pinned approvals
for the native/build packages the app needs. The unrelated `ip-set` package-manager
guard is explicitly denied. Do not replace this list with a wildcard approval or
disable remote-source restrictions. Review approvals when changing dependency versions.

Keep `next` and `eslint-config-next` on the same patched version. The `deepmerge-ts`
and `mysql2` overrides replace vulnerable versions pinned by Prisma 7; remove them
only when Prisma's own dependency tree resolves patched versions. After changing
these overrides, run the production audit, Prisma generation, fresh migrations and
`doctor`, not just TypeScript checks. The audit allowlist is separate: dependency
updates must not silently add or extend exceptions.

`doctor` checks Node, the built-in client's native module, runnable FFmpeg/FFprobe,
a real esbuild transform and
the migration ledger. It also runs before `npm run dev`, failing with an actionable
setup error rather than starting a server that later reports missing tables. For a
missing native module, reinstall under the pinned Node runtime and inspect download
or install-script errors; changing a version alone does not prove a binary is usable.

Agents never start, stop, restart or rebuild the owner's server. If port 3000 is
unavailable, finish isolated tests and explicitly leave live API/UI verification blocked.

Gates:
```
npm run typecheck                              # tsc --noEmit, must be 0 errors
npm run lint                                   # 0 errors (45 warnings currently tolerated)
node scripts/check-no-sabotage.mjs             # must PASS
npx tsx src/lib/torrents/season-plan.test.ts   # targeted unit
npx tsx "src/app/api/title/[workKey]/detail.test.ts"
node scripts/api-smoke.mjs http://127.0.0.1:3000   # all API routes (server must be up)
node scripts/visual-suite.mjs                  # visual + real-grab proof (server must be up)
node scripts/test-all.mjs                      # FULL gate: 236 offline units + e2e + Playwright (~20-30 min)
```
The full `test-all.mjs` auto-starts a dev server if `/` isn't reachable; do not run it
when the owner's server is absent. It writes
`ALL-SUMMARY.txt` / `.json` to `%TEMP%\tf-test-all-out`. Read the summary; don't trust the exit
code alone.

Commit (multi-line):
```powershell
"subject`n`nbody..." | Set-Content -LiteralPath "$env:TEMP\opencode\msg.txt" -NoNewline
git add -- <specific files>
git commit -F "$env:TEMP\opencode\msg.txt"
```

---

## 9. Sonarr research — what we learned & adopted

Sonarr's release comparison is **"Quality Trumps All"**, in this precedence:
`Quality → Custom-Format score → Protocol → Episode count → Episode number → Indexer priority
→ Seeders/peers → Age → Size`.

Key takeaways applied / to apply:
- **Sonarr does NOT prefer season packs by default** (opt-in via a custom format). TorrentFlow
  now uses exact episode releases for every season action.
- **Seeders are only the #7 tiebreaker** for Sonarr — it trusts indexers and grabs dead
  torrents. **Our `swarm-probe` verdict is genuinely better**; keep and lean on it.
- **Ideas worth stealing (not yet done):**
  1. **Aired-status guard** in `season-plan.ts`: only allow the last-resort pack when the
     season is *complete*; an airing season leaves gaps missing rather than pulling a whole
     pack. (High value, small.)
  2. **A single `scoreRelease()`** total-order function to replace scattered tiers
     (`ranking.ts` / `season-plan.ts` / `prerank.ts`) — kills tie-break bugs like the 4K one.
  3. **Surface the "why"**: we already compute `plan.reason`; show it in the season-grab toast/
     report so selection is inspectable.
  - **Skip for now:** cutoff/upgrade-until and delay profiles — big, and they clash with the
    "one press, it downloads" model.

---

## 10. Backlog / roadmap (prioritized)

**P0 — confirm current work** ✅ ALL DONE
- [x] Visually confirm the two "Loading season…" texts are gone (screenshot). ✅ Playwright snapshot clean
- [x] Run `scripts/visual-suite.mjs` live; fix what it catches; commit it. ✅ 84 PASS
- [x] Commit the singles-first planner (`season-plan.ts` + tests) as its own chunk. ✅ `eab92bd`
- [x] Commit the loading-text removal as its own chunk. ✅ `a451b39`
- [x] Run `api-smoke.mjs`; fix any route regressions. ✅ 79 PASS (fixed `defaultDownloadDir` → `2a49cf1`)
- [x] Run full `test-all.mjs`; read `ALL-SUMMARY.txt`. ✅ **28/28 ALL GREEN** (`9daf938`)

**P1 — Sonarr-inspired correctness** ✅ ALL DONE
- [x] Aired-status guard: no whole-season pack for a currently-airing season (§9.1). ✅ `e96b8a8`
- [x] Surface `plan.reason` in the season-grab report/toast (§9.3). ✅ `67adb5f`

**P2 — refactor** ✅ ALL DONE
- [x] Single `scoreRelease()` total-order; migrate `comparePacks`/`bestSingleFor` to it (§9.2). ✅ `1bffdfe`

**P3 — verification infrastructure**
- [ ] Extend `visual-suite.mjs` with per-state seeding (queued / 30% / ready / pack in-flight)
      so download-state proof isn't reliant on live-download timing.
- [ ] Add a downloads-page + watchlist visual assertion (media-first: no WEB-DL/peers/paths).

**Known-not-done / flagged**
- Autopilot (`.opencode/plugins/autopilot.ts`, `scripts/autopilot.mjs`) never fired — treat as
  broken; do not depend on it.
- `test-all.mjs` is slow and has been skipped repeatedly under time pressure — that is exactly
  how regressions slip in. Budget for it.

---

## 11. Definition of done (per change)
A change is DONE only when ALL are true:
- [ ] `npm run typecheck` = 0 errors
- [ ] `npm run lint` = 0 errors
- [ ] Relevant unit tests PASS **and were red-proven**
- [ ] `check-no-sabotage.mjs` PASS
- [ ] If UI: a screenshot exists and you looked at it
- [ ] If API: a real request/response is recorded
- [ ] Committed as one logical chunk with an honest message
- [ ] State section of this doc / plan DB updated

If any box is unchecked, it is **not done** — say so.

---

## 12. Autonomy, your team, and the critique mandate

### 12.1 You are not bound to our playbook — improve on it
Everything above is a strong default, not a cage. **Feel free to deviate** when you have a
better idea, but deviate *deliberately*: write down what you're changing and why, and hold the
new approach to the same proof bar (§5). If your way is better, update this guide so the next
run inherits it.

**Research before you invent.** For anything non-trivial, go read how the best have already
solved it:
- **GitHub first** — read real source: Sonarr/Radarr/Prowlarr (`Servarr` org) for
  acquisition/quality/scoring, qBittorrent/WebTorrent for engine behavior, Jellyfin/Plex/Overseerr
  for media-first UX, shadcn/ui + Radix + Vercel's own apps for component patterns.
- **Known platforms for inspiration** — Netflix, Disney+, Apple TV, Letterboxd, Trakt for the
  "page about a title" shape; Linear/Vercel/Stripe dashboards for calm, dense, media-first UI.
- Use `webfetch` for docs and the `explore`/`general` sub-agents to digest large sources so you
  don't burn your own context. **Cite what you borrowed** in the commit/PR so decisions are
  traceable. Never copy code you don't understand or can't test.

### 12.2 Wear three hats, on purpose
- **PM** — protect the product thesis (§1). Ruthlessly prioritize. Kill scope that doesn't move
  the media-first experience. Every change should map to a user-visible improvement or a proof
  that one works.
- **Engineer** — smallest correct change, proven three ways (§5), committed in clean logical
  chunks.
- **Sensitive manager** — of yourself and your sub-agents. Sensitive means *attentive*: notice
  when a task is thrashing, when an agent is stalling, when a "fix" is really a hack. Cut losses
  early, re-scope, and never let ego (or a sunk-cost diff) keep a bad approach alive. Be kind but
  exacting: the standard is the standard.

### 12.3 Your team = models, classified by job
Treat sub-agents as a team and **assign by task type**, not at random. Always label the kind of
work in the prompt so the right capability is used:
- **visual** — rendering, screenshots, layout/UX judgment, "does this look right?" Give it the
  DOM contract (§6) and make it *look at the pixels*.
- **research** — read GitHub/docs/platforms, summarize with citations, propose options. Read-only,
  bounded, report-back.
- **implementation** — scoped edits to an explicit, non-overlapping file-set. Reports; you
  integrate and commit.
- **verification/QA** — run the gate, red-prove tests, hit APIs, and independently re-confirm
  another agent's claim.
- **critique** — see §12.4; a dedicated reviewer pass, separate from the author.

Pick the model that fits the job (a stronger model for gnarly logic or UX taste; a fast one for
mechanical edits). State the classification in the task prompt every time so the routing is
explicit and auditable. Same anti-stale rules apply to all of them (§7.3): crisp done, stop-and-
report limits, time-boxing, and you re-verify.

### 12.4 Critique code heavily — the review bar
Before committing (and when reviewing any sub-agent's work), run a hard critique pass. Reject or
rework anything that fails on:
- **Necessity** — is this code needed at all? Delete dead paths, speculative flags, and
  "just-in-case" abstractions. The best diff is often a smaller one. Prefer removing code.
- **Clarity** — would a new reader understand *why* in 30 seconds? Names say intent; comments
  explain the *why*, not the *what*. If it needs a paragraph to defend, it's probably too clever.
- **Creativity** — is there a simpler, more elegant, or more delightful solution (in logic *or*
  UX)? Don't settle for the first thing that compiles.
- **DRY** — is this the third copy of a rule? Two judges of "which release" that can drift apart
  is a bug generator — unify them (this is exactly why a single `scoreRelease()` is on the
  roadmap, §9.2). But don't over-DRY: a wrong abstraction is worse than two honest duplicates.
- **Proof** — does a red-proven test or a screenshot back every behavioral claim? No proof, no
  merge.

Make the critique a *separate* step from writing (ideally a separate `critique`-classified
agent, or at minimum a fresh read of your own `git diff` with these five lenses). Author and
reviewer being the same tired context is how weak code ships.
## TorrentFlow user-journey critic/orchestrator

Invoke `.github/agents/torrentflow-user-journey-critic.agent.md` for read-only current-product evaluation, strict phase-plan judgment, design proposals (including explicitly authorized Figma proposal work), or post-implementation evaluation. It launches only read-only critic/research fleets, never changes application code or user data, and never dispatches implementation or fixes; it stops at evidence, verdicts, design artifacts, recommendations, acceptance criteria, and specifications.
