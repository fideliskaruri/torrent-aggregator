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
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Download, Loader2, Play, Search } from "lucide-react";
import { toast } from "sonner";
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
import { extrasRequestPending } from "./episode-list-state";
import { LibraryControls } from "./library-controls";
import { mergeEpisodes, mergeSeasons, isUnaired } from "./merge-extras";
import { MoreLikeThis } from "./more-like-this";
import { QualityPicker } from "./quality-picker";
import { shouldAskForQuality } from "./quality-picker-state";
import { usePreferredQuality } from "./use-preferred-quality";
import {
  formatReleaseDate,
  GenreChips,
  HeroMetaList,
  RatingMetaLine,
  releaseYear,
} from "./title-hero-meta";
import {
  offersDownload,
  resolvePrimaryAction,
  shouldRunTitleAction,
  titleActionButtonLabel,
  type TitleAction,
  type TitleActionStatus,
} from "./title-actions";
import {
  seasonGrabKey,
  shouldRunSeasonGrab,
  type SeasonGrabStatus,
} from "./season-grab-state";
import { postTitleAction } from "./title-action-request";
import {
  isValidSeason,
  nextRememberedSeasonCookieValue,
  readRememberedSeason,
  REMEMBERED_SEASON_COOKIE_NAME,
} from "@/lib/title/remembered-season";
import {
  resolveInitialSeason,
  resolveSeasonOnPropsChange,
} from "./season-persistence";
import { StorageCapDialog } from "@/components/storage/storage-cap-dialog";
import { useStorageCapOverride } from "@/components/storage/use-storage-cap-override";
import {
  parseStorageOverrideFacts,
  StorageLimitError,
} from "@/lib/library/storage-override";
import type {
  TitleDetailPayload,
  TitleExtrasPayload,
  TitleProgressPayload,
  TitleSeasonGrabResponse,
  TitleRetention,
} from "./types";
import { episodeTitleMap } from "./types";

export interface TitleDetailProps {
  workKey: string;
  /** What the linking card knew. Used only when nothing local knows better. */
  title?: string | null;
  year?: number | null;
  mediaType?: string | null;
  /** One-time compatibility seed from an old inbound `?s=` link. */
  legacySeason?: number | null;
  provider?: string | null;
  providerId?: string | null;
  sourceType?: string | null;
  format?: string | null;
  seriesHint?: string | null;
  aliases?: string[];
  /**
   * A season the user picked by hand on a previous visit, read server-side
   * from the durable `tf_season` cookie (see
   * `@/lib/title/remembered-season`). Threaded through to the API as a plain
   * query param so `pickSeason` can prefer it over a stale watch cursor.
   */
  rememberedSeason?: number | null;
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
  const [season, setSeason] = useState<number | null>(() =>
    resolveInitialSeason({
      legacySeason: props.legacySeason,
      rememberedSeason: props.rememberedSeason,
    }),
  );
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

  // Resync on props change — the SPA half of cookie persistence. A cached RSC
  // payload can carry an old server cookie, so the live browser cookie wins.
  const previousWorkKey = useRef(props.workKey);
  const manualSeasonSelection = useRef(false);
  useEffect(() => {
    const workKey = props.workKey;
    const workKeyChanged = workKey !== previousWorkKey.current;
    if (workKeyChanged) manualSeasonSelection.current = false;
    const legacySeason = readLegacySeasonFromLocation();
    if (legacySeason != null) {
      writeRememberedSeasonCookie(workKey, legacySeason);
    }
    const cookieSeason = readRememberedSeasonFromDocument(workKey);
    setSeason((current) =>
      resolveSeasonOnPropsChange({
        previousWorkKey: previousWorkKey.current,
        workKey,
        legacySeason,
        rememberedSeason: props.rememberedSeason,
        cookieSeason,
        currentSeason: current,
        preserveCurrentSeason: manualSeasonSelection.current,
      }),
    );
    removeLegacySeasonFromLocation();
    previousWorkKey.current = workKey;
  }, [props.workKey, props.legacySeason, props.rememberedSeason]);

