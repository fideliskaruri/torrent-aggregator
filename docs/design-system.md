# TorrentFlow — Design System & UI Definition of Done

> **Why this file exists:** so the owner never has to describe every little UI detail again.
> Any agent (or person) building/changing UI in this repo MUST read this and apply it.
> When a request is vague ("make a card", "sweep the pages", "fix the mobile view"),
> resolve the ambiguity using the principles + checklist below — do not invent a new look.

---

## 1. Design principles (how to resolve ambiguity)

1. **Media-first.** Posters/thumbnails and the title are the hero. Chrome is quiet; content is loud.
2. **One primary action per surface.** Exactly one amber/primary button per card or section (usually **Play**). Everything else is secondary/ghost or lives behind a `⋯` menu.
3. **Never a dead end — always a next step.** Every empty/error/blocked state offers an action (retry, back to browse, download, adjust filter). No bare "nothing here".
4. **Honest progress, never fake spinners.** A loader must say what it's doing when it can (e.g. "Finding peers…" → "Buffering…"). No infinite copy-free spinner on a wait > ~2s.
5. **No layout shift / no flash.** Background refresh (5s polls) must NOT blink content to skeletons. Skeletons only when there is genuinely nothing yet; once real rows exist, keep them.
6. **Flat tool UI.** Solid surfaces only. No decorative gradients on page chrome (see globals.css header). Elevation via `--bg-elevated` + subtle shadow, not glow.
7. **Respect the one real download.** Never delete/pause/re-download the owner's live data to "test". Verify non-destructively.

---

## 2. Tokens (use these — do NOT hardcode hex/px)

All defined in `src/app/globals.css` `:root`. Reference via `var(--…)` or the Tailwind theme aliases.

### Color
| Purpose | Token |
|---|---|
| Canvas | `--bg` `#0c0c0e` |
| Elevated surface (cards) | `--bg-elevated` `#141416` |
| Muted surface | `--bg-muted` `#1a1a1e` |
| Hover surface | `--bg-hover` `#222228` |
| Border | `--border` `#2a2a30` / strong `--border-strong` |
| Text | `--text` / secondary `--text-secondary` / tertiary `--text-tertiary` |
| **Accent (primary)** | `--accent` `#e8a54b` (amber), hover `--accent-hover` |
| Success / Danger / Info | `--success` `#3ecf8e` / `--danger` `#f07178` / `--info` `#7aa2f7` |

> Accessibility: body/secondary/tertiary text tokens are tuned for WCAG AA on our surfaces. Don't
> introduce lighter greys for metadata — `--text-tertiary` is the floor.

### Radius / elevation / typography
- Radius: `--radius` `10px` (default), `--radius-sm` `6px`, `--radius-lg` `14px`.
- Shadow: `--shadow-sm`, `--shadow-md`. Fonts: `--font-sans` (Geist), `--font-mono` (Geist Mono).
- Layout vars: `--header-h` `3.5rem`, `--mobile-nav-h` `3.5rem`, `--safe-bottom` (iOS safe area).

### Spacing
Use Tailwind's scale (multiples of 4px). Common: gap/padding `2` (8px), `3` (12px), `4` (16px),
section spacing `space-y-10`. Tap targets **≥ 44px** (`min-h-[44px]`) on interactive controls.

---

## 3. Component patterns (match these)

- **Card:** `--bg-elevated` surface, `--border`, `--radius`, `--shadow-sm`; hover → `--bg-hover`.
- **Primary button:** amber `--accent` bg, `--primary-foreground` text; exactly one per surface.
- **Secondary/ghost button:** transparent/`--bg-muted`, `--border`, `--text`.
- **Overflow menu (`⋯`):** DropdownMenu for non-primary actions (Copy stream URL / Open folder / Pause / Resume / Delete).
- **State machine per data surface — always implement all four:** `loading` (skeleton, only when empty) · `ready` · `empty` (with a next-step action) · `error` (with retry). Never collapse "loading" into a blank "ready".
- **Selects:** native `<select>` styled with our tokens (see `episode-list.tsx` `[data-season-select]`).
- **Every interactive element** has an `aria-label` and a stable `data-*` hook for MCP verification.

