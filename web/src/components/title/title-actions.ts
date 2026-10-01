/**
 * What the title page is allowed to offer.
 *
 * The product complaint this answers: clicking a title used to land you in a
 * table of release names. So the controls here are never navigation. A title
 * offers **Download** (one press; the server searches and sends), and a
 * series nobody can name an episode of yet offers **Find episodes**. A search
 * link may exist on the page, but only as a discreet way to override a
 * decision the app has already made for you. Nothing here plays: finished
 * files open in the owner's own player from Downloads.
 *
 * `null` is not `unavailable`. Nobody having searched is not the same as
 * having searched and found nothing, and both still get Download.
 *
 * Pure and DOM-free on purpose.
 */
import type {
  TitleDetailPayload,
  TitleEpisodeTransfer,
  TitleTransferState,
} from "./types";

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Searches and sends, in one click. Never navigates to a release table. */
export interface TitleAction {
  kind: "get";
  label: "Download";
  season: number | null;
  episode: number | null;
  /** Present when Download only has to keep a torrent that is already local. */
  infoHash?: string | null;
}

/**
 * A series the page cannot name a single episode of: no library cursor and no
 * episode rows at all.
 *
 * The page used to invent S01E01 here, which reads as a confident claim built
 * on no evidence. The honest answer is to offer to go and find the episodes,
 * and only show Download once something real came back.
 */
export function needsEpisodeDiscovery(payload: TitleDetailPayload): boolean {
  if (!payload.isSeries) return false;
  const { cursorSeason, cursorEpisode } = payload.library;
  if (cursorSeason && cursorEpisode) return false;
  return payload.episodes.length === 0;
}

// ---------------------------------------------------------------------------
// Button state
// ---------------------------------------------------------------------------

/** Where an in-flight action has got to. One grab at a time, per control. */
export type TitleActionStatus = "idle" | "pending" | "done" | "error";

/**
 * Whether pressing the button may run side effects now.
 *
 * Pending actions cannot be clicked, and a successful grab stays spent until
 * the refreshed payload reports its transfer. A failure may be retried.
 */
export function shouldRunTitleAction(status: TitleActionStatus): boolean {
  return status === "idle" || status === "error";
}

// ---------------------------------------------------------------------------
// Transfer state
// ---------------------------------------------------------------------------

/**
 * Whether a Download control may be offered for a target in this state.
 *
 * The rule is one intent, one control. A target the user has already asked
 * for is not offered again — pressing Download beside a torrent the Client is
 * actively fetching either starts a second grab or silently does nothing, and
 * both teach the viewer that the button lies.
 *
 * `failed` is the exception: it is the one state where pressing again is the
 * correct move, so the control stays and the label becomes a retry.
 * `null` means no target exists — nothing has been asked for, so Download is
 * exactly right.
 */
export function offersDownload(transfer: TitleEpisodeTransfer | null): boolean {
  if (!transfer) return true;
  return transfer.status === "failed";
}

/**
 * The film hero's keep control, decided by the title transfer's real state.
 *
 *  - `download`: nothing asked for yet → "Download".
 *  - `retry`: only when the transfer itself failed, or the press that just
 *    ran failed → "Retry download". Never for a transfer that is queued,
 *    moving or done.
 *  - `status`: already asked for → the control reports progress
 *    ("Looking", "Queued", "Downloading 42%", "Downloaded") and opens
 *    Downloads when the viewer can see transfers and Downloads has a row,
 *    instead of offering a second grab.
 *
 * Library membership is independent of all of this.
 */
export interface TitleTransferControl {
  intent: "download" | "retry" | "status";
  label: string;
  /** May the button run a grab now? Always false for `status`. */
  canRun: boolean;
  /** `status` only: link to the Downloads page instead of a dead button. */
  opensDownloads: boolean;
  /** The failed transfer's reason, when it gave one. */
  error: string | null;
}

/**
 * Plain words for a waiting or moving transfer. "Looking" is a download still
 * searching for a release (Download is fire and forget). Only owners have a
 * queue position, so a requester's queued item reads "Queued" without it.
 */
export function transferStateLabel(
  state: TitleTransferState | null | undefined,
  queuePosition?: number | null,
): string | null {
  if (state === "looking") return "Looking";
  if (state === "queued") return queuePosition != null ? `Queued #${queuePosition}` : "Queued";
  if (state === "downloading") return "Downloading";
  return null;
}

export function resolveTitleTransferControl(
  transfer: TitleEpisodeTransfer | null,
  downloadStatus: TitleActionStatus,
  options: { canSeeTransfers: boolean },
): TitleTransferControl {
  if (transfer && transfer.status !== "failed") {
    const label =
      transfer.status === "queued"
        ? transferStateLabel(transfer.state, transfer.queuePosition) ?? "Queued"
        : transfer.status === "downloading"
          ? `Downloading ${Math.floor(Math.max(0, Math.min(1, transfer.progress)) * 100)}%`
          : "Downloaded";
    return {
      intent: "status",
      label,
      canRun: false,
      // Still looking for a release: Downloads has no row for it yet.
      opensDownloads: options.canSeeTransfers && transfer.state !== "looking",
      error: null,
    };
  }
  const failed = transfer?.status === "failed" || downloadStatus === "error";
  return {
    intent: failed ? "retry" : "download",
    label: failed ? "Retry download" : "Download",
    canRun: downloadStatus !== "pending" && downloadStatus !== "done",
    opensDownloads: false,
    error: transfer?.status === "failed" ? transfer.error : null,
  };
}
