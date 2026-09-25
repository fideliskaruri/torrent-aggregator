/**
 * Seasons and episodes — reframed as a horizontal filmstrip.
 *
 * The old design was one tall row per episode with distinct Play / Download
 * buttons. The approved streaming reference (Trakt / SIMKL "SILO") is a
 * horizontally scrolling strip of stills, each card a poster you press to
 * watch, with the keep-it (Download) action demoted to a small affordance in
 * the corner. The judgements that were baked into the old row still hold and
 * are the whole point of the component:
 *
 *  - **The card is the play target.** Clicking anywhere on a card fires the
 *    exact same stream action the old Play button did (retention "stream").
 *    Playing must never silently become a kept download, so Download is a
 *    separate control on top of the card, never nested inside the play button.
 *  - **A row/card only claims a state it checked.** `availability: null` means
 *    nobody has looked — the card is still pressable and the Download control
 *    still says "Download", not "Unavailable".
 *  - **An unaired episode gets no controls.** It prints its air date as plain
 *    text, so there is no disabled button for a keyboard user to land on. A
 *    local file always wins over a future date.
 *
 * The header carries a compact watched-progress label — `Watched X of Y (Z%)`
 * for the loaded season — alongside the season <select>, the episode count and
 * the season-scoped Download button.
 */
import { memo, useCallback, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  Loader2,
  Play,
  RotateCcw,
} from "lucide-react";
import type { ReactNode } from "react";
import { PosterImage } from "@/components/browse/poster-image";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
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
  resolveEpisodeAction,
  shouldRunTitleAction,
  titleActionButtonLabel,
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
import type { TitleRetention, TitleSeason } from "./types";
import { useFeatures } from "@/lib/features";

