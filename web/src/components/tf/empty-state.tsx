import { Link } from "react-router";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

/** "There is nothing here yet", built on the shadcn `Empty` parts. */
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
    <Empty
      className={cn("border border-border bg-card px-6 py-14", className)}
      data-empty-state
    >
      <EmptyHeader>
        {Icon ? (
          <EmptyMedia variant="icon" className="size-11 text-subtle-foreground">
            <Icon className="size-5" strokeWidth={1.75} />
          </EmptyMedia>
        ) : null}
        <EmptyTitle className="text-foreground">{title}</EmptyTitle>
        {description ? (
          <EmptyDescription className="text-[13px] text-subtle-foreground">
            {description}
          </EmptyDescription>
        ) : null}
      </EmptyHeader>
      {actionLabel && actionHref ? (
        <EmptyContent>
          <Button asChild size="sm">
            <Link to={actionHref}>{actionLabel}</Link>
          </Button>
        </EmptyContent>
      ) : null}
    </Empty>
  );
}
