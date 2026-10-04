import { useCallback,useLayoutEffect,useRef } from "react";
import { toast } from "@/lib/toast";
import { cleanDisplayTitle } from "@/lib/title/display-title";
import { shouldRunTitleAction,type TitleAction } from "./title-actions";
import { NoReleaseFoundError,postTitleAction } from "./title-action-request";
import { toastDownloadOutcome } from "@/components/releases/download-outcome-toast";


import { useTitleDetailQuery } from "./use-title-detail-query";
import { followResolvedWorkKey } from "./title-url";

type TitleDetailQuery = ReturnType<typeof useTitleDetailQuery>;

export function useTitleDetailActions(query: TitleDetailQuery) {
  const { props, caps, cap, data, refetch, navigate, statusFor, startTransferPoll, setStatuses } = query;
  const canDownloadRef = useRef(caps.canDownload);
  canDownloadRef.current = caps.canDownload;
  const spentRemoteActions = useRef(new Set<string>());
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
