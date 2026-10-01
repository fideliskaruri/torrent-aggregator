# shadcn migration plan

The foundation is on `feat/shadcn`: official shadcn/ui primitives in
`web/src/components/ui` (see its README), the TorrentFlow theme mapped onto
shadcn tokens in `web/src/app/globals.css`, and the shared shells migrated
(header, phone tab bar and More sheet, notification bell, `tf/page-header`,
`tf/empty-state`, `tf/error-state`, `tf/stat-strip`).

This file lists what each area still hand-rolls and which primitive replaces
it, then splits the work into five slices that do not share files.

## Rules for every slice

- Read `web/src/components/ui/README.md` first. Import from
  `@/components/ui`. Add missing primitives with the CLI, not by hand.
- Keep existing `data-*` hooks and `aria-*` names; other code and the
  browser checks select on them.
- No unit tests and no mock-based tests. Do not add any.
- Replace `bg-[var(--x)]` / `text-[var(--x)]` classes with theme utilities
  in the files you touch (`bg-card`, `text-muted-foreground`, ...).
- Build: `pnpm --dir web typecheck`, `pnpm --dir web build`, and
  `dotnet build server/TorrentFlow.Api/TorrentFlow.Api.csproj`.

## Verification (real server, real data, real screens)

Evidence in a slice report is real API responses and real screenshots, not
test counts.

1. Copy the stable data SQLite-safely into the slice folder (never copy a
   live `.db` file directly):
   `python -c "import sqlite3; s=sqlite3.connect(r'D:\code\memtest\stable\data\torrentflow.db'); d=sqlite3.connect(r'D:\code\memtest\shadcn-<slice>\data\torrentflow.db'); s.backup(d)"`.
   Also copy `push-vapid.json` and `trackers_best.txt`. Point the download
   folder settings at `D:\code\memtest\shadcn-<slice>\data\downloads`,
   never `D:\Torrents` or `C:\Torrents`.
2. Build `web/dist`, then run the API from the slice worktree on the slice
   port: `ASPNETCORE_URLS=http://127.0.0.1:<port>`,
   `TorrentFlow__DataDirectory=D:\code\memtest\shadcn-<slice>\data`,
   `dotnet run --project server/TorrentFlow.Api`.
3. Call the real endpoints the slice's pages use (for example `/api/health`,
   `/api/me`, `/api/requests`, `/api/notifications`) with curl and paste the
   status and body excerpt into the report.
4. Take viewport screenshots of every page the slice touched at 390, 1024
   and 1440 with `pnpm --dir web screens` (`BASE_URL`, `SHOTS_DIR`, and
   `PW_ROOT` pointing at a scratch folder with `playwright` installed; channel
   `msedge`). Open the menus, sheets and dialogs you changed and shoot them
   too. Look at every image; fix overflow, clipping, native controls and
   misalignment, then shoot again.
5. Stop the server when done. Never use ports 3000, 3930, 3960 or 3941 to
   3945, `%LOCALAPPDATA%\TorrentFlow` or `C:\Torrents`.

## Inventory by area

Counts are from a grep of the current code (`<select`, `role="tab"`,
`type="radio"`, `aria-expanded`, `aria-pressed`, `<details`,
`type="range"`, `overflow-x-auto`, raw `<button>`).

### Browse (`components/browse`, `app/everything`)

| File | Bespoke control | Replace with |
| --- | --- | --- |
| `browse/rail.tsx` | Horizontal scroll strip with native scrollbar and custom arrow buttons | `Carousel` (or `ScrollArea` + `ScrollBar orientation="horizontal"`), `Button size="icon"` |
| `browse/hero-banner.tsx` | Six raw buttons (pager dots, actions) | `Button`; pager dots as `ToggleGroup` or `Carousel` dots |
| `browse/title-card.tsx` | Raw buttons, hand-made status chips | `Button`, `Badge` |
| `browse/play-overlay.tsx` | Removed with in-app playback (owner bugs 30 Sep, J) | Nothing to migrate |
| `browse/availability-chip.tsx` | Chip styling | `Badge` variants |
| `tf/recommendation-rail.tsx` | Raw button, scroll strip | `Carousel` or `ScrollArea`, `Button` |
| `browse/browse-skeleton.tsx` | Custom shimmer blocks | `Skeleton` |

