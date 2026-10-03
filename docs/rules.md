# Owner rules

Standing rules from the owner. Every agent reads this before starting work. When the owner complains or sets a new rule, add it here and add the follow-up work to [todo-list.md](todo-list.md).

## Product and UI

- One UI for everyone. Roles only hide actions and pages; they never get their own shell, search or components. A requester sees "Request" where the owner sees "Download".
- No in-app playback or streaming. A finished download opens in the owner's own player, or in the file manager with the file selected ([api-open-file.md](api-open-file.md)). TorrentFlow checks downloads itself and never needs ffmpeg or ffprobe.
- Keep the existing design system (tokens in the web CSS vars, `components/ui`, `components/tf`). Don't invent new looks or recolour controls that were fine.
- Contrast: text and icons must meet WCAG AA (4.5:1 for text, 3:1 for icons and large text) in every state. Don't put a glyph in the primary colour on a primary fill.
- Mobile: check at an `innerWidth` of 390 (Windows DPI 1.25 means about a 488px viewport). Touch targets are 44px or more, text is 12px or more, and nothing sits under the bottom nav. Check 1280 too, for desktop regressions.
- Copy is written from the user's side: plain verbs, sentence case, and one name per action through the whole flow. Errors say what happened and how to fix it.
- Filters stay quiet: one level reads as tabs, the level under it as light text filters. Never stack rows of identical bordered pills, and never show a raw scrollbar under a chip row.
- Owner-only tools, such as "View as requester", are never shown to requesters and grant nothing on the server.

## Verification

- See what you built. Run the app and check it with Playwright MCP: owner view, requester view (use the remote-access simulator) and mobile. Unit tests alone don't count.
- Test every feature end to end the way a real person uses it before calling it done. For requests, that means a requester searches, requests, and the owner approves (by hand and with auto-approve). Then check exactly what lands in Downloads: how many rows, releases and GB, and that a repeat request doesn't duplicate anything.
- Fix the whole class of a problem, not only the example the owner gave.
- Tests must be exhaustive. For every flow, cover the happy path, every error path and edge cases: empty, long and unicode titles, duplicates, double submits, expired state, restarts mid-flow, concurrency, both roles and both widths. Use at least three titles per content type (movie, western series, long-running anime, anime with sequel seasons). Report a coverage table marking each case pass, fail or blocked.
- A dedicated QA agent verifies after implementation. Findings are logged as bugs.
- Whenever work lands on main, restart the owner's test instance (port 3930, data `D:\code\memtest\stable\data`) on the new main build right away, so the owner can see and test the changes. Ship each finished lane on its own; don't hold it back for slower lanes.

## Engineering

- CI runs only by hand for now (owner request); validate locally before pushing.
- Reuse existing services and components. No duplicate logic, such as a second ranking or a second provider list.
- **No app-level rate limits for the owner.** TorrentFlow is the owner plus a couple of trusted friends. Do not add process-wide per-minute search or request budgets that stall real work (for example a second season download). Bound concurrency with queues instead. Per-site cool-down is allowed only on a real HTTP 429 (or 503 with Retry-After) from that site. The title-search/suggest box may keep a per-client keystroke guard.
- **Bound Find fanout per scope (2026-10-03).** Broad queries and parser filtering, not a query per episode or translated synonym. Default physical source HTTP caps: owner 12, background 6, configurable. Later source/name tiers run only without an eligible earlier result; at most two synonyms. Diagnostic dev Find may stop provisionally on a structural match with trusted seeds >= 1; this is not Check/Plan approval. Cache partial/truncated answers for 30 minutes; actual failures/timeouts may retry once per window in the shared background lane, not on every read.
- New server endpoints are owner-only by default. Requesters get read-only data with magnets, paths and engine state stripped.
- Settings changes take effect immediately. For example, lowering the download cap re-queues running downloads.
- Stage specific files only. No force push. Confirm before deleting branches.
- Ports 3921–3940 only; never use 3000. Never touch `%LOCALAPPDATA%\TorrentFlow` or `C:\Torrents`.
- Docs live in `docs/`.

