/**
 * The title page — the spine of the product.
 *
 * The complaint this answers, in the user's words: *"this is not a product,
 * it's a website you go to view torrent lists."* It was true, and structurally
 * so: clicking a title anywhere in the app landed on `/search`, a table of
 * release names, seeders and magnet links. This page is *see art → click → a
 * page about the title → press Download*.
 *
 * So the layout is built around acquiring the title, never "Search" and never
 * a releases table. Getting is one press, performed by the server, and does
 * not navigate anywhere. Finished files open in the owner's own player from
 * Downloads; nothing on this page plays.
 *
 * Two things about the states on this page:
 *
 *  - `availability: null` means *nobody has checked*, and renders as an
 *    ordinary clickable Download. It is not a disabled control and it is not
 *    `unavailable`.
 *  - Error and empty are one exclusive chain, not two independent `{x ? …}`
 *    blocks — the bug that told `/watchlist` users their library was empty
 *    when the request had actually failed.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { CheckCircle2, Download, FolderOpen, Loader2, Search, Trash2 } from "lucide-react";
import { Link, useNavigate, type NavigateFunction } from "react-router";
import { toast } from "@/lib/toast";
import { useFeatures } from "@/lib/features";
import { openDownload, type OpenDownloadMode } from "@/lib/open-download";
import { ConfirmDialog } from "@/components/tf/confirm-dialog";
import { PosterImage } from "@/components/browse/poster-image";
import { posterTint } from "@/components/browse/poster";
import { cleanDisplayTitle } from "@/components/browse/availability";
import { headingTitle } from "./heading-title";
import { TfEmptyState } from "@/components/tf/empty-state";
import { TfErrorState } from "@/components/tf/error-state";
import { TfOpenFileButton } from "@/components/tf/open-file-button";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useApiQuery } from "@/hooks/use-api-query";
import { cn } from "@/lib/utils";
import { browseReleaseGate } from "@/lib/browse/release-status";
import { ReleaseGateChip } from "@/components/browse/release-gate-chip";
import { EpisodeList, episodeIntentKey } from "./episode-list";
import { extrasRequestPending } from "./episode-list-state";
import { LibraryControls } from "./library-controls";
import { libraryHint } from "./library-hint";
import { mergeEpisodes, mergeSeasons, isUnaired } from "./merge-extras";
import { WatchStateChip } from "./watch-state";
import { ownedLabel } from "./owned-state";
import { OwnedQuality } from "./owned-quality";
import {
  providerAiredFor,
  seasonProgressFromRows,
  seasonProgressFromSummary,
  seasonProgressLabel,
  showProgressFromSeasons,
  type SeasonProgress,
} from "./season-progress";
import { SeasonProgressMeter } from "./season-progress-meter";
import { MoreLikeThis } from "./more-like-this";
import { LinkedRecords } from "./linked-records";
import { RequestAction } from "@/components/requests/request-action";
import {
  WantedActions,
  stopWanted,
  tryWantedNow,
  useWantedRows,
  wantedRemoveDescription,
  type WantedAction,
} from "@/components/wanted/wanted-actions";
import { useCapabilities } from "@/lib/capabilities";
import { parseRequestState, type RequesterTitle } from "@/lib/requests";
import type { CatalogIdentity } from "@/lib/browse/types";
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
  needsEpisodeDiscovery,
  resolveTitleTransferControl,
  shouldRunTitleAction,
  type TitleAction,
  type TitleActionStatus,
} from "./title-actions";
import {
  SeasonGrabFailureError,
  seasonGrabFailureDescription,
  seasonGrabKey,
  seasonGrabRetryEpisodes,
  shouldRetrySeasonGrab,
  shouldRunSeasonGrab,
  type SeasonGrabReport,
  type SeasonGrabStatus,
} from "./season-grab-state";
import {
  NoReleaseFoundError,
  postTitleAction,
  rethrowAcquisitionFetchError,
} from "./title-action-request";
import { encodeKeySegment } from "./work-key";
import { toastDownloadOutcome } from "@/components/releases/download-outcome-toast";
import { canFindAnotherSource, FIND_ANOTHER_SOURCE_LABEL } from "@/components/releases/find-another-source";
import { ReleaseSwapDialog, type ReleaseSwapSubject } from "@/components/releases/release-swap-dialog";
import { openReleasePicker } from "@/components/releases/release-picker-store";
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
  TitleEpisodeTransfer,
  TitleExtrasPayload,
  TitleProgressPayload,
  TitleSeasonGrabResponse,
} from "./types";

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
  /**
   * A season the user picked by hand on a previous visit, read server-side
   * from the durable `tf_season` cookie (see
   * `@/lib/title/remembered-season`). Threaded through to the API as a plain
   * query param so the server's season pick can prefer it over a provider default.
   */
  rememberedSeason?: number | null;
}

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

/**
 * Where a download went, when that is not this page. The server files a
 * download under the work it is, and a namesake's page can resolve to another
 * key (`doctor-who-2005` to `doctor-who-2005-tv`), so the page follows it in
 * place, with no new history entry, and the transfer shows on the page the
 * user is looking at. True when it moved.
 */
function followResolvedWorkKey(
  navigate: NavigateFunction,
  pageKey: string,
  resolved: string | null | undefined,
): boolean {
  const next = resolved?.trim();
  if (!next || sameWorkKey(next, pageKey)) return false;
  navigate(
    { pathname: `/title/${encodeKeySegment(next)}`, search: window.location.search },
    { replace: true },
  );
  return true;
}

/** One key however it is spelled: route params arrive decoded, stored keys may be percent-encoded. */
function sameWorkKey(a: string, b: string): boolean {
  const plain = (key: string) => {
    try {
      return decodeURIComponent(key).toLowerCase();
    } catch {
      return key.toLowerCase();
    }
  };
  return plain(a) === plain(b);
}

