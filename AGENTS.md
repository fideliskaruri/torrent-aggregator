# Agent instructions (TorrentFlow)

## MANDATORY SKILLS — load these, do not improvise around them

These are installed at user scope (`~/.copilot/skills/`). They are **not optional suggestions**.
Invoke the skill via the `skill` tool *before* doing the work it covers, not after.

| Trigger — the moment this happens | Skill to invoke FIRST | Why it exists here |
|---|---|---|
| User posts a screenshot / says "this looks wrong", "this isn't out yet", "wrong torrents" | `bug-reproduction-brief` | Stop jumping straight to a patch. Prove the smallest failing case with evidence, THEN fix. Prevents fixing the symptom in the screenshot while the rule class stays broken. |
| Building, restyling, or restructuring any screen or component | `anti-ui-slop` | Run its finish gate before declaring UI done. No generic cards, no inert controls, no missing states. |
| Claiming any UI behaviour works | `webapp-testing` | Verify in a real browser against the running app. A passing unit test is not evidence the screen behaves. |
| Needing before/after or "show me the state" visuals | `ui-screenshots` | Consistent capture + crop-iterate; do not hand-roll a new Playwright script each time. |
| Auditing a page for layout/responsive/a11y/consistency defects | `web-design-reviewer` | Find the defects *before* the user does, at every breakpoint. |

**Hard rules that follow from the above**

1. **Never fix a user-reported UI bug from the screenshot alone.** Reproduce it against the running
   app first, in the browser, and say what the minimal failing case is.
2. **Never report a UI fix as done on unit tests alone.** Unit tests prove the rule; a screenshot or
   a live DOM assertion proves the product. Provide both.
3. **Never leave the user to find the next defect.** After a fix, sweep the same surface with
   `web-design-reviewer` at desktop and mobile widths and report what else is wrong.
4. **Verify against the build the user is actually running.** Check `BUILD_ID` and the port before
   claiming anything is live; a fix in `.next-gate` is not a fix the user can see.

## Operating mode
- **Do not stop after a “slice.”** Finish the full objective, run tests, fix failures, continue until green.
- **Main orchestrator must spawn subagents** for implementation, exploration, and verification. Prefer not to hand-edit large code paths in the parent turn.
- User goal: **one app install** (builtin BitTorrent default); **optional** qBittorrent/Transmission if they connect their own.
- Always **test** with meaningful assertions (call real APIs when relevant). Not tests that only exist to go green.
- Do not leave Explorer windows open from tests (`reveal: false`).

## CRITICAL: Generalize from examples — never example-patch

When the user gives an **example**, extract the **rule class**, not a hardcode for that string.

| User said (example) | Wrong response | Right response |
|---------------------|----------------|----------------|
| “One Piece EP1233 S23 → One Piece/Season 23” | Special-case One Piece + ep 1233 | **Any** series: stable show folder + season folder when season is known |
| “Photoshop shouldn’t be Movies” | Only block Photoshop | **Software/apps signals** beat movie/year heuristics for all apps |
| “Mobile spacing is shit” | Fix one card padding | **8pt grid + touch targets + no space-between voids** across list UI |
| “502 on client torrents” | Silence one status code | **Offline/unreachable client** model for all engines |

**Definition of done for a bug class:** property holds for **diverse inputs** (many shows, many title formats, many sources), not just the sample titles in the complaint.

**Tests must encode the rule class:**
- Parametric / table-driven cases (Family Guy, Simpsons, Breaking Bad, anime with Sxx, site-prefix junk, season packs, multi-season packs)
- Optional live `/api/search` checks that organization invariants hold across results
- Never “assert true” or only the one example that failed in a screenshot

## Product truth
- Default engine: `builtin` (WebTorrent in-process).
- External clients: optional advanced path.
- **Package path (one flow, no duplicates):**
  1. **Library** (`/watchlist`) — what you want (monitor)
  2. **Run automation** — hunt (from Library only)
  3. **Activity** — what ran (grabs + savePath)
  4. **Client** — live transfers only
  5. **Download log** (`/history`) — thin past-sends, not a nav peer of Activity
- Smart paths (general rules):
  1. **Category** from content kind (anime/tv/movies/software/…)
  2. **Show/movie folder** stable identity (metadata or cleaned title; strip site/release junk; never per-episode folder names)
  3. **Season folder** when a season number is known (`Season NN`) for TV *and* anime; absolute-ep-only releases share show root until season is known
  4. **Multi-season packs** → show root (do not invent a single season)
  5. **Client layout:** qBit `contentLayout=NoSubfolder` so files land *in* Show/Season NN, not an extra release-name subfolder
  6. **Software/games/music/books** domain signals beat weak movie heuristics
- Offline external client: clear 503 + UX, not silent 502 spam.