---

## 4. Responsive / breakpoints

Tailwind defaults: `sm 640` · `md 768` · `lg 1024` · `xl 1280`. **Design mobile-first.**

- **Must verify every UI change at 390 (mobile), 768 (tablet), 1280 (desktop).** Non-negotiable.
- No horizontal overflow at 390px. Fix overflow with `min-w-0` on the flex/grid child (NOT
  `overflow-x:hidden` on an ancestor — see the globals.css note; that silently breaks sticky).
- Multi-column/table layouts must stack on mobile. Tiny fixed-width cards (e.g. `w-[9.75rem]`)
  must wrap and fit within 390px — prefer 2-up or fluid on mobile.
- Respect `--mobile-nav-h` + `--safe-bottom` for bottom padding so content isn't hidden behind nav.

---

## 5. UI Definition of Done — the checklist ("the 100 things")

**Run this on EVERY UI change before calling it done.** Verify with Playwright MCP (resize + screenshot).

### A. Layout & responsive
- [ ] Renders correctly at **390 / 768 / 1280** px.
- [ ] No horizontal scroll/overflow at 390px.
- [ ] Columns/tables stack sensibly on mobile; nothing clipped or squished.
- [ ] Bottom content clears the mobile nav (`--mobile-nav-h` + `--safe-bottom`).
- [ ] Sticky headers/toolbars still stick (didn't add `overflow` on an ancestor).
- [ ] No layout shift when data loads or on 5s background refresh (no skeleton flash).

### B. States (all four exist)
- [ ] **Loading** shows a skeleton ONLY when there's nothing yet.
- [ ] **Empty** shows a message **+ a next-step action** (never a dead end).
- [ ] **Error** shows the cause **+ a retry**.
- [ ] **Ready** never masquerades while a new fetch is in flight (show loading instead of blank).

### C. Actions & hierarchy
- [ ] Exactly **one** primary (amber) action per surface.
- [ ] Secondary actions are ghost/secondary or in a `⋯` menu.
- [ ] Destructive actions (Delete) require confirmation and are visually de-emphasized.
- [ ] Primary action is disabled/blocked when it can't succeed (e.g. Play gated until streamable).

### D. Feedback & motion
- [ ] Any wait > ~2s shows an **honest** loader with staged copy, not a bare spinner.
- [ ] A close/cancel is always reachable during a wait/overlay.
- [ ] Hover/active/focus states present on interactive elements.

### E. Accessibility & input
- [ ] Tap targets ≥ 44px.
- [ ] `aria-label` on icon-only buttons; visible focus ring (`--accent-ring`).
- [ ] Keyboard: primary flows reachable/operable by keyboard.
- [ ] Text uses `--text*` tokens (AA contrast); no sub-tertiary grey for metadata.

### F. Consistency & tokens
- [ ] Colors/radius/shadow/spacing use **tokens**, no ad-hoc hex/px.
- [ ] Matches existing patterns of the page being edited.
- [ ] Stable `data-*` hooks preserved (grep the page's `*-source.test.ts` and keep every asserted attr).

### G. Verification (this repo)
- [ ] Verified live via **Playwright MCP** (resize + screenshot + drive the real control), not just unit tests.
- [ ] `& node_modules\.bin\tsc.cmd --noEmit` clean.
- [ ] `node scripts/run-unit-tests.mjs` full suite green (report the count).
- [ ] Did NOT restart the dev server; did NOT disturb the one real download.

---

## 6. When something is genuinely undecided

If the checklist + principles don't resolve it and the choice is costly/irreversible, pick the most
standard media-app pattern, implement it, and note the decision — don't stall. Only ask the owner
when proceeding wrong would waste real effort or destroy data.
