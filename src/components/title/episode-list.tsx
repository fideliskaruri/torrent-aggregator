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
import { useState } from "react";
import { Check, ChevronDown, Download, Loader2, Play } from "lucide-react";
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
  episodeSeasonCountLabel,
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
import { QualityPicker } from "./quality-picker";
import { shouldAskForQuality } from "./quality-picker-state";
import { usePreferredQuality } from "./use-preferred-quality";
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
  /**
   * The whole work is future-dated. Every episode of it is unaired by
   * definition, so the season controls are withheld exactly like the hero's —
   * a "Download season" for a show that has not started is a button that can
   * only ever fail.
   */
  gated?: boolean;
  onSeasonChange: (season: number) => void;
  onSeasonGrab: (season: number, episodes: number[], retention: TitleRetention, resolution?: number) => void;
  onAction: (action: TitleAction, label: string, retention: TitleRetention, resolution?: number) => void;
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
  gated = false,
  onSeasonChange,
  onSeasonGrab,
  onAction,
}: EpisodeListProps) {
  const { preferredResolution, alwaysPreferred, setAlwaysPreferred } = usePreferredQuality();

  // Single quality picker for the whole list. One picker serves all Download
  // buttons — opening the picker records what triggered it, and on confirm
  // the right action is dispatched.
  type PendingDownload =
    | { kind: "episode"; action: TitleAction; label: string }
    | { kind: "season"; targetSeason: number; episodeNums: number[] };
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pendingDownload, setPendingDownload] = useState<PendingDownload | null>(null);

  function openPickerFor(pending: PendingDownload) {
    setPendingDownload(pending);
    setPickerOpen(true);
  }

  function handlePickerConfirm(resolution: number) {
    setPickerOpen(false);
    if (!pendingDownload) return;
    if (pendingDownload.kind === "episode") {
      onAction(pendingDownload.action, pendingDownload.label, "keep", resolution);
    } else {
      onSeasonGrab(pendingDownload.targetSeason, pendingDownload.episodeNums, "keep", resolution);
    }
    setPendingDownload(null);
  }

  function handlePickerOpenChange(open: boolean) {
    setPickerOpen(open);
    if (!open) setPendingDownload(null);
  }

  const view = episodeListView(loadState, episodes.length);
  const showSeasonGrab = !gated && canOfferSeasonGrab(season, episodes.length);
  const seasonDownloadCanRun =
    showSeasonGrab && shouldRunSeasonGrab(seasonGrabStatus);
  const seasonStreamCanRun =
    showSeasonGrab && shouldRunSeasonGrab(seasonStreamStatus);
  const seasonGrabSummaryId =
    showSeasonGrab && season != null ? `season-${season}-grab-status` : undefined;

  // Episode count next to the season control — the select already names the
  // season, so "7 episodes" beats the old "7 in season 1" echo.
  const seasonCountLabel =
    season != null
      ? episodeSeasonCountLabel(episodes.length, loadState, season)
      : null;

  return (
    <section aria-labelledby="title-episodes-heading" data-title-episodes>
      <h2 id="title-episodes-heading" className="text-title">
        Episodes
      </h2>

      {/*
        One toolbar, not a pill strip.
        24× "Season N" chips forced horizontal scroll and looked like a browser
        tab bar. Netflix/Plex use a select: every season is one click away, the
        row stays one line, and Play/Download sit next to the choice they act on.
      */}
      {seasons.length > 1 || showSeasonGrab || season != null ? (
        <div
          data-season-toolbar
          className="mt-3 flex flex-wrap items-center gap-2 sm:gap-3"
        >
          {seasons.length > 1 ? (
            <label className="relative inline-flex min-w-0 shrink-0 items-center">
              <span className="sr-only">Season</span>
              <select
                data-season-select
                value={season ?? ""}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  if (Number.isFinite(next)) onSeasonChange(next);
                }}
                className={cn(
                  "h-11 min-h-[44px] cursor-pointer appearance-none rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-elevated)] py-1.5 pl-3 pr-9 text-[13px] font-medium text-[var(--text)] shadow-sm transition-colors lg:h-9 lg:min-h-0",
                  "hover:border-[var(--border-strong)]",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
                )}
              >
                {seasons.map((s) => (
                  <option key={s.season} value={s.season}>
                    Season {s.season}
                  </option>
                ))}
              </select>
              <ChevronDown
                className="pointer-events-none absolute right-2.5 h-3.5 w-3.5 text-[var(--text-tertiary)]"
                aria-hidden
              />
            </label>
          ) : season != null ? (
            <span
              data-season-label
              className="text-[13px] font-medium text-[var(--text)]"
            >
              Season {season}
            </span>
          ) : null}

          {seasonCountLabel ? (
            <p
              data-season-count
              className="min-w-[72px] text-[12px] tabular-nums text-[var(--text-tertiary)]"
            >
              {seasonCountLabel}
            </p>
          ) : null}

          {showSeasonGrab && season != null ? (
            <div className="flex w-full items-center gap-2 sm:ml-auto sm:w-auto">
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
                className="relative min-h-[44px] flex-1 sm:flex-none lg:min-h-0"
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
                onClick={() => {
                  if (season == null) return;
                  const episodeNums = episodes.map((e) => e.episode);
                  if (shouldAskForQuality("keep", alwaysPreferred)) {
                    openPickerFor({ kind: "season", targetSeason: season, episodeNums });
                  } else {
                    onSeasonGrab(season, episodeNums, "keep", preferredResolution);
                  }
                }}
                className="relative min-h-[44px] flex-1 sm:flex-none lg:min-h-0"
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
                gated={gated}
                streamStatus={statusFor(
                  episodeIntentKey(episode.season, episode.episode, "stream"),
                )}
                downloadStatus={statusFor(
                  episodeIntentKey(episode.season, episode.episode, "keep"),
                )}
                fallbackStatus={statusFor(
                  episodeActionKey(episode.season, episode.episode),
                )}
                onAction={(action, label, retention) => {
                  // Play is always instant — never ask for quality.
                  // Download earns a quality question unless the user has
                  // elected "always preferred".
                  if (retention === "keep" && shouldAskForQuality("keep", alwaysPreferred)) {
                    openPickerFor({ kind: "episode", action, label });
                  } else {
                    onAction(action, label, retention, retention === "keep" ? preferredResolution : undefined);
                  }
                }}
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

      {/* One quality picker for the entire episode list. Episode Download and
          Download season both route through it. Play never does. */}
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
  gated = false,
  streamStatus,
  downloadStatus,
  fallbackStatus,
  onAction,
}: {
  episode: EpisodeRowModel;
  /** The whole work is future-dated — see `EpisodeListProps.gated`. */
  gated?: boolean;
  streamStatus: TitleActionStatus;
  downloadStatus: TitleActionStatus;
  fallbackStatus: TitleActionStatus;
  onAction: (action: TitleAction, label: string, retention: TitleRetention, resolution?: number) => void;
}) {
  const transfer = episode.transfer;
  const transferComplete =
    transfer?.status === "downloaded" && Boolean(transfer.infoHash);
  const resolved = resolveEpisodeAction(
    transferComplete
      ? {
          ...episode,
          availability: "ready",
          infoHash: transfer.infoHash,
          filePath: transfer.filePath,
        }
      : episode,
  );
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
  const streamDisplayLabel =
    effectiveStreamStatus === "idle" && streamAction.kind === "stream"
      ? "Play"
      : streamLabel;
  const downloadDisplayLabel =
    transfer?.status === "failed"
      ? "Retry"
      : transferComplete
        ? "Downloaded"
        : effectiveDownloadStatus === "idle"
          ? "Download"
          : downloadLabel;
  const streamCanRun = shouldRunTitleAction(streamAction, effectiveStreamStatus);
  const showStreamAction =
    transfer?.status !== "failed" || resolved.kind === "play";
  const downloadCanRun =
    !transferComplete &&
    transfer?.status !== "queued" &&
    transfer?.status !== "downloading" &&
    shouldRunTitleAction(downloadAction, effectiveDownloadStatus);
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
  // enough that letting one hide a real download would be the worse bug. A
  // future-dated *work* gates every row, including ones the provider has not
  // given an air date for at all.
  const unaired =
    resolved.kind !== "play" && (gated || isUnaired(meta?.airDate ?? null));

  const facts: string[] = [];
  if (!unaired && airDate) facts.push(airDate);
  const runtime = formatRuntime(meta?.runtimeMin ?? null);
  if (runtime) facts.push(runtime);
  if (episode.fromPack) facts.push("From a season pack");
  if (
    transfer == null &&
    downloaded != null &&
    downloaded < 100
  ) {
    facts.push(`${downloaded}% downloaded`);
  }
  if (resumeAt) facts.push(`Resume at ${resumeAt}`);
  else if (watched != null && watched < 100) facts.push(`${watched}% watched`);
  const factsText = factsLine(facts);

  // Only local states earn a badge. "Unavailable" beside a Play retry is
  // contradictory, and "Can get" only repeats the row's controls.
  const showChip =
    episode.availability === "ready" || episode.availability === "warm";
  const showTags = showChip || episode.nextUp || episode.watched;
  const transferText =
    transfer?.status === "queued"
      ? "Queued"
      : transfer?.status === "downloading"
        ? `Downloading ${formatTransferProgress(transfer.progress)}`
        : transfer?.status === "downloaded"
          ? "Downloaded/Available"
          : transfer?.status === "failed"
            ? "Download failed"
            : null;

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
                          <span className="inline-flex items-center gap-1 text-[12px] text-[var(--text-tertiary)]">
                <Check className="h-3 w-3" aria-hidden />
                Watched
              </span>
            ) : null}
          </span>
        ) : null}

        {factsText ? (
                      <span className="mt-1 flex flex-wrap items-center text-[12px] text-[var(--text-tertiary)]">
            {factsText}
          </span>
        ) : null}

        {transferText ? (
          <span
            className="mt-1 block text-[12px] font-medium text-[var(--text-secondary)]"
            data-episode-transfer={transfer?.status}
          >
            {transferText}
          </span>
        ) : null}

        {actionStatusText ? (
          <span
                        className="mt-1 block text-[12px] text-[var(--text-tertiary)]"
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
          className="shrink-0 self-start whitespace-nowrap rounded-[var(--radius)] border border-[var(--border)] px-2.5 py-1.5 text-[12px] text-[var(--text-tertiary)] sm:self-center"
        >
          {airDate ? `Airs ${airDate}` : "Not aired yet"}
        </span>
      ) : (
        <span className="flex w-full items-center gap-2 sm:w-auto sm:shrink-0 sm:flex-wrap sm:justify-end sm:self-center">
          {showStreamAction ? (
            <Button
              type="button"
              size="sm"
              variant="default"
              data-episode-action
              data-action="stream"
              data-action-kind={streamAction.kind}
              aria-label={`${streamDisplayLabel} — ${episode.label}`}
              aria-busy={effectiveStreamStatus === "pending" || undefined}
              disabled={!streamCanRun}
              onClick={() => onAction(streamAction, episode.label, "stream")}
              className="relative min-h-[44px] flex-1 lg:min-h-0 sm:flex-none sm:min-w-[5rem] sm:shrink-0"
            >
              <ButtonBody
                pending={effectiveStreamStatus === "pending"}
                icon={<Play className="fill-current" aria-hidden />}
              >
                {streamDisplayLabel}
              </ButtonBody>
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="secondary"
            data-episode-action
            data-action="download"
            data-action-kind={downloadAction.kind}
            aria-label={`${downloadDisplayLabel} — ${episode.label}`}
            aria-busy={effectiveDownloadStatus === "pending" || undefined}
            disabled={!downloadCanRun}
            onClick={() => onAction(downloadAction, episode.label, "keep")}
            className="relative min-h-[44px] flex-1 lg:min-h-0 sm:flex-none sm:min-w-[6rem] sm:shrink-0"
          >
            <ButtonBody
              pending={effectiveDownloadStatus === "pending"}
              icon={<Download aria-hidden />}
            >
              {downloadDisplayLabel}
            </ButtonBody>
          </Button>
        </span>
      )}
    </li>
  );
}

function formatTransferProgress(progress: number): string {
  const percent = Math.min(100, Math.max(0, progress * 100));
  return `${Number.isInteger(percent) ? percent.toFixed(0) : percent.toFixed(1)}%`;
}

function episodeActionStatusText(
  label: string,
  status: TitleActionStatus,
): string | null {
  // "Getting" and "Sending" are downloader jargon. These copies use plain
  // language. The `done` state means the API responded but the episode has
  // not yet appeared as playable — it is on its way, not stuck.
  if (status === "pending") return `Loading ${label}…`;
  if (status === "done") return `${label} is on its way…`;
  if (status === "error") return `Could not start ${label}. Try again.`;
  return null;
}
