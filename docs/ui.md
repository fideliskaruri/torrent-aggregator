# TorrentFlow UI system

## Stack
- **Tailwind CSS v4** + CSS variables in `src/app/globals.css`
- **shadcn-style primitives** (owned) under `src/components/ui/*` — Radix + CVA
- **Product compounds** under `src/components/tf/*`
- **Toasts:** `sonner` via `<Toaster />` in root layout (`src/components/ui/sonner.tsx`)
- **Icons:** `lucide-react`

## Amber warm foundation

TorrentFlow is a **warm near-black canvas** with an **amber accent**. No cyan CTAs, no violet brand, no frosted glass chrome.

| Token | Role |
|-------|------|
| `--bg` / `--background` | Page canvas `#0c0c0e` |
| `--bg-elevated` / `--card` | Surfaces `#141416` |
| `--bg-muted` / `--bg-hover` | Muted / hover `#1a1a1e` / `#222228` |
| `--border` / `--border-strong` | Borders `#2a2a30` / `#3a3a44` |
| `--text` / secondary / tertiary | `#ececef` / `#a1a1aa` / `#71717a` |
| `--accent` / `--primary` | Amber CTA `#e8a54b` |
| `--accent-hover` | Lighter amber hover `#f0b45c` |
| `--accent-text` | Soft amber text / links `#f0c078` |
| `--accent-dim` | Selected chip / nav fill `rgba(232, 165, 75, 0.14)` |
| `--accent-border` / `--accent-ring` | Soft amber borders / focus rings `rgba(232,165,75,…)` |
| `--primary-foreground` | Dark text on amber buttons `#1a1208` |
| `--danger` / `--destructive` | Destructive actions |
| `--success` | Success green |
| `--info` | Soft blue info `#7aa2f7` |

**PWA / chrome**
- `public/manifest.webmanifest` → `theme_color: #e8a54b`, `background_color: #0c0c0e`
- Root viewport `themeColor: #0c0c0e` (matches dark canvas)

**Hard rules**
- Prefer CSS vars (`var(--accent)`, `var(--primary)`, …) over raw hex in components
- Do **not** reintroduce cyan (`#22d3ee`, `#67e8f9`, `#083344`) or violet brand leftovers
- Surfaces are solid (`.surface`, `.surface-muted`). `.glass` / `.glass-strong` are **legacy bridges** that resolve to solid elevated surfaces — do not use them on new pages
- No decorative gradients on page chrome (`.bg-app` / `.bg-mesh` are flat `--bg`)

## When to use what

### Primitives — `@/components/ui/*`
Prefer for all new interactive UI:
- `Button` — primary / secondary / ghost / outline / destructive
- `Badge`, `Input`, `Checkbox`, `Progress`
- `Field` — label + optional hint wrapper. Use it for **every** form control; it
  generates the id and wires `htmlFor`/`aria-describedby`, so controls never end
  up unlabelled (placeholders are not labels).
- `AlertDialog`, `DropdownMenu`, `Tooltip`
- `PageShell` where a consistent page width/padding is needed

### Product compounds — `@/components/tf/*`
Use **Tf\*** when the layout pattern repeats across pages:

| Component | Use when |
|-----------|----------|
| `TfPageHeader` | Page title + optional description, meta row, and action cluster (Library, Activity, Client, …) |
| `TfEmptyState` | Zero-data state with optional icon + CTA link/button |
| `TfStatStrip` | Dense numeric/status summary row (Client dashboard density) |
| `TfPathChip` | Truncated download path / folder chip with open affordance |

Do **not** reimplement page headers or empty states with ad-hoc markup on secondary pages — compose Tf\*.

### Legacy `.btn` classes
`globals.css` still defines `.btn` / `.btn-primary` / `.btn-secondary` / `.btn-ghost` (+ size modifiers) for a few intentional call sites, mainly the **torrent-card split Send control** (primary + chevron joined as one control with custom radius/border). Prefer `@/components/ui/button` everywhere else (history, rules, settings, search toolbar, folder picker, pagination, …).

## Package navigation model (single path)

Navigation is defined **once**, in `src/lib/navigation.ts`. The desktop header and
the mobile nav both render from it, and `src/lib/automation/flow.test.ts` asserts
the rules below against that module. Do not hardcode nav items in a component —
the two lists drifted apart once already.

User journey is **one path** — do not reintroduce competing “what ran / what downloaded” pages:

| Step | Page | Role |
|------|------|------|
| 1 | **Library** (`/watchlist`) | What I want — monitor / search-request / watch |
| 2 | **Automation** | Run from Library (button + `POST /api/automation/run`) — no second Run control on Client or Settings |
| 3 | **Activity** (`/activity`) | What happened — GrabJobs, skips, failures, **savePath** |
| 4 | **Client** (`/client`) | Live downloads only (engine state) |
| 5 | **Download log** (`/history`) | Thin subset of past *sends*; linked from Activity, **not** a More peer |

- **Product:** Library aggregator — Search discovers/adds; Library is the product (from season + monitor); Activity logs; Client is the pipe.
- **Desktop header (flat):** Search · Library · Activity · Client · Settings  
  Rules demoted to mobile More as “Rules (advanced)” / not a primary peer. Density toggle next to auth. About in footer.
- **Mobile bottom tabs:** Search · Library · Client · **More** (Activity · Settings · Rules advanced · About · density).
- History stays routable for clear/delete of send log but is labeled **Download log** and points to Activity for automation results

## Mobile navigation & More sheet

Nav items are defined once in `src/lib/navigation.ts` (`PRIMARY_NAV`,
`SECONDARY_NAV`, `DESKTOP_NAV`). Header and `MobileNav` both render from it, so
the two cannot drift; `flow.test.ts` asserts the product rules against that
module.

- **Desktop (`md+`):** top `Header` — primary trio, a divider, then Activity and Settings
- **Mobile:** fixed bottom tab bar (`MobileNav`) with primary tabs: Search · Library · Client · **More**
- **More sheet:** bottom sheet (`data-mobile-more-sheet`) opened from the More tab
  - Secondary routes: Activity, Settings, Rules, About
  - Density toggle (compact / comfortable) via `UiPreferencesProvider`
  - Closing: backdrop tap, Escape, route change, or close button
- Routes under More prefixes light the More tab when the sheet is closed (`/activity`, `/settings`, `/rules`, `/about`, `/history`)

There is no sign-in UI — the app is local and single-user.

## Toast feedback convention

Use **sonner** (`import { toast } from "sonner"`) for async action outcomes. Do not invent custom toast stacks.

| Outcome | Call |
|---------|------|
| Success (saved, sent, cleared, removed) | `toast.success("…")` |
| Failure (API/network/validation) | `toast.error("…")` |
| Neutral / partial info | `toast.message("…")` or `toast.info("…")` |

Guidelines:
- Prefer short, user-facing sentences (“History cleared”, “Sent to client”)
- Include server `message` / `error` when useful: `toast.error(data.message \|\| data.error \|\| "…")`
- Destructive confirms stay in `AlertDialog`; the toast fires **after** the confirmed action succeeds
- Toaster lives in root layout: bottom-right, `richColors`, `closeButton`

## Density

- `html[data-density="compact" | "comfortable"]` drives torrent row padding
- Toggle from header (desktop) or More sheet (mobile)
- Search results toolbar also exposes a density control

## North stars
- **Client:** VueTorrent density (stats strip, multi-select, bulk actions)
- **Discovery:** Seerr-style primary action + advanced collapsed
- **Chrome:** Warm dark tool UI — flat surfaces, amber accent, no glass
