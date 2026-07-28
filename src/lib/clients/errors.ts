/**
 * Normalize torrent-client connection failures into clear, user-facing messages.
 * Root cause of many 502s: external client not running (ECONNREFUSED on host:port).
 * Built-in engine never needs a host:port — do not frame its errors as "offline client".
 */
export function isClientOfflineError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const cause =
    err instanceof Error && err.cause instanceof Error
      ? err.cause.message
      : "";
  const hay = `${msg} ${cause}`.toLowerCase();
  return (
    hay.includes("econnrefused") ||
    hay.includes("enotfound") ||
    hay.includes("econnreset") ||
    hay.includes("etimedout") ||
    hay.includes("networkerror") ||
    hay.includes("fetch failed") ||
    hay.includes("aborted") ||
    hay.includes("timeout") ||
    hay.includes("und_err_connect") ||
    hay.includes("connect timeout")
  );
}

function clientDisplayName(clientTypeOrLabel: string): string {
  const t = clientTypeOrLabel.toLowerCase();
  if (t === "builtin" || t.includes("built-in") || t.includes("builtin")) {
    return "built-in engine";
  }
  if (t === "qbittorrent") return "qBittorrent";
  if (t === "transmission") return "Transmission";
  return clientTypeOrLabel || "torrent client";
}

export function formatClientError(
  err: unknown,
  clientTypeOrLabel = "torrent client",
): { offline: boolean; message: string; code: string } {
  const isBuiltin =
    clientTypeOrLabel === "builtin" ||
    /built-?in/i.test(clientTypeOrLabel);
  const label = clientDisplayName(clientTypeOrLabel);
  const raw = err instanceof Error ? err.message : String(err);
  const cause =
    err instanceof Error && err.cause instanceof Error
      ? err.cause.message
      : err instanceof Error && err.cause
        ? String(err.cause)
        : "";
  const detail = [raw, cause].filter(Boolean).join(" — ");

  // Built-in has no external WebUI — network "offline" framing is wrong.
  if (isBuiltin) {
    return {
      offline: false,
      code: "ENGINE_ERROR",
      message:
        detail ||
        "Built-in engine failed. Check server logs, disk free space, and DOWNLOAD_DIR.",
    };
  }

  if (isClientOfflineError(err) || /fetch failed/i.test(detail)) {
    return {
      offline: true,
      code: "CLIENT_OFFLINE",
      message:
        `Cannot reach ${label}. Is it running, and is the Host URL in Settings correct? ` +
        `(Connection refused usually means qBittorrent/Transmission is not listening on that port.) ` +
        `Or switch Client to Built-in for one-app downloads.`,
    };
  }

  if (/login failed/i.test(detail)) {
    return {
      offline: false,
      code: "CLIENT_AUTH",
      message: `${label} login failed — check username/password in Settings.`,
    };
  }

  return {
    offline: false,
    code: "CLIENT_ERROR",
    message: detail || `Unexpected ${label} error`,
  };
}

/**
 * Root-cause taxonomy for a playback/stream failure.
 *
 * These are MACHINE codes, not user copy: a separate player agent maps each to
 * friendly words. The whole point of the discriminated union is that the UI can
 * branch on *why* a stream failed (a no-peer swarm is recoverable by re-trying
 * the same release once the network is back; an undecodable file is not) rather
 * than showing one generic "playback failed".
 *
 * The two axes that matter downstream:
 *   - DELIVERY vs PLAYABILITY. Delivery failures (NO_PEERS, CONNECTION_BLOCKED,
 *     STALLED) mean bytes are not arriving; the same infoHash can be re-announced
 *     and retried. PLAYABILITY failures (UNPLAYABLE) mean the bytes arrived but
 *     the file cannot be decoded; retrying the same release is pointless.
 *   - NOT_FOUND / ENGINE_ERROR are neither: the release or engine is the problem.
 */
export type PlaybackFailureKind =
  /** Swarm reachable but nobody is offering the data (0 peers, or peers that choke). */
  | "NO_PEERS"
  /** Network path to peers is blocked — VPN/firewall/DNS dropped the connection. */
  | "CONNECTION_BLOCKED"
  /** Peers connected and once delivered, but byte progress has frozen. */
  | "STALLED"
  /** The requested release/file/torrent is not known to the engine. */
  | "NOT_FOUND"
  /** Bytes arrived but the container/codec cannot be played. Not retryable. */
  | "UNPLAYABLE"
  /** The engine itself errored (disk, adapter, internal). */
  | "ENGINE_ERROR";

/** Whether a failure is about getting bytes (delivery) or decoding them (playability). */
export type PlaybackFailureClass = "delivery" | "playability" | "engine" | "not-found";

export interface PlaybackFailure {
  kind: PlaybackFailureKind;
  /** Coarse class so callers can decide "retry same release" vs "failover". */
  failureClass: PlaybackFailureClass;
  /** True when re-announcing/retrying the SAME infoHash can plausibly recover. */
  retryable: boolean;
  /**
   * A safe, mechanism-free default the UI MAY override. Deliberately terse and
   * free of peers/bytes/%/codec words — the player owns the real copy.
   */
  defaultMessage: string;
}

