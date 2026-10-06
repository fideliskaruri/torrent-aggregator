import { useCallback,useEffect,useRef,useState } from "react";
import { useNavigate } from "react-router";
import { useApiQuery } from "@/hooks/use-api-query";
import { useCapabilities } from "@/lib/capabilities";
import { type TitleActionStatus } from "./title-actions";
import { type SeasonGrabStatus } from "./season-grab-state";
import { resolveInitialSeason,resolveSeasonOnPropsChange,} from "./season-persistence";
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
  const [findAnother, setFindAnother] = useState<{
    hash: string;
    label: string;
    season?: number;
    episode?: number | null;
    packed?: boolean;
  } | null>(null);
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

  const url = buildDetailUrl({ ...props, season });
  const [transferPoll, setTransferPoll] = useState({ active: false, session: 0 });
  const [currentProgress, setCurrentProgress] = useState<{
    workKey: string;
    session: number;
    payload: TitleProgressPayload;
  } | null>(null);
  const startTransferPoll = useCallback(() => {
    setCurrentProgress(null);
    setTransferPoll((current) =>
      current.active ? current : { active: true, session: current.session + 1 },
    );
  }, []);
  const stopTransferPoll = useCallback(() => {
    setTransferPoll((current) => ({ ...current, active: false }));
  }, []);
  const { data, loading, refreshing, error, refetch } =
    useApiQuery<TitleDetailPayload>(url, {
      refreshMs: 0,
      select: withCatalogDefaults,
    });
  useEffect(() => {
    if (titleNeedsTransferPoll(data)) startTransferPoll();
  }, [data, startTransferPoll]);
  const progressUrl = caps.canSeeTransfers && transferPoll.active
    ? `/api/title/${encodeURIComponent(props.workKey)}/progress?session=${transferPoll.session}`
    : null;
  const {
    data: progress,
    error: progressError,
    settled: progressSettled,
  } = useApiQuery<TitleProgressPayload>(progressUrl, {
      refreshMs: transferPoll.active ? 2_500 : 0,
    });
  useEffect(() => {
    if (!progressSettled || progressError || !progress) return;
    setCurrentProgress({
      workKey: props.workKey,
      session: transferPoll.session,
      payload: progress,
    });
  }, [
    progress,
    progressError,
    progressSettled,
    props.workKey,
    transferPoll.session,
  ]);
  const visibleProgress =
    currentProgress?.workKey === props.workKey &&
    currentProgress.session === transferPoll.session
      ? currentProgress.payload
      : null;
  useEffect(() => {
    if (!transferPoll.active || !visibleProgress) return;
    if (titleProgressHasActiveTransfer(visibleProgress)) return;

    stopTransferPoll();
    void refetch();
  }, [
    refetch,
    stopTransferPoll,
    transferPoll.active,
    visibleProgress,
  ]);
  const activeSeason = season ?? data?.season ?? null;
  const extrasUrl = data?.known ? buildExtrasUrl(props, data, activeSeason) : null;
  const extrasIdentity = extrasDataIdentity(extrasUrl);
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
    findAnother, setFindAnother, findingAnother, setFindingAnother,
    handleSeasonChange, data, loading, refreshing, error, refetch, visibleProgress,
    extras, extrasLoading, extrasRefreshing, extrasError, extrasSettled, activeSeason, refetchExtras, statusFor,
    startTransferPoll,
  };
}
