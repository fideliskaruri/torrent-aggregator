import { useCallback,useState } from "react";
import { toast } from "@/lib/toast";
import { useFeatures } from "@/lib/features";
import { type OpenDownloadMode } from "@/lib/open-download";
import { headingTitle } from "./heading-title";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { episodeIntentKey } from "./episode-list";
import { stopWanted,tryWantedNow,type WantedAction } from "@/components/wanted/wanted-actions";
import { useCapabilities } from "@/lib/capabilities";
import { usePreferredQuality } from "./use-preferred-quality";
import { shouldAskForQuality } from "./quality-picker-state";
import { type TitleAction,type TitleActionStatus,DOWNLOAD_KEY } from "./title-actions";
import { type SeasonGrabStatus } from "./season-grab-state";
import { openReleasePicker } from "@/components/releases/release-picker-store";
import { formatEpisodeLabel } from "@/lib/library/cursor";
import type { TitleDetailPayload,TitleExtrasPayload,TitleProgressPayload } from "./types";


export function useTitleContentState({
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
  onFindAnother,
  routeTitle,
}: {
  routeTitle: string | null;
  payload: TitleDetailPayload;
  extras: TitleExtrasPayload | null;
  progress: TitleProgressPayload | null;
  extrasLoading: boolean;
  extrasRefreshing: boolean;
  extrasError: string | null;
    extrasSettled: boolean;
    extrasSeason: number | null;
  refetchExtras: () => void | Promise<unknown>;
  season: number | null;
  refreshing: boolean;
  statusFor: (key: string) => TitleActionStatus;
  seasonStatusFor: (season: number) => SeasonGrabStatus;
  onSeasonChange: (season: number) => void;
  onSeasonGrab: (season: number, resolution?: number) => void;
  onAction: (
    action: TitleAction,
    key: string,
    label: string,
    resolution?: number,
  ) => void;
  onLibraryChanged: () => void;
    onFindAnother: (subject: {
      hash: string;
      label: string;
      season?: number;
      episode?: number | null;
      packed?: boolean;
    }) => void;
}) {
  const caps = useCapabilities();
  const { openFolder } = useFeatures();
  const { preferredResolution, alwaysPreferred, setAlwaysPreferred } = usePreferredQuality();
  const [qualityPickerOpen, setQualityPickerOpen] = useState(false);
  const [pendingDownload, setPendingDownload] = useState<
    | { kind: "action"; action: TitleAction; key: string; label: string }
    | { kind: "season"; season: number }
    | null
  >(null);
  const [openingFile, setOpeningFile] = useState<OpenDownloadMode | null>(null);
  const handleDownloadAction = useCallback(
    (action: TitleAction, key: string, label: string, resolution?: number) => {
      if (resolution != null) {
        onAction(action, key, label, resolution);
      } else if (shouldAskForQuality(alwaysPreferred)) {
        setPendingDownload({ kind: "action", action, key, label });
        setQualityPickerOpen(true);
      } else {
        onAction(action, key, label, preferredResolution);
      }
    },
    [alwaysPreferred, onAction, preferredResolution],
  );
  const handleEpisodeListAction = useCallback(
    (action: TitleAction, label: string) =>
      handleDownloadAction(
        action,
        action.season != null && action.episode != null
          ? episodeIntentKey(action.season, action.episode)
          : DOWNLOAD_KEY,
        label,
      ),
    [handleDownloadAction],
  );
  const requestSeasonGrab = useCallback(
    (targetSeason: number, resolution?: number) => {
      if (resolution != null) {
        onSeasonGrab(targetSeason, resolution);
      } else if (shouldAskForQuality(alwaysPreferred)) {
        setPendingDownload({ kind: "season", season: targetSeason });
        setQualityPickerOpen(true);
      } else {
        onSeasonGrab(targetSeason, preferredResolution);
      }
    },
    [alwaysPreferred, onSeasonGrab, preferredResolution],
  );
  const confirmDownloadQuality = useCallback(
    (resolution: number) => {
      if (pendingDownload?.kind === "season") {
        onSeasonGrab(pendingDownload.season, resolution);
      } else if (pendingDownload?.kind === "action") {
        onAction(
          pendingDownload.action,
          pendingDownload.key,
          pendingDownload.label,
          resolution,
        );
      }
      setPendingDownload(null);
      setQualityPickerOpen(false);
    },
    [onAction, onSeasonGrab, pendingDownload],
  );
  const closeDownloadQuality = useCallback((open: boolean) => {
    setQualityPickerOpen(open);
    if (!open) setPendingDownload(null);
  }, []);
  const knownTitle = headingTitle(payload.title, routeTitle);
  const titlePending = knownTitle == null && (refreshing || extrasLoading || !extrasSettled);
  const title = knownTitle ?? "Unknown title";
  const tabTitle = titlePending ? routeTitle : title;
  useDocumentTitle(tabTitle, tabTitle ? `Get ${tabTitle}.` : null);
  const handleFindEpisodeSource = useCallback(
    (hash: string, episodeLabel: string, episodeSeason: number, episode: number, packed: boolean) =>
      onFindAnother({
        hash,
        label: `${title} ${episodeLabel}`,
        season: episodeSeason,
        episode: packed ? null : episode,
        packed,
      }),
    [onFindAnother, title],
  );
  const workKey = payload.workKey;
  const handlePickEpisodeRelease = useCallback(
    (season: number, episode: number) =>
      openReleasePicker({ workKey, title, season, episode, onPicked: onLibraryChanged }),
    [workKey, title, onLibraryChanged],
  );
  const [removingEpisode, setRemovingEpisode] = useState<{ season: number; episode: number } | null>(null);
  const [removingBusy, setRemovingBusy] = useState(false);
  const episodeName = useCallback(
    (season: number, episode: number) => `${title} ${formatEpisodeLabel(season, episode)}`,
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

  return {
    payload, extras, progress, extrasLoading, extrasRefreshing, extrasError, extrasSettled, extrasSeason, refetchExtras,
    season, refreshing, statusFor, seasonStatusFor, onSeasonChange, onSeasonGrab, onAction, onLibraryChanged, onFindAnother,
    routeTitle, caps, openFolder, preferredResolution, alwaysPreferred, setAlwaysPreferred,
    qualityPickerOpen, closeDownloadQuality, confirmDownloadQuality,
    openingFile, setOpeningFile, handleDownloadAction, handleEpisodeListAction, requestSeasonGrab,
    titlePending, title, handleFindEpisodeSource, workKey, handlePickEpisodeRelease,
    removingEpisode, setRemovingEpisode, removingBusy, episodeName, handleWantedAction, confirmRemoveEpisode,
  };
}