const PLAYBACK_FAILURE_TABLE: Record<
  PlaybackFailureKind,
  Omit<PlaybackFailure, "kind">
> = {
  NO_PEERS: {
    failureClass: "delivery",
    retryable: true,
    defaultMessage: "This isn’t available to play right now. Try again in a moment.",
  },
  CONNECTION_BLOCKED: {
    failureClass: "delivery",
    retryable: true,
    defaultMessage: "The connection was blocked. Check your network and try again.",
  },
  STALLED: {
    failureClass: "delivery",
    retryable: true,
    defaultMessage: "This stopped loading. Try again in a moment.",
  },
  NOT_FOUND: {
    failureClass: "not-found",
    retryable: false,
    defaultMessage: "This isn’t available.",
  },
  UNPLAYABLE: {
    failureClass: "playability",
    retryable: false,
    defaultMessage: "This can’t be played. Try a different version.",
  },
  ENGINE_ERROR: {
    failureClass: "engine",
    retryable: false,
    defaultMessage: "Something went wrong. Try again.",
  },
};

/** Build a full {@link PlaybackFailure} record from a kind. */
export function playbackFailure(kind: PlaybackFailureKind): PlaybackFailure {
  return { kind, ...PLAYBACK_FAILURE_TABLE[kind] };
}

/**
 * Signals a classifier can read off the engine/stream state to reach a verdict.
 *
 * Every field is optional so a caller supplies only what it knows; the rules are
 * applied most-specific first. This is the single place raw conditions become a
 * code, so the mapping can be table-tested independently of any live swarm.
 */
export interface PlaybackFailureSignals {
  /** A raw thrown error, if any (connection resets, aborts, disk errors). */
  error?: unknown;
  /** Connected peers at the moment of failure. 0 (or null) points at NO_PEERS. */
  peerCount?: number | null;
  /** The stall detector's reason, when the failure came from a stall verdict. */
  stallReason?: string | null;
  /** True when bytes were delivered but the file could not be decoded. */
  undecodable?: boolean;
  /** True when the release/file/torrent was not found by the engine. */
  notFound?: boolean;
}

/**
 * Map raw failure signals to a single {@link PlaybackFailureKind}.
 *
 * Order matters — it encodes precedence:
 *   1. not-found is structural and beats everything.
 *   2. an undecodable file is a playability verdict; delivery is irrelevant.
 *   3. a blocked connection (reset/abort/refused from a network layer) beats a
 *      plain no-peer reading, because the peers may exist but be unreachable.
 *   4. zero peers → NO_PEERS.
 *   5. an active-download stall with peers present → STALLED.
 *   6. anything else that threw → ENGINE_ERROR.
 */
export function classifyPlaybackFailure(
  signals: PlaybackFailureSignals,
): PlaybackFailure {
  if (signals.notFound) return playbackFailure("NOT_FOUND");
  if (signals.undecodable) return playbackFailure("UNPLAYABLE");

  const err = signals.error;
  if (err != null && isConnectionBlockedError(err)) {
    return playbackFailure("CONNECTION_BLOCKED");
  }

  const peers = signals.peerCount;
  const hasNoPeers = peers === 0 || peers == null;

  if (signals.stallReason === "stalled") {
    // A stall with peers is a true stall; a stall with no peers is really a
    // no-peer delivery failure wearing a stall's clothes.
    return playbackFailure(hasNoPeers ? "NO_PEERS" : "STALLED");
  }

  if (signals.stallReason != null && hasNoPeers && signals.error == null) {
    return playbackFailure("NO_PEERS");
  }

  if (err != null) {
    // A generic connection-level error with nobody on the wire is a no-peer
    // delivery failure; otherwise it is an engine fault.
    if (isClientOfflineError(err) && hasNoPeers) {
      return playbackFailure("NO_PEERS");
    }
    return playbackFailure("ENGINE_ERROR");
  }

  if (hasNoPeers) return playbackFailure("NO_PEERS");
  return playbackFailure("ENGINE_ERROR");
}

/**
 * A network layer actively refused/reset/aborted the connection — distinct from
 * "nobody answered". This is the VPN-off / firewall / DNS-poisoned signature,
 * and it is retryable on the SAME release once the path is restored.
 */
export function isConnectionBlockedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const cause =
    err instanceof Error && err.cause instanceof Error ? err.cause.message : "";
  const hay = `${msg} ${cause}`.toLowerCase();
  return (
    hay.includes("econnreset") ||
    hay.includes("econnrefused") ||
    hay.includes("enetunreach") ||
    hay.includes("ehostunreach") ||
    hay.includes("enetdown") ||
    hay.includes("ehostdown") ||
    hay.includes("blocked") ||
    hay.includes("und_err_connect") ||
    hay.includes("connect timeout") ||
    hay.includes("proxy")
  );
}
