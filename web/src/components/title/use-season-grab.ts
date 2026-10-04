import { useCallback,useRef } from "react";
import { send } from "@/lib/api";
import { toast } from "@/lib/toast";
import { cleanDisplayTitle } from "@/lib/title/display-title";
import { isUnaired } from "./merge-extras";
import { SeasonGrabFailureError,seasonGrabFailureDescription,seasonGrabKey,seasonGrabRetryEpisodes,shouldRetrySeasonGrab,shouldRunSeasonGrab,type SeasonGrabReport } from "./season-grab-state";
import { rethrowAcquisitionFetchError } from "./title-action-request";
import { toastDownloadOutcome } from "@/components/releases/download-outcome-toast";
import { parseStorageOverrideFacts,StorageLimitError,} from "@/lib/library/storage-override";
import type { TitleSeasonGrabResponse } from "./types";


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
