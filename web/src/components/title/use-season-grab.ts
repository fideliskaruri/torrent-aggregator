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

export function useSeasonGrab(query: TitleDetailQuery) {
  const { props, caps, cap, extras, refetch, navigate, seasonStatuses, setSeasonStatuses } = query;
  const spentSeasonGrabs = useRef(new Set<string>());
  const inFlightSeasonGrabs = useRef(new Set<string>());
  const seasonStatusFor = useCallback(
    (targetSeason: number) =>
      seasonStatuses[seasonGrabKey(targetSeason)] ?? ({ status: "idle" } as const),
    [seasonStatuses],
  );
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
      const retryAction = (report: SeasonGrabReport | null | undefined) => {
        if (!canDownloadRef.current) return undefined;
        const missing = seasonGrabRetryEpisodes(report, episodes);
        if (!missing) return undefined;
        return {
          label: "Retry",
          onClick: (event: { preventDefault: () => void }) => {
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
        const seasonComplete =
          extras != null &&
          extras.season === targetSeason &&
          extras.episodes.length > 0
            ? extras.episodes.every((ep) => !isUnaired(ep.airDate))
            : true;
        const outcome = await cap.run(async ({ overrideStorageCap }) => {
          const res = await send(`/api/title/${encodeURIComponent(props.workKey)}`, {
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
          toast.success(outcome.value.message, {
            id: toastId,
            description: report.planReason ?? undefined,
          });
          refetch();
          followResolvedWorkKey(navigate, props.workKey, outcome.value.workKey);
          return;
        }
        const partial = report.coveredEpisodes < report.totalEpisodes;
        const partialRetry = retryAction(report);
        const partialPick = partial ? pickAction(report) : null;
        const partialDescription = partial
          ? seasonGrabFailureDescription(report, outcome.value.message)
          : undefined;
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
  return { seasonStatusFor, runSeasonGrab };
}
