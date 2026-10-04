import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

export function BulkBar({
  count,
  actions,
  onClear,
}: {
  count: number;
  actions: ReactNode;
  onClear: () => void;
}) {
  if (!count) return null;
  return (
    <div className="sticky bottom-[calc(var(--mobile-nav-h)+var(--safe-bottom))] z-20 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-3 shadow-md">
      <span className="mr-auto text-sm font-medium text-foreground">{count} selected</span>
      {actions}
      <Button type="button" variant="ghost" onClick={onClear}>Clear</Button>
    </div>
  );
}
