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
  if (body?.retryAfterSeconds != null) {
    throw new Error(
      `${message} Try again in ${Math.max(1, Math.ceil(body.retryAfterSeconds))} seconds.`,
    );
  }
  if (body?.noReleaseFound) {
    throw new NoReleaseFoundError(message, body.noReleaseFound.manualSearchQuery ?? null);
  }
  throw new Error(message);
}

/** Nothing could be chosen automatically; the owner can still pick a release, starting from our search. */
export class NoReleaseFoundError extends Error {
  readonly query: string | null;
  constructor(message: string, query: string | null) {
    super(message);
    this.name = "NoReleaseFoundError";
    this.query = query;
  }
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
 * Acquisition requests (title, episode and season POSTs) carry no browser-side
 * deadline. The server legitimately spends minutes on source retries and the
 * start budget, and owns its own lifecycle; a client cutoff only turned a
 * download that was still starting into a generic failure.
 */

/**
 * What a lost connection mid-acquisition means, said out loud.
 *
 * The request is gone; the *download may not be*. The server may already have
 * started it, so this is an uncertain state, never "no release". It carries no
 * Retry: the next step is to look at Downloads, and a repeat click is safe only
 * because the server reuses a torrent that is already running.
 */
export const ACQUISITION_TRANSPORT_MESSAGE =
  "Lost contact with TorrentFlow before it answered. The download may still be starting. Check Downloads before trying again.";

export class AcquisitionTransportError extends Error {
  constructor() {
    super(ACQUISITION_TRANSPORT_MESSAGE);
    this.name = "AcquisitionTransportError";
  }
}

/**
 * The connection failed or a deadline (ours or a proxy's) cut it. A plain
 * `AbortError` is the component cancelling its own request (an unmount, a
 * switched season) and keeps propagating untouched.
 */
export function isAcquisitionTransportFailure(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: string }).name;
  return name === "TypeError" || name === "TimeoutError" || name === "NetworkError";
}

/** Rethrows a fetch rejection, turning transport failures into the uncertain state. */
export function rethrowAcquisitionFetchError(err: unknown): never {
  if (isAcquisitionTransportFailure(err)) throw new AcquisitionTransportError();
  throw err;
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
  }).catch(rethrowAcquisitionFetchError);
  const body = (await res.json().catch(() => null)) as TitleGrabResponse | null;
  if (!res.ok || !body?.ok) {
    throwGrabFailure(body, "Could not send this episode");
  }
  return body;
}
