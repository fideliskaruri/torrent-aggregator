/**
 * Seasons and episodes, as a horizontal filmstrip.
 *
 * A horizontally scrolling strip of stills, one card per episode, with the
 * Download action as a small affordance in the corner. The judgements baked
 * into the strip are the whole point of the component:
 *
 *  - **A row/card only claims a state it checked.** `availability: null` means
 *    nobody has looked — the Download control still says "Download", not
 *    "Unavailable".
 *  - **An unaired episode gets no controls.** It prints its air date as plain
 *    text, so there is no disabled button for a keyboard user to land on. A
 *    local file always wins over a future date.
 *
 * The header carries the season picker, one download-progress line for the
 * loaded season and the season-scoped Download button.
 */
import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  Loader2,
  RotateCcw,
  Search,
  Tv,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { PosterImage } from "@/components/browse/poster-image";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Progress } from "@/components/ui/progress";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useCapabilities } from "@/lib/capabilities";
import {
  formatAirDate,
  isUnaired,
  type EpisodeRowModel,
} from "./merge-extras";
import {
  EMPTY_EPISODES_COPY,
  episodeListView,
  episodeSeasonCountLabel,
  type EpisodeListLoadState,
} from "./episode-list-state";
import {
  shouldRunTitleAction,
  transferStateLabel,
  type TitleAction,
  type TitleActionStatus,
} from "./title-actions";
import {
  canOfferSeasonGrab,
  shouldRunSeasonGrab,
  type SeasonGrabStatus,
} from "./season-grab-state";
import { QualityPicker } from "./quality-picker";
import { shouldAskForQuality } from "./quality-picker-state";
import { usePreferredQuality } from "./use-preferred-quality";
import type { TitleSeason, TitleTransferState } from "./types";
import { seasonProgressLabel, type SeasonProgress } from "./season-progress";
import { SeasonProgressMeter } from "./season-progress-meter";

export interface EpisodeListProps {
  seasons: TitleSeason[];
  /** Downloaded progress per season number; see `season-progress.ts`. */
  seasonProgress?: Record<number, SeasonProgress>;
  season: number | null;
  episodes: EpisodeRowModel[];
  /** Episodes in the season before the row cap; defaults to the rendered count. */
  episodeTotal?: number;
  truncated: boolean;
  loadState: EpisodeListLoadState;
  /** Non-null while a season change is in flight. */
  busy: boolean;
  statusFor: (key: string) => TitleActionStatus;
  seasonGrabStatus: SeasonGrabStatus;
  /**
   * The whole work is future-dated. Every episode of it is unaired by
   * definition, so the season controls are withheld exactly like the hero's —
   * a "Download season" for a show that has not started is a button that can
   * only ever fail.
   */
  gated?: boolean;
  onSeasonChange: (season: number) => void;
  onSeasonGrab: (season: number, episodes: number[], resolution?: number) => void;
  onAction: (action: TitleAction, label: string, resolution?: number) => void;
}

/** Stable per-row key for tracking one in-flight Download. */
export function episodeIntentKey(season: number, episode: number): string {
  return `s${season}e${episode}`;
}

/** Clamped 0–100 integer for a 0–1 fraction. */
function progressPercent(fraction: number | null | undefined): number {
  if (fraction == null || !Number.isFinite(fraction)) return 0;
  return Math.round(Math.min(1, Math.max(0, fraction)) * 100);
}