### Title and watch (`components/title`, `components/watch`, `app/title`)

| File | Bespoke control | Replace with |
| --- | --- | --- |
| `title/episode-list.tsx` | Two native `<select>` (season, sort), custom disclosure chevrons, overflow strip | `Select`, `Collapsible` or `Accordion`, `ScrollArea` |
| `title/quality-picker.tsx` | Radio inputs styled as cards | `RadioGroup` + `RadioGroupItem` in `Label` cards |
| `title/library-controls.tsx` | Radio inputs, bottom-anchored dialog classes | `RadioGroup`, `Sheet side="bottom"` on phones, `Dialog` above |
| `title/title-detail.tsx` | Raw buttons, rating and meta chips | `Button`, `Badge` |
| `title/title-hero-meta.tsx`, `title/more-like-this.tsx` | Chips, rail | `Badge`, `Carousel` |
| `watch/*` (inline player, swarm chip) | Removed with in-app playback (owner bugs 30 Sep, J) | Nothing to migrate |

### Downloads, library, requests (`app/downloads`, `app/watchlist`, `app/requests`, `components/requests`, `components/library`)

| File | Bespoke control | Replace with |
| --- | --- | --- |
| `app/downloads/page.tsx` | Hand-rolled tabs (All, Movies, Series, Anime) and segmented status filter (`role="tablist"`, `aria-pressed`), three `<details>` disclosures, raw textarea and filter input, 22 raw buttons, table markup | `Tabs`, `ToggleGroup type="single"`, `Collapsible`, `Textarea`, `InputGroup` with search icon, `Button`, `DropdownMenu` for row actions |
| `app/downloads/series-download-dialog.tsx` | Native `<select>`, `aria-pressed` toggle, custom disclosure, scroll strip | `Select`, `ToggleGroup`, `Collapsible`, `ScrollArea` |
| `app/downloads/release-swap-dialog.tsx` | Radio list, scroll strip | `RadioGroup`, `ScrollArea` |
| `app/watchlist/page.tsx` (Library) | Hand-rolled tabs and segmented toggles, native `<select>` sort, `<details>` | `Tabs`, `ToggleGroup`, `Select`, `Collapsible` |
| `components/library/check-schedule.tsx` | Schedule chips | `Badge` |
| `app/requests/page.tsx` | Native `<select>`, raw textarea and input | `Select`, `Textarea`, `Input` |
| `components/requests/request-dialog.tsx` | Radio inputs, raw textarea | `RadioGroup`, `Textarea`, `FormField` |
| `components/requests/request-action.tsx` | Raw button | `Button` |

### Settings, rules, setup, storage (`app/settings`, `app/rules`, `components/settings`, `components/setup`, `components/storage`)

| File | Bespoke control | Replace with |
| --- | --- | --- |
| `app/settings/page.tsx` | Four native `<select>`, radio cards (minimum quality), two custom disclosures, raw `<label>` elements (use `Label` or `FormField`) | `Select`, `RadioGroup` cards or `ToggleGroup`, `Collapsible`, `FormField` |
| `settings/settings-disclosure.tsx` | Custom disclosure with chevron | `Collapsible` (or `Accordion` for the section list) |
| `settings/download-windows-panel.tsx` | Two native `<select>` (days, hours), `aria-pressed` day toggles | `Select`, `ToggleGroup type="multiple"` |
| `settings/retention-panel.tsx` | Removed with in-app playback (owner bugs 30 Sep, J) | Nothing to migrate |
| `settings/sources-settings.tsx` | Native checkbox, seven inputs, textarea | `Checkbox` or `Switch`, `Input`, `Textarea`, `FormField` |
| `settings/folder-picker.tsx` | Hand-rolled popover list | `Popover` + `Command` |
| `settings/remote-access-section.tsx`, `tmdb-settings.tsx`, `download-location-fields.tsx`, `desktop-section.tsx`, `download-recovery.tsx` | Raw inputs, textarea, buttons | `Input`, `InputGroup`, `Textarea`, `Button`, `FormField` |
| `app/rules/page.tsx` | Three native `<select>`, `aria-pressed` toggles, custom disclosure | `Select`, `ToggleGroup` or `Switch`, `Collapsible` |
| `components/setup/download-setup.tsx` | Raw buttons in a stepper | `Button`, `Card` |
| `components/storage/storage-cap-dialog.tsx` | Inputs in dialog | `Input`, `FormField`, `Slider` if a range fits |

