"use client";

/**
 * Seasons and episodes — the half of the title page that is not the hero.
 *
 * The agreed shape is one row per episode, each with **its own availability
 * indicator and its own single Play/Get button**. That is the whole design
 * constraint: no row may hand the user off to a list of releases, and no row
 * may claim a state it did not check.
 *
 * Three judgements are baked into a row:
 *
 *  - **A row has to say what the episode is.** "S02E01 · Not checked · Get"
 *    is a filename with better spacing, and drew the same verdict as the rest
 *    of the app once did: *"a website you go to view torrent lists"*. The name,
 *    air date, runtime and synopsis come from the extras round trip and are
 *    merged in when they arrive.
 *  - **A chip only earns its place when it says something actionable.**
 *    `availability: null` means nobody has looked, and a badge repeating that
 *    on every row of a season is a diagnostics dump, not information. Null
 *    renders as *no chip* — the row is still clickable and Get still says what
 *    it means. This is not the same as calling it `unavailable`, which is a
 *    claim, and one we never make per-episode.
 *  - **An unaired episode gets no button.** Offering "Get" for something
 *    that does not exist yet is the app asserting a state it never checked. It
 *    prints its air date instead — plain text, so there is no disabled control
 *    for a keyboard user to land on. A local file always wins over a future
 *    date, because bad provider data must never hide a file we actually hold.
 */
import { Check, Download, Loader2, Play } from "lucide-react";
import { AvailabilityChip } from "@/components/browse/availability-chip";
import { PosterImage } from "@/components/browse/poster-image";
import { formatClock, progressPercent } from "@/components/browse/availability";
import { Button } from "@/components/ui/button";
import { cn, factsLine } from "@/lib/utils";
import {
  formatAirDate,
  formatRuntime,
  isUnaired,
  type EpisodeRowModel,
} from "./merge-extras";
import {
  EMPTY_EPISODES_COPY,
  episodeListView,
  episodeSeasonSummary,
  type EpisodeListLoadState,
} from "./episode-list-state";
import {
  resolveEpisodeAction,
  shouldRunTitleAction,
  titleActionButtonLabel,
  type TitleAction,
  type TitleActionStatus,
} from "./title-actions";
import {
  canOfferSeasonGrab,
  seasonGrabStrategySummary,
  seasonGrabSummary,
  shouldRunSeasonGrab,
  type SeasonGrabStatus,
} from "./season-grab-state";
import type { TitleSeason } from "./types";

export interface EpisodeListProps {
  seasons: TitleSeason[];
  season: number | null;
  episodes: EpisodeRowModel[];
  truncated: boolean;
  loadState: EpisodeListLoadState;
  /** Non-null while a season change is in flight, so the list can dim. */
  busy: boolean;
  statusFor: (key: string) => TitleActionStatus;
  seasonGrabStatus: SeasonGrabStatus;
  onSeasonChange: (season: number) => void;
  onSeasonGrab: (season: number, episodes: number[]) => void;
  onAction: (action: TitleAction, label: string) => void;
}

/** Stable per-row key for tracking one in-flight action. */
export function episodeActionKey(season: number, episode: number): string {
  return `s${season}e${episode}`;
}

