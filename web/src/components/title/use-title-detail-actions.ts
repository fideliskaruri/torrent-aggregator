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

import { useTitleDetailQuery } from "./use-title-detail-query";
import { followResolvedWorkKey } from "./title-url";

type TitleDetailQuery = ReturnType<typeof useTitleDetailQuery>;

export function useTitleDetailActions(query: TitleDetailQuery) {
  const { props, caps, cap, data, extras, refetch, navigate, statusFor, startTransferPoll, seasonStatuses, setSeasonStatuses, setStatuses } = query;
  const canDownloadRef = useRef(caps.canDownload);
  canDownloadRef.current = caps.canDownload;
  const spentRemoteActions = useRef(new Set<string>());
  const spentSeasonGrabs = useRef(new Set<string>());
  const inFlightSeasonGrabs = useRef(new Set<string>());
  const actionDeps = useRef({ props, statusFor, cap, data, refetch, navigate });
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
    [startTransferPoll],
  );

  return { runAction };
}
