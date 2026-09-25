import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export function TfEmptyState({
  icon: Icon,
  title,
  description,
  actionLabel,
  actionHref,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  actionLabel?: string;
  actionHref?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "surface flex flex-col items-center justify-center text-center px-6 py-14 gap-3",
        className,
      )}
      data-empty-state
    >
      {Icon ? (
        <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-[var(--bg-muted)] text-[var(--text-tertiary)]">
          <Icon className="h-5 w-5" strokeWidth={1.75} />
        </span>
      ) : null}
      <div className="space-y-1 max-w-sm">
        <p className="text-sm font-medium text-[var(--text)]">{title}</p>
        {description ? (
          <p className="text-[13px] text-[var(--text-tertiary)] leading-relaxed">
            {description}
          </p>
        ) : null}
      </div>
      {actionLabel && actionHref ? (
        <Button asChild size="sm" className="mt-1">
          <Link href={actionHref}>{actionLabel}</Link>
        </Button>
      ) : null}
    </div>
  );
}
