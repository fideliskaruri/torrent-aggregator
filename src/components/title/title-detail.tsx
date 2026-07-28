"use client";

/**
 * The title page — the spine of the product.
 *
 * The complaint this answers, in the user's words: *"this is not a product,
 * it's a website you go to view torrent lists."* It was true, and structurally
 * so: clicking a title anywhere in the app landed on `/search`, a table of
 * release names, seeders and magnet links. Netflix is *see art → click → a
 * page about the title → press play*, and that page did not exist here.
 *
 * So the whole layout is built around one control. It is **Play**, **Resume**
 * or **Get** — never "Search". Getting is one press, performed by the
 * server, and does not navigate anywhere. The release table survives exactly
 * once, as a discreet "Choose a different release" link at the bottom of the
 * facts column: power features move one level deeper, they are not deleted.
 *
 * Three things about the states on this page:
 *
 *  - `availability: null` means *nobody has checked*, and renders as an
 *    ordinary clickable Get. It is not a disabled control and it is not
 *    `unavailable`.
 *  - Play is offered only when a live local torrent backs it. A progress row
 *    for a deleted download is not evidence of a file (the server already
 *    refuses to emit one, and this never invents its own).
 *  - Error and empty are one exclusive chain, not two independent `{x ? …}`
 *    blocks — the bug that told `/watchlist` users their library was empty
 *    when the request had actually failed.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Download, Loader2, Play, Search } from "lucide-react";
import { AvailabilityChip } from "@/components/browse/availability-chip";
import { PosterImage } from "@/components/browse/poster-image";
import { PlayOverlay } from "@/components/browse/play-overlay";
import { posterTint } from "@/components/browse/poster";
import {
  clampFraction,
  cleanDisplayTitle,
  progressPercent,
} from "@/components/browse/availability";
import { TfEmptyState } from "@/components/tf/empty-state";
import { TfErrorState } from "@/components/tf/error-state";
import { Button } from "@/components/ui/button";
import { useApiQuery } from "@/hooks/use-api-query";
import { cn } from "@/lib/utils";
import { EpisodeList, episodeActionKey, episodeIntentKey } from "./episode-list";
import { LibraryControls } from "./library-controls";
import { mergeEpisodes, mergeSeasons } from "./merge-extras";
import { MoreLikeThis } from "./more-like-this";
import { titleFacts } from "./title-facts";
import {
  resolvePrimaryAction,
  shouldRunTitleAction,
  titleActionButtonLabel,
  type TitleAction,
  type TitleActionStatus,
} from "./title-actions";
import {
  episodeStatusesFromSeasonReport,
  seasonGrabKey,
  shouldRunSeasonGrab,
  type SeasonGrabStatus,
} from "./season-grab-state";
import { postTitleAction } from "./title-action-request";
import type {
  TitleDetailPayload,
  TitleExtrasPayload,
  TitleSeasonGrabResponse,
  TitleRetention,
} from "./types";

export interface TitleDetailProps {
  workKey: string;
  /** What the linking card knew. Used only when nothing local knows better. */
  title?: string | null;
  year?: number | null;
  mediaType?: string | null;
  season?: number | null;
}

/** The player, once a Play has been pressed. */
type PlayTarget = {
  infoHash: string;
  title: string;
  subtitle: string | null;
  resumePositionSec: number | null;
};

const PRIMARY_KEY = "primary";
const DOWNLOAD_KEY = "download";

