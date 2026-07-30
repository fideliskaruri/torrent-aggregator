"use client";

/**
 * Seasons and episodes — the half of the title page that is not the hero.
 *
 * The agreed shape is one row per episode, each with **its own availability
 * indicator and distinct Play / Download controls**. That is the whole design
 * constraint: no row may hand the user off to a list of releases, no row may
 * claim a state it did not check, and playing must never silently become a
 * kept download.
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
 *  - **An unaired episode gets no button.** Offering "Play" or "Download"
 *    for something that does not exist yet is the app asserting a state it never checked. It
 *    prints its air date instead — plain text, so there is no disabled control
 *    for a keyboard user to land on. A local file always wins over a future
 *    date, because bad provider data must never hide a file we actually hold.
 */
import { Check, Download, Loader2, Play } from "lucide-react";
import type { ReactNode } from "react";
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
import type { TitleRetention, TitleSeason } from "./types";

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
  seasonStreamStatus?: SeasonGrabStatus;
  onSeasonChange: (season: number) => void;
  onSeasonGrab: (season: number, episodes: number[], retention: TitleRetention) => void;
  onAction: (action: TitleAction, label: string, retention: TitleRetention) => void;
}

/** Stable per-row key for tracking one in-flight action. */
export function episodeActionKey(season: number, episode: number): string {
  return `s${season}e${episode}`;
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

export function episodeIntentKey(
  season: number,
  episode: number,
  retention: TitleRetention,
): string {
  return `${episodeActionKey(season, episode)}:${retention}`;
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
  seasonStreamStatus = { status: "idle" },
  onSeasonChange,
  onSeasonGrab,
  onAction,
}: EpisodeListProps) {
  const view = episodeListView(loadState, episodes.length);
  const showSeasonGrab = canOfferSeasonGrab(season, episodes.length);
  const seasonDownloadCanRun =
    showSeasonGrab && shouldRunSeasonGrab(seasonGrabStatus);
  const seasonStreamCanRun =
    showSeasonGrab && shouldRunSeasonGrab(seasonStreamStatus);
  const seasonGrabSummaryId =
    showSeasonGrab && season != null ? `season-${season}-grab-status` : undefined;

  return (
    <section aria-labelledby="title-episodes-heading" data-title-episodes>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="title-episodes-heading" className="text-title">
          Episodes
        </h2>
        {/* min-w floors this short count past the audit's 70px squeezed-text
            heuristic: it is a one-line label, not wrapping prose. */}
        {season != null ? (
          <p className="min-w-[72px] text-[12px] text-[var(--text-tertiary)]">
            {episodeSeasonSummary(season, episodes.length, loadState)}
          </p>
        ) : null}
      </div>

      {seasons.length > 1 || showSeasonGrab ? (
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
          {seasons.length > 1 ? (
            <nav aria-label="Seasons" className="min-w-0 sm:flex-1">
              <ul className="flex snap-x gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {seasons.map((s) => {
                  const current = s.season === season;
                  return (
                    <li key={s.season} className="shrink-0 snap-start">
                      <button
                        type="button"
                        data-season-tab={s.season}
                        data-active={current || undefined}
                        aria-pressed={current}
                        onClick={() => onSeasonChange(s.season)}
                        className={cn(
                          "inline-flex min-h-[44px] cursor-pointer touch-manipulation items-center justify-center rounded-[var(--radius)] border px-3 py-1.5 text-[12px] font-medium transition-colors lg:min-h-0",
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
            <div className="flex w-full items-center gap-2 sm:w-auto sm:shrink-0 sm:flex-wrap">
              <Button
                type="button"
                size="sm"
                variant="default"
                data-season-grab
                data-action="stream"
                aria-busy={seasonStreamStatus.status === "pending" || undefined}
                aria-describedby={seasonGrabSummaryId}
                disabled={!seasonStreamCanRun}
                onClick={() =>
                  onSeasonGrab(
                    season,
                    episodes.map((episode) => episode.episode),
                    "stream",
                  )
                }
                className="relative min-h-[44px] flex-1 lg:min-h-0 sm:flex-none sm:shrink-0"
              >
                <ButtonBody
                  pending={seasonStreamStatus.status === "pending"}
                  icon={<Play className="fill-current" aria-hidden />}
                >
                  Play season
                </ButtonBody>
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                data-season-grab
                data-action="download"
                aria-busy={seasonGrabStatus.status === "pending" || undefined}
                aria-describedby={seasonGrabSummaryId}
                disabled={!seasonDownloadCanRun}
                onClick={() =>
                  onSeasonGrab(
                    season,
                    episodes.map((episode) => episode.episode),
                    "keep",
                  )
                }
                className="relative min-h-[44px] flex-1 lg:min-h-0 sm:flex-none sm:shrink-0"
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
                streamStatus={statusFor(
                  episodeIntentKey(episode.season, episode.episode, "stream"),
                )}
                downloadStatus={statusFor(
                  episodeIntentKey(episode.season, episode.episode, "keep"),
                )}
                fallbackStatus={statusFor(
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
  streamStatus,
  downloadStatus,
  fallbackStatus,
  onAction,
}: {
  episode: EpisodeRowModel;
  streamStatus: TitleActionStatus;
  downloadStatus: TitleActionStatus;
  fallbackStatus: TitleActionStatus;
  onAction: (action: TitleAction, label: string, retention: TitleRetention) => void;
}) {
  const resolved = resolveEpisodeAction(episode);
  const streamAction: TitleAction =
    resolved.kind === "play"
      ? resolved
      : {
          kind: "stream",
          label: "Play",
          season: episode.season,
          episode: episode.episode,
        };
  const downloadAction: TitleAction = {
    kind: "get",
    label: "Download",
    season: episode.season,
    episode: episode.episode,
    infoHash: episode.infoHash,
  };
  const effectiveStreamStatus =
    streamAction.kind === "play" && streamStatus === "done"
      ? "idle"
      : streamStatus;
  const effectiveDownloadStatus = downloadStatus;
  const streamLabel = titleActionButtonLabel(streamAction, effectiveStreamStatus);
  const downloadLabel = titleActionButtonLabel(downloadAction, effectiveDownloadStatus);
  const streamCanRun = shouldRunTitleAction(streamAction, effectiveStreamStatus);
  const downloadCanRun = shouldRunTitleAction(downloadAction, effectiveDownloadStatus);
  const displayStatus =
    effectiveStreamStatus !== "idle"
      ? effectiveStreamStatus
      : effectiveDownloadStatus !== "idle"
        ? effectiveDownloadStatus
        : fallbackStatus;
  const actionStatusText = episodeActionStatusText(
    episode.label,
    displayStatus,
  );
  const downloaded = progressPercent(episode.downloadFraction);
  const watched = progressPercent(episode.watchedFraction);
  const resumeAt = formatClock(episode.resumePositionSec);
  const meta = episode.meta;
  const airDate = formatAirDate(meta?.airDate ?? null);

  // A file we hold beats a future air date. Provider dates are wrong often
  // enough that letting one hide a real download would be the worse bug.
  const unaired = resolved.kind !== "play" && isUnaired(meta?.airDate ?? null);

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
        "surface flex flex-col gap-3 px-3 py-2.5 sm:flex-row sm:items-start",
        "transition-colors hover:border-[var(--border-strong)]",
      )}
    >
      <div className="flex min-w-0 items-start gap-3 sm:flex-1">
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
        <span className="flex items-baseline gap-x-2">
          <span className="shrink-0 text-[12px] font-medium tabular-nums text-[var(--text-secondary)]">
            {episode.label}
          </span>
          {meta?.name ? (
            <span
              data-episode-name
              className="min-w-0 truncate text-[13px] font-medium text-[var(--text)]"
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
          <span className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-[var(--text-tertiary)]">
            {meta.overview}
          </span>
        ) : null}
      </span>
      </div>

      {unaired ? (
        /* Plain text, not a disabled button: there is nothing to press, so
           there should be nothing to tab to. */
        <span
          data-episode-unaired
          className="shrink-0 self-start whitespace-nowrap rounded-[var(--radius)] border border-[var(--border)] px-2.5 py-1.5 text-[11px] text-[var(--text-tertiary)] sm:self-center"
        >
          {airDate ? `Airs ${airDate}` : "Not aired yet"}
        </span>
      ) : (
        <span className="flex w-full items-center gap-2 sm:w-auto sm:shrink-0 sm:flex-wrap sm:justify-end sm:self-center">
          <Button
            type="button"
            size="sm"
            variant="default"
            data-episode-action
            data-action="stream"
            data-action-kind={streamAction.kind}
            aria-label={`${streamLabel} — ${episode.label}`}
            aria-busy={effectiveStreamStatus === "pending" || undefined}
            disabled={!streamCanRun}
            onClick={() => onAction(streamAction, episode.label, "stream")}
            className="relative min-h-[44px] flex-1 lg:min-h-0 sm:flex-none sm:min-w-[5rem] sm:shrink-0"
          >
            <ButtonBody
              pending={effectiveStreamStatus === "pending"}
              icon={<Play className="fill-current" aria-hidden />}
            >
              {streamLabel}
            </ButtonBody>
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            data-episode-action
            data-action="download"
            data-action-kind={downloadAction.kind}
            aria-label={`${downloadLabel} — ${episode.label}`}
            aria-busy={effectiveDownloadStatus === "pending" || undefined}
            disabled={!downloadCanRun}
            onClick={() => onAction(downloadAction, episode.label, "keep")}
            className="relative min-h-[44px] flex-1 lg:min-h-0 sm:flex-none sm:min-w-[6rem] sm:shrink-0"
          >
            <ButtonBody
              pending={effectiveDownloadStatus === "pending"}
              icon={<Download aria-hidden />}
            >
              {downloadLabel}
            </ButtonBody>
          </Button>
        </span>
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
