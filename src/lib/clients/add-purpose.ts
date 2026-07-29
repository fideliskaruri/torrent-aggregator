/**
 * The single place intent becomes mechanism.
 *
 * A caller states ONE thing — why it is adding a torrent — and everything the
 * engine must decide (which pieces to claim, what `EngineTorrent.origin` to
 * stamp, whether an existing row may change) is derived here from that one
 * value plus the origin already on disk. Nothing downstream re-decides intent,
 * because there is nothing left to re-decide.
 *
 * This is the fix for a recurring defect in this codebase — a capability
 * computed, carried, then never consulted. `purpose` is required at the add
 * boundary and consumed exactly once, right here.
 *
 * Two hard rules encoded below:
 *
 *   A. A Play must NEVER deselect (halt) or relabel a download the user chose
 *      to keep. So when a Play meets an existing `user` row we LEAVE it: no
 *      deselect, no origin change.
 *   B. Origin transitions are MONOTONIC. Speculation (`prewarm`) may become a
 *      real stream on Play and either may become a kept `user` download on
 *      Download, but `user` NEVER demotes. Widening never makes a row more
 *      evictable than the user's most explicit action so far.
 */
import {
  EVICTING_ORIGIN,
  PREWARM_ORIGIN,
  STREAM_ORIGIN,
  USER_ORIGIN,
} from "@/lib/prewarm/types";
import type { TorrentPurpose } from "./types";

export type OriginValue = string;

/**
 * What we know about the row a send is about to touch. `error` is deliberately
 * distinct from `missing`: a failed read is NOT permission to treat the row as
 * absent — that is exactly how a genuine `user` download used to get demoted.
 */
export type ExistingOriginLookup =
  | { status: "missing" }
  | { status: "found"; origin: OriginValue }
  | { status: "error" };

/** How the live torrent's pieces should be claimed. */
export type AddSelection =
  /** Select every file and resume — download and keep the whole torrent. */
  | "select-all"
  /** Add/keep deselected — only the pieces the player asks for are fetched. */
  | "deselect"
  /**
   * Do not touch the current selection. Used when a Play meets a kept download
   * (never halt it) and when a read failed (never guess destructively).
   */
  | "leave";

export interface EffectiveAdd {
  /** The intent after reconciling the request with the on-disk origin. */
  effective: TorrentPurpose | "keep-existing";
  selection: AddSelection;
  /** Hold peer count down — speculative prewarm only. */
  capPeers: boolean;
  /** Origin to stamp when CREATING a brand-new row. */
  birthOrigin: OriginValue;
  /**
   * Monotonic transition for an EXISTING row, applied as a guarded
   * compare-and-set (`origin IN promoteFrom → promoteTo`). `null` = no change.
   * The guard is what makes it safe under a race: it can only ever move a row
   * "up" toward the user's most explicit intent, never down.
   */
  promoteTo: OriginValue | null;
  promoteFrom: OriginValue[];
  /**
   * True when we could not read the existing origin and chose the safe,
   * non-destructive branch. Callers should log it (see issue G — never convert
   * silently).
   */
  degraded: boolean;
}

/** The origin a brand-new row is born with for a stated purpose. */
export function birthOriginForPurpose(purpose: TorrentPurpose): OriginValue {
  if (purpose === "keep") return USER_ORIGIN;
  if (purpose === "prewarm") return PREWARM_ORIGIN;
  return STREAM_ORIGIN;
}

/** Map a stored origin back to the purpose a restart/retry should re-add with. */
export function purposeFromOrigin(
  origin: string | null | undefined,
): TorrentPurpose {
  if (origin === STREAM_ORIGIN) return "stream";
  if (origin === PREWARM_ORIGIN) return "prewarm";
  // A row mid-eviction (or crash-orphaned in `evicting`) is a stream being torn
  // down. A restart/resume that reads it must treat it as an ephemeral stream —
  // deselected, never whole-file downloaded — not as a kept `user` download.
  if (origin === EVICTING_ORIGIN) return "stream";
  return "keep";
}

/** How an explicit resume should (re)claim pieces, derived from stored intent. */
export type ResumeSelection =
  /** Kept download: select every file and resume — the download continues. */
  | "select-all"
  /** Stream cache: reconnect peers but keep files DESELECTED (stream route
   *  re-selects only the played ranges). Never whole-file selected on resume. */
  | "deselect"
  /** Prewarm: as `deselect`, plus re-enforce the speculative peer cap. */
  | "deselect-cap"
  /** Unknown row (missing/read error): reconnect only, touch NO selection —
   *  never reselect (would convert a stream) nor deselect (would halt a keep). */
  | "leave";