  const handleSeasonChange = useCallback(
    (nextSeason: number) => {
      manualSeasonSelection.current = true;
      setSeason(nextSeason);
      // This is the only durable write: an explicit user pick, never inferred
      // playback progress or a provider default.
      writeRememberedSeasonCookie(props.workKey, nextSeason);
    },
    [props.workKey],
  );

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
      props.rememberedSeason,
      season,
    ],
  );

  // Poll only while a transfer is actually moving. A fixed 2.5s refresh on an
  // idle title page hammered /api/title (network waterfall of identical GETs),
  // re-rendered the whole document, and made chips/status lines appear and
  // disappear — layout shift with no product reason.
  const [transferPoll, setTransferPoll] = useState(false);
  const [transferPollSession, setTransferPollSession] = useState(0);
  const [currentProgress, setCurrentProgress] = useState<{
    workKey: string;
    session: number;
    payload: TitleProgressPayload;
  } | null>(null);
  const transferPollActive = useRef(false);
  const startTransferPoll = useCallback(() => {
    if (transferPollActive.current) return;
    transferPollActive.current = true;
    setCurrentProgress(null);
    setTransferPollSession((current) => current + 1);
    setTransferPoll(true);
  }, []);
  const stopTransferPoll = useCallback(() => {
    transferPollActive.current = false;
    setTransferPoll(false);
  }, []);
  const { data, loading, refreshing, error, refetch } =
    useApiQuery<TitleDetailPayload>(url, {
      refreshMs: 0,
    });
  useEffect(() => {
    if (titleNeedsTransferPoll(data)) startTransferPoll();
  }, [data, startTransferPoll]);

  const progressUrl = transferPoll && !playing
    ? `/api/title/${encodeURIComponent(props.workKey)}/progress?session=${transferPollSession}`
    : null;
  const {
    data: progress,
    error: progressError,
    settled: progressSettled,
  } = useApiQuery<TitleProgressPayload>(progressUrl, {
      refreshMs: transferPoll && !playing ? 2_500 : 0,
    });
  useEffect(() => {
    if (!progressSettled || progressError || !progress) return;
    setCurrentProgress({
      workKey: props.workKey,
      session: transferPollSession,
      payload: progress,
    });
  }, [
    progress,
    progressError,
    progressSettled,
    props.workKey,
    transferPollSession,
  ]);
  const visibleProgress =
    currentProgress?.workKey === props.workKey &&
    currentProgress.session === transferPollSession
      ? currentProgress.payload
      : null;
  useEffect(() => {
    if (!transferPoll || !visibleProgress) return;
    if (titleProgressHasActiveTransfer(visibleProgress)) return;

    stopTransferPoll();
    void refetch();
  }, [
    refetch,
    stopTransferPoll,
    transferPoll,
    visibleProgress,
  ]);

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
      data?.title,
      data?.year,
      data?.mediaType,
      data?.posterUrl,
      activeSeason,
    ],
  );
  const extrasIdentity = useMemo(
    () => extrasDataIdentity(extrasUrl),
    [extrasUrl],
  );
  const {
    data: extras,
    loading: extrasLoading,
    refreshing: extrasRefreshing,
    error: extrasError,
    settled: extrasSettled,
    refetch: refetchExtras,
  } = useApiQuery<TitleExtrasPayload>(extrasUrl, {
    dataIdentity: extrasIdentity,
  });
  const episodeTitles = useMemo(
    () =>
      extras?.season == null
        ? undefined
        : episodeTitleMap(extras.season, extras.episodes),
    [extras],
  );

  const statusFor = useCallback(
    (key: string) => statuses[key] ?? "idle",
    [statuses],
  );

  // runAction must keep ONE identity for the life of the page. It flows through
  // handleEpisodeListAction into every memoised <EpisodeCard>, whose comparator
  // bails on a changed `onAction`. Depending on `cap` (a fresh object every
  // render) or `extras`/`data` (a fresh object every 2.5s transfer poll) rebuilt
  // it on every poll and reflashed every card. The volatile values it reads are
  // therefore kept in a ref refreshed each render and shadowed at the top of the
  // body, so the callback itself carries an empty dependency list.
  const actionDeps = useRef({ props, statusFor, cap, extras, data, refetch });
  // Refresh the ref *after commit* (latest-ref pattern), not during render.
  // runAction only fires from user events, which always run post-commit, so it
  // sees committed values — and an interrupted/discarded concurrent render can
  // never leave the committed handler reading uncommitted props.
  useLayoutEffect(() => {
    actionDeps.current = { props, statusFor, cap, extras, data, refetch };
  });

  const runAction = useCallback(
    async (
      action: TitleAction,
      key: string,
      label: string,
      retention: TitleRetention,
      resolution?: number,
    ) => {
      const { props, statusFor, cap, extras, data, refetch } =
        actionDeps.current;
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
            provider: props.provider ?? null,
            providerId: props.providerId ?? null,
            sourceType: props.sourceType ?? null,
            format: props.format ?? null,
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
        if (!streaming) startTransferPoll();
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
    // Every changing value runAction needs is read from `actionDeps.current`.
    // startTransferPoll is stable, so this callback also stays stable across
    // progress ticks and the memoised episode cards never rebuild.
    [startTransferPoll],
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
        // A season is "complete" when every TMDB episode has an air date that
        // is today or in the past.  Only computed when the extras for this
        // exact season are loaded — unknown extras default to true (complete)
        // so the planner stays conservative and may still choose a pack.
        const seasonComplete =
          extras != null &&
          extras.season === targetSeason &&
          extras.episodes.length > 0
            ? extras.episodes.every((ep) => !isUnaired(ep.airDate))
            : true;
        const outcome = await cap.run(async ({ overrideStorageCap }) => {
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
              provider: props.provider ?? null,
              providerId: props.providerId ?? null,
              sourceType: props.sourceType ?? null,
              format: props.format ?? null,
              seasonComplete,
              ...(resolution != null
                ? { preferredResolution: resolution }
                : {}),
              ...(overrideStorageCap ? { overrideStorageCap: true } : {}),
            }),
          });
          const body = (await res.json().catch(() => null)) as
            | TitleSeasonGrabResponse
            | null;

          if (!res.ok || !body?.ok || !body.report) {
            // Re-derive overridability on the client so a wire flag alone cannot
            // open the "download anyway" path for a hard stop (wont-fit/setup).
            const storage = parseStorageOverrideFacts(body?.storage);
            const message =
              body?.message || `Could not plan season ${targetSeason}`;
            if (storage) throw new StorageLimitError(message, storage);
            throw new Error(message);
          }
          return body;
        });

        if (outcome.status === "cancelled") {
          spentSeasonGrabs.current.delete(key);
          setSeasonStatuses((prev) => ({
            ...prev,
            [key]: { status: "idle" },
          }));
          return;
        }

        const report = outcome.value.report!;
        setSeasonStatuses((prev) => ({
          ...prev,
          [key]: { status: "done", report },
        }));
        toast.success(`Season ${targetSeason} added to downloads`);
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
        toast.error(
          err instanceof Error
            ? err.message
            : `Could not download season ${targetSeason}`,
        );
      }
    },
    [
      props.workKey,
      props.title,
      props.mediaType,
      props.year,
      props.provider,
      props.providerId,
      props.sourceType,
      props.format,
      extras,
      refetch,
      seasonStatusFor,
      cap,
    ],
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
          progress={visibleProgress}
          extrasLoading={extrasLoading}
          extrasRefreshing={extrasRefreshing}
          extrasError={extrasError}
          extrasSettled={extrasSettled}
          extrasSeason={activeSeason}
          refetchExtras={refetchExtras}
          season={season}
          refreshing={refreshing}
          statusFor={statusFor}
          seasonStatusFor={seasonStatusFor}
          onSeasonChange={handleSeasonChange}
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
          episodeTitles={episodeTitles}
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
  progress,
  extrasLoading,
  extrasRefreshing,
  extrasError,
  extrasSettled,
  extrasSeason,
  refetchExtras,
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
  progress: TitleProgressPayload | null;
  extrasLoading: boolean;
  extrasRefreshing: boolean;
  extrasError: string | null;
  /** Has the extras request for the URL currently in play finished? */
  extrasSettled: boolean;
  /** The season the extras request was built for — not always the one shown. */
  extrasSeason: number | null;
  refetchExtras: () => void | Promise<unknown>;
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

  // Stable per-list handler. Passed straight to <EpisodeList>, which hands it
  // to every card. An inline arrow here was recreated on every render, so the
  // memoised cards saw a new onAction each transfer poll and all re-rendered —
  // reflashing their stills. `onAction` (runAction) is itself a useCallback, so
  // this stays referentially stable across polls.
  const handleEpisodeListAction = useCallback(
    (
      action: TitleAction,
      _label: string,
      _retention: TitleRetention,
      resolution?: number,
    ) => {
      onAction(
        action,
        action.season != null && action.episode != null
          ? episodeIntentKey(
              action.season,
              action.episode,
              action.kind === "get" ? "keep" : "stream",
            )
          : PRIMARY_KEY,
        _label,
        action.kind === "get" ? "keep" : "stream",
        resolution,
      );
    },
    [onAction],
  );

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
  const seasons = mergeSeasons(
    payload.seasons,
    extras?.seasons ?? [],
    progress?.seasonTransfers,
  );
  // Default to the first known season when neither the user nor the detail
  // route has chosen one, so a series never renders with every season tab
  // inactive and an empty episode list ("no default season selected").
  const activeSeason = season ?? payload.season ?? seasons[0]?.season ?? null;
  const onKnownSeason = activeSeason === payload.season;
  const extrasDescribeActiveSeason =
    !payload.isSeries ||
    activeSeason == null ||
    (extras != null && extras.season === activeSeason);
  const episodeExtras = extrasDescribeActiveSeason ? extras : null;
  const { rows, truncated } = mergeEpisodes({
    season: activeSeason,
    episodes: onKnownSeason ? payload.episodes : [],
    meta: episodeExtras?.episodes ?? [],
    metaSeason: episodeExtras?.season ?? null,
    transfers: progress?.episodeTransfers,
    truncated: onKnownSeason && payload.episodesTruncated,
  });

  // The hero means watch only when the payload can name what to watch.
  // Provider-complete rows let a series name a real first/next episode; when
  // they cannot, discovery stays discovery instead of becoming an ambiguous
  // title-scope stream.
  const resolvedPrimary = resolvePrimaryAction({
    ...payload,
    seasons,
    season: activeSeason,
    episodes: rows,
  });
  const primary: TitleAction =
    resolvedPrimary.kind === "discover"
      ? resolvedPrimary
      : resolvedPrimary.kind === "play"
        ? resolvedPrimary
        : {
            kind: "stream",
            label: "Play",
            season: resolvedPrimary.season,
            episode: resolvedPrimary.episode,
          };
  const primaryStatus = statusFor(PRIMARY_KEY);
  const primaryDisplayLabel = titleActionButtonLabel(primary, primaryStatus);

  const seasonCount = extras?.seasonCount ?? null;
  const similar = extras?.moreLikeThis ?? [];
  // A series page with no extras yet is still loading the episode list —
  // not "ready with zero episodes". Treating that gap as ready flashed the
  // empty copy (or nothing) under a finished hero, then the list popped in
  // with no explanation of the wait.
  // Show the loading skeletons only when there is nothing to show yet. Once
  // rows exist, a background refresh (the transfer poll) must never swap them
  // for skeletons — that was the flashing episode list: every 2.5s poll set
  // `refreshing`, and while the answered season lagged the requested one the
  // list blinked to skeletons and back.
  //
  // A mismatch between the extras' season and the shown season only counts as
  // loading while a request for the shown season is actually pending
  // (`extrasRequestPending`). The page's extras URL falls back to the payload
  // season only, while this panel also falls back to the first merged
  // (provider) season — so extras could answer `season: null` for good while
  // the panel showed Season 1, with no error and no further request. That is a
  // terminal empty/provider state, not a permanent skeleton.
  const extrasPending = extrasRequestPending({
    activeSeason,
    requestedSeason: extrasSeason,
    extrasDescribeActiveSeason,
    extrasLoading,
    extrasRefreshing,
    extrasSettled,
  });
  const episodeListLoading =
    payload.isSeries &&
    rows.length === 0 &&
    (extrasPending ||
      (refreshing && season != null && season !== payload.season));
  const episodeListState =
    extrasError && rows.length === 0
      ? ({ status: "error", message: extrasError } as const)
      : episodeListLoading
        ? ({ status: "loading" } as const)
        : ({ status: "ready" } as const);
  const activeSeasonGrabStatus =
    activeSeason != null ? seasonStatusFor(activeSeason, "keep") : ({ status: "idle" } as const);

  // The SILO-style hero prints one score/meta line under the title and a
  // compact metadata list in a right column. Both draw only from what the
  // payload/extras vouch for — every absent piece is dropped, never faked.
  const metaRating = payload.rating ?? extras?.rating ?? null;
  const releaseDate = payload.releaseDate ?? extras?.releaseDate ?? null;
  // The year piece prefers the payload's explicit year, falling back to the
  // year of the real release date when the page was opened from a link that
  // carried no year (a derivation, not an invented value).
  const metaYear = payload.year ?? releaseYear(releaseDate);
  const genres = extras?.genres ?? [];
  const metaListPresent = Boolean(
    extras?.originalLanguage ||
      formatReleaseDate(releaseDate) ||
      extras?.certification,
  );

  // The button is the only place a pending action is narrated: ButtonBody
  // overlays the spinner in place of the label, exactly like a normal video
  // player. No status line, no hint, and no progress bar under the buttons.
  //
  // A `get` primary is the download control, so an in-flight title transfer
  // disables it for the same reason it hides the secondary Download. A `stream`
  // or `play` primary is left alone: a kept download does not stop the file
  // being watchable, and taking Play away mid-download is the behaviour the
  // sequential piece strategy exists to avoid.
  const primaryCanRun =
    (primary.kind === "discover"
      ? !extrasLoading && !extrasRefreshing
      : shouldRunTitleAction(primary, primaryStatus)) && !gated;

  // Play and Download are the two acquire intents. The primary button above is
  // the Play/Resume path (it opens the player); Download keeps the file. We only
  // offer a separate Download alongside a playable primary — when the primary is
  // itself a Get (positively unavailable), it already *is* the download, so a
  // second identical button would be noise.
  //
  // `discover` suppresses it for a different reason: there is no target yet.
  // A Download button here would have to name an episode, and the only episode
  // it could name is the guess this whole change exists to remove.
  //
  // The third condition is the one the Client used to contradict: a title the
  // user has already sent is not offered again. `payload.transfer` is title
  // scope — an episode or season grab elsewhere in this work must not silence
  // the title's own control.
  const showDownload = !payload.isSeries && !gated;
  const downloadAction: TitleAction = {
    kind: "get",
    label: "Download",
    season: primary.season,
    episode: primary.episode,
    infoHash: primary.kind === "play" ? primary.infoHash : payload.infoHash,
  };
  const downloadStatus = statusFor(DOWNLOAD_KEY);
  const titleTransfer = progress?.transfer ?? payload.transfer;
  const downloadLabel =
    titleTransfer?.status === "queued"
      ? "Queued"
      : titleTransfer?.status === "downloading"
        ? `Downloading ${Math.floor(Math.max(0, Math.min(1, titleTransfer.progress)) * 100)}%`
        : titleTransfer?.status === "downloaded"
          ? "Downloaded"
          : titleTransfer?.status === "failed"
            ? "Retry download"
            : titleActionButtonLabel(downloadAction, downloadStatus);
  const downloadCanRun =
    offersDownload(titleTransfer) &&
    shouldRunTitleAction(downloadAction, downloadStatus) &&
    !gated;
  const downloadLabelTarget = title;

  return (
    <article aria-labelledby="title-heading" className="flex grow flex-col">
      <header
        data-title-hero
        className="relative isolate flex flex-col justify-end overflow-hidden border-b border-[var(--border)] bg-[var(--bg-elevated)]"
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
          {/* Bounded, not proportional.
              `min-h: 56vh` plus `grow` on the header above meant the hero took
              a fixed share of every viewport, so on a 1080p screen the title,
              its metadata and its buttons sat alone in a cinema-sized band and
              the first genuinely useful section — episodes, or similar titles —
              began below the fold. The content is what sets the height now; the
              floor only stops a title with no artwork and no overview from
              collapsing into a strip. */}
          <div
            className={cn(
              "grid grid-cols-[104px_minmax(0,1fr)] items-end gap-x-4 gap-y-5 py-5 sm:grid-cols-[120px_minmax(0,1fr)] sm:py-8 md:grid-cols-[168px_minmax(0,1fr)] md:gap-x-6 md:py-10 lg:grid-cols-[196px_minmax(0,1fr)] lg:py-10",
              payload.isSeries
                ? "min-h-0 md:min-h-[18rem] lg:min-h-[20rem]"
                : "min-h-0 md:min-h-[21rem] lg:min-h-[24rem]",
            )}
          >
            {/* The poster is a mark, not a caption: the title is printed
                beside it, so the no-artwork tile carries no words of its own. */}
            <div className="w-[104px] shrink-0 self-end sm:w-[120px] md:row-span-2 md:w-[168px] lg:w-[196px]">
              <div
                className={cn(
                  "relative aspect-[2/3] w-full overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-muted)] shadow-[var(--shadow-md)]",
                  gated && "grayscale",
                )}
              >
                <PosterImage
                  src={payload.posterUrl}
                  title={title}
                  sizes="(min-width: 1024px) 196px, (min-width: 768px) 168px, (min-width: 640px) 120px, 104px"
                  priority
                />
              </div>
            </div>

            <div className="min-w-0 flex-1">
              <h1
                id="title-heading"
                title={payload.title}
                className="text-[clamp(1.75rem,7vw,2.25rem)] font-semibold leading-[1.05] tracking-[-0.03em] text-[var(--text)] md:text-display"
              >
                {title}
              </h1>

              {/* The rating/meta line sits directly under the title, SILO-style:
                  `TMDB {score} ({votes}) · {year} · {N Seasons|runtime}`. A gated
                  title keeps its "Coming {date}" / "In cinemas" chip beside it. */}
              <div className="mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-2">
                {gated ? (
                  <span
                    data-title-coming
                    className="inline-flex items-center gap-1.5 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-elevated)] px-2.5 py-1 text-[12px] font-medium text-[var(--text-secondary)]"
                  >
                    {theatrical.theatricalLabel ?? release.comingLabel ?? "Coming soon"}
                  </span>
                ) : null}
                <RatingMetaLine
                  rating={metaRating}
                  voteCount={extras?.voteCount ?? null}
                  ratingSource={extras?.ratingSource ?? null}
                  year={metaYear}
                  isSeries={payload.isSeries}
                  seasonCount={seasonCount}
                />
              </div>

              {/* Actions come next in the reference: the existing Play/Resume
                  primary, the film-only Download, then the library controls. The
                  behaviour of each is untouched — only their position moved above
                  the synopsis. */}
              <div
                className="mt-4 grid grid-cols-1 gap-2 sm:mt-5 sm:flex sm:flex-wrap sm:items-center"
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
                    `${primaryDisplayLabel} — ${title}`
                  }
                  aria-busy={
                    (primary.kind === "discover"
                      ? extrasLoading || extrasRefreshing
                      : primaryStatus === "pending") || undefined
                  }
                  disabled={!primaryCanRun}
                  onClick={() => {
                    if (primary.kind === "discover") {
                      void refetchExtras();
                      return;
                    }
                    requestAction(
                      primary,
                      PRIMARY_KEY,
                      title,
                      "stream",
                    );
                  }}
                  className="relative w-full min-w-0 sm:w-auto sm:min-w-[9rem]"
                >
                  <ButtonBody
                    pending={
                      primary.kind === "discover"
                        ? extrasLoading || extrasRefreshing
                        : primaryStatus === "pending"
                    }
                    icon={
                      primary.kind === "discover" ? (
                        <Search aria-hidden />
                      ) : (
                        <Play className="fill-current" aria-hidden />
                      )
                    }
                  >
                    {primaryDisplayLabel}
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
                    aria-label={`Download — ${title}`}
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
                    className="relative w-full min-w-0 sm:w-auto sm:min-w-[8rem]"
                  >
                    <ButtonBody
                      pending={downloadStatus === "pending"}
                      icon={<Download aria-hidden />}
                    >
                      {downloadLabel}
                    </ButtonBody>
                  </Button>
                ) : null}

                <LibraryControls
                  library={payload.library}
                  isSeries={payload.isSeries}
                  seasons={seasons.map((s) => s.season)}
                  releaseDate={payload.releaseDate}
                  onChanged={onLibraryChanged}
                />
              </div>

            </div>

            {/* The two-column band under the actions. It spans the full phone
                width so synopsis/meta never get squeezed beside the compact
                poster, then returns to the desktop content column at md+. */}
            <div className="col-span-2 flex flex-col gap-4 md:col-span-1 md:col-start-2 md:flex-row md:gap-8">
                <div className="min-w-0 flex-1 md:max-w-2xl">
                  {payload.overview ?? extras?.overview ? (
                    <p
                      data-title-overview
                      className="text-body line-clamp-5 max-w-xl"
                    >
                      {payload.overview ?? extras?.overview}
                    </p>
                  ) : !extras ? (
                    // Reserve the paragraph's space while the extras round trip
                    // is still in flight, so the hero does not reflow when the
                    // synopsis lands. Same placeholder behaviour as before, only
                    // relocated into the left column of the band.
                    <p
                      aria-hidden
                      data-title-overview-placeholder
                      className="min-h-0 md:min-h-[5.25rem]"
                    />
                  ) : null}

                  <GenreChips genres={genres} />
                </div>

                {metaListPresent ? (
                  <div className="w-full md:w-[260px] md:shrink-0">
                    <HeroMetaList
                      originalLanguage={extras?.originalLanguage ?? null}
                      releaseDate={releaseDate}
                      certification={extras?.certification ?? null}
                    />
                  </div>
                ) : null}
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

      <div className="container-app space-y-7 py-6 pb-[calc(var(--mobile-nav-h)+var(--safe-bottom)+1.5rem)] md:space-y-10 md:py-8 md:pb-8">
        {payload.isSeries ? (
          <EpisodeList
            seasons={seasons}
            season={activeSeason}
            episodes={rows}
            truncated={truncated}
            loadState={episodeListState}
            busy={rows.length === 0 && refreshing && season != null && season !== payload.season}
            statusFor={statusFor}
            seasonGrabStatus={activeSeasonGrabStatus}
            gated={gated}
            onSeasonChange={onSeasonChange}
            onSeasonGrab={requestSeasonGrab}
            onAction={handleEpisodeListAction}
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
  // Threaded through so `pickSeason` can fall back to a manual pick from a
  // previous visit, even on a fresh link with no `?s=`. Server-side only
  // (read from the cookie in the page component) — see
  // `@/lib/title/remembered-season`.
  if (props.rememberedSeason != null) {
    params.set("remembered", String(props.rememberedSeason));
  }
  const qs = params.toString();
  const base = `/api/title/${encodeURIComponent(props.workKey)}`;
  return qs ? `${base}?${qs}` : base;
}

/**
 * Persists a manually-picked season to the durable `tf_season` cookie.
 *
 * Client-only (reads/writes `document.cookie`) — the bounded parse/serialize
 * logic itself lives in the isomorphic `@/lib/title/remembered-season` so the
 * same rules apply whether the value is read here or in the server page
 * component. A year-long `max-age` matches the "durable" requirement: this is
 * a preference, not a session artifact, and should survive well past a single
 * browsing session.
 */
function writeRememberedSeasonCookie(workKey: string, season: number): void {
  if (typeof document === "undefined") return;
  const current = readCookieRaw(REMEMBERED_SEASON_COOKIE_NAME);
  const next = nextRememberedSeasonCookieValue(current, workKey, season);
  if (next == null) return;
  const oneYearSeconds = 60 * 60 * 24 * 365;
  const secure =
    typeof window !== "undefined" && window.location.protocol === "https:"
      ? "; Secure"
      : "";
  document.cookie = `${REMEMBERED_SEASON_COOKIE_NAME}=${next}; Path=/; Max-Age=${oneYearSeconds}; SameSite=Lax${secure}`;
}

/**
 * The remembered season for this title as the *browser* currently knows it.
 *
 * The server-rendered `rememberedSeason` prop can be stale on a client-side
 * navigation (a router-cached RSC payload predates the pick); `document.cookie`
 * never is, because `writeRememberedSeasonCookie` above set it in this tab.
 */
function readRememberedSeasonFromDocument(workKey: string): number | null {
  if (typeof document === "undefined") return null;
  return readRememberedSeason(
    readCookieRaw(REMEMBERED_SEASON_COOKIE_NAME),
    workKey,
  );
}

function readCookieRaw(name: string): string | null {
  if (typeof document === "undefined") return null;
  const prefix = `${name}=`;
  for (const part of document.cookie.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length);
  }
  return null;
}

