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

import { useTitleContentState } from "./use-title-content-state";
import type { TitleDetailProps } from "./title-props";

export function useTitleContentViewModel(state: ReturnType<typeof useTitleContentState>) {
  const { payload, extras, progress, extrasLoading, extrasRefreshing, extrasError, extrasSettled, extrasSeason, season, refreshing, statusFor, seasonStatusFor, onSeasonChange, onSeasonGrab, onAction, onLibraryChanged, onFindAnother, provider, providerId, routeTitle, caps, openFolder, preferredResolution, alwaysPreferred, setAlwaysPreferred, heroPicker, setHeroPicker, openingFile, setOpeningFile, handleEpisodeListAction, requestSeasonGrab, knownTitle, titlePending, title, tabTitle, handleFindEpisodeSource, workKey, handlePickEpisodeRelease, removingEpisode, setRemovingEpisode, removingBusy, setRemovingBusy, episodeName, handleWantedAction, confirmRemoveEpisode } = state;
  const backdrop = payload.backdropUrl;
  const releaseGate = browseReleaseGate({
    releaseDate: payload.releaseDate ?? extras?.releaseDate ?? null,
    mediaType: payload.isSeries ? "series" : "movie",
    inTheatricalWindow: extras?.inTheatricalWindow ?? false,
    nextHomeReleaseAt: extras?.nextHomeReleaseAt ?? null,
  });
  const gated = releaseGate.gated;
  const seasons = mergeSeasons(
    payload.seasons,
    extras?.seasons ?? [],
    progress?.seasonTransfers,
  );
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
  const discoverEpisodes = needsEpisodeDiscovery({
    ...payload,
    seasons,
    season: activeSeason,
    episodes: rows,
  });
  const discoveryPending = extrasLoading || extrasRefreshing;

  const seasonCount = extras?.seasonCount ?? null;
  const similar = extras?.moreLikeThis ?? [];
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
  const metaScore =
    payload.rating != null
      ? {
          rating: payload.rating,
          source: payload.ratingSource ?? null,
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
  const metaYear = payload.year ?? releaseYear(releaseDate);
  const genres = extras?.genres ?? [];
  const heroExtrasPending = extras == null && !extrasError && (extrasLoading || !extrasSettled);
  const metaListPresent = Boolean(
    extras?.originalLanguage ||
      formatReleaseDate(releaseDate) ||
      extras?.certification,
  );
  const showDownload = !payload.isSeries && !gated;
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
  const openHash = titleTransfer?.status === "downloaded" ? titleTransfer.infoHash : null;
  const canOpenFile = showDownload && caps.canSeePaths && openFolder && !!openHash;
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
  const similarLoading = extrasLoading && !extrasError;
  const nothingBelowHero =
    !payload.isSeries && hint == null && similar.length === 0 && !similarLoading;


  return {
    ...state, backdrop, releaseGate, gated, seasons, activeSeason, onKnownSeason, extrasDescribeActiveSeason, episodeExtras,
    rows, allRows, truncated, rowsCoverSeason, seasonProgress, showProgress, showProgressText, discoverEpisodes, discoveryPending,
    seasonCount, similar, extrasPending, episodeListLoading, episodeListState, activeSeasonGrabStatus, metaScore, releaseDate, metaYear,
    genres, heroExtrasPending, metaListPresent, showDownload, ownedFilm, downloadAction, downloadStatus, ownTitleTransfer, titleTransfer,
    downloadControl, downloadLabel, titleLooking, titleWanted, titleWantedRow, downloadCanRun, downloadLabelTarget, openHash,
    canOpenFile, findSourceHash, canFindSource, openTitleFile, hint, similarLoading, nothingBelowHero,
  };
}
