import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type ListSelection = {
  selectedIds: Set<string>;
  toggle: (id: string) => void;
  toggleAll: () => void;
  allSelected: boolean;
  someSelected: boolean;
};

export function DataList<T>({
  items,
  getKey,
  renderRow,
  loading = false,
  empty,
  error,
  noResults = false,
  onClearFilters,
  selection,
  selectionLayout = "row",
  className,
}: {
  items: readonly T[];
  getKey: (item: T) => string;
  renderRow: (item: T) => ReactNode;
  loading?: boolean;
  empty?: ReactNode;
  error?: ReactNode;
  noResults?: boolean;
  onClearFilters?: () => void;
  selection?: ListSelection;
  /** `overlay` floats the checkbox over the item's top-left corner, for poster grids. */
  selectionLayout?: "row" | "overlay";
  className?: string;
}) {
  if (error) return <>{error}</>;
  if (loading) return <div role="status" className="py-8 text-center text-sm text-muted-foreground">Loading…</div>;
  if (!items.length) {
    return noResults ? (
      <div className="space-y-3 py-8 text-center">
        <p className="text-sm text-muted-foreground">No items match these filters.</p>
        {onClearFilters && <button type="button" onClick={onClearFilters} className="text-sm text-brand-foreground underline">Clear filters</button>}
      </div>
    ) : <>{empty}</>;
  }

  return (
    <ul className={cn("space-y-2", className)}>
      {selection && (
        <li className="col-span-full flex items-center gap-2 px-1">
          <input type="checkbox" aria-label="Select all items" checked={selection.allSelected} ref={(node) => { if (node) node.indeterminate = selection.someSelected; }} onChange={selection.toggleAll} />
          <span className="text-xs text-muted-foreground">Select all</span>
        </li>
      )}
      {items.map((item) => {
        const id = getKey(item);
        if (selection && selectionLayout === "overlay") {
          const checked = selection.selectedIds.has(id);
          return (
            <li key={id} className="group/item relative min-w-0">
              {renderRow(item)}
              <label
                className={cn(
                  "absolute left-0 top-0 z-[4] flex size-11 cursor-pointer items-start justify-start p-1.5 transition-opacity duration-150",
                  !checked && !selection.someSelected &&
                    "[@media(hover:hover)_and_(pointer:fine)]:opacity-0 group-hover/item:opacity-100 focus-within:opacity-100",
                )}
              >
                <span className="flex size-6 items-center justify-center rounded-md border border-border bg-card/90 shadow-sm">
                  <input type="checkbox" aria-label={`Select ${id}`} checked={checked} onChange={() => selection.toggle(id)} />
                </span>
              </label>
            </li>
          );
        }
        return selection ? (
          <li key={id} className="flex min-w-0 items-start gap-3">
            <input type="checkbox" aria-label={`Select ${id}`} checked={selection.selectedIds.has(id)} onChange={() => selection.toggle(id)} className="mt-4 shrink-0" />
            <div className="min-w-0 flex-1">{renderRow(item)}</div>
          </li>
        ) : <li key={id} className="min-w-0">{renderRow(item)}</li>;
      })}
    </ul>
  );
}
