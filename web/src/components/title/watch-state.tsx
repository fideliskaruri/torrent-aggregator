import { Check } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { JellyfinNextUp, JellyfinWatchState } from "./types";

/** Plain words for Jellyfin progress, or null when there is nothing to say. */
export function watchStateLabel(state: JellyfinWatchState | null | undefined): string | null {
  if (!state) return null;
  if (state.watched) return "Watched";
  if (state.inProgress != null && state.inProgress > 0) return `${Math.max(1, Math.round(state.inProgress))}% watched`;
  return null;
}

export function nextUpLabel(next: JellyfinNextUp | null | undefined): string | null {
  return next ? `Up next: S${String(next.season).padStart(2, "0")}E${String(next.episode).padStart(2, "0")}` : null;
}

/** One chip for Jellyfin watch progress and next up, used on title rows and library cards. */
export function WatchStateChip({ state, nextUp, className }: {
  state?: JellyfinWatchState | null;
  nextUp?: JellyfinNextUp | null;
  className?: string;
}) {
  const label = watchStateLabel(state) ?? nextUpLabel(nextUp);
  if (!label) return null;
  return (
    <Badge data-watch-state title={`From Jellyfin: ${label}`}
      className={cn("gap-1 border-transparent bg-background/80 font-medium tabular-nums text-foreground backdrop-blur-sm", className)}>
      {state?.watched ? <Check aria-hidden className="size-3" /> : null}
      {label}
    </Badge>
  );
}
