import type { TitleEpisodeTransfer, TitleOwned } from "./types";
import type { TitleActionStatus } from "./title-actions";

export type TitleDownloadVisualState =
  | "download"
  | "retry"
  | "queued"
  | "downloading"
  | "looking"
  | "pending"
  | "done";

export interface TitleDownloadPresentation {
  onDisk: boolean;
  held: boolean;
  state: TitleDownloadVisualState;
  label: string;
  progress: number | null;
  queuePosition: number | null;
}

export function isTitleOnDisk(target: {
  available?: boolean;
  owned?: TitleOwned | null;
  transfer?: TitleEpisodeTransfer | null;
}): boolean {
  return (
    target.available === true ||
    target.owned != null ||
    target.transfer?.status === "downloaded"
  );
}

export function titleDownloadPresentation(target: {
  available?: boolean;
  owned?: TitleOwned | null;
  transfer?: TitleEpisodeTransfer | null;
  fromPack?: boolean;
  actionStatus: TitleActionStatus;
}): TitleDownloadPresentation {
  const { transfer, actionStatus } = target;
  const onDisk = isTitleOnDisk(target);
  const held = transfer?.status === "downloaded" || (onDisk && !target.fromPack);
  if (transfer?.status === "failed" || actionStatus === "error") {
    return { onDisk, held, state: "retry", label: "Retry download", progress: null, queuePosition: null };
  }
  if (transfer?.status === "downloading") {
    const progress = transfer.progress;
    return {
      onDisk,
      held,
      state: "downloading",
      label: `Downloading ${Math.floor(Math.max(0, Math.min(1, progress)) * 100)}%`,
      progress,
      queuePosition: null,
    };
  }
  if (transfer?.status === "queued") {
    const queuePosition = transfer.queuePosition ?? null;
    const label =
      transfer.state === "looking" || transfer.state === "waiting_season_list"
        ? "Looking"
        : transfer.state === "waiting_english"
          ? "Waiting for an English source"
          : queuePosition != null
            ? `Queued #${queuePosition}`
            : "Queued";
    return { onDisk, held, state: transfer.state === "looking" ? "looking" : "queued", label, progress: null, queuePosition };
  }
  if (
    transfer?.state === "looking" ||
    transfer?.state === "waiting_english" ||
    transfer?.state === "waiting_season_list"
  ) {
    return {
      onDisk,
      held,
      state: "looking",
      label: transfer.state === "waiting_english" ? "Waiting for an English source" : "Looking",
      progress: null,
      queuePosition: null,
    };
  }
  if (held || transfer?.status === "downloaded") {
    return { onDisk, held, state: "done", label: "Downloaded", progress: null, queuePosition: null };
  }
  if (actionStatus === "done") {
    return { onDisk, held, state: "done", label: "Queued", progress: null, queuePosition: null };
  }
  if (actionStatus === "pending") {
    return { onDisk, held, state: "pending", label: "Download", progress: null, queuePosition: null };
  }
  return { onDisk, held, state: "download", label: "Download", progress: null, queuePosition: null };
}
