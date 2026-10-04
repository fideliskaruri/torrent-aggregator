import { useCallback,useLayoutEffect,useRef } from "react";
import { toast } from "@/lib/toast";
import { useDownloadSetup } from "@/components/setup/download-setup";
import { shouldRunTitleAction,type TitleAction } from "./title-actions";
import { postAcquisition } from "./title-action-request";

import { useTitleDetailQuery } from "./use-title-detail-query";
import { followResolvedWorkKey } from "./title-url";

type TitleDetailQuery = ReturnType<typeof useTitleDetailQuery>;

export function useTitleDetailActions(query: TitleDetailQuery) {
  const { props, caps, refetch, navigate, statusFor, startTransferPoll, setStatuses } = query;
  const { ensureDownloadSetup } = useDownloadSetup();
  const spentRemoteActions = useRef(new Set<string>());
  const actionDeps = useRef({ props, caps, statusFor, refetch, navigate, ensureDownloadSetup });
  useLayoutEffect(() => {
    actionDeps.current = { props, caps, statusFor, refetch, navigate, ensureDownloadSetup };
  });

  const runAction = useCallback(
    async (
      action: TitleAction,
      key: string,
      label: string,
      resolution?: number,
    ) => {
      const { props, caps, statusFor, refetch, navigate, ensureDownloadSetup } = actionDeps.current;
      if (!shouldRunTitleAction(statusFor(key))) return;
      if (spentRemoteActions.current.has(key)) return;
      if (caps.canDownload && !(await ensureDownloadSetup())) return;
      spentRemoteActions.current.add(key);

      setStatuses((prev) => ({ ...prev, [key]: "pending" }));
      try {
        const body = await postAcquisition(props.workKey, {
          scope:
            action.season != null && action.episode != null
              ? "episode"
              : "title",
          season: action.season,
          episode: action.episode,
          title: props.title ?? null,
          mediaType: props.mediaType ?? null,
          year: props.year ?? null,
          provider: props.provider ?? null,
          providerId: props.providerId ?? null,
          sourceType: props.sourceType ?? null,
          format: props.format ?? null,
          ...(resolution != null ? { preferredResolution: resolution } : {}),
        });
        startTransferPoll();
        setStatuses((prev) => ({ ...prev, [key]: "done" }));
        toast.success(body.message || `Looking for ${label}.`);
        refetch();
        followResolvedWorkKey(navigate, props.workKey, body.workKey);
      } catch (err) {
        spentRemoteActions.current.delete(key);
        setStatuses((prev) => ({ ...prev, [key]: "error" }));
        toast.error(err instanceof Error ? err.message : `Could not get ${label}. Try again.`);
      }
    },
    [startTransferPoll],
  );

  return { runAction };
}
