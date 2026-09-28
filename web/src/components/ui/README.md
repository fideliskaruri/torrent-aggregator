# UI primitives

Everything in this folder is official shadcn/ui (style `radix-nova`, see
`web/components.json`) with small TorrentFlow tweaks. Pages build on these.
Do not add a hand-made copy of something shadcn has.

## Rules for page code

1. Import from `@/components/ui/<name>`. Add a missing primitive with the CLI:
   `pnpm dlx shadcn@latest add <name>` from `web/` (set
   `PNPM_CONFIG_STORE_DIR` first). The CLI writes `from "cn"`; change it to
   `from "@/lib/utils"`. It may also re-add the `cn` package; remove it.
   Check `pnpm-lock.yaml` has no `ms-feed` tarball URLs or `sha1-` hashes.
2. Never use a native `<select>`, `<input type="checkbox">`,
   `<input type="radio">`, `<input type="range">`, `<dialog>` or `<details>`.
   Use `Select`, `Checkbox`, `RadioGroup`, `Slider`, `Dialog`/`Sheet` and
   `Collapsible`/`Accordion`.
3. No hand-rolled tabs, popovers, menus, segmented toggles, tooltips or
   disclosure chevrons. Use `Tabs`, `Popover`, `DropdownMenu`, `ToggleGroup`,
   `Tooltip` and `Collapsible`.
4. No hand-rolled scroll strips with native scrollbars. Use `ScrollArea`
   (with `ScrollBar orientation="horizontal"`) or `Carousel` for rails.
5. Colors come from theme utilities, not hex or new `var(--x)` names.
   Legacy `bg-[var(--bg-muted)]` style classes still work; prefer the
   utilities below in new code.
6. Keep the 44px touch rule. `Button`, `Input`, `SelectTrigger`, `Checkbox`
   and menu items already grow to 44px on phones and coarse pointers. If you
   override a height, keep `max-md:min-h-11 pointer-coarse:min-h-11`.
7. No em dashes in UI copy. Plain words.

## Available primitives

accordion, alert-dialog, avatar, badge, button, card, carousel, checkbox,
collapsible, command, dialog, dropdown-menu, empty, field, hover-card, input,
input-group, kbd, label, navigation-menu, popover, progress, radio-group,
scroll-area, select, separator, sheet, skeleton, slider, sonner, spinner,
switch, tabs, textarea, toggle, toggle-group, tooltip.

TorrentFlow helpers that stay here: `form-field.tsx` (`FormField` = label,
control, hint on top of `Field`), `loading.tsx`, `loading-state.ts`,
`use-stable-loading.ts`.

## TorrentFlow tweaks

- `Button`: sizes `default` h-9, `sm` h-8, `lg` h-10, `icon`, `icon-sm`,
  `icon-lg`. A disabled primary goes neutral unless it is `aria-busy`.
- `Badge` variants: `default` (neutral chip), `secondary`, `outline`,
  `solid` (filled amber, use for counts), `accent` (amber tint), `success`,
  `danger`, `info`, `destructive`, `ghost`, `link`. One count per place.
- `Dialog`: `<DialogContent mobileFullscreen>` fills the phone screen and is
  a centered panel from `sm` up. Without it the dialog is centered everywhere.
  `showCloseButton={false}` hides the X.
- `Progress`: `indicatorClassName` colors the bar.
- `DropdownMenuContent`: 8px collision padding and a max width that fits
  phones.
- `TooltipProvider` is mounted once in `app/layout.tsx`.

## Theme tokens

Defined once in `app/globals.css`. The TorrentFlow palette (`--bg`,
`--text*`, `--brand`, `--success`...) is the source; shadcn tokens alias it.
`--accent` is the shadcn hover surface, not the amber. The amber is `brand`.

| Use | Utility |
| --- | --- |
| Page background | `bg-background` |
| Raised surface, popovers | `bg-card`, `bg-popover` |
| Hover or selected row | `bg-muted` or `bg-accent` |
| Body text | `text-foreground` |
| Secondary text | `text-muted-foreground` |
| Tertiary text | `text-subtle-foreground` |
| Amber fill / text | `bg-brand` or `bg-primary`, `text-brand-foreground` |
| Amber tint | `bg-brand-dim` |
| Status | `text-success`, `text-warning`, `text-info`, `text-destructive` |
| Borders, inputs | `border-border`, `border-input` |
| Focus ring | `ring-ring` (components already set it) |
| Radius | `rounded-md` (8px), `rounded-lg` (10px), `rounded-xl` |