## Agents and models

- UI work goes to Claude Opus 5.5 (medium effort), following the frontend-design skill, and it may start sub-agents. Never use GPT-6 Astra for UI, and never use Claude Opus 5 or Sonnet 5.
- Keep long-running agents in check. The orchestrator checks every running agent against its timebox. At the timebox it asks for status and a push of the finished slices. At 1.5× the timebox it forces a push, and it splits or reassigns whatever is left. No agent runs past its timebox without the owner hearing about it.
- Test server behaviour (search, grabs, requests) by calling the HTTP API and inspecting the JSON. Use a browser only when the thing under test is the UI itself. The Playwright MCP browser is shared between agents, so keep sessions short and use headless scripts for bulk screenshots.
- Errors shown to the user must say why it failed and what to do. The system auto-resolves transient failures (retry, back off, queue) before surfacing anything. No internal jargon in user-facing copy.
- Season-download failures aggregate the actual per-episode causes and next steps. No em dash or internal wording such as "acquisition path". Recovery toasts keep a Retry action visible; it retries only missing episodes and preserves the selected quality.
- Styling is Tailwind CSS with shadcn/ui components, always. No plain CSS beyond the Tailwind entry file (new projects; existing apps migrate when touched with owner approval).
- All code must be type-checked: TypeScript (strict) for JS-land code, no plain `.js`/`.mjs` source files.
- No UI change ships without a real visual check at 390 and 1280. If the browser tool is down, stop UI work and tell the owner; don't push UI verified only by deleted unit tests; use Playwright MCP.
- One pipeline per action. A season, series or request grab runs the same release finder as the title page's episode download, for each episode (with bounded concurrency); for a finished season that finder also pools season packs (see Season packs). Never a separate search or ranking path.
- The owner's screenshots come from their main machine over remote desktop, not the agent machine. Don't assume a local instance or build matches what they see; reproduce on a fresh instance built from `main`.
- Investigation-only agents stop the moment their report is in. Don't send them follow-up work meant for other agents; stop them explicitly if they keep going.
- Small or mechanical tasks go to grok-4.5. Keep time boxes short and costs low.
- Break work into dev-spec style tasks, one agent per task. Implementers write code and targeted tests only.
- Questions and complaints get a text answer. Only run work on an explicit instruction.

- DRY, built from atoms up. Before writing any search, grab, identity, key or formatting helper, find the existing one and reuse or extend it. One implementation per concept (for example one work-key function, one release picker, one send path); features compose those atoms and never re-implement them. A second copy is a bug. Reviews check for duplicates, not just behaviour.
- The same goes for UI: one component per pattern (poster, card, chip, transfer row, progress, confirm dialog, page loading/empty/error, formatter). If the same thing renders differently on two pages, that is a bug. The server resolves a work's poster and display data in one place for every endpoint. (2026-10-01, after posters worked on some pages and not others)
- Download season is fire and forget. The owner presses Download season on each season in turn and walks away. It must never fail on the spot: accept instantly, run the one release finder for every episode (batched, no separate season logic; for a finished season the finder also weighs season packs, see below), keep retrying in the background for anything not found yet, and only surface a problem later if it truly needs the owner, with one plain action to fix it. No errors at click time. (2026-09-30; pack wording updated 2026-10-03)
- Season packs (2026-10-03, replaces the 2026-09-30 last-resort rule after Little Fires Everywhere would not download episode by episode): for a finished season (every episode aired), season packs and single-episode releases are searched together and the healthiest release wins, live seeders first, then quality. A healthy pack beats weak or dead single episodes. When some episodes of the season are already on disk, a pack is taken with only the missing episodes' files selected. The pack's file list is always verified before download and only the needed files download. A season still airing stays episode by episode. Record per-episode and per-pack reasons so picks can be judged from evidence. Plan and critic before code.
- Result messages give counts only. After a batch action (Download season, series, request) tell the owner how many succeeded and how many failed, nothing else. Never explain internals ("same acquisition path", pipelines, sources). (2026-09-30)
- The concurrent-downloads setting applies instantly in both directions. Lowering it (10 to 4) pauses the extra running downloads back to Queued right away; raising it starts queued ones right away. Only the owner pressing Download now on a torrent overrides the cap. (2026-09-30)
- Status is visible where the owner looks. If an episode is queued, searching or waiting, its episode card says so (for example "Queued #19"), not only the Downloads page. (2026-09-30)
- Never fill a control in the brand amber behind a glyph. Episode card pills stay neutral and frosted in every state (download, queued, downloading, done, retry). (2026-09-30)
- **No workarounds.** When something is broken, don't hand the owner a workaround. Research the cause and brainstorm a proper fix with him (owner, 30 Sep: 'no workarounds please, we can research and brainstorm around this').
- **'Debug, plan, critic' means carry on into the fix.** When the owner hands over bugs with debug -> plan -> critic, go straight into implementation after the critic using the recommended defaults; don't stop and wait for a separate go (owner, 1 Oct: 'i had also given you bugs and told you to fix them. what happened?').

