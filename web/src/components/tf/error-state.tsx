/**
 * The counterpart to `TfEmptyState`.
 *
 * We already had a considered component for "there is nothing here", and no
 * component at all for "we could not find out". So every panel that failed to
 * load reached for the empty state instead, and told the user their download
 * log was empty when the truth was that the server never answered. An empty
 * state is a statement of fact about their data; showing one for a failed
 * request is simply a lie, and a confident one — it offers no retry, because
 * as far as it knows nothing went wrong.
 *
 * This exists so that "broken" has somewhere to go that is not "empty". It
 * deliberately mirrors `TfEmptyState`'s shape and surface so the two read as
 * siblings, and differs in the one way that matters: it always offers a way
 * to try again.
 */

import { AlertTriangle, RotateCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export function TfErrorState({
  title = "Could not load this",
  message,
  onRetry,
  retrying = false,
  className,
}: {
  title?: string;
  /** What actually went wrong. Shown verbatim — it is the actionable part. */
  message?: string | null;
  onRetry?: () => void;
  retrying?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "surface flex flex-col items-center justify-center text-center px-6 py-14 gap-3",
        className,
      )}
      data-error-state
      role="alert"
    >
      <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-[var(--bg-muted)] text-[var(--text-tertiary)]">
        <AlertTriangle className="h-5 w-5" strokeWidth={1.75} />
      </span>
      <div className="space-y-1 max-w-sm">
        <p className="text-sm font-medium text-[var(--text)]">{title}</p>
        {message ? (
          <p className="text-[13px] text-[var(--text-tertiary)] leading-relaxed break-words">
            {message}
          </p>
        ) : null}
      </div>
      {onRetry ? (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="mt-1"
          onClick={onRetry}
          disabled={retrying}
        >
          <RotateCw
            className={cn("h-3.5 w-3.5", retrying && "animate-spin")}
            aria-hidden
          />
          {retrying ? "Retrying…" : "Try again"}
        </Button>
      ) : null}
    </div>
  );
}
