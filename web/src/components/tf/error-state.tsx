/**
 * The counterpart to `TfEmptyState`.
 *
 * We already had a considered component for "there is nothing here", and no
 * component at all for "we could not find out". So every panel that failed to
 * load reached for the empty state instead, and told the user their download
 * log was empty when the truth was that the server never answered. An empty
 * state is a statement of fact about their data; showing one for a failed
 * request is simply a lie, and a confident one: it offers no retry, because
 * as far as it knows nothing went wrong.
 *
 * This exists so that "broken" has somewhere to go that is not "empty". It is
 * built on the same shadcn `Empty` parts as `TfEmptyState` so the two read as
 * siblings, and differs in the one way that matters: it always offers a way
 * to try again.
 */

import { AlertTriangle, RotateCw } from "lucide-react";
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

export function TfErrorState({
  title = "Could not load this",
  message,
  onRetry,
  retrying = false,
  className,
}: {
  title?: string;
  /** What actually went wrong. Shown verbatim: it is the actionable part. */
  message?: string | null;
  onRetry?: () => void;
  retrying?: boolean;
  className?: string;
}) {
  return (
    <Empty
      className={cn("border border-border bg-card px-6 py-14", className)}
      data-error-state
      role="alert"
    >
      <EmptyHeader>
        <EmptyMedia variant="icon" className="size-11 text-subtle-foreground">
          <AlertTriangle className="size-5" strokeWidth={1.75} />
        </EmptyMedia>
        <EmptyTitle className="text-foreground">{title}</EmptyTitle>
        {message ? (
          <EmptyDescription className="break-words text-[13px] text-subtle-foreground">
            {message}
          </EmptyDescription>
        ) : null}
      </EmptyHeader>
      {onRetry ? (
        <EmptyContent>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={onRetry}
            disabled={retrying}
          >
            <RotateCw
              className={cn("size-3.5", retrying && "animate-spin")}
              aria-hidden
            />
            {retrying ? "Retrying…" : "Try again"}
          </Button>
        </EmptyContent>
      ) : null}
    </Empty>
  );
}
