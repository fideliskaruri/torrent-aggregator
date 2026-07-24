import { cn } from "@/lib/utils";

export interface TfStatItem {
  label: string;
  value: string | number;
  tone?: "default" | "accent" | "success" | "muted";
  mono?: boolean;
}

export function TfStatStrip({
  items,
  className,
}: {
  items: TfStatItem[];
  className?: string;
}) {
  return (
    <div
      className={cn(
        "surface flex flex-wrap items-stretch divide-x divide-[var(--border)] overflow-hidden",
        className,
      )}
      data-stat-strip
    >
      {items.map((item) => (
        <div
          key={item.label}
          className="flex min-w-[5.5rem] flex-1 flex-col gap-0.5 px-3.5 py-2.5 sm:px-4"
        >
          <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-tertiary)]">
            {item.label}
          </span>
          <span
            className={cn(
              "text-sm font-semibold tabular-nums",
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
      ))}
    </div>
  );
}