- **Rethink, not patch (2026-10-03).** Discovery got slower and picks got less healthy than the old Next.js build, while each lane added machinery (gates, journals, retry files, reconcilers). Keep what works (release swap, concurrent-download cap, the new UI); redesign how search, pick, download and file fit together before adding features. Measure against the old build: time to first result and seeders of the chosen release.
- **Agents for the rebuild favour speed (owner, 2026-10-03, replaces 'no agents for the rethink').** Model choice matters less than the process: the best models gave poor results under a poor process. Implementation agents use GPT-6.1 Sol at low or medium effort (owner: relatively cheap), one phase at a time, each within its module contract. The coordinator reviews every phase against the design, the module contracts and the benchmark before the next phase starts.
- **One download folder (2026-10-03).** Downloads go straight into their one final folder, as before. No staging folder and no move after completion. The rethink's File step only names and places within that folder.

## Rebuild rules (2026-10-03, from the regression review)
- **Fix the design, not the symptom.** Before adding a gate, ladder, journal, retry file or background service, show the flow is right; a new mechanism needs a reason the existing flow cannot cover.
- **One source of truth per fact.** A download's state lives in one place; everything else reads it. No copied progress, no side JSON files.
- **Few background services.** Each one has a single job that no other service does; adding one needs a reason.
- **Measure every addition.** A new source, step or check ships only if the benchmark shows it helps (speed, seed health, correct picks).
- **Port by behaviour, not by file.** When moving code, list what the old one did that worked and confirm the new one still does it.
- **Test the real world.** Upgrade and end-to-end checks run on a copy of the owner's real data, downloads included, not a sanitized one.
- **Done means it works for the owner.** A series actually downloads and lands in the library; builds, tests and reviews passing are not done.
- **Benchmark gates.** The fixed test list runs before and after every phase; results are shown to the owner.
- **Regression run after every merge,** on the real setup, before the next merge.
- **One change at a time on shared code.** No parallel lanes touching the same subsystem.
- **Review the whole design, not just the diff.** Each phase gets a system-level critique.
- **Stop when the owner's real task fails.** Pause and fix that before anything else.
- **Report plainly.** Say "stalled at 0%" when it is; never round a failure up.
- **Fix the class, not the example.** A reported bug is one instance; find and fix every case of it.
- **The swarm check is essential (owner, 2026-10-03).** No release is chosen on advertised seeders alone. Before anything is added, the top candidates are probed against the real swarm (connected peers, delivered bytes, file list) and given a verdict: good, weak, dead or unknown (unknown is not dead), cached about 6 h. It is the core of the release finder, built in the first build phase, and measured on the benchmark. The Next.js swarm-probe.ts (5824ed5~1) is the reference.

