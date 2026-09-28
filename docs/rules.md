# Owner rules

Standing rules from the owner. Every agent reads this before starting work. When the owner complains or sets a new rule, add it here and add the follow-up work to [todo-list.md](todo-list.md).

## Product and UI

- One UI for everyone. Roles only hide actions and pages; they never get their own shell, search or components. A requester sees "Request" where the owner sees "Download".
- Keep the existing design system (tokens in the web CSS vars, `components/ui`, `components/tf`). Don't invent new looks or recolour controls that were fine.
- Contrast: text and icons must meet WCAG AA (4.5:1 for text, 3:1 for icons and large text) in every state. Don't put a glyph in the primary colour on a primary fill.
- Mobile: check at an `innerWidth` of 390 (Windows DPI 1.25 means about a 488px viewport). Touch targets are 44px or more, text is 12px or more, and nothing sits under the bottom nav. Check 1280 too, for desktop regressions.
- Copy is written from the user's side: plain verbs, sentence case, and one name per action through the whole flow. Errors say what happened and how to fix it.
- Owner-only tools, such as "View as requester", are never shown to requesters and grant nothing on the server.

## Verification

- See what you built. Run the app and check it with Playwright MCP: owner view, requester view (use the remote-access simulator) and mobile. Unit tests alone don't count.
- Test every feature end to end the way a real person uses it before calling it done. For requests, that means a requester searches, requests, and the owner approves (by hand and with auto-approve). Then check exactly what lands in Downloads: how many rows, releases and GB, and that a repeat request doesn't duplicate anything.
- Fix the whole class of a problem, not only the example the owner gave.
- Tests must be exhaustive. For every flow, cover the happy path, every error path and edge cases: empty, long and unicode titles, duplicates, double submits, expired state, restarts mid-flow, concurrency, both roles and both widths. Use at least three titles per content type (movie, western series, long-running anime, anime with sequel seasons). Report a coverage table marking each case pass, fail or blocked.
- A dedicated QA agent verifies after implementation. Findings are logged as bugs.

## Engineering

- CI runs only by hand for now (owner request); validate locally before pushing.
- Reuse existing services and components. No duplicate logic, such as a second ranking or a second provider list.
- New server endpoints are owner-only by default. Requesters get read-only data with magnets, paths and engine state stripped.
- Settings changes take effect immediately. For example, lowering the download cap re-queues running downloads.
- Stage specific files only. No force push. Confirm before deleting branches.
- Ports 3921–3940 only; never use 3000. Never touch `%LOCALAPPDATA%\TorrentFlow` or `C:\Torrents`.
- Docs live in `docs/`.

## Agents and models

- UI work goes to Claude Opus 5.5 (medium effort), following the frontend-design skill, and it may start sub-agents. Never use GPT-6 Astra for UI, and never use Claude Opus 5 or Sonnet 5.
- Keep long-running agents in check. The orchestrator checks every running agent against its timebox. At the timebox it asks for status and a push of the finished slices. At 1.5× the timebox it forces a push, and it splits or reassigns whatever is left. No agent runs past its timebox without the owner hearing about it.
- All code must be type-checked: TypeScript (strict) for JS-land code, no plain `.js`/`.mjs` source files.
- No UI change ships without a real visual check at 390 and 1280. If the browser tool is down, stop UI work and tell the owner; don't push "verified by unit tests" UI.
- One pipeline per action. A season, series or request grab is just the title-page episode download run for each episode (with bounded concurrency). Never a separate search or ranking path.
- The owner's screenshots come from their main machine over remote desktop, not the agent machine. Don't assume a local instance or build matches what they see; reproduce on a fresh instance built from `main`.
- Investigation-only agents stop the moment their report is in. Don't send them follow-up work meant for other agents; stop them explicitly if they keep going.
- Small or mechanical tasks go to grok-4.5. Keep time boxes short and costs low.
- Break work into dev-spec style tasks, one agent per task. Implementers write code and targeted tests only.
- Questions and complaints get a text answer. Only run work on an explicit instruction.
