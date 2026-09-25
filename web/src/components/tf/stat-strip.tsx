import { cn } from "@/lib/utils";

export interface TfStatItem {
  label: string;
  value: string | number;
  tone?: "default" | "accent" | "success" | "muted";
  mono?: boolean;
  /**
   * Mirror this tile's raw value into a `data-stat-value` attribute so tests can
   * read the count without parsing the formatted text node. Opt-in per item.
   */
  statValueHook?: boolean;
}

/** Columns rendered at each breakpoint. */
const COLUMNS = { base: 2, sm: 3, lg: 5 } as const;

/**
 * Tailwind only ships classes it can see as literal strings, so the spans are
 * enumerated rather than built by interpolation.
 */
const SPAN_CLASS: Record<keyof typeof COLUMNS, Record<number, string>> = {
  base: { 1: "col-span-1", 2: "col-span-2" },
  sm: { 1: "sm:col-span-1", 2: "sm:col-span-2", 3: "sm:col-span-3" },
  lg: {
    1: "lg:col-span-1",
    2: "lg:col-span-2",
    3: "lg:col-span-3",
    4: "lg:col-span-4",
    5: "lg:col-span-5",
  },
};

/**
 * How many columns the last tile must cover so the final row has no hole.
 *
 * The 1px gap shows the container's border colour through, so an unfilled cell
 * reads as a stray grey block in the rounded corner rather than as empty space.
 * Stretching the last tile keeps the strip clean at any item count, not just
 * the counts that happen to divide evenly.
 */
function lastItemSpan(count: number, columns: number): number {
  if (count <= 0 || columns <= 0) return 1;
  const remainder = count % columns;
  return remainder === 0 ? 1 : columns - remainder + 1;
}

export function TfStatStrip({
  items,
  className,
}: {
  items: TfStatItem[];
  className?: string;
}) {
  if (items.length === 0) return null;

  return (
    /**
     * A grid rather than a wrapping flex row: with flex-wrap an odd count left
     * the last stat alone on its own row at a different width from the rest.
     * The 1px gap over a border-coloured background draws the dividers.
     */
    <div
      className={cn(
        "grid grid-cols-2 gap-px overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--border)] sm:grid-cols-3 lg:grid-cols-5",
        className,
      )}
      data-stat-strip
    >
      {items.map((item, i) => {
        const isLast = i === items.length - 1;
        return (
          <div
            key={item.label}
            className={cn(
              "flex min-w-0 flex-col gap-0.5 bg-[var(--bg-elevated)] px-3.5 py-2.5 sm:px-4",
              isLast && [
                SPAN_CLASS.base[lastItemSpan(items.length, COLUMNS.base)],
                SPAN_CLASS.sm[lastItemSpan(items.length, COLUMNS.sm)],
                SPAN_CLASS.lg[lastItemSpan(items.length, COLUMNS.lg)],
              ],
            )}
          >
            <span className="truncate text-[10px] font-medium uppercase tracking-wide text-[var(--text-tertiary)]">
              {item.label}
            </span>
            <span
              data-stat-value={item.statValueHook ? item.value : undefined}
              className={cn(
                "truncate text-sm font-semibold tabular-nums",
                item.mono && "font-mono text-[12px] font-medium",
                item.tone === "accent" && "text-[var(--accent-text)]",
                item.tone === "success" && "text-[var(--success)]",
                item.tone === "muted" && "text-[var(--text-secondary)]",
                (!item.tone || item.tone === "default") && "text-[var(--text)]",
              )}
            >
              {item.value}
            </span>
          </div>
        );
      })}
    </div>
  );
}