- **Whole backend rebuild (owner, 2026-10-03).** The rebuild covers the whole server, not just the download core. The web app and its API contract stay; the server behind it is rebuilt to the rethink design, porting by behaviour.
- **Unknown language is not checked for now (owner, 2026-10-03).** A release whose language can't be determined is treated as acceptable: no probe, no wait, no "English not confirmed" state. Only releases that clearly say they are foreign (for example RUS, LostFilm, VOSTFR, raws) are refused. Revisit after the rebuild.
- **Separation of concerns (owner, 2026-10-03).** Each module has one job and talks to the others only through a small interface: Metadata (what exists), Sources (raw search results), Parser (release name to numbers), Find (queries and pooling), Check (swarm probe), Plan (choosing), Engine (bytes), Library (files and names), Targets (state), API (HTTP only, no logic). No module reaches into another's data or repeats its work. Pure logic (parser, ranking, plan) has no I/O.

- **One kind of owned (owner, 2026-10-03).** Imported and downloaded media are the same to the user. Search results, title pages and episode rows show "In your library" and the quality for anything on disk, however it got there. Never show or ask about origin.

- **English name first (owner, 2026-10-03).** Search every title by its English name. Only when no good release is found, search the original-language (or romaji) name.

- **Up to five quick agents at a time (owner, 2026-10-03, replaces the two-agent cap).** Run up to five agents at once plus the coordinator. They use fast models at low effort, and each works on its own module so no two agents edit the same files.

- **Speed (owner, 2026-10-03: 'this has been going for too long!').** Agents run 30 min max; the coordinator stops and rescopes any agent past that. Proof runs cover only what the change touches (no full hard-set reruns except at phase gates). Gate-blocking fixes go before new phases.

- **No patches (owner, 2026-10-03: 'make sure you're doing things that make sense and not patching shit').** Every fix goes to the root cause, in the module that owns it. No copies of a fact to paper over a missing read (example: owned titles show in the Library because the Library read derives from MediaFile, not by writing watchlist rows). No workaround that only makes a symptom disappear. Proof-only shortcuts stay in proof tools and never ship. The coordinator rejects patch-style fixes in review.

- **Think it through before code, not after (owner, 2026-10-04: ''how are you having bugs right now? it means you''re not thinking through the problem and disecting it to the core'').** Bugs found late mean the problem wasn't dissected up front. Before any code for a journey, the coordinator writes its full state table: every state an item can be in (missing, wanted, downloading, owned at each quality, upgrade offered, upgrade queued, upgrading, best available) and, for each, exactly what every surface shows (search card, title page, season header, episode row, library card, downloads) and which actions exist. Every rule in the plan (for example "owned never shows Download") is checked against every surface in that table. Agents get a whole journey and its table, never a single symptom, and the review checks the whole table, not just the reported issue.

## Restored from old main working copy (2026-10-04)
- One pipeline per action. A season, series or request grab is just the title-page episode download run for each episode (with bounded concurrency). Never a separate search or ranking path.
- No app-level rate limits for the owner. TorrentFlow is a home-lab app for the owner and a few friends who only request. Don't cap the owner's searches or downloads per minute; if load needs smoothing, queue work (bounded concurrency, back off on a real 429 from a site) instead of refusing or stalling it.
- Download season is fire and forget. The owner presses Download season on each season in turn and walks away. It must never fail on the spot: accept instantly, run the same single-episode pipeline for every episode (batched, no separate season logic), keep retrying in the background for anything not found yet, and only surface a problem later if it truly needs the owner, with one plain action to fix it. No errors at click time. (2026-09-30)
- No season packs as a first choice. Episodes are acquired one release per episode; packs are only a last-resort fallback under the rule below. Record per-episode miss reasons so pack use can be judged from evidence. (2026-09-30)
- Season packs (updated 2026-09-30 20:16): allowed ONLY as a last-resort fallback after the single-episode pipeline has really missed an episode (refused searches don't count), only for fully aired seasons, only for the episodes still missing, with the file list verified before download and only the needed files downloaded. Plan and critic before code.
