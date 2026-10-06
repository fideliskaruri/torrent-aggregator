import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft,ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea,ScrollBar } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { WantedAction } from "@/components/wanted/wanted-actions";
import { type EpisodeRowModel } from "./merge-extras";
import { EMPTY_EPISODES_COPY,type EpisodeListView } from "./episode-list-state";
import { type TitleAction,type TitleActionStatus } from "./title-actions";

import { EpisodeCard } from "./episode-card";
import { episodeIntentKey } from "./episode-key";
import { CARD_WIDTH } from "./episode-card-layout";
import { pageScrollDelta,railEdges } from "@/components/browse/rail-scroll";

export function EpisodeStrip({
  episodes, truncated, view, busy, season, statusFor, gated, onAction, onFindAnother, onPickRelease, onWantedAction,
}: {
  episodes: EpisodeRowModel[];
  truncated: boolean;
  view: EpisodeListView;
  busy: boolean;
  season: number | null;
  statusFor: (key: string) => TitleActionStatus;
  gated: boolean;
  onAction: (action: TitleAction, label: string, resolution?: number) => void;
  onFindAnother?: (hash: string, episodeLabel: string, season: number, episode: number, packed: boolean) => void;
  onPickRelease?: (season: number, episode: number) => void;
  onWantedAction?: (season: number, episode: number, action: WantedAction) => void;
}) {
  const stripRef = useRef<HTMLDivElement | null>(null);
  const viewport = useCallback(
    () =>
      stripRef.current?.querySelector<HTMLElement>(
        '[data-slot="scroll-area-viewport"]',
      ) ?? null,
    [],
  );
  const [edges, setEdges] = useState({ start: false, end: false });
  const updateEdges = useCallback(() => {
    const element = viewport();
    if (!element) return;
    const measured = railEdges({
      scrollLeft: element.scrollLeft,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    });
    setEdges({
      start: measured.scrollable && !measured.atStart,
      end: measured.scrollable && !measured.atEnd,
    });
  }, [viewport]);
  useEffect(() => {
    const element = viewport();
    const list = element?.querySelector("ul");
    if (!element || !list) return;
    updateEdges();
    element.addEventListener("scroll", updateEdges, { passive: true });
    const observer = new ResizeObserver(updateEdges);
    observer.observe(element);
    observer.observe(list);
    return () => {
      element.removeEventListener("scroll", updateEdges);
      observer.disconnect();
    };
  }, [episodes.length, updateEdges, viewport, view.kind, busy]);
  const scrollStrip = useCallback(
    (direction: -1 | 1) => {
      const element = viewport();
      if (!element) return;
      element.scrollBy({
        left: direction * pageScrollDelta(element.clientWidth),
        behavior: "smooth",
      });
    },
    [viewport],
  );
  return (
    <>
      {busy || view.kind === "loading" ? (
        <EpisodeSkeletonStrip
          count={view.kind === "loading" ? view.skeletonRows : Math.max(episodes.length, 3)}
          label={
            season != null
              ? `Loading season ${season} episodes…`
              : "Loading episodes…"
          }
        />
      ) : view.kind === "error" ? (
        <p
          role="alert"
          className="surface mt-3 px-4 py-6 text-[13px] leading-relaxed text-subtle-foreground"
        >
          Could not load this season&apos;s episodes. {view.message}
        </p>
      ) : view.kind === "empty" ? (
        <p className="surface mt-3 px-4 py-6 text-[13px] leading-relaxed text-subtle-foreground">

          {EMPTY_EPISODES_COPY}
        </p>
      ) : (
        <>
          <div className="relative mt-3">

            {edges.start ? (
              <StripArrow direction="left" onClick={() => scrollStrip(-1)} />
            ) : null}
            {edges.end ? (
              <StripArrow direction="right" onClick={() => scrollStrip(1)} />
            ) : null}

            <ScrollArea
              ref={stripRef}
              className={cn(
                "sm:[&>[data-slot=scroll-area-viewport]]:snap-x sm:[&>[data-slot=scroll-area-viewport]]:snap-mandatory",
                "max-sm:[&>[data-slot=scroll-area-viewport]>div]:block!",
                edges.start && edges.end
                  ? "sm:[mask-image:linear-gradient(to_right,transparent,black_40px,black_calc(100%-64px),transparent)]"
                  : edges.end
                    ? "sm:[mask-image:linear-gradient(to_right,black_calc(100%-64px),transparent)]"
                    : edges.start
                      ? "sm:[mask-image:linear-gradient(to_right,transparent,black_40px)]"
                      : null,
              )}
            >
            <ul
              data-episode-strip
              className="grid grid-cols-1 gap-2 sm:flex sm:gap-3 sm:pb-3"
            >
              {episodes.map((episode) => (
                <EpisodeCard
                  key={episode.episode}
                  episode={episode}
                  gated={gated}
                  downloadStatus={statusFor(
                    episodeIntentKey(episode.season, episode.episode),
                  )}
                  onAction={onAction}
                  onFindAnother={onFindAnother}
                  onPickRelease={onPickRelease}
                  onWantedAction={onWantedAction}
                />
              ))}
            </ul>
            <ScrollBar orientation="horizontal" />
            </ScrollArea>
          </div>
          {truncated ? (
            <p className="mt-2 text-[12px] text-subtle-foreground">
              Only the first {episodes.length} episodes are listed.
            </p>
          ) : null}
        </>
      )}


    </>
  );
}

function StripArrow({
  direction,
  onClick,
}: {
  direction: "left" | "right";
  onClick: () => void;
}) {
  const Icon = direction === "left" ? ChevronLeft : ChevronRight;
  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      aria-hidden
      tabIndex={-1}
      data-strip-arrow={direction}
      onClick={onClick}
      className={cn(
        "absolute top-[calc(28%_-_1rem)] z-30 hidden rounded-full bg-card text-muted-foreground shadow-md hover:text-foreground lg:inline-flex dark:bg-card",
        direction === "left" ? "-left-3" : "-right-3",
      )}
    >
      <Icon aria-hidden />
    </Button>
  );
}

function EpisodeSkeletonStrip({
  count,
  label,
}: {
  count: number;
  label: string;
}) {
  return (
    <div
      className="mt-3"
      data-episode-skeletons
      aria-busy="true"
      aria-label={label}
    >

      <ul
        className="grid grid-cols-1 gap-2 sm:flex sm:gap-3 sm:overflow-x-hidden"
        aria-label={label}
      >
        {Array.from({ length: count }, (_, i) => (
          <li
            key={i}
            className={cn(
              "surface flex min-h-[96px] overflow-hidden p-0 sm:block sm:min-h-0",
              CARD_WIDTH,
            )}
            data-episode-skeleton
          >
            <Skeleton className="h-24 w-16 shrink-0 rounded-none sm:aspect-video sm:h-auto sm:w-full" />
            <span className="min-w-0 flex-1 p-3">
              <Skeleton className="h-3.5 w-3/4 rounded" />
              <Skeleton className="mt-2 h-2.5 w-full rounded" />
              <Skeleton className="mt-1.5 h-2.5 w-2/3 rounded" />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
