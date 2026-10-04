import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { get, send } from "@/lib/api";
import type { ReactNode } from "react";
import { CheckCircle2, Download, FolderOpen, Loader2, Search, Trash2 } from "lucide-react";
import { Link, useNavigate, type NavigateFunction } from "react-router";
import { toast } from "@/lib/toast";
import { useFeatures } from "@/lib/features";
import { openDownload, type OpenDownloadMode } from "@/lib/open-download";
import { ConfirmDialog } from "@/components/tf/confirm-dialog";
import { PosterImage } from "@/components/browse/poster-image";
import { posterTint } from "@/components/browse/poster";
import { cleanDisplayTitle } from "@/lib/title/display-title";
import { headingTitle } from "./heading-title";
import { TfEmptyState } from "@/components/tf/empty-state";
import { TfErrorState } from "@/components/tf/error-state";
import { TfOpenFileButton } from "@/components/tf/open-file-button";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useApiQuery } from "@/hooks/use-api-query";
import { useDocumentTitle } from "@/hooks/use-document-title";
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
import { providerAiredFor, seasonProgressFromRows, seasonProgressFromSummary, seasonProgressLabel, showProgressFromSeasons, type SeasonProgress, } from "./season-progress";
import { SeasonProgressMeter } from "./season-progress-meter";
import { MoreLikeThis } from "./more-like-this";
import { LinkedRecords } from "./linked-records";
import { RequestAction } from "@/components/requests/request-action";
import { WantedActions, stopWanted, tryWantedNow, useWantedRows, wantedRemoveDescription, type WantedAction, } from "@/components/wanted/wanted-actions";
import { useCapabilities } from "@/lib/capabilities";
import { parseRequestState, type RequesterTitle } from "@/lib/requests";
import type { CatalogIdentity } from "@/lib/browse/types";
import { QualityPicker } from "./quality-picker";
import { shouldAskForQuality } from "./quality-picker-state";
import { usePreferredQuality } from "./use-preferred-quality";
import { formatReleaseDate, GenreChips, HeroMetaList, RatingMetaLine, releaseYear, } from "./title-hero-meta";
import { needsEpisodeDiscovery, resolveTitleTransferControl, shouldRunTitleAction, type TitleAction, type TitleActionStatus, } from "./title-actions";
import { SeasonGrabFailureError, seasonGrabFailureDescription, seasonGrabKey, seasonGrabRetryEpisodes, shouldRetrySeasonGrab, shouldRunSeasonGrab, type SeasonGrabReport, type SeasonGrabStatus, } from "./season-grab-state";
import { NoReleaseFoundError, postTitleAction, rethrowAcquisitionFetchError, } from "./title-action-request";
import { encodeKeySegment } from "./work-key";
import { toastDownloadOutcome } from "@/components/releases/download-outcome-toast";
import { canFindAnotherSource, FIND_ANOTHER_SOURCE_LABEL } from "@/components/releases/find-another-source";
import { openReleasePicker } from "@/components/releases/release-picker-store";
import { isValidSeason, nextRememberedSeasonCookieValue, readRememberedSeason, REMEMBERED_SEASON_COOKIE_NAME, } from "@/lib/title/remembered-season";
import { resolveInitialSeason, resolveSeasonOnPropsChange, } from "./season-persistence";
import { StorageCapDialog } from "@/components/storage/storage-cap-dialog";
import { useStorageCapOverride } from "@/components/storage/use-storage-cap-override";
import { parseStorageOverrideFacts, StorageLimitError, } from "@/lib/library/storage-override";
import type { TitleDetailPayload, TitleEpisodeTransfer, TitleExtrasPayload, TitleProgressPayload, TitleSeasonGrabResponse, } from "./types";

import type { TitleDetailProps } from "./title-props";

import { buildDetailUrl, buildExtrasUrl, extrasDataIdentity } from "./title-url";
import { readLegacySeasonFromLocation, readRememberedSeasonFromDocument, removeLegacySeasonFromLocation, writeRememberedSeasonCookie } from "./season-memory";
import { withCatalogDefaults } from "./title-payload";
import { titleNeedsTransferPoll, titleProgressHasActiveTransfer } from "./title-poll";

export function useTitleDetailQuery(props: TitleDetailProps) {
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
  const cap = useStorageCapOverride();
  const spentRemoteActions = useRef(new Set<string>());
  const spentSeasonGrabs = useRef(new Set<string>());
  const inFlightSeasonGrabs = useRef(new Set<string>());
  const [findAnother, setFindAnother] = useState<{ hash: string; label: string } | null>(null);
  const [findingAnother, setFindingAnother] = useState(false);
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
      writeRememberedSeasonCookie(props.workKey, nextSeason);
    },
    [props.workKey],
  );

  const url = useMemo(
    () => buildDetailUrl({ ...props, season }),
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
  const activeSeason = season ?? data?.season ?? null;
  const extrasUrl = useMemo(
    () => (data ? buildExtrasUrl(props, data, activeSeason) : null),
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


  return {
    props, caps, navigate, season, setSeason, statuses, setStatuses, seasonStatuses, setSeasonStatuses,
    cap, findAnother, setFindAnother, findingAnother, setFindingAnother,
    handleSeasonChange, data, loading, refreshing, error, refetch, visibleProgress,
    extras, extrasLoading, extrasRefreshing, extrasError, extrasSettled, activeSeason, refetchExtras, statusFor,
    transferPoll, startTransferPoll,
  };
}