export interface EpisodeListProps {
  seasons: TitleSeason[];
  season: number | null;
  episodes: EpisodeRowModel[];
  truncated: boolean;
  loadState: EpisodeListLoadState;
  /** Non-null while a season change is in flight. */
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
function episodeActionKey(season: number, episode: number): string {
  return `s${season}e${episode}`;
}

export function episodeIntentKey(
  season: number,
  episode: number,
  retention: TitleRetention,
): string {
  return `${episodeActionKey(season, episode)}:${retention}`;
}

/** Clamped 0–100 integer for a 0–1 fraction. */
function progressPercent(fraction: number | null | undefined): number {
  if (fraction == null || !Number.isFinite(fraction)) return 0;
  return Math.round(Math.min(1, Math.max(0, fraction)) * 100);
}

/** `Watched X of Y (Z%)` for the loaded season. */
function watchedProgressLabel(episodes: EpisodeRowModel[]): string {
  const total = episodes.length;
  const watched = episodes.filter((e) => e.watched === true).length;
  const percent = total === 0 ? 0 : Math.round((watched / total) * 100);
  return `Watched ${watched} of ${total} (${percent}%)`;
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
  gated = false,
  onSeasonChange,
  onSeasonGrab,
  onAction,
}: EpisodeListProps) {
  const { streaming } = useFeatures();
  const { preferredResolution, alwaysPreferred, setAlwaysPreferred } = usePreferredQuality();

  // Single quality picker for the whole list. One picker serves every card's
  // Download control — opening it records what triggered it, and on confirm
  // the right action is dispatched.
  type PendingDownload =
    | { kind: "episode"; action: TitleAction; label: string }
    | { kind: "season"; targetSeason: number; episodeNums: number[] };
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pendingDownload, setPendingDownload] = useState<PendingDownload | null>(null);

  const stripRef = useRef<HTMLUListElement | null>(null);

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
    (action: TitleAction, label: string, retention: TitleRetention) => {
      // Play is always instant — never ask for quality. Download earns a
      // quality question unless the user has elected "always preferred".
      if (retention === "keep" && shouldAskForQuality("keep", alwaysPreferred)) {
        openPickerFor({ kind: "episode", action, label });
      } else {
        onAction(
          action,
          label,
          retention,
          retention === "keep" ? preferredResolution : undefined,
        );
      }
    },
    [alwaysPreferred, preferredResolution, onAction, openPickerFor],
  );

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

  function scrollStrip(direction: -1 | 1) {
    const el = stripRef.current;
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
      ? episodeSeasonCountLabel(episodes.length, loadState, season)
      : null;
  // The watched label only earns its place once a season's episodes exist:
  // "Watched 0 of 0 (0%)" over a spinner is noise, not progress.
  const showWatched = view.kind === "rows" && episodes.length > 0;

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
                className="text-[12px] tabular-nums text-[var(--text-tertiary)]"
              >
                {seasonCountLabel}
              </p>
            ) : null}

            {showWatched ? (
              <p
                data-watched-label
                className="inline-flex items-center gap-1.5 text-[12px] tabular-nums text-[var(--text-tertiary)]"
              >
                <Check className="h-3.5 w-3.5 text-[var(--accent-text,var(--accent))]" aria-hidden />
                {watchedProgressLabel(episodes)}
              </p>
            ) : null}
          </div>

          {showSeasonGrab && season != null ? (
            <div className="col-start-2 row-start-1 ml-auto flex items-center justify-end sm:col-auto sm:row-auto sm:w-auto">
              <Button
                type="button"
                size="sm"
                variant={streaming ? "secondary" : "default"}
                data-season-grab
                data-action="download"
                aria-busy={seasonGrabStatus.status === "pending" || undefined}
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

          {showSeasonGrab &&
          seasonGrabStatus.status === "done" &&
          seasonGrabStatus.report.planReason ? (
            <p
              data-season-plan-reason
              className="w-full text-[11px] leading-snug text-[var(--text-tertiary)]"
            >
              {seasonGrabStatus.report.planReason}
            </p>
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
          <div className="relative mt-3">
            {/* Native horizontal scroll carries the strip; the arrows are a
                convenience for pointer users on wide viewports and are hidden
                from assistive tech (the strip is reachable and scrollable on
                its own). */}
            <button
              type="button"
              aria-hidden
              tabIndex={-1}
              data-strip-arrow="left"
              onClick={() => scrollStrip(-1)}
              className="absolute -left-3 top-[calc(28%_-_1rem)] z-20 hidden h-9 w-9 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--bg-elevated)] text-[var(--text-secondary)] shadow-[var(--shadow-md)] transition-colors hover:text-[var(--text)] lg:flex"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden />
            </button>
            <button
              type="button"
              aria-hidden
              tabIndex={-1}
              data-strip-arrow="right"
              onClick={() => scrollStrip(1)}
              className="absolute -right-3 top-[calc(28%_-_1rem)] z-20 hidden h-9 w-9 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--bg-elevated)] text-[var(--text-secondary)] shadow-[var(--shadow-md)] transition-colors hover:text-[var(--text)] lg:flex"
            >
              <ChevronRight className="h-4 w-4" aria-hidden />
            </button>

            <ul
              ref={stripRef}
              data-episode-strip
              className={cn(
                "grid grid-cols-1 gap-2 sm:flex sm:snap-x sm:snap-mandatory sm:gap-3 sm:overflow-x-auto sm:overflow-y-hidden sm:pb-3",
                "sm:[scrollbar-width:thin] sm:[-webkit-overflow-scrolling:touch]",
              )}
            >
              {episodes.map((episode) => (
                <EpisodeCard
                  key={episode.episode}
                  episode={episode}
                  gated={gated}
                  streamStatus={statusFor(
                    episodeIntentKey(episode.season, episode.episode, "stream"),
                  )}
                  downloadStatus={statusFor(
                    episodeIntentKey(episode.season, episode.episode, "keep"),
                  )}
                  onAction={handleCardAction}
                />
              ))}
            </ul>
          </div>
          {truncated ? (
            <p className="mt-2 text-[12px] text-[var(--text-tertiary)]">
              Only the first {episodes.length} episodes are listed.
            </p>
          ) : null}
        </>
      )}

      {/* One quality picker for the entire strip. Every card's Download and the
          Download season button route through it. Play never does. */}
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
        className="grid grid-cols-1 gap-2 sm:flex sm:gap-3 sm:overflow-x-hidden sm:pb-3"
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
            <span className="skeleton block h-24 w-[128px] shrink-0 sm:aspect-video sm:h-auto sm:w-full" />
            <span className="min-w-0 flex-1 p-3">
              <span className="skeleton block h-3.5 w-3/4 rounded" />
              <span className="skeleton mt-2 block h-2.5 w-full rounded" />
              <span className="skeleton mt-1.5 block h-2.5 w-2/3 rounded" />
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
  streamStatus,
  downloadStatus,
  onAction,
}: {
  episode: EpisodeRowModel;
  /** The whole work is future-dated — see `EpisodeListProps.gated`. */
  gated?: boolean;
  streamStatus: TitleActionStatus;
  downloadStatus: TitleActionStatus;
  onAction: (action: TitleAction, label: string, retention: TitleRetention, resolution?: number) => void;
}) {
  const { streaming } = useFeatures();
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
  const streamDisplayLabel =
    effectiveStreamStatus === "idle" && streamAction.kind === "stream"
      ? "Play"
      : streamLabel;

  const held =
    transfer?.status === "downloaded" ||
    (episode.availability === "ready" && !episode.fromPack);
  const downloadDisplayLabel = transfer?.status === "failed"
    ? "Retry download"
    : transfer?.status === "queued"
      ? "Queued"
      : transfer?.status === "downloading"
        ? `Downloading ${formatTransferProgress(transfer.progress)}`
        : held
          ? "Downloaded"
          : effectiveDownloadStatus === "done"
            ? "Queued"
          : effectiveDownloadStatus === "error"
            ? "Retry download"
            : titleActionButtonLabel(downloadAction, effectiveDownloadStatus);
  const streamCanRun = shouldRunTitleAction(streamAction, effectiveStreamStatus);
  const downloadCanRun =
    !held &&
    transfer?.status !== "queued" &&
    transfer?.status !== "downloading" &&
    shouldRunTitleAction(downloadAction, effectiveDownloadStatus);

  const meta = episode.meta;
  const airDate = formatAirDate(meta?.airDate ?? null);

  // A file we hold beats a future air date. Provider dates are wrong often
  // enough that letting one hide a real download would be the worse bug. A
  // future-dated *work* gates every card, including ones the provider has not
  // given an air date for at all.
  const unaired =
    resolved.kind !== "play" && (gated || isUnaired(meta?.airDate ?? null));

  // The progress strip on the still: watched playback wins over a partial
  // download, and an actively-downloading transfer is the last fallback. Only
  // rendered when there is something to show.
  const downloadingProgress =
    transfer?.status === "downloading" ? transfer.progress : null;
  const progressFraction =
    episode.watchedFraction ?? episode.downloadFraction ?? downloadingProgress ?? null;
  const progressPct = progressPercent(progressFraction);
  const progressKind = episode.watchedFraction != null ? "watched" : "download";

  const codeAndTitle = meta?.name ? `${episode.label} · ${meta.name}` : episode.label;

  const still = (
    <span
      data-episode-still
      className="relative block h-24 w-[128px] shrink-0 overflow-hidden bg-[var(--bg-muted)] sm:aspect-video sm:h-auto sm:w-full"
    >
      {meta?.stillUrl ? (
        <EpisodeStillImage src={meta.stillUrl} title={meta.name ?? episode.label} />
      ) : null}
      <span
        data-episode-badge
        className="absolute left-2 top-2 rounded-[6px] bg-[color-mix(in_srgb,var(--bg)_72%,transparent)] px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-[var(--text)] backdrop-blur-sm"
      >
        E{episode.episode}
      </span>
      {progressPct > 0 ? (
        <span
          data-episode-progress={progressKind}
          className="absolute inset-x-0 bottom-0 h-1 bg-[color-mix(in_srgb,var(--bg)_55%,transparent)]"
        >
          <span
            className="block h-full bg-[var(--accent-text,var(--accent))]"
            style={{ width: `${progressPct}%` }}
          />
        </span>
      ) : null}
    </span>
  );

  const mobileMeta = [
    airDate,
    downloadDisplayLabel,
  ]
    .filter(Boolean)
    .join(" · ");

  const caption = (
    <span className="min-w-0 flex-1 p-3 pr-14 sm:block sm:p-3">
      <span
        data-episode-name
        className="block truncate text-[13px] font-medium text-[var(--text)]"
      >
        {codeAndTitle}
      </span>
      {mobileMeta ? (
        <span className="mt-1 block truncate text-[11px] text-[var(--text-tertiary)] sm:hidden">
          {mobileMeta}
        </span>
      ) : null}
      {meta?.overview ? (
        <span className="mt-1 hidden line-clamp-2 text-[12px] leading-relaxed text-[var(--text-tertiary)] sm:block">
          {meta.overview}
        </span>
      ) : null}
    </span>
  );

  return (
    <li
      data-episode-row
      data-episode={episode.episode}
      data-availability={episode.availability ?? "unresolved"}
      className={cn(
        "group surface relative overflow-hidden p-0",
        "transition-colors hover:border-[var(--border-strong)]",
        CARD_WIDTH,
      )}
    >
      {unaired ? (
        <div className="flex min-h-[96px] sm:block">
          {still}
          {caption}
          {/* Plain text, not a disabled button: there is nothing to press, so
              there should be nothing to tab to. */}
          <span
            data-episode-unaired
            className="hidden px-3 pb-3 text-[12px] text-[var(--text-tertiary)] sm:block"
          >
            {airDate ? `Airs ${airDate}` : "Not aired yet"}
          </span>
        </div>
      ) : (
        <>
          {/* The whole card is the play target. It is a real button so the
              press is keyboard-reachable; the Download control is a SIBLING
              layered on top, never a child, so a click on Download can never
              also fire Play. */}
          {streaming ? <button
            type="button"
            data-episode-action
            data-action="stream"
            data-action-kind={streamAction.kind}
            aria-label={`${streamDisplayLabel} — ${episode.label}`}
            aria-busy={effectiveStreamStatus === "pending" || undefined}
            disabled={!streamCanRun}
            onClick={() => onAction(streamAction, episode.label, "stream")}
            className="flex min-h-[96px] w-full cursor-pointer items-stretch text-left disabled:cursor-default sm:block sm:min-h-0"
          >
            <span className="relative block shrink-0">
              {still}
              {/* Play glyph washed over the still on hover / focus — the card's
                  primary meaning made visible without a permanent chrome. */}
              <span
                aria-hidden
                className="pointer-events-none absolute inset-0 flex items-center justify-center opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
              >
                <span className="flex h-11 w-11 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--bg)_60%,transparent)] text-[var(--text)] backdrop-blur-sm">
                  {effectiveStreamStatus === "pending" ? (
                    <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
                  ) : (
                    <Play className="h-5 w-5 fill-current" aria-hidden />
                  )}
                </span>
              </span>
            </span>
            {caption}
          </button> : (
            <div className="flex min-h-[96px] w-full items-stretch text-left sm:block sm:min-h-0">
              <span className="relative block shrink-0">{still}</span>
              {caption}
            </div>
          )}

          {/* Compact keep-it affordance. Icon-only to stay out of the card's
              way, but a 44px touch target and a full aria-label so it is neither
              too small to hit nor mute to assistive tech. */}
          <span className="absolute bottom-2 right-2 z-10 sm:bottom-auto sm:top-2">
            <button
              type="button"
              data-episode-action
              data-action="download"
              data-action-kind={downloadAction.kind}
              aria-label={`${downloadDisplayLabel} — ${episode.label}`}
              aria-busy={effectiveDownloadStatus === "pending" || undefined}
              disabled={!downloadCanRun}
              onClick={(event) => {
                event.stopPropagation();
                onAction(downloadAction, episode.label, "keep");
              }}
              className={cn(
                "inline-flex h-11 items-center justify-center gap-1 rounded-full border border-[var(--border)]",
                "bg-[color-mix(in_srgb,var(--bg-elevated)_82%,transparent)] text-[var(--text-secondary)] shadow-sm backdrop-blur-sm",
                "transition-colors hover:text-[var(--text)] hover:border-[var(--border-strong)]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
                "disabled:cursor-default disabled:opacity-70 lg:h-8 lg:min-h-[44px] lg:min-w-[44px]",
                !streaming && "bg-[var(--accent)] text-[var(--primary-foreground)]",
                // Downloading shows a live percentage, so the pill grows to fit
                // the digits; every other state is a single glyph in a circle.
                transfer?.status === "downloading"
                  ? "w-auto px-2.5 text-[var(--accent-text,var(--accent))] lg:px-2.5"
                  : "w-11 lg:w-8",
              )}
            >
              <DownloadGlyph
                transferStatus={transfer?.status ?? null}
                progress={transfer?.progress ?? null}
                held={held}
                status={effectiveDownloadStatus}
              />
            </button>
          </span>
        </>
      )}
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
  if (a.streamStatus !== b.streamStatus) return false;
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
    pe.watched !== ne.watched ||
    pe.watchedFraction !== ne.watchedFraction ||
    pe.downloadFraction !== ne.downloadFraction ||
    pe.nextUp !== ne.nextUp ||
    pe.fromPack !== ne.fromPack
  ) {
    return false;
  }
  // The transfer is the thing a poll moves — status and progress especially.
  const pt = pe.transfer;
  const nt = ne.transfer;
  if (
    (pt?.status ?? null) !== (nt?.status ?? null) ||
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
      sizes="(min-width: 640px) 300px, 128px"
      variant="plain"
      className="object-cover"
    />
  );
});

/** What a card's compact Download control shows, by state. */
function DownloadGlyph({
  transferStatus,
  progress,
  held,
  status,
}: {
  transferStatus: "queued" | "downloading" | "downloaded" | "failed" | null;
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
  // Queued has not started moving yet — a brief spinner is honest here.
  if (transferStatus === "queued" || status === "pending") {
    return <Loader2 className="h-4 w-4 animate-spin" aria-hidden />;
  }
  if (held || transferStatus === "downloaded" || status === "done") {
    return <Check className="h-4 w-4 text-[var(--accent-text,var(--accent))]" aria-hidden />;
  }
  return <Download className="h-4 w-4" aria-hidden />;
}

function formatTransferProgress(progress: number): string {
  const percent = Math.min(100, Math.max(0, progress * 100));
  return `${Number.isInteger(percent) ? percent.toFixed(0) : percent.toFixed(1)}%`;
}
