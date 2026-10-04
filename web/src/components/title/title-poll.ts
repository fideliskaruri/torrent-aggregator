import type { TitleDetailPayload, TitleProgressPayload } from "./types";

export function titleNeedsTransferPoll(
  payload: TitleDetailPayload | null,
): boolean {
  if (!payload) return false;
  const live = (status: string | undefined) =>
    status === "queued" || status === "downloading";
  if (live(payload.transfer?.status)) return true;
  if (payload.seasons.some((season) => live(season.transfer?.status))) return true;
  return payload.episodes.some((episode) => live(episode.transfer?.status));
}

export function titleProgressHasActiveTransfer(
  payload: TitleProgressPayload,
): boolean {
  const active = (status: string | undefined) =>
    status === "queued" || status === "downloading";
  if (active(payload.transfer?.status)) return true;
  if (Object.values(payload.seasonTransfers).some((transfer) => active(transfer?.status))) {
    return true;
  }
  return Object.values(payload.episodeTransfers).some((transfer) =>
    active(transfer?.status),
  );
}