function readLegacySeasonFromLocation(): number | null {
  if (typeof window === "undefined") return null;
  const raw = new URL(window.location.href).searchParams.get("s");
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return isValidSeason(parsed) ? parsed : null;
}

function removeLegacySeasonFromLocation(): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (!url.searchParams.has("s")) return;
  url.searchParams.delete("s");
  const query = url.searchParams.toString();
  window.history.replaceState(
    window.history.state,
    "",
    `${url.pathname}${query ? `?${query}` : ""}${url.hash}`,
  );
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
  params.set("v", "3");
  params.set("t", title);
  if (payload.year) params.set("y", String(payload.year));
  const routeMediaType =
    props.provider ? (props.mediaType ?? payload.mediaType) : payload.mediaType;
  if (routeMediaType) params.set("type", routeMediaType);
  if (payload.posterUrl) params.set("poster", payload.posterUrl);
  if (season != null) params.set("s", String(season));
  if (props.provider) params.set("provider", props.provider);
  if (props.providerId) params.set("providerId", props.providerId);
  if (props.sourceType) params.set("sourceType", props.sourceType);
  if (props.format) params.set("format", props.format);
  if (props.seriesHint) params.set("series", props.seriesHint);
  for (const alias of props.aliases ?? []) params.append("alias", alias);

  return `/api/title/${encodeURIComponent(props.workKey)}/extras?${params.toString()}`;
}

