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
 * or **Get** — never "Search" and never a releases table. Getting is one press,
 * performed by the server, and does not navigate anywhere. The user picks a
 * title, sees info, and watches or downloads — torrent plumbing stays off-stage.
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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Download, Loader2, Play, Search } from "lucide-react";
import { toast } from "sonner";
import { AvailabilityChip } from "@/components/browse/availability-chip";
import { PosterImage } from "@/components/browse/poster-image";
import { PlayOverlay } from "@/components/browse/play-overlay";
import { posterTint } from "@/components/browse/poster";
import { cleanDisplayTitle } from "@/components/browse/availability";
import { TfEmptyState } from "@/components/tf/empty-state";
import { TfErrorState } from "@/components/tf/error-state";
import { Button } from "@/components/ui/button";
import { useApiQuery } from "@/hooks/use-api-query";
import { cn } from "@/lib/utils";
import { releaseStatus, theatricalWindowStatus } from "@/lib/browse/release-status";
import { EpisodeList, episodeIntentKey } from "./episode-list";
import { LibraryControls } from "./library-controls";
import { mergeEpisodes, mergeSeasons } from "./merge-extras";
import { MoreLikeThis } from "./more-like-this";
import { QualityPicker } from "./quality-picker";
import { shouldAskForQuality } from "./quality-picker-state";
import { usePreferredQuality } from "./use-preferred-quality";
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
import { StorageCapDialog } from "@/components/storage/storage-cap-dialog";
import { useStorageCapOverride } from "@/components/storage/use-storage-cap-override";
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
  provider?: string | null;
  providerId?: string | null;
  sourceType?: string | null;
  format?: string | null;
  seriesHint?: string | null;
  aliases?: string[];
}

/** The player, once a Play has been pressed. */
type PlayTarget = {
  /**
   * `null` during the opening handoff: the overlay mounts the instant a stream
   * Play is pressed and shows its one loader while the grab runs; the resolved
   * hash flows in afterwards. Existing-local play sets it immediately.
   */
  infoHash: string | null;
  title: string;
  episodeTitle: string | null;
  season: number | null;
  episode: number | null;
  resumePositionSec: number | null;
};

const PRIMARY_KEY = "primary";
const DOWNLOAD_KEY = "download";