export function EpisodeList({
  seasons,
  seasonProgress = {},
  season,
  episodes,
  episodeTotal,
  truncated,
  loadState,
  busy,
  statusFor,
  seasonGrabStatus,
  gated = false,
  onSeasonChange,
  onSeasonGrab,
  onAction,
}: EpisodeListProps) {
  const { canDownload } = useCapabilities();
  const { preferredResolution, alwaysPreferred, setAlwaysPreferred } = usePreferredQuality();

  // Single quality picker for the whole list. One picker serves every card's
  // Download control — opening it records what triggered it, and on confirm
  // the right action is dispatched.
  type PendingDownload =
    | { kind: "episode"; action: TitleAction; label: string }
    | { kind: "season"; targetSeason: number; episodeNums: number[] };
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pendingDownload, setPendingDownload] = useState<PendingDownload | null>(null);

  // The scroll container is the ScrollArea viewport around the strip.
  const stripRef = useRef<HTMLDivElement | null>(null);
  const stripViewport = useCallback(
    () =>
      stripRef.current?.querySelector<HTMLElement>(
        '[data-slot="scroll-area-viewport"]',
      ) ?? null,
    [],
  );
  const [edges, setEdges] = useState({ start: false, end: false });
  const updateEdges = useCallback(() => {
    const el = stripViewport();
    if (!el) return;
    const start = el.scrollLeft > 4;
    const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 4;
    setEdges((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
  }, [stripViewport]);
  useEffect(() => {
    const el = stripViewport();
    if (!el || typeof ResizeObserver === "undefined") return;
    updateEdges();
    el.addEventListener("scroll", updateEdges, { passive: true });
    const observer = new ResizeObserver(updateEdges);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", updateEdges);
      observer.disconnect();
    };
  }, [stripViewport, updateEdges, episodes.length, loadState.status, busy]);

  const openPickerFor = useCallback((pending: PendingDownload) => {
    setPendingDownload(pending);
    setPickerOpen(true);
  }, []);

  // One stable handler for every card. Without this, each card received a fresh
  // inline closure on every render, so the transfer poll re-rendered the whole
  // strip. Paired with the memoised card below, a poll now re-renders only the
  // card whose transfer state actually changed — the download icon — not the
  // list.
  const handleCardAction = useCallback(
    (action: TitleAction, label: string) => {
      // Download asks for a quality unless the user chose "always preferred".
      if (shouldAskForQuality(alwaysPreferred)) {
        openPickerFor({ kind: "episode", action, label });
      } else {
        onAction(action, label, preferredResolution);
      }
    },
    [alwaysPreferred, preferredResolution, onAction, openPickerFor],
  );

  function handlePickerConfirm(resolution: number) {
    setPickerOpen(false);
    if (!pendingDownload) return;
    if (pendingDownload.kind === "episode") {
      onAction(pendingDownload.action, pendingDownload.label, resolution);
    } else {
      onSeasonGrab(pendingDownload.targetSeason, pendingDownload.episodeNums, resolution);
    }
    setPendingDownload(null);
  }

  function handlePickerOpenChange(open: boolean) {
    setPickerOpen(open);
    if (!open) setPendingDownload(null);
  }

  function scrollStrip(direction: -1 | 1) {
    const el = stripViewport();
    if (!el) return;
    el.scrollBy({ left: direction * Math.round(el.clientWidth * 0.9), behavior: "smooth" });
  }

  const view = episodeListView(loadState, episodes.length);
  const showSeasonGrab = !gated && canOfferSeasonGrab(season, episodes.length);
  const seasonDownloadCanRun =
    showSeasonGrab && shouldRunSeasonGrab(seasonGrabStatus);
  // Episode count next to the season control — the select already names the
  // season, so "7 episodes" beats the old "7 in season 1" echo.
  const seasonCountLabel =
    season != null
      ? episodeSeasonCountLabel(Math.max(episodeTotal ?? 0, episodes.length), loadState, season)
      : null;
  const activeProgress =
    season != null && !busy && view.kind !== "loading" ? seasonProgress[season] ?? null : null;
  const activeProgressLabel = activeProgress ? seasonProgressLabel(activeProgress) : null;

  return (
    <section aria-labelledby="title-episodes-heading" data-title-episodes>
      {seasons.length > 1 || showSeasonGrab || season != null ? (
        <div
          data-season-toolbar
          className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 sm:flex sm:flex-wrap"
        >
          <h2 id="title-episodes-heading" className="text-title min-w-0 sm:w-auto">
            Episodes
          </h2>
          <div className="col-span-2 row-start-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 sm:col-auto sm:row-auto">
            {seasons.length > 1 ? (
              <Select
                value={season != null ? String(season) : undefined}
                onValueChange={(value) => {
                  const next = Number(value);
                  if (Number.isFinite(next)) onSeasonChange(next);
                }}
              >
                <SelectTrigger
                  data-season-select
                  aria-label="Season"
                  className="min-w-0 shrink-0 bg-card font-medium dark:bg-card"
                >
                  <SelectValue placeholder="Season" />
                </SelectTrigger>
                <SelectContent position="popper" align="start">
                  {seasons.map((s) => (
                    <SelectItem
                      key={s.season}
                      value={String(s.season)}
                      data-season-option={s.season}
                    >
                      Season {s.season}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : season != null ? (
              <span
                data-season-label
                className="text-[13px] font-medium text-foreground"
              >
                Season {season}
              </span>
            ) : null}

            {seasonCountLabel && !(activeProgressLabel && activeProgress?.aired != null) ? (
              <p
                data-season-count
                className="text-[12px] tabular-nums text-subtle-foreground"
              >
                {seasonCountLabel}
              </p>
            ) : null}

            {activeProgress && activeProgressLabel ? (
              <SeasonProgressMeter
                progress={activeProgress}
                label={activeProgressLabel}
                data-season-progress
              />
            ) : null}
          </div>

          {showSeasonGrab && canDownload && season != null ? (
            <div className="col-start-2 row-start-1 ml-auto flex items-center justify-end sm:col-auto sm:row-auto sm:w-auto">
              <Button
                type="button"
                size="sm"
                data-season-grab
                data-action="download"
                aria-busy={seasonGrabStatus.status === "pending" || undefined}
                disabled={!seasonDownloadCanRun}
                onClick={() => {
                  if (season == null) return;
                  const episodeNums = episodes.map((e) => e.episode);
                  if (shouldAskForQuality(alwaysPreferred)) {
                    openPickerFor({ kind: "season", targetSeason: season, episodeNums });
                  } else {
                    onSeasonGrab(season, episodeNums, preferredResolution);
                  }
                }}
                className="relative min-h-[44px] w-auto lg:min-h-0"
              >
                <ButtonBody
                  pending={seasonGrabStatus.status === "pending"}
                  icon={<Download aria-hidden />}
                >
                  Download season
                </ButtonBody>
              </Button>
            </div>
          ) : null}

        </div>
      ) : (
        <h2 id="title-episodes-heading" className="text-title">Episodes</h2>
      )}

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
          {/* Not an empty state: the page has plenty on it. This is the honest
              answer to "how many episodes are there?" — which nothing local
              knows until something for this show has been searched or grabbed. */}
          {EMPTY_EPISODES_COPY}
        </p>
      ) : (
        <>
          <div className="relative mt-3">
            {/* Touch, trackpad and keyboard scroll the strip natively. Its
                scrollbar is hidden: the arrows and the faded edge already say
                "there is more", and a bar under an arrow said it twice. Each
                arrow shows only on a side that has more, and both are hidden
                from assistive tech (the strip scrolls on its own). */}
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
                // Phones stack the cards; Radix's table wrapper would let a long
                // name widen the column past the screen.
                "max-sm:[&>[data-slot=scroll-area-viewport]>div]:block!",
                // A card cut at the edge reads as a layout bug; fading the side
                // that has more makes the cut read as "keep scrolling".
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
                  onAction={handleCardAction}
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

      {/* One quality picker for the entire strip. Every card's Download and the
          Download season button route through it. */}
      <QualityPicker
        open={pickerOpen}
        onOpenChange={handlePickerOpenChange}
        preferredResolution={preferredResolution}
        alwaysPreferred={alwaysPreferred}
        onAlwaysPreferredChange={setAlwaysPreferred}
        onConfirm={handlePickerConfirm}
      />
    </section>
  );
}

/**
 * Renders a button's icon + label with a spinner **overlaid** on top when
 * pending, instead of swapping the label out for the spinner. The label stays
 * mounted (only made invisible) so the button keeps identical width/height in
 * both idle and loading states — no layout shift, no "jumping" controls.
 */
function ButtonBody({
  pending,
  icon,
  children,
}: {
  pending: boolean;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <span
        className={cn(
          "inline-flex items-center gap-1.5",
          pending && "invisible",
        )}
      >
        {icon}
        {children}
      </span>
      {pending ? (
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Loader2 className="animate-spin" aria-hidden />
        </span>
      ) : null}
    </>
  );
}

/**
 * Desktop-only edge control for the strip. Touch, trackpad and keyboard scroll
 * the strip on their own, so it stays out of the tab order and away from
 * assistive tech.
 */
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

/** Shared card width so skeletons and real cards reserve identical geometry. */
const CARD_WIDTH = "w-full sm:w-[300px] sm:shrink-0 sm:snap-start";

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
      {/* The visible loading line was removed as noise; the busy region stays
          labelled for assistive tech via aria-busy + aria-label above. */}
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

function EpisodeCardImpl({
  episode,
  gated = false,
  downloadStatus,
  onAction,
}: {
  episode: EpisodeRowModel;
  /** The whole work is future-dated — see `EpisodeListProps.gated`. */
  gated?: boolean;
  downloadStatus: TitleActionStatus;
  onAction: (action: TitleAction, label: string, resolution?: number) => void;
}) {
  const { canDownload } = useCapabilities();
  const transfer = episode.transfer;
  const downloadAction: TitleAction = {
    kind: "get",
    label: "Download",
    season: episode.season,
    episode: episode.episode,
    infoHash: episode.infoHash,
  };

  const held =
    transfer?.status === "downloaded" ||
    (episode.availability === "ready" && !episode.fromPack);
  const downloadDisplayLabel = transfer?.status === "failed"
    ? "Retry download"
    : transfer?.status === "queued"
      ? transferStateLabel(transfer.state, transfer.queuePosition) ?? "Queued"
      : transfer?.status === "downloading"
        ? `Downloading ${formatTransferProgress(transfer.progress)}`
        : held
          ? "Downloaded"
          : downloadStatus === "done"
            ? "Queued"
          : downloadStatus === "error"
            ? "Retry download"
            : downloadAction.label;
  const downloadCanRun =
    !held &&
    transfer?.status !== "queued" &&
    transfer?.status !== "downloading" &&
    shouldRunTitleAction(downloadStatus);

  const meta = episode.meta;
  const airDate = formatAirDate(meta?.airDate ?? null);

  // A file we hold, fully or in part, beats a future air date. Provider dates
  // are wrong often enough that letting one hide a real download would be the
  // worse bug. A future-dated *work* gates every card, including ones the
  // provider has not given an air date for at all.
  const onDisk =
    (transfer?.status === "downloaded" && Boolean(transfer.infoHash)) ||
    ((episode.availability === "ready" || episode.availability === "warm") &&
      Boolean(episode.infoHash?.trim()));
  const unaired = !onDisk && (gated || isUnaired(meta?.airDate ?? null));

  // The progress strip on the still shows a download that is still moving,
  // and nothing once the file is here.
  const downloadingProgress =
    transfer?.status === "downloading" ? transfer.progress : null;
  const progressPct = held
    ? 0
    : progressPercent(episode.downloadFraction ?? downloadingProgress);

  // The badge on the still already says "E2", so the caption is the episode's
  // name alone. "S01E02 · Name" under an "E2" badge printed the number twice.
  const episodeName = meta?.name?.trim() || `Episode ${episode.episode}`;
  const [synopsisOpen, setSynopsisOpen] = useState(false);
  const overview = meta?.overview?.trim() || null;
  // Roughly two caption lines at 300px; anything longer earns a "More".
  const overviewClamped = overview != null && overview.length > 90;
  const runtime = meta?.runtimeMin ? `${meta.runtimeMin} min` : null;
  const desktopFacts = [airDate, runtime].filter(Boolean).join(" · ");

  const still = (
    <span
      data-episode-still
      className="relative block h-24 w-16 shrink-0 overflow-hidden bg-muted sm:aspect-video sm:h-auto sm:w-full"
    >
      {meta?.stillUrl ? (
        <EpisodeStillImage src={meta.stillUrl} title={episodeName} />
      ) : (
        <span aria-hidden className="absolute inset-0 flex items-center justify-center text-input">
          <Tv className="size-6 sm:size-8" />
        </span>
      )}
      <Badge
        data-episode-badge
        className="absolute left-2 top-2 border-transparent bg-background/80 font-semibold tabular-nums text-foreground backdrop-blur-sm"
      >
        E{episode.episode}
      </Badge>
      {progressPct > 0 ? (
        <Progress
          data-episode-progress
          value={progressPct}
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-1 rounded-none bg-background/55"
          indicatorClassName="bg-brand-foreground"
        />
      ) : null}
    </span>
  );

  const available = episode.available ?? (episode.availability === "ready" || episode.availability === "warm");
  // Requesters get the plain state of the owner's download, never its place in line.
  const requesterLabel = available ? "Available" : transferStateLabel(episode.state);
  const mobileMeta = [
    airDate,
    canDownload ? downloadDisplayLabel : requesterLabel,
  ]
    .filter(Boolean)
    .join(" · ");

  const caption = (
    <span className={cn("min-w-0 flex-1 p-3 sm:flex sm:flex-col sm:p-3", !unaired && "pb-14 sm:pb-3")}>
      <span
        data-episode-name
        title={episodeName}
        className="line-clamp-2 break-words text-[13px] font-medium text-foreground sm:block sm:truncate"
      >
        {episodeName}
      </span>
      {mobileMeta ? (
        <span className="mt-1 block break-words text-[12px] leading-relaxed text-subtle-foreground sm:hidden">
          {mobileMeta}
        </span>
      ) : null}
      {/* Two lines, always reserved, so every card in the rail is the same
          height whether its synopsis is long, short or missing. */}
      <span
        data-episode-overview
        className="mt-1 hidden min-h-[calc(2*1.625*12px)] text-[12px] leading-relaxed text-subtle-foreground sm:line-clamp-2"
      >
        {overview ?? ""}
      </span>
      {/* Plain text when unaired, not a disabled button: there is nothing to
          press, so there should be nothing to tab to. */}
      <span
        data-episode-unaired={unaired || undefined}
        className="mt-2 hidden min-h-5 items-center text-[12px] tabular-nums text-subtle-foreground sm:flex"
      >
        {unaired ? (airDate ? `Airs ${airDate}` : "Not aired yet") : desktopFacts}
      </span>
    </span>
  );

  // Closing hands focus back to the "More" toggle so keyboard users land
  // where they started instead of at the top of the page.
  const closeSynopsis = (from: HTMLElement) => {
    const toggle = from
      .closest("li")
      ?.querySelector<HTMLButtonElement>("[data-episode-synopsis-toggle]");
    setSynopsisOpen(false);
    toggle?.focus();
  };

  // The trigger stays under the panel while it is open; the panel covers the
  // whole card and carries its own close control.
  const synopsis = overviewClamped && overview ? (
    <Collapsible open={synopsisOpen} onOpenChange={setSynopsisOpen}>
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="link"
          data-episode-synopsis-toggle
          aria-label={`Read the synopsis of ${episodeName}`}
          onClick={(event) => event.stopPropagation()}
          className="absolute bottom-0 right-0 z-10 hidden h-11 rounded-none px-3 text-xs text-muted-foreground underline-offset-2 hover:text-foreground focus-visible:ring-inset sm:inline-flex"
        >
          More
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent asChild>
        <div
          data-episode-synopsis
          role="region"
          aria-label={`Synopsis of ${episodeName}`}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            closeSynopsis(event.currentTarget);
          }}
          // Phone rows are compact and carry no synopsis, so the overlay is
          // desktop only; a stale open state must not cover the phone row.
          className="absolute inset-0 z-20 hidden flex-col bg-card p-3 sm:flex"
        >
          <div className="flex items-start gap-2">
            <p className="min-w-0 flex-1 text-[13px] font-medium text-foreground">
              <span className="tabular-nums text-subtle-foreground">E{episode.episode}</span>{" "}
              {episodeName}
            </p>
            <Button
              type="button"
              variant="ghost"
              size="icon-lg"
              aria-label="Close synopsis"
              onClick={(event) => closeSynopsis(event.currentTarget)}
              autoFocus
              className="-mr-2 -mt-2 size-11 text-muted-foreground"
            >
              <X aria-hidden />
            </Button>
          </div>
          <p className="mt-1 min-h-0 flex-1 overflow-y-auto pr-1 text-[12px] leading-relaxed text-muted-foreground">
            {overview}
          </p>
          {desktopFacts ? (
            <p className="mt-2 text-[12px] tabular-nums text-subtle-foreground">{desktopFacts}</p>
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  ) : null;

  return (
    <li
      data-episode-row
      data-episode={episode.episode}
      data-availability={episode.availability ?? "unresolved"}
      className={cn("surface relative overflow-hidden p-0", CARD_WIDTH)}
    >
      {unaired ? (
        <div className="flex min-h-[96px] sm:block">
          {still}
          {caption}
        </div>
      ) : (
        <>
          <div className="flex min-h-[96px] w-full items-stretch text-left sm:block sm:min-h-0">
            <span className="relative block shrink-0">{still}</span>
            {caption}
          </div>

          {/* Compact Download affordance. Icon-only to stay out of the card's
              way, but a 44px touch target and a full aria-label so it is neither
              too small to hit nor mute to assistive tech. */}
          {canDownload ? (
          <span className="absolute bottom-2 right-2 z-10 sm:bottom-auto sm:top-2">
            <Button
              type="button"
              variant="outline"
              size="icon-lg"
              data-episode-action
              data-action="download"
              data-action-kind={downloadAction.kind}
              aria-label={`${downloadDisplayLabel}, ${episode.label}`}
              aria-busy={downloadStatus === "pending" || undefined}
              disabled={!downloadCanRun}
              onClick={(event) => {
                event.stopPropagation();
                onAction(downloadAction, episode.label);
              }}
              className={cn(
                "h-11 gap-1 rounded-full border-foreground/14 dark:border-foreground/14",
                // Near-opaque canvas under the glyph: on a bright still the
                // old 82% elevated frost washed the icon out.
                "bg-background/86 text-foreground shadow-sm backdrop-blur-sm dark:bg-background/86",
                "hover:border-input hover:bg-background dark:hover:bg-background",
                // Busy/done states are disabled but still report status, so they stay
                // fully opaque: fading them let a bright still wash the glyph below AA.
                "disabled:cursor-default disabled:opacity-100",
                // Downloading shows a live percentage, so the pill grows to fit
                // the digits; every other state is a single glyph in a circle.
                transfer?.status === "downloading"
                  ? "w-auto px-2.5 text-brand-foreground"
                  : "w-11",
              )}
            >
              <DownloadGlyph
                transferStatus={transfer?.status ?? null}
                transferState={transfer?.state ?? null}
                queuePosition={transfer?.queuePosition ?? null}
                progress={transfer?.progress ?? null}
                held={held}
                status={downloadStatus}
              />
            </Button>
          </span>
          ) : requesterLabel ? (
            <Badge
              data-episode-available={available || undefined}
              data-episode-state={available ? undefined : episode.state ?? undefined}
              className="absolute bottom-2 right-2 z-10 hidden bg-card/82 backdrop-blur-sm sm:bottom-auto sm:top-2 sm:inline-flex"
            >
              {requesterLabel}
            </Badge>
          ) : null}
        </>
      )}
      {synopsis}
    </li>
  );
}

/**
 * A card re-renders only when something it actually shows has changed. The
 * transfer poll hands the whole list new episode objects every 2.5s, so
 * without this every card re-rendered on every poll and the strip flickered.
 * `onAction` is stable (see `handleCardAction`), so the only things worth
 * comparing are the fields a card renders — chiefly the transfer, which is
 * what the download icon reflects.
 */
const EpisodeCard = memo(EpisodeCardImpl, (a, b) => {
  if (a.gated !== b.gated) return false;
  if (a.downloadStatus !== b.downloadStatus) return false;
  if (a.onAction !== b.onAction) return false;
  const pe = a.episode;
  const ne = b.episode;
  if (
    pe.season !== ne.season ||
    pe.episode !== ne.episode ||
    pe.label !== ne.label ||
    pe.availability !== ne.availability ||
    pe.infoHash !== ne.infoHash ||
    pe.downloadFraction !== ne.downloadFraction ||
    pe.nextUp !== ne.nextUp ||
    pe.fromPack !== ne.fromPack ||
    (pe.state ?? null) !== (ne.state ?? null)
  ) {
    return false;
  }
  // The transfer is the thing a poll moves — status and progress especially.
  const pt = pe.transfer;
  const nt = ne.transfer;
  if (
    (pt?.status ?? null) !== (nt?.status ?? null) ||
    (pt?.state ?? null) !== (nt?.state ?? null) ||
    (pt?.queuePosition ?? null) !== (nt?.queuePosition ?? null) ||
    (pt?.progress ?? null) !== (nt?.progress ?? null) ||
    (pt?.infoHash ?? null) !== (nt?.infoHash ?? null) ||
    (pt?.filePath ?? null) !== (nt?.filePath ?? null) ||
    (pt?.error ?? null) !== (nt?.error ?? null)
  ) {
    return false;
  }
  const pm = pe.meta;
  const nm = ne.meta;
  return (
    (pm?.name ?? null) === (nm?.name ?? null) &&
    (pm?.overview ?? null) === (nm?.overview ?? null) &&
    (pm?.airDate ?? null) === (nm?.airDate ?? null) &&
    (pm?.runtimeMin ?? null) === (nm?.runtimeMin ?? null) &&
    (pm?.stillUrl ?? null) === (nm?.stillUrl ?? null)
  );
});

/**
 * The episode still, memoised on its own so a card that re-renders to move its
 * download percent does not reflash the image beneath it. next/image swaps its
 * src whenever it re-renders; keeping the image out of the re-rendering path is
 * what makes "only the icon updates" true even for the one downloading card.
 */
const EpisodeStillImage = memo(function EpisodeStillImage({
  src,
  title,
}: {
  src: string;
  title: string;
}) {
  return (
    <PosterImage
      src={src}
      title={title}
      sizes="(min-width: 640px) 300px, 64px"
      variant="plain"
      className="object-cover"
    />
  );
});

/** What a card's compact Download control shows, by state. */
function DownloadGlyph({
  transferStatus,
  transferState,
  queuePosition,
  progress,
  held,
  status,
}: {
  transferStatus: "queued" | "downloading" | "downloaded" | "failed" | null;
  transferState: TitleTransferState | null;
  queuePosition: number | null;
  progress: number | null;
  held: boolean;
  status: TitleActionStatus;
}) {
  if (transferStatus === "failed" || status === "error") {
    return <RotateCcw className="h-4 w-4" aria-hidden />;
  }
  // Downloading shows a live integer percent, not an endless spinner — the
  // spinner read as "loading forever" with no sense of movement. Floored so a
  // torrent at 99.6% never prints 100% before it is actually complete.
  if (transferStatus === "downloading") {
    const pct = Math.floor(Math.max(0, Math.min(1, progress ?? 0)) * 100);
    return (
      <span className="text-[12px] font-semibold tabular-nums leading-none">
        {pct}%
      </span>
    );
  }
  // No release found yet can last days, so it is a still magnifier, not a spinner.
  if (transferState === "looking") {
    return <Search className="h-4 w-4" aria-hidden />;
  }
  // Found and waiting for a download slot: its place in line.
  if (transferStatus === "queued" && queuePosition != null) {
    return (
      <span className="text-[12px] font-semibold tabular-nums leading-none">
        #{queuePosition}
      </span>
    );
  }
  // Queued has not started moving yet — a brief spinner is honest here.
  if (transferStatus === "queued" || status === "pending") {
    return <Loader2 className="h-4 w-4 animate-spin" aria-hidden />;
  }
  if (held || transferStatus === "downloaded" || status === "done") {
    return <Check className="h-4 w-4 text-brand-foreground" aria-hidden />;
  }
  return <Download className="h-4 w-4" aria-hidden />;
}

function formatTransferProgress(progress: number): string {
  const percent = Math.min(100, Math.max(0, progress * 100));
  return `${Number.isInteger(percent) ? percent.toFixed(0) : percent.toFixed(1)}%`;
}