### Search, notifications, shell leftovers (`components/search`, `app/search`, `app/notifications`, `app/activity`, `app/history`, `app/upcoming`, `app/about`, `app/share`, `app/client`, `components/notifications` (feed only), `components/pwa`, `components/layout` banners)

| File | Bespoke control | Replace with |
| --- | --- | --- |
| `search/search-overlay.tsx` | Hand-made palette: custom dialog, tabs, result list with its own keyboard handling, scroll strip | `CommandDialog` + `CommandInput`/`CommandList`/`CommandGroup`, `Tabs` for scopes |
| `search/title-result-card.tsx`, `title-results-list.tsx` | Chips, list rows | `Badge`, `Card` |
| `notifications/notification-feed.tsx` (`NotificationFeed`, `PushToggle`) | Bordered list, raw empty block, push toggle button | `Card`, `Empty`, `Switch`, `Skeleton` |
| `app/activity`, `app/history`, `app/upcoming` | Lists and chips with legacy var classes | `Card`, `Badge`, `Tabs` where filters exist, `Skeleton` |
| `app/about`, `app/share`, `app/client` | Raw buttons, inputs | `Button`, `Input`, `Card` |
| `pwa/install-app-card.tsx`, `pwa/connection-banner.tsx`, `layout/update-banner.tsx`, `layout/preview-banner.tsx` | Raw buttons, banner boxes | `Button`, `Alert` (add with CLI), `Card` |
| `app/layout.tsx` footer | Raw `<kbd>` | `Kbd` |

## Slices for the next wave

Each slice owns its files. No two slices edit the same file. Shared files
(`components/ui/*`, `app/globals.css`, `components/layout/header.tsx`,
`components/layout/mobile-nav.tsx`, `components/tf/*`) are frozen for the
wave; ask the foundation owner for changes there.

| Slice | Port | Data folder | Owns | Main primitives | Size |
| --- | --- | --- | --- | --- | --- |
| 1. Browse and title | 3950 | `D:\code\memtest\shadcn-browse\data` | `components/browse/*`, `components/tf/recommendation-rail.tsx`, `components/title/*`, `app/title/*`, `app/everything/*` | Carousel, ScrollArea, Select, RadioGroup, Collapsible, Badge, Skeleton | Medium |
| 2. Player | — | — | Removed: there is no in-app playback, and `components/watch/*` is gone | — | — |
| 3. Downloads, library, requests | 3952 | `D:\code\memtest\shadcn-downloads\data` | `app/downloads/*`, `app/watchlist/*`, `app/requests/*`, `components/requests/*`, `components/library/*` | Tabs, ToggleGroup, Select, Collapsible, RadioGroup, Textarea, DropdownMenu | Large |
| 4. Settings and rules | 3953 | `D:\code\memtest\shadcn-settings\data` | `app/settings/*`, `app/rules/*`, `components/settings/*`, `components/setup/*`, `components/storage/*` | Select, ToggleGroup, Collapsible, Checkbox or Switch, Popover + Command, FormField | Large |
| 5. Search, notifications, small pages | 3954 | `D:\code\memtest\shadcn-search\data` | `components/search/*`, `app/search/*`, `app/notifications/*`, `components/notifications/notification-feed.tsx` (feed and push toggle only; leave `NotificationBell`), `app/activity/*`, `app/history/*`, `app/upcoming/*`, `app/about/*`, `app/share/*`, `app/client/*`, `components/pwa/*`, `components/layout/update-banner.tsx`, `components/layout/preview-banner.tsx`, `app/layout.tsx` footer | Command, Tabs, Card, Empty, Switch, Badge, Button, Kbd | Medium |

Settings note: the foundation already fixed the "Downloads at once" label,
the import buttons and the download folder / space limit field heights in
`app/settings/page.tsx`, `components/settings/download-location-fields.tsx`
and `components/settings/download-recovery.tsx`. Slice 4 still owns those
files.
