import { useCallback,useState } from "react";
import { toast } from "@/lib/toast";
import { useFeatures } from "@/lib/features";
import { type OpenDownloadMode } from "@/lib/open-download";
import { cleanDisplayTitle } from "@/lib/title/display-title";
import { headingTitle } from "./heading-title";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { episodeIntentKey } from "./episode-list";
import { stopWanted,tryWantedNow,type WantedAction } from "@/components/wanted/wanted-actions";
import { useCapabilities } from "@/lib/capabilities";
import { usePreferredQuality } from "./use-preferred-quality";
import { type TitleAction,type TitleActionStatus } from "./title-actions";
import { type SeasonGrabStatus } from "./season-grab-state";
import { openReleasePicker } from "@/components/releases/release-picker-store";
import type { TitleDetailPayload,TitleExtrasPayload,TitleProgressPayload } from "./types";

const DOWNLOAD_KEY = "download";

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
  provider,
  providerId,
  routeTitle,
}: {
    provider: string | null;
  providerId: string | null;
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
    onFindAnother: (subject: { hash: string; label: string }) => void;
}) {
  const caps = useCapabilities();
  const { openFolder } = useFeatures();
  const { preferredResolution, alwaysPreferred, setAlwaysPreferred } = usePreferredQuality();
  const [heroPicker, setHeroPicker] = useState(false);
  const [openingFile, setOpeningFile] = useState<OpenDownloadMode | null>(null);
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
  const knownTitle = headingTitle(payload.title, routeTitle);
  const titlePending = knownTitle == null && (refreshing || extrasLoading || !extrasSettled);
  const title = knownTitle != null ? cleanDisplayTitle(knownTitle) : "Unknown title";
  const tabTitle = titlePending ? routeTitle : title;
  useDocumentTitle(tabTitle, tabTitle ? `Get ${tabTitle}.` : null);
  const handleFindEpisodeSource = useCallback(
    (hash: string, episodeLabel: string) =>
      onFindAnother({ hash, label: `${title} ${episodeLabel}` }),
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

  return {
    payload, extras, progress, extrasLoading, extrasRefreshing, extrasError, extrasSettled, extrasSeason, refetchExtras,
    season, refreshing, statusFor, seasonStatusFor, onSeasonChange, onSeasonGrab, onAction, onLibraryChanged, onFindAnother,
    provider, providerId, routeTitle, caps, openFolder, preferredResolution, alwaysPreferred, setAlwaysPreferred,
    heroPicker, setHeroPicker, openingFile, setOpeningFile, handleEpisodeListAction, requestSeasonGrab,
    knownTitle, titlePending, title, tabTitle, handleFindEpisodeSource, workKey, handlePickEpisodeRelease,
    removingEpisode, setRemovingEpisode, removingBusy, setRemovingBusy, episodeName, handleWantedAction, confirmRemoveEpisode,
  };
}
