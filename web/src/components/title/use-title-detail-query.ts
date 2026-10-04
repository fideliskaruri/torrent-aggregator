import { useCallback,useEffect,useMemo,useRef,useState } from "react";
import { useNavigate } from "react-router";
import { useApiQuery } from "@/hooks/use-api-query";
import { useCapabilities } from "@/lib/capabilities";
import { type TitleActionStatus } from "./title-actions";
import { type SeasonGrabStatus } from "./season-grab-state";
import { resolveInitialSeason,resolveSeasonOnPropsChange,} from "./season-persistence";
import { useStorageCapOverride } from "@/components/storage/use-storage-cap-override";
import type { TitleDetailPayload,TitleExtrasPayload,TitleProgressPayload } from "./types";

import type { TitleDetailProps } from "./title-props";

import { buildDetailUrl,buildExtrasUrl,extrasDataIdentity } from "./title-url";
import { readLegacySeasonFromLocation,readRememberedSeasonFromDocument,removeLegacySeasonFromLocation,writeRememberedSeasonCookie } from "./season-memory";
import { withCatalogDefaults } from "./title-payload";
import { titleNeedsTransferPoll,titleProgressHasActiveTransfer } from "./title-poll";

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
