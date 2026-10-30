import { Check, Play } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatEpisodeLabel } from "@/lib/library/cursor";
import type { JellyfinNextUp, JellyfinWatchState } from "@/lib/api/watchlist-types";

/** Plain words for Jellyfin progress, or null when there is nothing to say. */
export function watchStateLabel(state: JellyfinWatchState | null | undefined): string | null {
  if (!state) return null;
  if (state.watched) return "Watched";
  if (state.inProgress != null && state.inProgress > 0) return `${Math.max(1, Math.round(state.inProgress))}% watched`;
  return null;
}

export function nextUpLabel(next: JellyfinNextUp | null | undefined): string | null {
  return next ? `Up next: ${formatEpisodeLabel(next.season, next.episode)}` : null;
}

/** One chip for Jellyfin watch progress and next up, used on title rows and library cards. */
export function WatchStateChip({ state, nextUp, href, className }: {
  state?: JellyfinWatchState | null;
  nextUp?: JellyfinNextUp | null;
  /** Opens the up next episode in Jellyfin. Only used when the chip shows up next. */
  href?: string | null;
  className?: string;
}) {
  const progress = watchStateLabel(state);
  const label = progress ?? nextUpLabel(nextUp);
  if (!label) return null;
  const classes = cn("gap-1 border-transparent bg-background/80 font-medium tabular-nums text-foreground backdrop-blur-sm", className);
  if (!progress && href) {
    return (
      <Badge asChild className={cn(classes, "relative underline-offset-2 after:absolute after:-inset-y-2 after:inset-x-0 hover:underline focus-visible:ring-2 focus-visible:ring-ring")}>
        <a data-watch-state data-watch-state-link href={href} target="_blank" rel="noopener noreferrer"
          aria-label={`${label}, play in Jellyfin (opens in a new tab)`}>
          <Play aria-hidden className="size-3" />
          {label}
        </a>
      </Badge>
    );
  }
  return (
    <Badge data-watch-state title={`From Jellyfin: ${label}`} className={classes}>
      {state?.watched ? <Check aria-hidden className="size-3" /> : null}
      {label}
    </Badge>
  );
}

/** The Jellyfin page for the up next episode, built from the series' own Jellyfin link. */
export function nextUpHref(playUrl: string | null | undefined, nextUp: JellyfinNextUp | null | undefined): string | null {
  const itemId = nextUp?.jellyfinItemId;
  if (!playUrl || !itemId) return null;
  return playUrl.replace(/([?&])id=[^&]*/, `$1id=${encodeURIComponent(itemId)}`);
}