export function TitleDetail(props: TitleDetailProps) {
  const caps = useCapabilities();
  const navigate = useNavigate();
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
  // The cap is a guardrail, not a wall: an over-cap Download raises an informed
  // confirmation instead of a dead-end toast.
  const cap = useStorageCapOverride();
  const spentRemoteActions = useRef(new Set<string>());
  const spentSeasonGrabs = useRef(new Set<string>());
  // Season requests still waiting on the server; a toast Retry may pass a
  // spent (partially started) season but never one of these.
  const inFlightSeasonGrabs = useRef(new Set<string>());
  // The download "Find another source" is open for: the film, or one episode. Owner only.
  const [swapSubject, setSwapSubject] = useState<ReleaseSwapSubject | null>(null);

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
      // This is the only durable write: an explicit user pick, never an
      // inferred season or a provider default.
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
      select: withCatalogDefaults,
    });
  useEffect(() => {
    if (titleNeedsTransferPoll(data)) startTransferPoll();
  }, [data, startTransferPoll]);

  // Transfers are the owner's; everyone else never polls them.
  const progressUrl = caps.canSeeTransfers && transferPoll
    ? `/api/title/${encodeURIComponent(props.workKey)}/progress?session=${transferPollSession}`
    : null;
  const {
    data: progress,
    error: progressError,
    settled: progressSettled,
  } = useApiQuery<TitleProgressPayload>(progressUrl, {
      refreshMs: transferPoll ? 2_500 : 0,
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
  const statusFor = useCallback(
    (key: string) => statuses[key] ?? "idle",
    [statuses],
  );

  // runAction must keep ONE identity for the life of the page. It flows through
  // handleEpisodeListAction into every memoised <EpisodeCard>, whose comparator
  // bails on a changed `onAction`. Depending on `cap` (a fresh object every
  // render) or `data` (a fresh object every 2.5s transfer poll) rebuilt it on
  // every poll and reflashed every card. The volatile values it reads are
  // therefore kept in a ref refreshed each render and shadowed at the top of the
  // body, so the callback itself only depends on stable values.
  const actionDeps = useRef({ props, statusFor, cap, data, refetch, navigate });
  // Refresh the ref *after commit* (latest-ref pattern), not during render.
  // runAction only fires from user events, which always run post-commit, so it
  // sees committed values — and an interrupted/discarded concurrent render can
  // never leave the committed handler reading uncommitted props.
  useLayoutEffect(() => {
    actionDeps.current = { props, statusFor, cap, data, refetch, navigate };
  });

  const runAction = useCallback(
    async (
      action: TitleAction,
      key: string,
      label: string,
      resolution?: number,
    ) => {
      const { props, statusFor, cap, data, refetch, navigate } = actionDeps.current;
      if (!shouldRunTitleAction(statusFor(key))) return;
      if (spentRemoteActions.current.has(key)) return;
      spentRemoteActions.current.add(key);

      setStatuses((prev) => ({ ...prev, [key]: "pending" }));
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
            resolution,
            overrideStorageCap,
          }),
        );

        // The owner was shown the real figures and said no. Nothing was sent, so
        // the row goes back to idle — a declined confirmation is not a failure
        // and must not leave an error state behind.
        if (outcome.status === "cancelled") {
          spentRemoteActions.current.delete(key);
          setStatuses((prev) => ({ ...prev, [key]: "idle" }));
          return;
        }

        const body = outcome.value;
        startTransferPoll();
        setStatuses((prev) => ({ ...prev, [key]: "done" }));
        toast.success(body.message ?? `${label} sent to your client.`);
        refetch();
        followResolvedWorkKey(navigate, props.workKey, body.workKey);
      } catch (err) {
        spentRemoteActions.current.delete(key);
        setStatuses((prev) => ({ ...prev, [key]: "error" }));
        toastDownloadOutcome({
          ok: false,
          message: err instanceof Error ? err.message : `Could not get ${label}`,
          pick:
            err instanceof NoReleaseFoundError && canDownloadRef.current
              ? {
                  workKey: props.workKey,
                  title: cleanDisplayTitle(data?.title ?? props.title ?? label),
                  season: action.season ?? null,
                  episode: action.episode ?? null,
                  query: err.query,
                  onPicked: refetch,
                }
              : null,
        });
      }
    },
    // Every changing value runAction needs is read from `actionDeps.current`.
    // startTransferPoll is stable, so this callback also stays stable across
    // progress ticks and the memoised episode cards never rebuild.
    [startTransferPoll],
  );

  const seasonStatusFor = useCallback(
    (targetSeason: number) =>
      seasonStatuses[seasonGrabKey(targetSeason)] ?? ({ status: "idle" } as const),
    [seasonStatuses],
  );

  // A toast's Retry fires long after the render that raised it; these refs
  // let it reach the current season state and the viewer's current rights.
  const runSeasonGrabRef = useRef<typeof runSeasonGrab | null>(null);
  const canDownloadRef = useRef(caps.canDownload);
  canDownloadRef.current = caps.canDownload;

  const runSeasonGrab = useCallback(
    async (
      targetSeason: number,
      episodes: number[],
      resolution?: number,
      options?: { retry?: boolean },
    ) => {
      const key = seasonGrabKey(targetSeason);
      const current = seasonStatusFor(targetSeason);
      const retry = options?.retry === true;
      if (retry ? !shouldRetrySeasonGrab(current) : !shouldRunSeasonGrab(current)) return;
      if (retry && !canDownloadRef.current) return;
      if (episodes.length === 0) return;
      if (inFlightSeasonGrabs.current.has(key)) return;
      if (!retry && spentSeasonGrabs.current.has(key)) return;

      const toastId = `season-grab:${props.workKey}:${key}`;
      // Retry resends only the episodes the report lists as missing, with the
      // same season, quality and title identity as the original click.
      const retryAction = (report: SeasonGrabReport | null | undefined) => {
        if (!canDownloadRef.current) return undefined;
        const missing = seasonGrabRetryEpisodes(report, episodes);
        if (!missing) return undefined;
        return {
          label: "Retry",
          onClick: (event: { preventDefault: () => void }) => {
            // Sonner would dismiss this toast, and with it the result toast
            // that reuses its id; runSeasonGrab shows progress in place instead.
            event.preventDefault();
            void runSeasonGrabRef.current?.(
              targetSeason,
              missing,
              resolution,
              { retry: true },
            );
          },
        };
      };
      // "Pick a release yourself" for the season, prefilled with our search.
      const pickAction = (report: SeasonGrabReport | null | undefined) =>
        canDownloadRef.current
          ? {
              workKey: props.workKey,
              title: cleanDisplayTitle(props.title ?? props.workKey),
              season: targetSeason,
              query: report?.manualSearchQuery ?? null,
              onPicked: refetch,
            }
          : null;

      spentSeasonGrabs.current.add(key);
      inFlightSeasonGrabs.current.add(key);
      setSeasonStatuses((prev) => ({ ...prev, [key]: { status: "pending" } }));
      if (retry) {
        toast.loading(
          episodes.length === 1
            ? `Retrying episode ${episodes[0]}…`
            : `Retrying ${episodes.length} episodes…`,
          { id: toastId, description: undefined, action: undefined, duration: Infinity },
        );
      }
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
            body: JSON.stringify({
              scope: "season",
              season: targetSeason,
              episodes,
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
          }).catch(rethrowAcquisitionFetchError);
          const body = (await res.json().catch(() => null)) as
            | TitleSeasonGrabResponse
            | null;

          if (!res.ok || !body?.ok || !body.report) {
            // Re-derive overridability on the client so a wire flag alone cannot
            // open the "download anyway" path for a hard stop (wont-fit/setup).
            const storage = parseStorageOverrideFacts(body?.storage);
            const message =
              body?.message || `Could not download season ${targetSeason}`;
            const description =
              body?.report != null
                ? seasonGrabFailureDescription(body.report, message)
                : undefined;
            if (storage) throw new StorageLimitError(message, storage);
            if (body?.retryAfterSeconds != null) {
              throw new SeasonGrabFailureError(
                `${message} Try again in ${Math.max(1, Math.ceil(body.retryAfterSeconds))} seconds.`,
                description,
                body?.report,
              );
            }
            throw new SeasonGrabFailureError(message, description, body?.report);
          }
          return body;
        });

        if (outcome.status === "cancelled") {
          spentSeasonGrabs.current.delete(key);
          setSeasonStatuses((prev) => ({
            ...prev,
            [key]: { status: "idle" },
          }));
          if (retry) toast.dismiss(toastId);
          return;
        }

        const report = outcome.value.report!;
        setSeasonStatuses((prev) => ({
          ...prev,
          [key]: { status: "done", report },
        }));
        if (outcome.value.queued) {
          // Fire and forget: the season is on the wanted list and the server
          // keeps looking; anything that needs the owner shows up later.
          toast.success(outcome.value.message, {
            id: toastId,
            description: report.planReason ?? undefined,
          });
          refetch();
          followResolvedWorkKey(navigate, props.workKey, outcome.value.workKey);
          return;
        }
        // A partial start names why the rest did not start and offers a Retry
        // for just those episodes.
        const partial = report.coveredEpisodes < report.totalEpisodes;
        const partialRetry = retryAction(report);
        const partialPick = partial ? pickAction(report) : null;
        const partialDescription = partial
          ? seasonGrabFailureDescription(report, outcome.value.message)
          : undefined;
        // A partial start names why the rest did not start and stays until the
        // user retries or dismisses it; a full start fades.
        toastDownloadOutcome({
          ok: true,
          id: toastId,
          message: outcome.value.message,
          description: partialDescription ?? report.planReason ?? undefined,
          retry: partialRetry,
          pick: partialPick,
        });
        refetch();
        followResolvedWorkKey(navigate, props.workKey, outcome.value.workKey);
      } catch (err) {
        spentSeasonGrabs.current.delete(key);
        setSeasonStatuses((prev) => ({
          ...prev,
          [key]: {
            status: "error",
            message:
              err instanceof Error
                ? err.message
                : `Could not download season ${targetSeason}`,
          },
        }));
        const message =
          err instanceof Error
            ? err.message
            : `Could not download season ${targetSeason}`;
        const failure =
          err instanceof SeasonGrabFailureError ? err : undefined;
        toastDownloadOutcome({
          ok: false,
          id: toastId,
          message,
          description: failure?.description,
          retry: failure ? retryAction(failure.report) : undefined,
          pick: failure ? pickAction(failure.report) : null,
        });
      } finally {
        inFlightSeasonGrabs.current.delete(key);
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
      navigate,
    ],
  );
  runSeasonGrabRef.current = runSeasonGrab;

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
          onFindAnotherSource={setSwapSubject}
          provider={props.provider ?? null}
          providerId={props.providerId ?? null}
          routeTitle={props.title ?? null}
        />
      )}

      {swapSubject && caps.canDownload ? (
        <ReleaseSwapDialog
          key={swapSubject.hash}
          subject={swapSubject}
          onClose={() => setSwapSubject(null)}
          onSwapped={() => {
            setSwapSubject(null);
            startTransferPoll();
            void refetch();
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
  onFindAnotherSource,
  provider,
  providerId,
  routeTitle,
}: {
  /** From the link that opened the page; a request needs them to name the title. */
  provider: string | null;
  providerId: string | null;
  /** The name the link carried, used when the payload only has a provider key. */
  routeTitle: string | null;
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
  seasonStatusFor: (season: number) => SeasonGrabStatus;
  onSeasonChange: (season: number) => void;
  onSeasonGrab: (
    season: number,
    episodes: number[],
    resolution?: number,
  ) => void;
  onAction: (
    action: TitleAction,
    key: string,
    label: string,
    resolution?: number,
  ) => void;
  onLibraryChanged: () => void;
  /** Opens Find another source for the film's or an episode's download. Stable: a state setter. */
  onFindAnotherSource: (subject: ReleaseSwapSubject) => void;
}) {
  const caps = useCapabilities();
  const { openFolder } = useFeatures();
  const { preferredResolution, alwaysPreferred, setAlwaysPreferred } = usePreferredQuality();
  // Quality picker for the hero Download button.
  const [heroPicker, setHeroPicker] = useState(false);
  const [openingFile, setOpeningFile] = useState<OpenDownloadMode | null>(null);

  // Stable per-list handler. Passed straight to <EpisodeList>, which hands it
  // to every card. An inline arrow here was recreated on every render, so the
  // memoised cards saw a new onAction each transfer poll and all re-rendered —
  // reflashing their stills. `onAction` (runAction) is itself a useCallback, so
  // this stays referentially stable across polls.
  const handleEpisodeListAction = useCallback(
    (action: TitleAction, label: string, resolution?: number) => {
      onAction(
        action,
        action.season != null && action.episode != null
          ? episodeIntentKey(action.season, action.episode)
          : DOWNLOAD_KEY,
        label,
        resolution,
      );
    },
    [onAction],
  );

  function requestSeasonGrab(
    targetSeason: number,
    episodes: number[],
    resolution?: number,
  ) {
    onSeasonGrab(targetSeason, episodes, resolution);
  }

  // A provider key ("Tmdb:movie:550") is never printed. While metadata is
  // still arriving the heading is a skeleton; once it settles with no name the
  // page says so plainly.
  const knownTitle = headingTitle(payload.title, routeTitle);
  const titlePending = knownTitle == null && (refreshing || extrasLoading || !extrasSettled);
  const title = knownTitle != null ? cleanDisplayTitle(knownTitle) : "Unknown title";
  // Stable across polls like handleEpisodeListAction, so the memoised episode
  // cards don't re-render for it. Names the episode the way Downloads does.
  const handleFindEpisodeSource = useCallback(
    (hash: string, episodeLabel: string) =>
      onFindAnotherSource({ hash, workTitle: title, label: `${title} ${episodeLabel}` }),
    [onFindAnotherSource, title],
  );
  // Waiting for an English release: the owner can pick one by hand, which always goes.
  const workKey = payload.workKey;
  const handlePickEpisodeRelease = useCallback(
    (season: number, episode: number) =>
      openReleasePicker({ workKey, title, season, episode, onPicked: onLibraryChanged }),
    [workKey, title, onLibraryChanged],
  );
  // Waiting for the show's season list: Try now or Remove, the same requests and confirmation as Downloads.
  const [removingEpisode, setRemovingEpisode] = useState<{ season: number; episode: number } | null>(null);
  const [removingBusy, setRemovingBusy] = useState(false);
  const episodeName = useCallback(
    (season: number, episode: number) =>
      `${title} S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`,
    [title],
  );
  const handleWantedAction = useCallback(
    async (season: number, episode: number, action: WantedAction) => {
      if (action === "remove") {
        setRemovingEpisode({ season, episode });
        return;
      }
      const name = episodeName(season, episode);
      try {
        if (!(await tryWantedNow({ workKey, season, episode }))) throw new Error("refused");
        toast.success(`Looking for ${name} now.`);
      } catch {
        toast.error(`Couldn't start a search for ${name}. Check that TorrentFlow is running, then try again.`);
      }
      onLibraryChanged();
    },
    [workKey, episodeName, onLibraryChanged],
  );
  const confirmRemoveEpisode = async () => {
    if (!removingEpisode) return;
    const name = episodeName(removingEpisode.season, removingEpisode.episode);
    setRemovingBusy(true);
    try {
      if (!(await stopWanted({ workKey, ...removingEpisode }))) throw new Error("refused");
      toast.success(`Removed ${name}. TorrentFlow stopped looking for it.`);
      setRemovingEpisode(null);
      onLibraryChanged();
    } catch {
      toast.error(`Couldn't remove ${name}. Check that TorrentFlow is running, then try again.`);
    } finally {
      setRemovingBusy(false);
    }
  };
  // Only a real backdrop. A poster stretched across a 16:9 band is a hack in
  // itself, and it is also how a single wrong artwork URL becomes a
  // full-bleed claim: the invented film above wore *The Quiet*'s key art,
  // wordmark and all, behind its own H1. No backdrop is a tinted panel.
  const backdrop = payload.backdropUrl;

  // Visual availability: a title whose release date is still in the future is
  // shown but not actionable — grayed art, a "Coming {date}" label, and no
  // Download. Unknown dates are never gated (releaseStatus says so).
  // The local catalog only knows dates for works it already holds, so a title
  // opened straight from search falls back to the date the provider returned
  // with the rest of the extras.
  const releaseGate = browseReleaseGate({
    releaseDate: payload.releaseDate ?? extras?.releaseDate ?? null,
    mediaType: payload.isSeries ? "series" : "movie",
    inTheatricalWindow: extras?.inTheatricalWindow ?? false,
    nextHomeReleaseAt: extras?.nextHomeReleaseAt ?? null,
  });
  const gated = releaseGate.gated;

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
  const { rows, allRows, truncated } = mergeEpisodes({
    season: activeSeason,
    episodes: onKnownSeason ? payload.episodes : [],
    meta: episodeExtras?.episodes ?? [],
    metaSeason: episodeExtras?.season ?? null,
    transfers: progress?.episodeTransfers,
    truncated: onKnownSeason && payload.episodesTruncated,
  });
  // Progress counts every row, not only the rendered ones: a long anime's
  // downloads sit around episode 1118, far past the row cap. When the server
  // itself cut the list short, only its per-season summary saw every episode.
  const rowsCoverSeason = !(onKnownSeason && payload.episodesTruncated);
  const seasonProgress: Record<number, SeasonProgress> = {};
  for (const s of seasons) {
    const aired = providerAiredFor(extras?.airedEpisodes, s.season);
    seasonProgress[s.season] =
      s.season === activeSeason && allRows.length > 0 && rowsCoverSeason
        ? seasonProgressFromRows(allRows, aired)
        : seasonProgressFromSummary(s, aired);
  }
  const showProgress = payload.isSeries
    ? showProgressFromSeasons(seasons.map((s) => seasonProgress[s.season]))
    : null;
  const showProgressText = showProgress ? seasonProgressLabel(showProgress) : null;

  // A series the server holds nothing for, whose provider listing has not
  // answered with episodes yet, offers one obvious next step: find them.
  const discoverEpisodes = needsEpisodeDiscovery({
    ...payload,
    seasons,
    season: activeSeason,
    episodes: rows,
  });
  const discoveryPending = extrasLoading || extrasRefreshing;

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
    activeSeason != null ? seasonStatusFor(activeSeason) : ({ status: "idle" } as const);

  // The SILO-style hero prints one score/meta line under the title and a
  // compact metadata list in a right column. Both draw only from what the
  // payload/extras vouch for — every absent piece is dropped, never faked.
  //
  // A score, its provider and its vote count are one unit. The payload's score
  // paints first and keeps its own provider; the extras only fill a missing
  // score. Labelling the payload's score from the extras is how an AniList
  // score read "TMDB" until the extras arrived, then changed its label.
  const metaScore =
    payload.rating != null
      ? {
          rating: payload.rating,
          source: payload.ratingSource ?? null,
          // Vote counts arrive with the extras' score, so they back the
          // payload's score only when one provider supplied both (absent
          // means TMDB on either side).
          voteCount:
            (payload.ratingSource ?? "tmdb") === (extras?.ratingSource ?? "tmdb")
              ? (extras?.voteCount ?? null)
              : null,
        }
      : {
          rating: extras?.rating ?? null,
          source: extras?.ratingSource ?? null,
          voteCount: extras?.voteCount ?? null,
        };
  const releaseDate = payload.releaseDate ?? extras?.releaseDate ?? null;
  // The year piece prefers the payload's explicit year, falling back to the
  // year of the real release date when the page was opened from a link that
  // carried no year (a derivation, not an invented value).
  const metaYear = payload.year ?? releaseYear(releaseDate);
  const genres = extras?.genres ?? [];
  // The extras (synopsis, genres, rating, facts) are still on their way: the
  // hero holds their space until they land or the request settles empty.
  const heroExtrasPending = extras == null && !extrasError && (extrasLoading || !extrasSettled);
  const metaListPresent = Boolean(
    extras?.originalLanguage ||
      formatReleaseDate(releaseDate) ||
      extras?.certification,
  );

  // The button is the only place a pending action is narrated: ButtonBody
  // overlays the spinner in place of the label. No status line, no hint, and
  // no progress bar under the buttons.
  //
  // Download is offered for a film only: a series is acquired per season or
  // per episode in the panel below. A title the user has already sent is not
  // offered again. `payload.transfer` is title scope — an episode or season
  // grab elsewhere in this work must not silence the title's own control.
  const showDownload = !payload.isSeries && !gated;
  // An owned film never offers Download: it says what you have, and the owner
  // gets Upgrade or Check again from the quality sweep (OPS-857).
  const ownedFilm = payload.isSeries ? null : ownedLabel(payload.owned);
  const downloadAction: TitleAction = {
    kind: "get",
    label: "Download",
    season: null,
    episode: null,
    infoHash: payload.infoHash,
  };
  const downloadStatus = statusFor(DOWNLOAD_KEY);
  const ownTitleTransfer = progress?.transfer ?? payload.transfer;
  // A film already on this computer reads as downloaded however it got there
  // (this page's Download, or a torrent sent by hand from Downloads): the same
  // rule the episode cards use. It offers Open, never a second Download.
  const titleTransfer: TitleEpisodeTransfer | null =
    (ownTitleTransfer == null || ownTitleTransfer.status === "failed") &&
    payload.availability === "ready" &&
    payload.infoHash
      ? { status: "downloaded", progress: 1, infoHash: payload.infoHash, filePath: null, error: null }
      : ownTitleTransfer;
  const downloadControl = resolveTitleTransferControl(titleTransfer, downloadStatus, {
    canSeeTransfers: caps.canSeeTransfers,
  });
  const downloadLabel = downloadControl.label;
  // Still looking for a release, or waiting for an English one: the owner gets
  // the same way out as the Downloads row (Pick a release, Try now, Remove),
  // from the same component.
  const titleLooking =
    showDownload &&
    caps.canManage &&
    (titleTransfer?.state === "looking" || titleTransfer?.state === "waiting_english");
  const titleWanted = useWantedRows(titleLooking);
  const titleWantedRow = titleLooking
    ? titleWanted.rows.find((r) => r.workKey === payload.workKey && r.season == null) ?? null
    : null;
  const downloadCanRun = downloadControl.canRun && !gated;
  const downloadLabelTarget = title;
  // A downloaded film opens in the owner's own player, on the computer running
  // TorrentFlow only (docs/api-open-file.md). Both a finished title transfer
  // and a ready local row are built-in downloads, and the info hash names it.
  const openHash = titleTransfer?.status === "downloaded" ? titleTransfer.infoHash : null;
  const canOpenFile = showDownload && caps.canSeePaths && openFolder && !!openHash;
  // The film's download can be replaced by another release. Owner only, and
  // the shared rule decides which states offer it.
  const findSourceHash = showDownload && caps.canDownload ? (titleTransfer?.infoHash ?? null) : null;
  const canFindSource =
    findSourceHash != null &&
    canFindAnotherSource({
      builtin: true,
      hash: findSourceHash,
      pack: false,
      finished: titleTransfer?.status === "downloaded" || (titleTransfer?.progress ?? 0) >= 0.9999,
    });
  const openTitleFile = async (mode: OpenDownloadMode) => {
    if (!openHash || openingFile) return;
    setOpeningFile(mode);
    try {
      await openDownload(openHash, mode);
    } finally {
      setOpeningFile(null);
    }
  };

  const hint = libraryHint({ known: payload.known, gated, caps });

  // A film with no similar titles and no library hint has nothing under the
  // hero once the extras settle. Rendering the empty bottom section left a
  // bordered band of dead page between the hero and the footer, so the hero
  // takes that height instead; its content stays top-aligned, so nothing moves
  // under the cursor.
  const similarLoading = extrasLoading && !extrasError;
  const nothingBelowHero =
    !payload.isSeries && hint == null && similar.length === 0 && !similarLoading;

  return (
    <article aria-labelledby="title-heading" className="flex min-w-0 grow flex-col">
      <header
        data-title-hero
        data-hero-fills={nothingBelowHero || undefined}
        className={cn(
          "relative isolate flex flex-col overflow-hidden bg-card",
          nothingBelowHero ? "grow justify-start" : "justify-end border-b border-border",
        )}
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
          className="absolute inset-0 -z-10 bg-background/52"
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
              "grid grid-cols-1 items-end gap-x-4 gap-y-5 py-5 sm:py-8 md:grid-cols-[168px_minmax(0,1fr)] md:gap-x-6 md:py-10 lg:grid-cols-[196px_minmax(0,1fr)] lg:py-10",
              payload.isSeries
                ? "min-h-0 md:min-h-[18rem] lg:min-h-[20rem]"
                : "min-h-0 md:min-h-[21rem] lg:min-h-[24rem]",
            )}
          >
            {/* On phones the poster, identity and actions stack so artwork
                never takes width away from the title or primary labels. */}
            <div className="w-[104px] shrink-0 self-end sm:w-[120px] md:row-span-2 md:w-[168px] lg:w-[196px]">
              <div
                className={cn(
                  "relative aspect-[2/3] w-full overflow-hidden rounded-lg border border-border bg-muted shadow-md",
                  gated && "grayscale",
                )}
              >
                {titlePending && !payload.posterUrl ? (
                  <Skeleton className="size-full rounded-none" aria-hidden="true" data-title-poster-pending />
                ) : (
                  <PosterImage
                    src={payload.posterUrl}
                    title={title}
                    sizes="(min-width: 1024px) 196px, (min-width: 768px) 168px, (min-width: 640px) 120px, 104px"
                    priority
                  />
                )}
              </div>
            </div>

            <div className="min-w-0 flex-1">
              <h1
                id="title-heading"
                title={titlePending ? undefined : title}
                aria-busy={titlePending || undefined}
                data-title-heading-pending={titlePending ? "" : undefined}
                className="break-words text-[clamp(1.75rem,7vw,2.25rem)] font-semibold leading-[1.05] tracking-[-0.03em] text-foreground md:text-display"
              >
                {titlePending ? (
                  <>
                    <span className="sr-only">Loading title</span>
                    {/* A span, not <Skeleton>: a div is not allowed inside a heading. */}
                    <span aria-hidden="true" className="block h-[1em] w-3/4 max-w-[28rem] animate-pulse rounded bg-muted" />
                  </>
                ) : (
                  title
                )}
              </h1>

              {/* The rating/meta line sits directly under the title, SILO-style:
                  `TMDB {score} ({votes}) · {year} · {N Seasons|runtime}`. A gated
                  title keeps its "Coming {date}" / "In cinemas" chip beside it. */}
              <div
                className={cn(
                  "mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-2",
                  // The rating badge arrives with the extras; hold its 28px.
                  heroExtrasPending && "min-h-7",
                )}
              >
                {gated ? (
                  <ReleaseGateChip gate={releaseGate} data-title-coming />
                ) : null}
                <RatingMetaLine
                  rating={metaScore.rating}
                  voteCount={metaScore.voteCount}
                  ratingSource={metaScore.source}
                  year={metaYear}
                  isSeries={payload.isSeries}
                  seasonCount={seasonCount}
                />
                <WatchStateChip state={payload.watchState} nextUp={payload.jellyfinNextUp}
                  className="mt-2 h-7 rounded-full bg-background/60 px-2.5" />
              </div>

              {/* An anime sequel entry is a season of its show: say which one
                  and link to the show's page, where every season is listed. */}
              {extras?.partOf ? (
                <p className="mt-1 text-[13px] text-muted-foreground" data-title-part-of>
                  {extras.seasons.length > 0
                    ? `Season ${extras.seasons.join(", ")} of `
                    : "Part of "}
                  <Button asChild variant="link" size="sm" className="h-auto min-h-11 px-0 align-middle text-[13px]">
                    <Link to={extras.partOf.href}>{extras.partOf.title}</Link>
                  </Button>
                </p>
              ) : null}

              {/* A series' whole-show download line, summed over its seasons:
                  the same words and ring as the season header below. */}
              {showProgress && showProgressText ? (
                <SeasonProgressMeter
                  progress={showProgress}
                  label={showProgressText}
                  className="mt-3 text-[13px]"
                  data-show-progress
                />
              ) : null}

              {/* Actions come next: Find episodes while a series has nothing
                  listed yet, the film-only Download (Open and Show in folder
                  once it is on this computer), then the library controls.
                  The row collapses when none of them applies. */}
              <div
                className="mt-4 grid w-full min-w-0 grid-cols-1 gap-2 empty:hidden md:mt-5 md:flex md:flex-wrap md:items-center"
                data-title-acquire
              >
                {/* A gated (unreleased) title offers no Download at all — the
                    "Coming {date}" label and grayed art already say why, and a
                    disabled action is just clutter that does nothing. Tracking
                    it via "Add to library" stays available below. */}
                {ownedFilm && payload.owned ? (
                  <OwnedQuality
                    variant="title"
                    workKey={workKey}
                    name={title}
                    owned={payload.owned}
                    upgrade={payload.upgrade}
                    bestAvailable={payload.bestAvailable}
                    upgradeQueued={payload.upgradeQueued}
                    canAct={caps.canDownload}
                    onChanged={onLibraryChanged}
                  />
                ) : !caps.canDownload ? (
                  gated ? null : (
                    <RequestAction
                      title={requestTitleFor(payload)}
                      state={parseRequestState(payload)}
                      onRequested={onLibraryChanged}
                    />
                  )
                ) : discoverEpisodes && !gated ? (
                  <Button
                    type="button"
                    size="lg"
                    data-title-primary
                    data-action-kind="discover"
                    aria-label={`Find episodes, ${title}`}
                    aria-busy={discoveryPending || undefined}
                    disabled={discoveryPending}
                    onClick={() => void refetchExtras()}
                    className="relative w-full min-w-0 md:w-auto md:min-w-[9rem]"
                  >
                    <ButtonBody pending={discoveryPending} icon={<Search aria-hidden />}>
                      Find episodes
                    </ButtonBody>
                  </Button>
                ) : null}
                {canOpenFile ? (
                  <>
                    <TfOpenFileButton
                      name={title}
                      busy={openingFile === "open"}
                      disabled={openingFile !== null}
                      variant="default"
                      size="lg"
                      data-title-open
                      onClick={() => void openTitleFile("open")}
                      className="w-full min-w-0 md:w-auto md:min-w-[8rem]"
                    />
                    <Button
                      type="button"
                      size="lg"
                      variant="secondary"
                      data-title-reveal
                      aria-label={`Show ${title} in its folder`}
                      aria-busy={openingFile === "reveal" || undefined}
                      disabled={openingFile !== null}
                      onClick={() => void openTitleFile("reveal")}
                      className="relative w-full min-w-0 md:w-auto"
                    >
                      <ButtonBody pending={openingFile === "reveal"} icon={<FolderOpen aria-hidden />}>
                        Show in folder
                      </ButtonBody>
                    </Button>
                  </>
                ) : showDownload && caps.canDownload && !ownedFilm && downloadControl.opensDownloads ? (
                  <Button
                    asChild
                    size="lg"
                    className="relative w-full min-w-0 md:w-auto md:min-w-[8rem]"
                  >
                    <Link
                      to="/downloads"
                      data-title-download
                      data-transfer-status={titleTransfer?.status}
                      aria-label={`${downloadLabel}, view ${title} in Downloads`}
                    >
                      {titleTransfer?.status === "downloaded" ? (
                        <CheckCircle2 aria-hidden />
                      ) : (
                        <Download aria-hidden />
                      )}
                      {downloadLabel}
                    </Link>
                  </Button>
                ) : showDownload && caps.canDownload && !ownedFilm ? (
                  <Button
                    type="button"
                    size="lg"
                    data-title-download
                    data-action-kind="get"
                    data-transfer-status={titleTransfer?.status}
                    aria-label={`${downloadLabel}, ${title}`}
                    title={downloadControl.error ?? undefined}
                    aria-busy={downloadStatus === "pending" || undefined}
                    disabled={!downloadCanRun}
                    onClick={() => {
                      if (shouldAskForQuality(alwaysPreferred)) {
                        setHeroPicker(true);
                      } else {
                        onAction(
                          downloadAction,
                          DOWNLOAD_KEY,
                          downloadLabelTarget,
                          preferredResolution,
                        );
                      }
                    }}
                    className="relative w-full min-w-0 md:w-auto md:min-w-[8rem]"
                  >
                    <ButtonBody
                      pending={downloadStatus === "pending"}
                      icon={titleTransfer?.state === "looking" ? <Search aria-hidden /> : <Download aria-hidden />}
                    >
                      {downloadLabel}
                    </ButtonBody>
                  </Button>
                ) : null}

                {titleLooking ? (
                  <WantedActions
                    target={{ workKey: payload.workKey, season: null, episode: null }}
                    name={metaYear ? `${title} (${metaYear})` : title}
                    pickTitle={title}
                    looking={titleWantedRow?.looking ?? true}
                    onChanged={async () => {
                      await titleWanted.reload();
                      onLibraryChanged();
                    }}
                    size="lg"
                    className="w-full md:w-auto"
                  />
                ) : null}

                {canFindSource && findSourceHash ? (
                  <Button
                    type="button"
                    size="lg"
                    variant="outline"
                    data-title-find-source
                    aria-label={`${FIND_ANOTHER_SOURCE_LABEL} for ${title}`}
                    onClick={() => onFindAnotherSource({ hash: findSourceHash, workTitle: title, label: title })}
                    className="relative w-full min-w-0 md:w-auto"
                  >
                    <Search aria-hidden />
                    {FIND_ANOTHER_SOURCE_LABEL}
                  </Button>
                ) : null}

                {caps.canManage ? (
                  <LibraryControls
                    library={payload.library}
                    isSeries={payload.isSeries}
                    seasons={seasons.map((s) => s.season)}
                    releaseDate={payload.releaseDate}
                    title={title}
                    onChanged={onLibraryChanged}
                    ownedShown={Boolean(ownedFilm) || seasons.some((s) => (s.downloadedEpisodes ?? 0) > 0)}
                  />
                ) : null}
              </div>

            </div>

            {/* The two-column band under the actions. It spans the full phone
                width so synopsis/meta never get squeezed beside the compact
                poster, then returns to the desktop content column at md+. */}
            <div className="min-w-0 flex flex-col gap-4 md:col-start-2 md:flex-row md:gap-8">
                {/* From md the band holds a five-line synopsis and a row of genres
                    whether or not they have landed yet, so the poster and title
                    beside it never move when the extras arrive. */}
                <div className="min-w-0 flex-1 md:max-w-2xl md:min-h-[9.40625rem]">
                  {payload.overview ?? extras?.overview ? (
                    <p
                      data-title-overview
                      className="text-body line-clamp-5 max-w-xl"
                    >
                      {payload.overview ?? extras?.overview}
                    </p>
                  ) : heroExtrasPending ? (
                    // Hold the synopsis, genre and facts space while the extras
                    // round trip is in flight, at the size they land at, so the
                    // hero and everything under it do not move when they do.
                    <div aria-hidden data-title-overview-placeholder className="max-w-xl">
                      <div className="text-body">
                        {["w-full", "w-full", "w-11/12", "w-full", "w-2/3"].map((width, i) => (
                          <div key={i} className="flex h-lh items-center">
                            <Skeleton className={cn("h-3 rounded", width)} />
                          </div>
                        ))}
                      </div>
                      <div className="mt-4 flex gap-2">
                        <Skeleton className="h-[1.625rem] w-16 rounded-full" />
                        <Skeleton className="h-[1.625rem] w-20 rounded-full" />
                        <Skeleton className="h-[1.625rem] w-14 rounded-full" />
                      </div>
                    </div>
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
                ) : heroExtrasPending ? (
                  <div aria-hidden className="grid w-full gap-y-2 text-[13px] md:w-[260px] md:shrink-0">
                    {["w-40", "w-48", "w-32"].map((width) => (
                      <div key={width} className="flex h-lh items-center">
                        <Skeleton className={cn("h-3 rounded", width)} />
                      </div>
                    ))}
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
      {caps.canDownload ? (
      <QualityPicker
        open={heroPicker}
        onOpenChange={setHeroPicker}
        preferredResolution={preferredResolution}
        alwaysPreferred={alwaysPreferred}
        onAlwaysPreferredChange={setAlwaysPreferred}
        onConfirm={(resolution) => {
          setHeroPicker(false);
          onAction(
            downloadAction,
            DOWNLOAD_KEY,
            downloadLabelTarget,
            resolution,
          );
        }}
      />
      ) : null}

      {nothingBelowHero ? null : (
      <div className="container-app space-y-7 py-6 md:space-y-10 md:py-8">
        {payload.isSeries ? (
          <EpisodeList
            seasons={seasons}
            seasonProgress={seasonProgress}
            season={activeSeason}
            episodes={rows}
            episodeTotal={allRows.length}
            truncated={truncated}
            loadState={episodeListState}
            busy={rows.length === 0 && refreshing && season != null && season !== payload.season}
            statusFor={statusFor}
            seasonGrabStatus={activeSeasonGrabStatus}
            gated={gated}
            onSeasonChange={onSeasonChange}
            onSeasonGrab={requestSeasonGrab}
            onAction={handleEpisodeListAction}
            onFindAnotherSource={caps.canDownload ? handleFindEpisodeSource : undefined}
            onPickRelease={caps.canDownload ? handlePickEpisodeRelease : undefined}
            onWantedAction={caps.canDownload ? handleWantedAction : undefined}
            workKey={workKey}
            onOwnedChanged={onLibraryChanged}
          />

        ) : null}

        {removingEpisode ? (
          <ConfirmDialog
            open
            onOpenChange={(open) => {
              if (!open) setRemovingEpisode(null);
            }}
            contentData={{ "data-looking-remove-dialog": true }}
            confirmData={{ "data-looking-remove-confirm": true }}
            title={`Remove ${episodeName(removingEpisode.season, removingEpisode.episode)}?`}
            description={wantedRemoveDescription({ workKey, ...removingEpisode })}
            variant="destructive"
            busy={removingBusy}
            icon={<Trash2 className="h-3.5 w-3.5" />}
            confirmLabel="Remove"
            onConfirm={() => void confirmRemoveEpisode()}
          />
        ) : null}

        {/* Somewhere to go next. On a film this is the whole reason the space
            under the hero is not empty; on a series it follows the episodes.
            The `loading` prop tells MoreLikeThis to render a skeleton grid when
            items have not arrived yet, which keeps the bottom section the same
            height before and after the extras round trip. Without this, the
            hero (which is flex-grow) shrinks when the grid appears — causing
            the Download button to jump up under the cursor, which is how a
            click silently navigated to the wrong film (Task 1). */}
        <MoreLikeThis
          items={similar}
          loading={similarLoading}
        />

        {/* The owner's view of the crosswalk, with Unlink for a wrong match. */}
        {caps.canManage ? <LinkedRecords workKey={payload.workKey} /> : null}

        {hint ? (
          <p className="text-[12px] text-subtle-foreground" data-library-hint>
            {hint}
          </p>
        ) : null}
      </div>
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fills what a requester's catalog-only payload leaves out (library state,
 * files, transfers) with "nothing here", so the shared page code never reads
 * a missing field. The owner's payload already has them all and passes through.
 */
function withCatalogDefaults(json: unknown): TitleDetailPayload {
  const p = (json ?? {}) as Partial<TitleDetailPayload> & { inLibrary?: unknown };
  return {
    ...p,
    aliases: p.aliases ?? [],
    seasons: p.seasons ?? [],
    episodes: ((p.episodes ?? []) as Partial<TitleDetailPayload["episodes"][number]>[]).map((e) => ({
      availability: null,
      infoHash: null,
      filePath: null,
      downloadFraction: null,
      nextUp: false,
      fromPack: false,
      transfer: null,
      ...e,
    })),
    availability: p.availability ?? null,
    infoHash: p.infoHash ?? null,
    transfer: p.transfer ?? null,
    library: p.library ?? {
      inLibrary: p.inLibrary === true,
      watchListItemId: null,
      monitored: false,
      status: null,
      cursorSeason: null,
      cursorEpisode: null,
      addPayload: {
        mediaType: p.mediaType ?? "movie",
        externalId: "",
        title: p.title ?? "",
        posterUrl: p.posterUrl ?? null,
        synopsis: null,
        rating: null,
      },
    },
  } as TitleDetailPayload;
}

/** The title as a request names it: the catalog id the server matched. Null when it matched none. */
function requestTitleFor(payload: TitleDetailPayload & CatalogIdentity): RequesterTitle | null {
  if (!payload.provider || !payload.providerId) return null;
  const mediaType = payload.mediaType ?? (payload.isSeries ? "tv" : "movie");
  return {
    key: payload.workKey,
    title: payload.title,
    year: payload.year,
    mediaType,
    isSeries: payload.isSeries,
    format: null,
    category: "",
    provider: payload.provider,
    providerId: payload.providerId,
    posterUrl: payload.posterUrl ?? null,
    overview: payload.overview ?? null,
    releaseDate: payload.releaseDate ?? null,
    ...parseRequestState(payload),
  };
}

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
  const current = readCookieRaw(REMEMBERED_SEASON_COOKIE_NAME);
  const next = nextRememberedSeasonCookieValue(current, workKey, season);
  if (next == null) return;
  const oneYearSeconds = 60 * 60 * 24 * 365;
  const secure =
    window.location.protocol === "https:"
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
  return readRememberedSeason(
    readCookieRaw(REMEMBERED_SEASON_COOKIE_NAME),
    workKey,
  );
}

function readCookieRaw(name: string): string | null {
  const prefix = `${name}=`;
  for (const part of document.cookie.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length);
  }
  return null;
}

function readLegacySeasonFromLocation(): number | null {
  const raw = new URL(window.location.href).searchParams.get("s");
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return isValidSeason(parsed) ? parsed : null;
}

function removeLegacySeasonFromLocation(): void {
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
 * to open (the one the library is hunting, the one remembered from last
 * time), and asking
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
function TitleDetailSkeleton() {
  return (
    <div aria-hidden>
      <div className="border-b border-border bg-card">
        <div className="container-app">
          <div className="grid grid-cols-1 items-end gap-4 py-5 sm:py-8 md:grid-cols-[168px_minmax(0,1fr)] md:gap-6 md:py-10 lg:grid-cols-[196px_minmax(0,1fr)] lg:py-12">
            <div className="w-[104px] shrink-0 sm:w-[120px] md:w-[168px] lg:w-[196px]">
              <Skeleton className="aspect-[2/3] w-full rounded-lg" />
            </div>
            <div className="min-w-0 max-w-2xl flex-1">
              <Skeleton className="h-9 w-3/4 rounded" />
              <Skeleton className="mt-3 h-3 w-40 rounded" />
              <Skeleton className="mt-5 h-11 w-full rounded-lg md:w-44" />
            </div>
            <div className="space-y-2 md:col-start-2">
              <Skeleton className="h-3 w-full max-w-md rounded" />
              <Skeleton className="h-3 w-4/5 max-w-md rounded" />
            </div>
          </div>
        </div>
      </div>
      <div className="container-app py-6 md:py-8">
        <Skeleton className="h-5 w-32 rounded" />
        <div className="mt-3 space-y-2 sm:flex sm:gap-3 sm:space-y-0 sm:overflow-hidden">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton
              key={i}
              className="h-24 w-full rounded-lg sm:h-[215px] sm:w-[300px] sm:shrink-0"
            />
          ))}
        </div>
      </div>
    </div>
  );
}
