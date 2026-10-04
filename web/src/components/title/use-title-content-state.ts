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
import { ButtonBody } from "./button-body";
import { requestTitleFor } from "./title-payload";
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