export function EpisodeList({
  seasons,
  season,
  episodes,
  truncated,
  loadState,
  busy,
  statusFor,
  seasonGrabStatus,
  onSeasonChange,
  onSeasonGrab,
  onAction,
}: EpisodeListProps) {
  const view = episodeListView(loadState, episodes.length);
  const showSeasonGrab = canOfferSeasonGrab(season, episodes.length);
  const seasonGrabCanRun =
    showSeasonGrab && shouldRunSeasonGrab(seasonGrabStatus);
  const seasonGrabSummaryId =
    showSeasonGrab && season != null ? `season-${season}-grab-status` : undefined;

  return (
    <section aria-labelledby="title-episodes-heading" data-title-episodes>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="title-episodes-heading" className="text-title">
          Episodes
        </h2>
        {season != null ? (
          <p className="text-[12px] text-[var(--text-tertiary)]">
            {episodeSeasonSummary(season, episodes.length, loadState)}
          </p>
        ) : null}
      </div>

      {seasons.length > 1 || showSeasonGrab ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          {seasons.length > 1 ? (
            <nav aria-label="Seasons" className="min-w-0 flex-1">
              <ul className="flex snap-x gap-1.5 overflow-x-auto pb-1">
                {seasons.map((s) => {
                  const current = s.season === season;
                  return (
                    <li key={s.season} className="shrink-0 snap-start">
                      <button
                        type="button"
                        data-season-tab
                        aria-pressed={current}
                        onClick={() => onSeasonChange(s.season)}
                        className={cn(
                          "rounded-[var(--radius)] border px-3 py-1.5 text-[12px] font-medium transition-colors",
                          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
                          current
                            ? "border-transparent bg-[var(--accent)] text-[var(--primary-foreground)]"
                            : "border-[var(--border)] bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text)]",
                        )}
                      >
                        Season {s.season}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </nav>
          ) : null}

          {showSeasonGrab && season != null ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              data-season-grab
              aria-busy={seasonGrabStatus.status === "pending" || undefined}
              aria-describedby={seasonGrabSummaryId}
              disabled={!seasonGrabCanRun}
              onClick={() =>
                onSeasonGrab(
                  season,
                  episodes.map((episode) => episode.episode),
                )
              }
              className="shrink-0"
            >
              {seasonGrabStatus.status === "pending" ? (
                <Loader2 className="animate-spin" aria-hidden />
              ) : (
                <Download aria-hidden />
              )}
              Download season
            </Button>
          ) : null}
        </div>
      ) : null}

      {showSeasonGrab && season != null ? (
        <SeasonGrabReportLine
          id={seasonGrabSummaryId}
          season={season}
          status={seasonGrabStatus}
        />
      ) : null}

      {view.kind === "loading" ? (
        <EpisodeSkeletonRows rows={view.skeletonRows} />
      ) : view.kind === "error" ? (
        <p
          role="alert"
          className="surface mt-3 px-4 py-6 text-[13px] leading-relaxed text-[var(--text-tertiary)]"
        >
          Could not load this season&apos;s episodes. {view.message}
        </p>
      ) : view.kind === "empty" ? (
        <p className="surface mt-3 px-4 py-6 text-[13px] leading-relaxed text-[var(--text-tertiary)]">
          {/* Not an empty state: the page has plenty on it. This is the honest
              answer to "how many episodes are there?" — which nothing local
              knows until something for this show has been searched or grabbed. */}
          {EMPTY_EPISODES_COPY}
        </p>
      ) : (
        <>
          <ul
            className={cn(
              "mt-3 space-y-1.5",
              (busy || view.dim) && "opacity-60",
            )}
          >
            {episodes.map((episode) => (
              <EpisodeRow
                key={episode.episode}
                episode={episode}
                status={statusFor(
                  episodeActionKey(episode.season, episode.episode),
                )}
                onAction={onAction}
              />
            ))}
          </ul>
          {truncated ? (
            <p className="mt-2 text-[12px] text-[var(--text-tertiary)]">
              Only the first {episodes.length} episodes are listed.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

function SeasonGrabReportLine({
  id,
  season,
  status,
}: {
  id?: string;
  season: number;
  status: SeasonGrabStatus;
}) {
  if (status.status === "idle") return null;
  const strategy =
    status.status === "done" ? seasonGrabStrategySummary(status.report) : null;
  return (
    <div
      id={id}
      className="mt-2 text-[12px] leading-relaxed text-[var(--text-tertiary)]"
      role={status.status === "error" ? "alert" : "status"}
      data-season-grab-report
    >
      <p>{seasonGrabSummary(status, season)}</p>
      {strategy ? <p>{strategy}</p> : null}
    </div>
  );
}

function EpisodeSkeletonRows({ rows }: { rows: number }) {
  return (
    <ul
      className="mt-3 space-y-1.5"
      aria-label="Loading episodes"
      aria-busy="true"
      data-episode-skeletons
    >
      {Array.from({ length: rows }, (_, i) => (
        <li
          key={i}
          className="surface flex items-start gap-3 px-3 py-2.5"
          data-episode-skeleton
        >
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline gap-2">
              <span className="skeleton h-3 w-12 rounded" />
              <span className="skeleton h-3.5 w-40 rounded" />
            </span>
            <span className="mt-2 block">
              <span className="skeleton block h-2.5 w-56 max-w-full rounded" />
            </span>
          </span>
          <span className="skeleton h-8 w-16 shrink-0 self-center rounded-[var(--radius)]" />
        </li>
      ))}
    </ul>
  );
}

function EpisodeRow({
  episode,
  status,
  onAction,
}: {
  episode: EpisodeRowModel;
  status: TitleActionStatus;
  onAction: (action: TitleAction, label: string) => void;
}) {
  const action = resolveEpisodeAction(episode);
  const effectiveStatus =
    action.kind === "play" && status === "done" ? "idle" : status;
  const label = titleActionButtonLabel(action, effectiveStatus);
  const canRun = shouldRunTitleAction(action, effectiveStatus);
  const actionStatusText = episodeActionStatusText(
    episode.label,
    effectiveStatus,
  );
  const downloaded = progressPercent(episode.downloadFraction);
  const watched = progressPercent(episode.watchedFraction);
  const resumeAt = formatClock(episode.resumePositionSec);
  const meta = episode.meta;
  const airDate = formatAirDate(meta?.airDate ?? null);

  // A file we hold beats a future air date. Provider dates are wrong often
  // enough that letting one hide a real download would be the worse bug.
  const unaired = action.kind !== "play" && isUnaired(meta?.airDate ?? null);

  const facts: string[] = [];
  if (!unaired && airDate) facts.push(airDate);
  const runtime = formatRuntime(meta?.runtimeMin ?? null);
  if (runtime) facts.push(runtime);
  if (episode.fromPack) facts.push("From a season pack");
  if (downloaded != null && downloaded < 100) {
    facts.push(`${downloaded}% downloaded`);
  }
  if (resumeAt) facts.push(`Resume at ${resumeAt}`);
  else if (watched != null && watched < 100) facts.push(`${watched}% watched`);
  const factsText = factsLine(facts);

  // Only actionable states get a badge. `null` means nobody has looked, and a
  // chip saying so on every row of a season conveys nothing.
  const showChip = episode.availability != null;
  const showTags = showChip || episode.nextUp || episode.watched;

  return (
    <li
      data-episode-row
      data-episode={episode.episode}
      data-availability={episode.availability ?? "unresolved"}
      className={cn(
        "surface flex items-start gap-3 px-3 py-2.5",
        "transition-colors hover:border-[var(--border-strong)]",
      )}
    >
      {meta?.stillUrl ? (
        <span className="relative block aspect-video w-[88px] shrink-0 overflow-hidden rounded-[6px] border border-[var(--border)] bg-[var(--bg-muted)] sm:w-[128px]">
          <PosterImage
            src={meta.stillUrl}
            title={meta.name ?? episode.label}
            sizes="128px"
            variant="plain"
            className="object-cover"
          />
        </span>
      ) : null}

      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-[12px] font-medium tabular-nums text-[var(--text-secondary)]">
            {episode.label}
          </span>
          {meta?.name ? (
            <span
              data-episode-name
              className="min-w-0 text-[13px] font-medium text-[var(--text)]"
            >
              {meta.name}
            </span>
          ) : null}
        </span>

        {showTags ? (
          <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
            {showChip ? (
              <AvailabilityChip state={episode.availability} compact />
            ) : null}
            {episode.nextUp ? (
              <span className="rounded-[5px] border border-[var(--border)] bg-[var(--bg-muted)] px-1.5 py-1 text-[10px] font-medium leading-none text-[var(--text-secondary)]">
                Next up
              </span>
            ) : null}
            {episode.watched ? (
              <span className="inline-flex items-center gap-1 text-[11px] text-[var(--text-tertiary)]">
                <Check className="h-3 w-3" aria-hidden />
                Watched
              </span>
            ) : null}
          </span>
        ) : null}

        {factsText ? (
          <span className="mt-1 flex flex-wrap items-center text-[11px] text-[var(--text-tertiary)]">
            {factsText}
          </span>
        ) : null}

        {actionStatusText ? (
          <span
            className="mt-1 block text-[11px] text-[var(--text-tertiary)]"
            data-episode-action-status
          >
            {actionStatusText}
          </span>
        ) : null}

        {meta?.overview ? (
          <span className="mt-1 line-clamp-2 block text-[12px] leading-relaxed text-[var(--text-tertiary)]">
            {meta.overview}
          </span>
        ) : null}
      </span>

      {unaired ? (
        /* Plain text, not a disabled button: there is nothing to press, so
           there should be nothing to tab to. */
        <span
          data-episode-unaired
          className="shrink-0 self-center whitespace-nowrap rounded-[var(--radius)] border border-[var(--border)] px-2.5 py-1.5 text-[11px] text-[var(--text-tertiary)]"
        >
          {airDate ? `Airs ${airDate}` : "Not aired yet"}
        </span>
      ) : (
        <Button
          type="button"
          size="sm"
          variant={action.kind === "play" ? "default" : "secondary"}
          data-episode-action
          data-action-kind={action.kind}
          aria-label={`${label} — ${episode.label}`}
          aria-busy={effectiveStatus === "pending" || undefined}
          disabled={!canRun}
          onClick={() => onAction(action, episode.label)}
          className="shrink-0 self-center"
        >
          {effectiveStatus === "pending" ? (
            <Loader2 className="animate-spin" aria-hidden />
          ) : action.kind === "play" ? (
            <Play className="fill-current" aria-hidden />
          ) : (
            <Download aria-hidden />
          )}
          {label}
        </Button>
      )}
    </li>
  );
}

function episodeActionStatusText(
  label: string,
  status: TitleActionStatus,
): string | null {
  if (status === "pending") return `Getting ${label} ready…`;
  if (status === "done") return `Getting ${label}`;
  if (status === "error") return `Could not get ${label}.`;
  return null;
}
