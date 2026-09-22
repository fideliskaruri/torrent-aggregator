import type { TitleAction } from "./title-actions";
import type {
  TitleGrabResponse,
  TitleRetention,
} from "./types";
import {
  parseStorageOverrideFacts,
  StorageLimitError,
} from "@/lib/library/storage-override";

/**
 * Throw the most specific error the response supports.
 *
 * Deliberately re-derives overridability through `parseStorageOverrideFacts`
 * rather than trusting the wire: a server that starts marking free-space
 * refusals overridable must not be able to talk the client into offering it.
 */
function throwGrabFailure(body: TitleGrabResponse | null, fallback: string): never {
  const storage = parseStorageOverrideFacts(body?.storage);
  const message = body?.message || fallback;
  if (storage) throw new StorageLimitError(message, storage);
  throw new Error(message);
}

export interface PostTitleActionInput {
  workKey: string;
  title?: string | null;
  mediaType?: string | null;
  year?: number | null;
  provider?: string | null;
  providerId?: string | null;
  sourceType?: string | null;
  format?: string | null;
  action: TitleAction;
  retention: TitleRetention;
  /** Preferred download resolution in pixels (480/720/1080/2160). Only set for
   *  keep-it grabs — Play never prompts for quality. */
  resolution?: number | null;
  /**
   * Re-issue of a grab the storage cap refused, after the owner was shown the
   * real figures and chose to proceed. Never set on the first attempt, and
   * never honoured for the free-space floor.
   */
  overrideStorageCap?: boolean;
}

/**
 * Hard ceiling on how long a single grab round trip may take before we report
 * an error and re-enable the row.  30 s is long enough for a slow server to
 * respond but short enough that a dead connection does not leave a row disabled
 * for the remainder of the session.
 */
const FETCH_TIMEOUT_MS = 30_000;

/**
 * What a 30 s abort actually means, said out loud.
 *
 * The request is abandoned here; the *grab is not*. The server keeps resolving
 * the release and its torrent metadata on its own, longer budget, so a row that
 * reported "Could not send this episode" was making a claim this client cannot
 * support — and the download frequently appeared moments later. Say what is
 * true: we stopped waiting, the work may still be running, and here is where to
 * look. Never phrased as "no release", which is a statement about availability
 * that a timeout is no evidence for.
 */
export const GRAB_TIMEOUT_MESSAGE =
  "Still working after 30s, so we stopped waiting — the grab may still be running on the server. Check Downloads before trying again.";

/**
 * Our own 30 s deadline, as opposed to a caller's cancellation.
 *
 * Only `TimeoutError`, which is what `AbortSignal.timeout` raises. A plain
 * `AbortError` is the component cancelling its own request (an unmount, a
 * switched season) and must keep propagating untouched — turning that into a
 * message would make ordinary navigation look like a failed grab.
 */
function isTimeoutAbort(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  return (err as { name?: string }).name === "TimeoutError";
}

export async function postTitleAction({
  workKey,
  title,
  mediaType,
  year,
  provider,
  providerId,
  sourceType,
  format,
  action,
  retention,
  resolution,
  overrideStorageCap,
}: PostTitleActionInput): Promise<TitleGrabResponse> {
  const res = await fetch(`/api/title/${encodeURIComponent(workKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    body: JSON.stringify({
      scope:
        action.season != null && action.episode != null
          ? "episode"
          : "title",
      season: action.season,
      episode: action.episode,
      title: title ?? null,
      mediaType: mediaType ?? null,
      year: year ?? null,
      provider: provider ?? null,
      providerId: providerId ?? null,
      sourceType: sourceType ?? null,
      format: format ?? null,
      retention,
      ...(resolution != null ? { preferredResolution: resolution } : {}),
      ...(overrideStorageCap ? { overrideStorageCap: true } : {}),
    }),
  }).catch((err: unknown) => {
    if (isTimeoutAbort(err)) throw new Error(GRAB_TIMEOUT_MESSAGE);
    throw err;
  });
  const body = (await res.json().catch(() => null)) as TitleGrabResponse | null;
  if (!res.ok || !body?.ok) {
    throwGrabFailure(body, "Could not send this episode");
  }
  return body;
}