/**
 * Renders a button's icon + label with the pending spinner **overlaid** rather
 * than swapped in for the label. The label stays mounted (only invisible) so
 * the control keeps identical width and height idle↔loading — no layout shift,
 * no controls that resize the moment they are pressed.
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

export function TitleDetail(props: TitleDetailProps) {
  const [season, setSeason] = useState<number | null>(props.season ?? null);
  const [statuses, setStatuses] = useState<Record<string, TitleActionStatus>>({});
  const [seasonStatuses, setSeasonStatuses] = useState<
    Record<string, SeasonGrabStatus>
  >({});
  const [playing, setPlaying] = useState<PlayTarget | null>(null);
  // The cap is a guardrail, not a wall: an over-cap Download raises an informed
  // confirmation instead of a dead-end toast. Play never reaches it — the
  // server-side gate reclaims stream cache and proceeds.
  const cap = useStorageCapOverride();
  const spentRemoteActions = useRef(new Set<string>());
  const spentSeasonGrabs = useRef(new Set<string>());
  // Recovery timers: if a streaming grab stays in "done" for 90 s without the
  // episode becoming playable, re-enable the row so the user has a path to
  // retry. This fixes the class of stuck state where the API responded but the
  // client refetch never arrived (Task 3).
  const recoveryTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  // Clear all recovery timers on unmount to prevent state updates on an
  // unmounted component.
  useEffect(() => {
    const timers = recoveryTimers.current;
    return () => {
      timers.forEach(clearTimeout);
      timers.clear();
    };
  }, []);

  const url = useMemo(
    () => buildDetailUrl({ ...props, season }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      props.workKey,
      props.title,
      props.year,
      props.mediaType,
      props.provider,
      props.providerId,
      props.sourceType,
      props.format,
      props.seriesHint,
      props.aliases,
      season,
    ],
  );

  const { data, loading, refreshing, error, refetch } =
    useApiQuery<TitleDetailPayload>(url, { refreshMs: 2_500 });

  // The second round trip: episode names, the real season count, neighbours.
  //
  // Deliberately a *separate* query with its own lifecycle. It is the only
  // part of this page that touches the network, so it must never be able to
  // hold the whole render. Its absence degrades a row from "Nightmares" back
  // to "S02E01"; its loading and error states still matter to the episode
  // panel, because unknown must not be narrowed into empty.
  const activeSeason = season ?? data?.season ?? null;
  const extrasUrl = useMemo(
    () => (data ? buildExtrasUrl(props, data, activeSeason) : null),
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
    async (
      action: TitleAction,
      key: string,
      label: string,
      retention: TitleRetention,
      resolution?: number,
    ) => {
      if (!shouldRunTitleAction(action, statusFor(key))) return;

      if (action.kind === "play" && retention === "stream") {
        const episodeTitle =
          action.season != null &&
          action.episode != null &&
          extras?.season === action.season
            ? extras.episodes.find(
                (item) => item.episode === action.episode,
              )?.name ?? null
            : null;
        setPlaying({
          infoHash: action.infoHash,
          title: cleanDisplayTitle(data?.title ?? props.title ?? label),
          episodeTitle,
          season: action.season ?? null,
          episode: action.episode ?? null,
          resumePositionSec: action.resumePositionSec,
        });
        return;
      }

      const streaming = retention === "stream";
      if (spentRemoteActions.current.has(key)) return;
      spentRemoteActions.current.add(key);

      // A stream Play opens the player NOW, in its "opening" state (no hash yet),
      // so ONE loader owns the entire journey from the instant of the press. The
      // button never shows its own spinner for a stream Play — that button→player
      // spinner handoff is exactly the "two loaders" the viewer kept reporting.
      // Non-stream actions (send to client) keep the in-button pending state
      // because they never open a player.
      if (streaming) {
        const episodeTitle =
          action.season != null &&
          action.episode != null &&
          extras?.season === action.season
            ? extras.episodes.find(
                (item) => item.episode === action.episode,
              )?.name ?? null
            : null;
        setPlaying({
          infoHash: null,
          title: cleanDisplayTitle(data?.title ?? props.title ?? label),
          episodeTitle,
          season: action.season ?? null,
          episode: action.episode ?? null,
          resumePositionSec: null,
        });
      } else {
        setStatuses((prev) => ({ ...prev, [key]: "pending" }));
      }
      try {
        const outcome = await cap.run(({ overrideStorageCap }) =>
          postTitleAction({
            workKey: props.workKey,
            title: props.title ?? null,
            mediaType: props.mediaType ?? null,
            year: props.year ?? null,
            action,
            retention,
            resolution,
            overrideStorageCap,
          }),
        );

        // The owner was shown the real figures and said no. Nothing was sent, so
        // the row goes back to idle — a declined confirmation is not a failure
        // and must not leave an error state or a hanging player behind.
        if (outcome.status === "cancelled") {
          spentRemoteActions.current.delete(key);
          setStatuses((prev) => ({ ...prev, [key]: "idle" }));
          if (streaming) setPlaying(null);
          return;
        }

        const body = outcome.value;
        setStatuses((prev) => ({ ...prev, [key]: "done" }));

        // The press said Play, so the press has to end in the player. The
        // engine fetches sequentially and primes the file's first bytes, so a
        // torrent that started a second ago is as openable as one that
        // finished last week — the only thing that was missing was being told
        // which one it is. The resolved hash flows into the SAME already-open
        // player as a prop update, so the loader that has been up since the
        // press just keeps running — it is never torn down and rebuilt.
        //
        // No hash means the grab succeeded but we cannot address what it sent.
        // That is rare and it is not an error, so it closes the opening player
        // and degrades to the download notice rather than hanging on a spinner.
        const hash = body.infoHash?.trim();
        if (streaming && hash) {
          const episodeTitle =
            action.season != null &&
            action.episode != null &&
            extras?.season === action.season
              ? extras.episodes.find(
                  (item) => item.episode === action.episode,
                )?.name ?? null
              : null;
          setPlaying({
            infoHash: hash,
            title: cleanDisplayTitle(data?.title ?? props.title ?? label),
            episodeTitle,
            season: action.season ?? null,
            episode: action.episode ?? null,
            resumePositionSec: null,
          });
          refetch();
          return;
        }

        if (streaming) setPlaying(null);
        toast.success(body.message ?? `${label} sent to your client.`);
        refetch();

        // For streaming grabs that did not immediately resolve a hash: the
        // episode will become playable once the refetch arrives and the library
        // maps the info hash. But if that never happens (slow network, torrent
        // client unreachable), the row stays disabled with no path forward.
        // Schedule a recovery that resets to idle so the user can try again.
        if (streaming && !hash) {
          if (recoveryTimers.current.has(key)) {
            clearTimeout(recoveryTimers.current.get(key)!);
          }
          const timer = setTimeout(() => {
            recoveryTimers.current.delete(key);
            setStatuses((prev) => {
              if (prev[key] === "done") {
                spentRemoteActions.current.delete(key);
                return { ...prev, [key]: "idle" };
              }
              return prev;
            });
          }, 90_000);
          recoveryTimers.current.set(key, timer);
        }
      } catch (err) {
        spentRemoteActions.current.delete(key);
        setStatuses((prev) => ({ ...prev, [key]: "error" }));
        // Close the opening player on a grab failure so no loader is left hanging.
        if (streaming) setPlaying(null);
        toast.error(
          err instanceof Error ? err.message : `Could not get ${label}`,
        );
      }
    },
    [
      props.workKey,
      props.title,
      props.mediaType,
      props.year,
      refetch,
      statusFor,
      cap,
      data?.title,
      extras,
    ],
  );

  const seasonStatusFor = useCallback(
    (targetSeason: number, retention: TitleRetention = "keep") =>
      seasonStatuses[seasonGrabKey(targetSeason, retention)] ?? ({ status: "idle" } as const),
    [seasonStatuses],
  );

  const runSeasonGrab = useCallback(
    async (
      targetSeason: number,
      episodes: number[],
      retention: TitleRetention,
      resolution?: number,
    ) => {
      const key = seasonGrabKey(targetSeason, retention);
      const current = seasonStatusFor(targetSeason, retention);
      if (!shouldRunSeasonGrab(current)) return;
      if (spentSeasonGrabs.current.has(key)) return;

      spentSeasonGrabs.current.add(key);
      setSeasonStatuses((prev) => ({ ...prev, [key]: { status: "pending" } }));
      try {
        const res = await fetch(`/api/title/${encodeURIComponent(props.workKey)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(30_000),
          body: JSON.stringify({
            scope: "season",
            season: targetSeason,
            episodes,
            retention,
            title: props.title ?? null,
            mediaType: props.mediaType ?? null,
            year: props.year ?? null,
            ...(resolution != null
              ? { preferredResolution: resolution }
              : {}),
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
          episodeTitle={playing.episodeTitle}
          season={playing.season}
          episode={playing.episode}
          year={data?.year ?? null}
          resumePositionSec={playing.resumePositionSec}
          onClose={() => {
            setPlaying(null);
            refetch();
          }}
        />
      ) : null}

      <StorageCapDialog {...cap.dialogProps} />
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
  statusFor: (key: string) => TitleActionStatus;
  seasonStatusFor: (season: number, retention?: TitleRetention) => SeasonGrabStatus;
  onSeasonChange: (season: number) => void;
  onSeasonGrab: (
    season: number,
    episodes: number[],
    retention: TitleRetention,
    resolution?: number,
  ) => void;
  onAction: (
    action: TitleAction,
    key: string,
    label: string,
    retention: TitleRetention,
    resolution?: number,
  ) => void;
  onLibraryChanged: () => void;
}) {
  const { preferredResolution, alwaysPreferred, setAlwaysPreferred } = usePreferredQuality();
  // Quality picker for the hero Download button. Play is always instant.
  const [heroPicker, setHeroPicker] = useState(false);

  function requestAction(
    action: TitleAction,
    key: string,
    label: string,
    retention: TitleRetention,
    resolution?: number,
  ) {
    onAction(action, key, label, retention, resolution);
  }

  function requestSeasonGrab(
    targetSeason: number,
    episodes: number[],
    retention: TitleRetention,
    resolution?: number,
  ) {
    onSeasonGrab(
      targetSeason,
      episodes,
      retention,
      resolution,
    );
  }

  const title = cleanDisplayTitle(payload.title);
  const primary = resolvePrimaryAction(payload);
  const primaryStatus = statusFor(PRIMARY_KEY);
  const primaryLabel = titleActionButtonLabel(primary, primaryStatus);
  const primaryDisplayLabel =
    primaryStatus === "idle" && primary.kind !== "play"
      ? primary.kind === "stream"
        ? "Play"
        : "Download"
      : primaryLabel;
  // Only a real backdrop. A poster stretched across a 16:9 band is a hack in
  // itself, and it is also how a single wrong artwork URL becomes a
  // full-bleed claim: the invented film above wore *The Quiet*'s key art,
  // wordmark and all, behind its own H1. No backdrop is a tinted panel.
  const backdrop = payload.backdropUrl;

  // Visual availability: a title whose release date is still in the future is
  // shown but not actionable — grayed art, a "Coming {date}" label, and no
  // Play/Download. Unknown dates are never gated (releaseStatus says so).
  // The local catalog only knows dates for works it already holds, so a title
  // opened straight from search falls back to the date the provider returned
  // with the rest of the extras.
  const release = releaseStatus(payload.releaseDate ?? extras?.releaseDate ?? null);
  // A movie in its theatrical window is also gated: it has a past primary
  // release (theatrically showing) but no past home release (Digital/Physical/
  // TV). Only fires when extras explicitly set inTheatricalWindow — unknown
  // data (extras not yet loaded, endpoint failed) never gates.
  const theatrical = theatricalWindowStatus(
    extras?.inTheatricalWindow ?? false,
    extras?.nextHomeReleaseAt ?? null,
  );
  const gated = release.unreleased || theatrical.inTheatricalWindow;

  // The season the user is looking at, which is not always the season the
  // detail route answered with: it only knows the seasons we hold files for,
  // and the tabs also list the ones the provider says exist.
  const seasons = mergeSeasons(payload.seasons, extras?.seasons ?? []);
  // Default to the first known season when neither the user nor the detail
  // route has chosen one, so a series never renders with every season tab
  // inactive and an empty episode list ("no default season selected").
  const activeSeason = season ?? payload.season ?? seasons[0]?.season ?? null;
  const onKnownSeason = activeSeason === payload.season;
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
  // The button is the only place a pending action is narrated: ButtonBody
  // overlays the spinner in place of the label, exactly like a normal video
  // player. No status line, no hint, and no progress bar under the buttons.
  const primaryCanRun = shouldRunTitleAction(primary, primaryStatus) && !gated;

  // Play and Download are the two acquire intents. The primary button above is
  // the Play/Resume path (it opens the player); Download keeps the file. We only
  // offer a separate Download alongside a playable primary — when the primary is
  // itself a Get (positively unavailable), it already *is* the download, so a
  // second identical button would be noise.
  const showDownload = primary.kind !== "get" && !gated;
  const downloadAction: TitleAction = {
    kind: "get",
    label: "Download",
    season: primary.season,
    episode: primary.episode,
    infoHash: primary.kind === "play" ? primary.infoHash : payload.infoHash,
  };
  const downloadStatus = statusFor(DOWNLOAD_KEY);
  const downloadLabel = titleActionButtonLabel(downloadAction, downloadStatus);
  const downloadCanRun =
    shouldRunTitleAction(downloadAction, downloadStatus) && !gated;
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
              className={cn(
                "scale-[1.06] object-cover object-[center_22%] blur-[3px]",
                gated && "grayscale",
              )}
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
              <div
                className={cn(
                  "relative aspect-[2/3] w-full overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-muted)] shadow-[var(--shadow-md)]",
                  gated && "grayscale",
                )}
              >
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
                {/* A gated title shows a chip instead of an availability chip and
                    disabled actions. Theatrical-window films get "In cinemas" (or
                    "Digital Aug 2026"); future-dated films get "Coming {date}". */}
                {gated ? (
                  <span
                    data-title-coming
                    className="inline-flex items-center gap-1.5 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-elevated)] px-2.5 py-1 font-medium text-[var(--text-secondary)]"
                  >
                    {theatrical.theatricalLabel ?? release.comingLabel ?? "Coming soon"}
                  </span>
                ) : payload.availability === "ready" ||
                  payload.availability === "warm" ? (
                  <AvailabilityChip state={payload.availability} />
                ) : null}
                {/* Only local states earn a chip. A stale "Unavailable" beside
                    Play is self-contradictory, while "Can get" only repeats the
                    controls already visible below. */}
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
              ) : !extras ? (
                // Reserve the paragraph's space while the extras round trip is
                // still in flight. The hero is justify-end, so the buttons are
                // pinned to the bottom: adding content above them does not move
                // the buttons. What this prevents is the HEADER shrinking once
                // MoreLikeThis loads — that is a separate guard (below).
                // This placeholder keeps the hero looking composed on first
                // paint even when the detail endpoint returned no overview.
                <p aria-hidden data-title-overview-placeholder className="mt-3 min-h-[5.25rem]" />
              ) : null}

              <div
                className="mt-5 flex flex-wrap items-center gap-2"
                data-title-acquire
              >
                {/* A gated (unreleased) title offers no Play/Download at all —
                    the "Coming {date}" label and grayed art already say why, and
                    a disabled action is just clutter that does nothing. Tracking
                    it via "Add to library" stays available below. */}
                {gated ? null : (
                <Button
                  type="button"
                  size="lg"
                  data-title-primary
                  data-action-kind={primary.kind}
                  aria-label={
                    primarySubtitle
                      ? `${primaryDisplayLabel} — ${title} ${primarySubtitle}`
                      : `${primaryDisplayLabel} — ${title}`
                  }
                  aria-busy={primaryStatus === "pending" || undefined}
                  disabled={!primaryCanRun}
                  onClick={() =>
                    requestAction(
                      primary,
                      PRIMARY_KEY,
                      primarySubtitle ? `${title} ${primarySubtitle}` : title,
                      primary.kind === "get" ? "keep" : "stream",
                    )
                  }
                  className="relative min-w-[9rem]"
                >
                  <ButtonBody
                    pending={primaryStatus === "pending"}
                    icon={
                      primary.kind === "play" || primary.kind === "stream" ? (
                        <Play className="fill-current" aria-hidden />
                      ) : (
                        <Download aria-hidden />
                      )
                    }
                  >
                    {primaryDisplayLabel}
                    {primarySubtitle ? (
                      <span className="text-[12px] tabular-nums opacity-80">
                        {primarySubtitle}
                      </span>
                    ) : null}
                  </ButtonBody>
                </Button>
                )}

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
                    onClick={() => {
                      // Play is instant and never prompts. Download is the
                      // deliberate keep-it action — it earns a quality question.
                      if (shouldAskForQuality("keep", alwaysPreferred)) {
                        setHeroPicker(true);
                      } else {
                        requestAction(
                          downloadAction,
                          DOWNLOAD_KEY,
                          downloadLabelTarget,
                          "keep",
                          preferredResolution,
                        );
                      }
                    }}
                    className="relative min-w-[8rem]"
                  >
                    <ButtonBody
                      pending={downloadStatus === "pending"}
                      icon={<Download aria-hidden />}
                    >
                      {downloadStatus === "idle" ? "Download" : downloadLabel}
                    </ButtonBody>
                  </Button>
                ) : null}

                <LibraryControls
                  library={payload.library}
                  isSeries={payload.isSeries}
                  onChanged={onLibraryChanged}
                />
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Quality picker for the hero Download button.
          Mounted outside the header so it renders in its own stacking context
          and does not interfere with the hero's z-index layers. Radix manages
          scroll-lock with body padding compensation, so opening it does not
          shift the page behind it. */}
      <QualityPicker
        open={heroPicker}
        onOpenChange={setHeroPicker}
        preferredResolution={preferredResolution}
        alwaysPreferred={alwaysPreferred}
        onAlwaysPreferredChange={setAlwaysPreferred}
        onConfirm={(resolution) => {
          setHeroPicker(false);
          requestAction(
            downloadAction,
            DOWNLOAD_KEY,
            downloadLabelTarget,
            "keep",
            resolution,
          );
        }}
      />

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
            gated={gated}
            onSeasonChange={onSeasonChange}
            onSeasonGrab={requestSeasonGrab}
            onAction={(action, label, _retention, resolution) =>
              requestAction(
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
                resolution,
              )
            }
          />
        ) : null}

        {/* Somewhere to go next. On a film this is the whole reason the space
            under the hero is not empty; on a series it follows the episodes.
            The `loading` prop tells MoreLikeThis to render a skeleton grid when
            items have not arrived yet, which keeps the bottom section the same
            height before and after the extras round trip. Without this, the
            hero (which is flex-grow) shrinks when the grid appears — causing
            the Play/Download buttons to jump up under the cursor, which is how
            clicking Play silently navigated to the wrong film (Task 1). */}
        <MoreLikeThis
          items={similar}
          loading={extrasLoading && !extrasError}
        />

        {!payload.known ? (
          <p className="text-[12px] text-[var(--text-tertiary)]">
            Nothing local knows this title yet — everything above comes from
            the link you followed.
          </p>
        ) : null}
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
  if (props.provider) params.set("provider", props.provider);
  if (props.providerId) params.set("providerId", props.providerId);
  if (props.sourceType) params.set("sourceType", props.sourceType);
  if (props.format) params.set("format", props.format);
  if (props.seriesHint) params.set("series", props.seriesHint);
  for (const alias of props.aliases ?? []) params.append("alias", alias);
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
  props: TitleDetailProps,
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
  if (props.provider) params.set("provider", props.provider);
  if (props.providerId) params.set("providerId", props.providerId);
  if (props.sourceType) params.set("sourceType", props.sourceType);
  if (props.format) params.set("format", props.format);
  if (props.seriesHint) params.set("series", props.seriesHint);
  for (const alias of props.aliases ?? []) params.append("alias", alias);

  return `/api/title/${encodeURIComponent(props.workKey)}/extras?${params.toString()}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
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