function extrasDataIdentity(url: string | null): string | null {
  if (!url) return null;
  const parsed = new URL(url, "http://torrentflow.local");
  parsed.searchParams.delete("s");
  return `${parsed.pathname}?${parsed.searchParams.toString()}`;
}

/** True when the payload still has something the engine is moving. */
function titleNeedsTransferPoll(
  payload: TitleDetailPayload | null,
): boolean {
  if (!payload) return false;
  const live = (status: string | undefined) =>
    status === "queued" || status === "downloading";
  if (live(payload.transfer?.status)) return true;
  for (const season of payload.seasons) {
    if (live(season.transfer?.status)) return true;
  }
  for (const episode of payload.episodes) {
    if (live(episode.transfer?.status)) return true;
  }
  return false;
}

function titleProgressHasActiveTransfer(
  payload: TitleProgressPayload,
): boolean {
  const active = (status: string | undefined) =>
    status === "queued" || status === "downloading";
  if (active(payload.transfer?.status)) return true;
  if (
    Object.values(payload.seasonTransfers).some((transfer) =>
      active(transfer?.status)
    )
  ) {
    return true;
  }
  return Object.values(payload.episodeTransfers).some((transfer) =>
    active(transfer?.status)
  );
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
          <div className="grid grid-cols-[104px_minmax(0,1fr)] items-end gap-4 py-5 sm:grid-cols-[120px_minmax(0,1fr)] sm:py-8 md:grid-cols-[168px_minmax(0,1fr)] md:gap-6 md:py-10 lg:grid-cols-[196px_minmax(0,1fr)] lg:py-12">
            <div className="w-[104px] shrink-0 sm:w-[120px] md:w-[168px] lg:w-[196px]">
              <div className="skeleton aspect-[2/3] w-full rounded-[var(--radius)]" />
            </div>
            <div className="min-w-0 max-w-2xl flex-1">
              <div className="skeleton h-9 w-3/4 rounded" />
              <div className="skeleton mt-3 h-3 w-40 rounded" />
              <div className="skeleton mt-5 h-11 w-full rounded-[var(--radius)] sm:w-44" />
            </div>
            <div className="col-span-2 space-y-2 md:col-start-2 md:col-span-1">
              <div className="skeleton h-3 w-full max-w-md rounded" />
              <div className="skeleton h-3 w-4/5 max-w-md rounded" />
            </div>
          </div>
        </div>
      </div>
      <div className="container-app py-6 md:py-8">
        <div className="skeleton h-5 w-32 rounded" />
        <div className="mt-3 space-y-2 sm:flex sm:gap-3 sm:space-y-0 sm:overflow-hidden">
          {[0, 1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="skeleton h-24 w-full rounded-[var(--radius)] sm:h-[215px] sm:w-[300px] sm:shrink-0"
            />
          ))}
        </div>
      </div>
    </div>
  );
}