export function TitleDetail(props: TitleDetailProps) {
  const [season, setSeason] = useState<number | null>(props.season ?? null);
  const [statuses, setStatuses] = useState<Record<string, TitleActionStatus>>({});
  const [seasonStatuses, setSeasonStatuses] = useState<
    Record<string, SeasonGrabStatus>
  >({});
  const [notice, setNotice] = useState<string | null>(null);
  const [playing, setPlaying] = useState<PlayTarget | null>(null);
  const spentRemoteActions = useRef(new Set<string>());
  const spentSeasonGrabs = useRef(new Set<string>());

  const url = useMemo(
    () => buildDetailUrl({ ...props, season }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.workKey, props.title, props.year, props.mediaType, season],
  );

  const { data, loading, refreshing, error, refetch } =
    useApiQuery<TitleDetailPayload>(url);

  // The second round trip: episode names, the real season count, neighbours.
  //
  // Deliberately a *separate* query with its own lifecycle. It is the only
  // part of this page that touches the network, so it must never be able to
  // hold the whole render. Its absence degrades a row from "Nightmares" back
  // to "S02E01"; its loading and error states still matter to the episode
  // panel, because unknown must not be narrowed into empty.
  const activeSeason = season ?? data?.season ?? null;
  const extrasUrl = useMemo(
    () => (data ? buildExtrasUrl(props.workKey, data, activeSeason) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.workKey, data?.title, data?.year, data?.mediaType, activeSeason],
  );
  const {
    data: extras,
    loading: extrasLoading,
    refreshing: extrasRefreshing,
    error: extrasError,
  } = useApiQuery<TitleExtrasPayload>(extrasUrl);

  const statusFor = useCallback(
    (key: string) => statuses[key] ?? "idle",
    [statuses],
  );

  const runAction = useCallback(
    async (action: TitleAction, key: string, label: string, retention: TitleRetention) => {
      if (!shouldRunTitleAction(action, statusFor(key))) return;

      if (action.kind === "play" && retention === "stream") {
        setPlaying({
          infoHash: action.infoHash,
          title: label,
          subtitle: null,
          resumePositionSec: action.resumePositionSec,
        });
        return;
      }

      const streaming = retention === "stream";
      if (spentRemoteActions.current.has(key)) return;
      spentRemoteActions.current.add(key);

      setStatuses((prev) => ({ ...prev, [key]: "pending" }));
      setNotice(null);
      try {
        const body = await postTitleAction({
          workKey: props.workKey,
          title: props.title ?? null,
          mediaType: props.mediaType ?? null,
          year: props.year ?? null,
          action,
          retention,
        });
        setStatuses((prev) => ({ ...prev, [key]: "done" }));

        // The press said Play, so the press has to end in the player. The
        // engine fetches sequentially and primes the file's first bytes, so a
        // torrent that started a second ago is as openable as one that
        // finished last week — the only thing that was missing was being told
        // which one it is.
        //
        // No hash means the grab succeeded but we cannot address what it sent.
        // That is rare and it is not an error, so it degrades to the download
        // notice rather than opening a player on nothing.
        const hash = body.infoHash?.trim();
        if (streaming && hash) {
          setNotice(null);
          setPlaying({
            infoHash: hash,
            title: label,
            subtitle: null,
            resumePositionSec: null,
          });
          refetch();
          return;
        }

        setNotice(body.message ?? `${label} sent to your client.`);
        refetch();
      } catch (err) {
        spentRemoteActions.current.delete(key);
        setStatuses((prev) => ({ ...prev, [key]: "error" }));
        setNotice(err instanceof Error ? err.message : `Could not get ${label}`);
      }
    },
    [props.workKey, props.title, props.mediaType, props.year, refetch, statusFor],
  );

  const seasonStatusFor = useCallback(
    (targetSeason: number, retention: TitleRetention = "keep") =>
      seasonStatuses[seasonGrabKey(targetSeason, retention)] ?? ({ status: "idle" } as const),
    [seasonStatuses],
  );

  const runSeasonGrab = useCallback(
    async (targetSeason: number, episodes: number[], retention: TitleRetention) => {
      const key = seasonGrabKey(targetSeason, retention);
      const current = seasonStatusFor(targetSeason, retention);
      if (!shouldRunSeasonGrab(current)) return;
      if (spentSeasonGrabs.current.has(key)) return;

      spentSeasonGrabs.current.add(key);
      setSeasonStatuses((prev) => ({ ...prev, [key]: { status: "pending" } }));
      setNotice(null);
      try {
        const res = await fetch(`/api/title/${encodeURIComponent(props.workKey)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode: "season",
            season: targetSeason,
            episodes,
            retention,
            title: props.title ?? null,
            mediaType: props.mediaType ?? null,
            year: props.year ?? null,
          }),
        });
        const body = (await res.json().catch(() => null)) as
          | TitleSeasonGrabResponse
          | null;

        if (!res.ok || !body?.ok || !body.report) {
          throw new Error(body?.message || `Could not plan season ${targetSeason}`);
        }
        const report = body.report;

        setSeasonStatuses((prev) => ({
          ...prev,
          [key]: { status: "done", report },
        }));
        refetch();
      } catch (err) {
        spentSeasonGrabs.current.delete(key);
        setSeasonStatuses((prev) => ({
          ...prev,
          [key]: {
            status: "error",
            message:
              err instanceof Error
                ? err.message
                : `Could not plan season ${targetSeason}`,
          },
        }));
      }
    },
    [props.workKey, props.title, props.mediaType, props.year, refetch, seasonStatusFor],
  );

  // One exclusive chain. A failed request must never be narrowed into "there
  // is nothing here" — those are different sentences and only one of them is
  // true at a time.
  return (
    // Fill what the shell leaves, so a title with nothing under its hero ends
    // at the footer instead of stopping short and leaving it floating in
    // black. `min-h-full` cannot do this: `.app-main` is a flex item with no
    // specified height, so a percentage min-height resolves to nothing.
    <div
      className="flex min-h-[calc(100dvh_-_var(--header-h)_-_var(--mobile-nav-h)_-_var(--safe-bottom))] min-w-0 flex-col md:min-h-[calc(100dvh_-_var(--header-h)_-_3.5rem)]"
      data-title-detail
    >
      {loading && !data ? (
        <TitleDetailSkeleton />
      ) : error ? (
        <div className="container-app py-10">
          <TfErrorState
            title="Could not load this title"
            message={error}
            onRetry={refetch}
            retrying={refreshing}
          />
        </div>
      ) : !data ? (
        <div className="container-app py-10">
          <TfEmptyState
            icon={Search}
            title="Nothing to show for this title"
            description="The page loaded but the server returned no details for it."
            actionLabel="Back to browse"
            actionHref="/"
          />
        </div>
      ) : (
        <TitleContent
          payload={data}
          extras={extras}
          extrasLoading={extrasLoading}
          extrasRefreshing={extrasRefreshing}
          extrasError={extrasError}
          season={season}
          refreshing={refreshing}
          notice={notice}
          statusFor={statusFor}
          seasonStatusFor={seasonStatusFor}
          onSeasonChange={setSeason}
          onSeasonGrab={runSeasonGrab}
          onAction={runAction}
          onLibraryChanged={refetch}
        />
      )}

      {playing ? (
        <PlayOverlay
          infoHash={playing.infoHash}
          title={playing.title}
          subtitle={playing.subtitle}
          resumePositionSec={playing.resumePositionSec}
          onClose={() => {
            setPlaying(null);
            refetch();
          }}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

function TitleContent({
  payload,
  extras,
  extrasLoading,
  extrasRefreshing,
  extrasError,
  season,
  refreshing,
  notice,
  statusFor,
  seasonStatusFor,
  onSeasonChange,
  onSeasonGrab,
  onAction,
  onLibraryChanged,
}: {
  payload: TitleDetailPayload;
  extras: TitleExtrasPayload | null;
  extrasLoading: boolean;
  extrasRefreshing: boolean;
  extrasError: string | null;
  season: number | null;
  refreshing: boolean;
  notice: string | null;
  statusFor: (key: string) => TitleActionStatus;
  seasonStatusFor: (season: number, retention?: TitleRetention) => SeasonGrabStatus;
  onSeasonChange: (season: number) => void;
  onSeasonGrab: (season: number, episodes: number[], retention: TitleRetention) => void;
  onAction: (action: TitleAction, key: string, label: string, retention: TitleRetention) => void;
  onLibraryChanged: () => void;
}) {
  const title = cleanDisplayTitle(payload.title);
  const primary = resolvePrimaryAction(payload);
  const primaryStatus = statusFor(PRIMARY_KEY);
  const primaryLabel = titleActionButtonLabel(primary, primaryStatus);
  // Only a real backdrop. A poster stretched across a 16:9 band is a hack in
  // itself, and it is also how a single wrong artwork URL becomes a
  // full-bleed claim: the invented film above wore *The Quiet*'s key art,
  // wordmark and all, behind its own H1. No backdrop is a tinted panel.
  const backdrop = payload.backdropUrl;
  const downloaded = progressPercent(payload.downloadFraction);
  const downloadFraction = clampFraction(payload.downloadFraction);

  // The season the user is looking at, which is not always the season the
  // detail route answered with: it only knows the seasons we hold files for,
  // and the tabs also list the ones the provider says exist.
  const activeSeason = season ?? payload.season;
  const onKnownSeason = activeSeason === payload.season;
  const seasons = mergeSeasons(payload.seasons, extras?.seasons ?? []);
  const { rows, truncated } = mergeEpisodes({
    season: activeSeason,
    episodes: onKnownSeason ? payload.episodes : [],
    meta: extras?.episodes ?? [],
    metaSeason: extras?.season ?? null,
    truncated: onKnownSeason && payload.episodesTruncated,
  });

  const seasonCount = extras?.seasonCount ?? null;
  const similar = extras?.moreLikeThis ?? [];
  const episodeListLoading =
    (refreshing && season !== payload.season) || extrasLoading || extrasRefreshing;
  const episodeListState =
    extrasError && rows.length === 0
      ? ({ status: "error", message: extrasError } as const)
      : episodeListLoading
        ? ({ status: "loading" } as const)
        : ({ status: "ready" } as const);
  const activeSeasonGrabStatus =
    activeSeason != null ? seasonStatusFor(activeSeason, "keep") : ({ status: "idle" } as const);
  const activeSeasonStreamStatus =
    activeSeason != null ? seasonStatusFor(activeSeason, "stream") : ({ status: "idle" } as const);
  const seasonEpisodeStatuses =
    activeSeasonGrabStatus.status === "done"
      ? episodeStatusesFromSeasonReport(activeSeasonGrabStatus.report)
      : activeSeasonStreamStatus.status === "done"
        ? episodeStatusesFromSeasonReport(activeSeasonStreamStatus.report)
        : {};

  const facts = titleFacts({
    year: payload.year,
    mediaType: payload.mediaType,
    rating: payload.rating ?? extras?.rating ?? null,
    isSeries: payload.isSeries,
    // Only ever the provider's count. Counting the seasons we hold files for
    // printed "1 season" directly above a list headed "5 in season 2"; a
    // number that contradicts the thing under it is worse than no number.
    seasonCount,
  });

  const primarySubtitle =
    primary.season != null && primary.episode != null
      ? `S${pad(primary.season)}E${pad(primary.episode)}`
      : null;
  const primaryStatusText = primaryStatusMessage(
    primary,
    primaryStatus,
    primarySubtitle,
  );
  const primaryCanRun = shouldRunTitleAction(primary, primaryStatus);
  const primaryStatusId = "title-primary-status";
  const primaryDescribedBy =
    primaryStatusText || (downloaded != null && downloaded < 100)
      ? primaryStatusId
      : undefined;
  const primaryHint =
    payload.isSeries && primarySubtitle
      ? `${
          primary.kind === "get"
            ? "Gets"
            : primary.label === "Resume"
              ? "Resumes"
              : "Starts with"
        } ${primarySubtitle}. Choose a different episode below.`
      : null;

  // Play and Download are the two acquire intents. The primary button above is
  // the Play/Resume path (it opens the player); Download keeps the file. We only
  // offer a separate Download alongside a playable primary — when the primary is
  // itself a Get (positively unavailable), it already *is* the download, so a
  // second identical button would be noise.
  const showDownload = primary.kind !== "get";
  const downloadAction: TitleAction = {
    kind: "get",
    label: "Download",
    season: primary.season,
    episode: primary.episode,
    infoHash: primary.kind === "play" ? primary.infoHash : payload.infoHash,
  };
  const downloadStatus = statusFor(DOWNLOAD_KEY);
  const downloadLabel = titleActionButtonLabel(downloadAction, downloadStatus);
  const downloadCanRun = shouldRunTitleAction(downloadAction, downloadStatus);
  const downloadLabelTarget = primarySubtitle
    ? `${title} ${primarySubtitle}`
    : title;

  return (
    <article aria-labelledby="title-heading" className="flex grow flex-col">
      <header
        data-title-hero
        className="relative isolate flex grow flex-col justify-end overflow-hidden border-b border-[var(--border)] bg-[var(--bg-elevated)]"
      >
        <div
          className="absolute inset-0 -z-10"
          style={{ background: posterTint(title) }}
        >
          {backdrop ? (
            /* Softened and slightly overscanned on purpose. Key art routinely
               contains the show's own wordmark, and an unblurred backdrop puts
               a second, larger "Severance" directly behind the H1 — the same
               duplicate-caption defect the poster tiles were fixed for. The
               scale keeps the blur from feathering the edges. */
            <PosterImage
              src={backdrop}
              title={title}
              sizes="100vw"
              priority
              variant="plain"
              className="scale-[1.06] object-cover object-[center_22%] blur-[3px]"
            />
          ) : null}
        </div>
        {/* A flat veil first, so no part of the art competes with type at full
            strength, then the directional falloffs that carry the layout. */}
        <div
          aria-hidden
          className="absolute inset-0 -z-10 bg-[color-mix(in_srgb,var(--bg)_52%,transparent)]"
        />
        <div
          aria-hidden
          className="absolute inset-0 -z-10 bg-[linear-gradient(to_top,var(--bg)_0%,color-mix(in_srgb,var(--bg)_88%,transparent)_34%,color-mix(in_srgb,var(--bg)_45%,transparent)_68%,transparent_100%)]"
        />
        <div
          aria-hidden
          className="absolute inset-0 -z-10 bg-[linear-gradient(to_right,var(--bg)_0%,color-mix(in_srgb,var(--bg)_70%,transparent)_45%,transparent_88%)]"
        />

        <div className="container-app">
          {/* A tall hero is the point of the page, and it is also what stops a
              film — which has no episode list under it — reading as a short
              band floating over several hundred pixels of nothing. */}
          <div className="flex min-h-[clamp(360px,56vh,560px)] flex-col justify-end gap-6 py-8 sm:py-10 md:flex-row md:items-end md:justify-start lg:py-12">
            {/* The poster is a mark, not a caption: the title is printed
                beside it, so the no-artwork tile carries no words of its own. */}
            <div className="hidden w-[168px] shrink-0 md:block lg:w-[196px]">
              <div className="relative aspect-[2/3] w-full overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-muted)] shadow-[var(--shadow-md)]">
                <PosterImage
                  src={payload.posterUrl}
                  title={title}
                  sizes="(min-width: 1024px) 196px, 168px"
                  priority
                />
              </div>
            </div>

            <div className="min-w-0 max-w-2xl">
              <h1 id="title-heading" title={payload.title} className="text-display">
                {title}
              </h1>

              <div className="mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-2 text-[12px] text-[var(--text-secondary)]">
                {/* Same rule as the episode rows: a chip is for a state worth
                    acting on. "Nobody has checked" is already said, in words,
                    under the button. */}
                {payload.availability != null ? (
                  <AvailabilityChip state={payload.availability} />
                ) : null}
                {facts ? (
                  <span data-title-facts className="tabular-nums">
                    {facts}
                  </span>
                ) : null}
              </div>

              {payload.overview ?? extras?.overview ? (
                <p
                  data-title-overview
                  className="text-body mt-3 line-clamp-4 max-w-xl"
                >
                  {payload.overview ?? extras?.overview}
                </p>
              ) : null}

              <div className="mt-5 flex flex-col gap-3">
                <div
                  className="flex flex-wrap items-center gap-2"
                  data-title-acquire
                >
                  <Button
                    type="button"
                    size="lg"
                    data-title-primary
                    data-action-kind={primary.kind}
                    aria-label={
                      primarySubtitle
                        ? `${primaryLabel} — ${title} ${primarySubtitle}`
                        : `${primaryLabel} — ${title}`
                    }
                    aria-busy={primaryStatus === "pending" || undefined}
                    aria-describedby={primaryDescribedBy}
                    disabled={!primaryCanRun}
                    onClick={() =>
                      onAction(
                        primary,
                        PRIMARY_KEY,
                        primarySubtitle ? `${title} ${primarySubtitle}` : title,
                        primary.kind === "get" ? "keep" : "stream",
                      )
                    }
                  >
                    {primaryStatus === "pending" ? (
                      <Loader2 className="animate-spin" aria-hidden />
                    ) : primary.kind === "play" || primary.kind === "stream" ? (
                      <Play className="fill-current" aria-hidden />
                    ) : (
                      <Download aria-hidden />
                    )}
                    {primaryLabel}
                    {primarySubtitle ? (
                      <span className="text-[12px] opacity-80">
                        {primarySubtitle}
                      </span>
                    ) : null}
                  </Button>

                  {showDownload ? (
                    <Button
                      type="button"
                      size="lg"
                      variant="secondary"
                      data-title-download
                      data-action-kind="get"
                      aria-label={
                        primarySubtitle
                          ? `Download — ${title} ${primarySubtitle}`
                          : `Download — ${title}`
                      }
                      aria-busy={downloadStatus === "pending" || undefined}
                      disabled={!downloadCanRun}
                      onClick={() =>
                        onAction(
                          downloadAction,
                          DOWNLOAD_KEY,
                          downloadLabelTarget,
                          "keep",
                        )
                      }
                    >
                      {downloadStatus === "pending" ? (
                        <Loader2 className="animate-spin" aria-hidden />
                      ) : (
                        <Download aria-hidden />
                      )}
                      {downloadLabel}
                    </Button>
                  ) : null}
                </div>

                <LibraryControls
                  library={payload.library}
                  isSeries={payload.isSeries}
                  onChanged={onLibraryChanged}
                />
              </div>

              {primaryHint ? (
                <p className="mt-2 text-[12px] text-[var(--text-secondary)]">
                  {primaryHint}
                </p>
              ) : null}

              {primaryStatusText || (downloaded != null && downloaded < 100) ? (
                <div
                  id={primaryStatusId}
                  className="mt-3 max-w-sm space-y-1.5 text-[12px] text-[var(--text-tertiary)]"
                  role={primaryStatusText ? "status" : undefined}
                >
                  <p>
                    {[
                      primaryStatusText,
                      downloaded != null && downloaded < 100
                        ? `${downloaded}% downloaded`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" — ")}
                  </p>
                  {downloadFraction != null ? (
                    <div
                      className="h-1 overflow-hidden rounded-full bg-[var(--bg-muted)]"
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(downloadFraction * 100)}
                      aria-label={`${title} download progress`}
                    >
                      <div
                        className="h-full rounded-full bg-[var(--accent)]"
                        style={{
                          width: `${Math.round(downloadFraction * 100)}%`,
                        }}
                      />
                    </div>
                  ) : null}
                </div>
              ) : null}

              {notice ? (
                <p
                  role="status"
                  className="mt-2 max-w-md text-[12px] leading-relaxed text-[var(--text-secondary)]"
                >
                  {notice}
                </p>
              ) : null}
            </div>
          </div>
        </div>
      </header>

      <div className="container-app space-y-10 py-8 pb-[calc(var(--mobile-nav-h)+var(--safe-bottom)+1.5rem)] md:pb-8">
        {payload.isSeries ? (
          <EpisodeList
            seasons={seasons}
            season={activeSeason}
            episodes={rows}
            truncated={truncated}
            loadState={episodeListState}
            busy={refreshing && season !== payload.season}
            statusFor={(key) => {
              const direct = statusFor(key);
              return direct !== "idle" ? direct : (seasonEpisodeStatuses[key] ?? "idle");
            }}
            seasonGrabStatus={activeSeasonGrabStatus}
            seasonStreamStatus={activeSeasonStreamStatus}
            onSeasonChange={onSeasonChange}
            onSeasonGrab={onSeasonGrab}
            onAction={(action, label) =>
              onAction(
                action,
                action.season != null && action.episode != null
                  ? episodeIntentKey(
                      action.season,
                      action.episode,
                      action.kind === "get" ? "keep" : "stream",
                    )
                  : PRIMARY_KEY,
                label,
                action.kind === "get" ? "keep" : "stream",
              )
            }
          />
        ) : null}

        {/* Somewhere to go next. On a film this is the whole reason the space
            under the hero is not empty; on a series it follows the episodes.
            Renders nothing when there is nothing — a heading over an empty
            grid is the same void with a label on it. */}
        <MoreLikeThis items={similar} />

        {/* The old release table, kept exactly once and kept quiet. It is the
            override for someone who wants a specific encode, not the way in. */}
        <footer
          className={cn(
            "flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-[var(--text-tertiary)]",
            payload.isSeries || similar.length > 0
              ? "border-t border-[var(--border)] pt-5"
              : "",
          )}
        >
          <Link
            href={payload.releasesHref}
            data-choose-release
            className="inline-flex items-center gap-1.5 underline decoration-[var(--border-strong)] underline-offset-4 transition-colors hover:text-[var(--text)]"
          >
            <Search className="h-3.5 w-3.5" aria-hidden />
            Choose a different release
          </Link>
          {!payload.known ? (
            <span>
              Nothing local knows this title yet — everything above comes from
              the link you followed.
            </span>
          ) : null}
        </footer>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildDetailUrl(
  props: TitleDetailProps & { season: number | null },
): string {
  const params = new URLSearchParams();
  if (props.title) params.set("t", props.title);
  if (props.year) params.set("y", String(props.year));
  if (props.mediaType) params.set("type", props.mediaType);
  if (props.season != null) params.set("s", String(props.season));
  const qs = params.toString();
  const base = `/api/title/${encodeURIComponent(props.workKey)}`;
  return qs ? `${base}?${qs}` : base;
}

/**
 * The extras URL, built from the *answered* payload rather than the props.
 *
 * It has to be, for one specific reason: the detail route picks which season
 * to open (the one being watched, the one the library is hunting), and asking
 * the provider for a different season than the list is showing would pin one
 * season's episode names onto another season's rows.
 */
function buildExtrasUrl(
  workKey: string,
  payload: TitleDetailPayload,
  season: number | null,
): string | null {
  const title = cleanDisplayTitle(payload.title).trim();
  if (!title) return null;

  const params = new URLSearchParams();
  params.set("t", title);
  if (payload.year) params.set("y", String(payload.year));
  if (payload.mediaType) params.set("type", payload.mediaType);
  if (season != null) params.set("s", String(season));

  return `/api/title/${encodeURIComponent(workKey)}/extras?${params.toString()}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function primaryStatusMessage(
  action: TitleAction,
  status: TitleActionStatus,
  target: string | null,
): string | null {
  const subject = target ?? "this title";
  if (status === "pending") {
    if (action.kind === "play") return "Opening player…";
    return `Getting ${subject} ready…`;
  }
  if (status === "done" && action.kind === "get") {
    return `Getting ${subject}`;
  }
  return null;
}

/**
 * The finished layout's geometry, before the payload lands.
 *
 * Same shape as the real page so nothing moves when data arrives — a skeleton
 * that reserves the wrong space is a layout shift with extra steps.
 */
export function TitleDetailSkeleton() {
  return (
    <div aria-hidden>
      <div className="border-b border-[var(--border)] bg-[var(--bg-elevated)]">
        <div className="container-app">
          <div className="flex flex-col gap-6 py-8 sm:py-10 md:flex-row md:items-end lg:py-12">
            <div className="hidden w-[168px] shrink-0 md:block lg:w-[196px]">
              <div className="skeleton aspect-[2/3] w-full rounded-[var(--radius)]" />
            </div>
            <div className="min-w-0 max-w-2xl flex-1">
              <div className="skeleton h-9 w-3/4 rounded" />
              <div className="skeleton mt-3 h-3 w-40 rounded" />
              <div className="skeleton mt-3 h-3 w-full max-w-md rounded" />
              <div className="skeleton mt-2 h-3 w-4/5 max-w-md rounded" />
              <div className="skeleton mt-5 h-11 w-44 rounded-[var(--radius)]" />
            </div>
          </div>
        </div>
      </div>
      <div className="container-app py-8">
        <div className="skeleton h-5 w-32 rounded" />
        <div className="mt-3 space-y-1.5">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="skeleton h-14 w-full rounded-[var(--radius)]" />
          ))}
        </div>
      </div>
    </div>
  );
}
