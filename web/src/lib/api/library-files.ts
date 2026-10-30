import { send } from "@/lib/api";
import { deleteFailure } from "@/lib/api/delete-refusal";

function fileUrl(mediaFileId: string, action: "find-another" | "keep-new" | "keep-both") {
  return `/api/library/files/${encodeURIComponent(mediaFileId)}/${action}`;
}

/** Blocks this file's release and starts looking for another copy. The file stays until the owner chooses. */
export async function findAnotherCopy(mediaFileId: string, title: string): Promise<void> {
  const response = await send<{ ok?: boolean; error?: string }>(fileUrl(mediaFileId, "find-another"), {
    method: "POST",
    body: {},
  });
  if (response.error || !response.data?.ok)
    throw new Error(response.data?.error ?? `Could not look for another copy of ${title}. Try again.`);
}

/** Deletes the old copy once the new one is ready. Throws PlaybackUncheckedError when Jellyfin can't be asked. */
export async function keepNewCopy(mediaFileId: string, title: string, deleteAnyway = false): Promise<void> {
  const response = await send<{ ok?: boolean }>(fileUrl(mediaFileId, "keep-new"), {
    method: "POST",
    body: deleteAnyway ? { deleteAnyway: true } : {},
  });
  if (response.error || !response.data?.ok)
    throw deleteFailure(response.data, `Could not delete the old copy of ${title}. Try again.`);
}

export async function keepBothCopies(mediaFileId: string, title: string): Promise<void> {
  const response = await send<{ ok?: boolean; error?: string }>(fileUrl(mediaFileId, "keep-both"), {
    method: "POST",
    body: {},
  });
  if (response.error || !response.data?.ok)
    throw new Error(response.data?.error ?? `Could not keep both copies of ${title}. Try again.`);
}
