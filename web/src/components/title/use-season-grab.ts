import { useCallback, useRef } from "react";
import { toast } from "@/lib/toast";
import { useDownloadSetup } from "@/components/setup/download-setup";
import { postAcquisition } from "./title-action-request";
import { seasonGrabKey, type SeasonGrabStatus } from "./season-grab-state";
import { useTitleDetailQuery } from "./use-title-detail-query";
import { followResolvedWorkKey } from "./title-url";

type TitleDetailQuery = ReturnType<typeof useTitleDetailQuery>;

export function useSeasonGrab(query: TitleDetailQuery) {
  const { props, navigate, refetch, setSeasonStatuses, seasonStatuses, startTransferPoll } = query;
  const { ensureDownloadSetup } = useDownloadSetup();
  const inFlight = useRef(new Set<string>());
  const seasonStatusFor = useCallback(
    (season: number): SeasonGrabStatus =>
      seasonStatuses[seasonGrabKey(season)] ?? { status: "idle" },
    [seasonStatuses],
  );
  const runSeasonGrab = useCallback(
    async (season: number, resolution?: number) => {
      const key = seasonGrabKey(season);
      const status = seasonStatusFor(season).status;
      if ((status !== "idle" && status !== "error") || inFlight.current.has(key)) return;
      if (!(await ensureDownloadSetup())) return;

      inFlight.current.add(key);
      setSeasonStatuses((current) => ({ ...current, [key]: { status: "pending" } }));
      try {
        const result = await postAcquisition(props.workKey, {
          scope: "season",
          season,
          ...(resolution != null ? { preferredResolution: resolution } : {}),
        });
        setSeasonStatuses((current) => ({ ...current, [key]: { status: "done" } }));
        toast.success(result.message || `Season ${season} queued.`);
        startTransferPoll();
        refetch();
        followResolvedWorkKey(navigate, props.workKey, result.workKey);
      } catch (error) {
        setSeasonStatuses((current) => ({
          ...current,
          [key]: {
            status: "error",
            message: error instanceof Error ? error.message : "Could not queue this season. Try again.",
          },
        }));
        toast.error(error instanceof Error ? error.message : "Could not queue this season. Try again.");
      } finally {
        inFlight.current.delete(key);
      }
    },
    [ensureDownloadSetup, navigate, props.workKey, refetch, seasonStatusFor, setSeasonStatuses, startTransferPoll],
  );
  return { seasonStatusFor, runSeasonGrab };
}
