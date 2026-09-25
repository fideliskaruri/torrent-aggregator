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
