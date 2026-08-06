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
- **Singles-first for season downloads** (NEW, see §3/§4). A season pack is a last resort,
  never preferred over per-episode releases that exist. This matches how Sonarr actually
  behaves by default (see §9).

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

### The title API (server truth)
- `src/app/api/title/[workKey]/detail.ts` — `buildTitleDetail`, `buildEpisodes`,
  `buildPackCoverage`, `inFlightPackTransfer`, `pickLocal`/`pickUnpackedEpisodeLocal`/
  `pickDownloadingEpisodeLocal`, `isDownloadingLocal`/`isInFlightLocal`, `LocalRelease`,
  `pickSeason` (honors requested season even with no local files).
- `src/app/api/title/[workKey]/grab.ts` — `grabForTitle`, `grabSeasonForTitle` (returns
  `ok:false` + 409 when nothing sent; surfaces storage refusal).
- `src/app/api/title/[workKey]/route.ts` — POST handler; writes `AcquisitionTarget`;
  `overrideStorageCap` plumbing.
- `src/app/api/title/tmdb-extras.ts` — TMDB facts, `memo` with `TTL_MS` (6h) /
  `NEG_TTL_MS` (2min negative cache).

### Season acquisition (the planner)
- `src/lib/torrents/season-plan.ts` — **pure** planner. `planSeason` (singles-first now),
  `comparePacks`, `resolutionRank`, `demotedTier`, `classify`, `packEpisodeRange`,
  `episodesFromFilenames`. **All acquisition strategy lives here, tested without a swarm.**
- `src/lib/library/season-acquire.ts` — orchestration over the pure planner.
  `resolveSeasonPlan`, `acquireSeason`, `seasonSearchQuery`, `seasonSearchQueries`
  (multi-query ladder), `searchSeasonReleases` (with per-episode gap-fill), storage-gate
  wiring + `overrideStorageCap`.
- `src/lib/library/ondemand.ts` — `grabSingleEpisode` (the correct single-episode path;
  season path reuses its shape).
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

### Committed & pushed (through `2a49cf1`)
- `2a49cf1` fix: settings/client returns a sensible default download path for first-run
- `fd33332` add visual-suite: route sweep + download-state proof with cleanup
- `a451b39` remove visible loading text from episode strip
- `eab92bd` singles-first planner: pack only fills gaps singles can't cover
- `608bde8` season-grabbed episodes show a downloading state
- `3b465d9` honour the picked resolution in pack and single selection
- `ee25bf8` find airing-season releases (multi-query search) + cap override for season grabs
- …plus the earlier title-page redesign and downloads-page cleanup.

### Uncommitted working tree
Clean — all changes committed.

### Confirmed green (last full gate run)
- `npm run typecheck` → 0 errors
- `npm run lint` → 0 errors (45 pre-existing warnings, tolerated)
- `season-plan.test.ts` → PASS (red-proven for singles-first change)
- `season-acquire.test.ts` → PASS
- `detail.test.ts` → PASS
- `defaults.test.ts` → PASS (red-proven for defaultDownloadDir change)
- `check-no-sabotage.mjs` → PASS
- `visual-suite.mjs` → **84 PASS** (14 routes × 6 assertions + download-state proof + cleanup)
- `api-smoke.mjs` → **79 PASS** (0 failures)

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
- `test-all.mjs` full suite (168 units + e2e + Playwright, ~20–30 min) not yet run this cycle.
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

6. **"It grabbed a garbage pack."** The planner *preferred* packs and would take a `weak` one as
   last resort even when singles existed. Now **singles-first**. (This is the current
   uncommitted change.)

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

Start the dev server yourself without the bash tool killing it:
```powershell
Start-Process -FilePath "C:\nvm4w\nodejs\node.exe" `
  -ArgumentList @("node_modules\next\dist\bin\next","dev","-H","127.0.0.1","-p","3000") `
  -WorkingDirectory "D:\code\torrent-aggregator" -WindowStyle Hidden
# then poll: Invoke-WebRequest http://127.0.0.1:3000/ -UseBasicParsing -TimeoutSec 5
```

Gates:
```
npm run typecheck                              # tsc --noEmit, must be 0 errors
npm run lint                                   # 0 errors (45 warnings currently tolerated)
node scripts/check-no-sabotage.mjs             # must PASS
npx tsx src/lib/torrents/season-plan.test.ts   # targeted unit
npx tsx src/lib/library/season-acquire.test.ts
npx tsx "src/app/api/title/[workKey]/detail.test.ts"
node scripts/api-smoke.mjs http://127.0.0.1:3000   # all API routes (server must be up)
node scripts/visual-suite.mjs                  # visual + real-grab proof (server must be up)
node scripts/test-all.mjs                      # FULL gate: 168 units + e2e + Playwright (~20-30 min)
```
The full `test-all.mjs` auto-starts a dev server if `/` isn't reachable and writes
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
- **Sonarr does NOT prefer season packs by default** (opt-in via a custom format), and **won't
  grab a pack for a partially-aired season** — it fills airing seasons episode-by-episode. →
  validates our **singles-first** change. ✅ (done, committed `eab92bd`)
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
- [ ] Run full `test-all.mjs`; read `ALL-SUMMARY.txt`. ← still needed (~20-30 min)

**P1 — Sonarr-inspired correctness**
- [ ] Aired-status guard: no whole-season pack for a currently-airing season (§9.1).
- [ ] Surface `plan.reason` in the season-grab report/toast (§9.3).

**P2 — refactor**
- [ ] Single `scoreRelease()` total-order; migrate `comparePacks`/`bestSingleFor` to it (§9.2).

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