/**
 * Decide how a resume must (re)claim pieces from the STORED origin alone.
 *
 * This is the guard for issue C on the explicit-resume path: a bare resume that
 * whole-file selects would silently turn a `stream`/`prewarm` row into a full
 * download every time it is un-paused. Only a `keep` row is ever `select-all`;
 * an unreadable/absent row is `leave` (fail-safe in BOTH directions).
 */
export function resumeSelectionForLookup(
  lookup: ExistingOriginLookup,
): ResumeSelection {
  if (lookup.status !== "found") return "leave";
  const purpose = purposeFromOrigin(lookup.origin);
  if (purpose === "keep") return "select-all";
  if (purpose === "prewarm") return "deselect-cap";
  return "deselect";
}

/**
 * Reconcile a requested purpose with the origin already on disk. Pure and
 * total — every (purpose × lookup) pair has an explicit, auditable answer.
 */
export function resolveEffectiveAdd(
  purpose: TorrentPurpose,
  existing: ExistingOriginLookup,
): EffectiveAdd {
  const origin = existing.status === "found" ? existing.origin : null;

  // ── Download: explicit and permanent. Always select all, promote up to
  // `user` (never demoting — the guard excludes `user`). The promote guard
  // INCLUDES `evicting`: an explicit Download STEALS a lease the sweep is
  // holding, so the user's instruction beats a speculative eviction (issue D,
  // reviewer round 2 — the sweep re-checks under its lease and aborts). Safe
  // even on a read error, because select-all + a monotonic promote can only
  // ever KEEP more.
  if (purpose === "keep") {
    return {
      effective: "keep",
      selection: "select-all",
      capPeers: false,
      birthOrigin: USER_ORIGIN,
      promoteTo: USER_ORIGIN,
      promoteFrom: [STREAM_ORIGIN, PREWARM_ORIGIN, EVICTING_ORIGIN],
      degraded: existing.status === "error",
    };
  }

  // ── Prewarm: speculative. Only ever births a fresh row; never touches or
  // downgrades anything that already exists, and never risks it on a read
  // error.
  if (purpose === "prewarm") {
    if (existing.status === "missing") {
      return {
        effective: "prewarm",
        selection: "deselect",
        capPeers: true,
        birthOrigin: PREWARM_ORIGIN,
        promoteTo: null,
        promoteFrom: [],
        degraded: false,
      };
    }
    return {
      effective: "keep-existing",
      selection: "leave",
      capPeers: false,
      birthOrigin: PREWARM_ORIGIN,
      promoteTo: null,
      promoteFrom: [],
      degraded: existing.status === "error",
    };
  }

  // ── Play (stream). The cardinal rule (A): never deselect or relabel a kept
  // download. So a `user` row — or an unreadable one, or any legacy origin we
  // cannot positively classify as evictable — is LEFT untouched.
  if (existing.status === "error") {
    return {
      effective: "keep-existing",
      selection: "leave",
      capPeers: false,
      birthOrigin: STREAM_ORIGIN,
      promoteTo: null,
      promoteFrom: [],
      degraded: true,
    };
  }
  if (origin === USER_ORIGIN) {
    return {
      effective: "keep-existing",
      selection: "leave",
      capPeers: false,
      birthOrigin: STREAM_ORIGIN,
      promoteTo: null,
      promoteFrom: [],
      degraded: false,
    };
  }
  if (origin === EVICTING_ORIGIN) {
    // An explicit Play STEALS a row the sweep is mid-evicting, back to a live
    // stream. A user instruction — even Play — must beat a speculative eviction:
    // the sweep re-checks under its lease and aborts, keeping the files. This is
    // `evicting → stream`, a rank INCREASE, never a demotion. Selection stays
    // `deselect` (a stream is never whole-file selected).
    return {
      effective: "stream",
      selection: "deselect",
      capPeers: false,
      birthOrigin: STREAM_ORIGIN,
      promoteTo: STREAM_ORIGIN,
      promoteFrom: [PREWARM_ORIGIN, EVICTING_ORIGIN],
      degraded: false,
    };
  }
  if (
    origin != null &&
    origin !== STREAM_ORIGIN &&
    origin !== PREWARM_ORIGIN
  ) {
    // A legacy/external origin we cannot prove is a cache. Treat like `user`:
    // never deselect or relabel it toward eviction.
    return {
      effective: "keep-existing",
      selection: "leave",
      capPeers: false,
      birthOrigin: STREAM_ORIGIN,
      promoteTo: null,
      promoteFrom: [],
      degraded: false,
    };
  }

  // Fresh, or an existing stream/prewarm: this IS a stream. Fetch only what is
  // played, birth `stream`, and promote a speculative row up to `stream` (the
  // guard excludes `user`, so it can never demote a download).
  return {
    effective: "stream",
    selection: "deselect",
    capPeers: false,
    birthOrigin: STREAM_ORIGIN,
    promoteTo: STREAM_ORIGIN,
    promoteFrom: [PREWARM_ORIGIN],
    degraded: false,
  };
}
