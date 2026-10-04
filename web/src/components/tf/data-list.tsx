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
        <li className="flex items-center gap-2 px-1">
          <input type="checkbox" aria-label="Select all items" checked={selection.allSelected} ref={(node) => { if (node) node.indeterminate = selection.someSelected; }} onChange={selection.toggleAll} />
          <span className="text-xs text-muted-foreground">Select all</span>
        </li>
      )}
      {items.map((item) => {
        const id = getKey(item);
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
