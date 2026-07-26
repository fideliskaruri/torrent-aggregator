/**
 * Starting and stopping an in-process WebTorrent transfer for real.
 *
 * This exists because `torrent.pause()` does not pause anything. Upstream
 * (`webtorrent/lib/torrent.js:2078`) is, in full:
 *
 *     pause () {
 *       if (this.destroyed) return
 *       this._debug('pause')
 *       this.paused = true
 *     }
 *
 * That flag is read in exactly three places, and all three are about
 * *acquiring* peers, not about transferring with the ones already connected:
 *
 *     torrent.js:1093   _addPeer  → ignore a newly discovered peer
 *     torrent.js:1173   incoming  → destroy an inbound connection
 *     torrent.js:2104   _drain    → do not dial out
 *
 * The request pump is `_update` → `_updateWireWrapper` → `_updateWire`
 * (torrent.js:1580-1602). None of them consults `paused`. So a torrent that
 * already has peers keeps requesting blocks, keeps writing to disk and keeps
 * uploading after `pause()` returns, while the UI reads `torrent.paused` and
 * truthfully reports what the flag says and falsely reports what the app is
 * doing.
 *
 * Deselecting files does not fix it either. `_onMetadata` installs a
 * whole-torrent selection with `select(0, pieces.length - 1)`
 * (torrent.js:624). `file.deselect()` calls `torrent.deselect(startPiece,
 * endPiece)` (file.js:92) and `Selections.remove` matches on the exact
 * `{from, to}` pair, so a per-file deselect can never remove the whole-torrent
 * entry. The torrent stays interested and the wires stay busy.
 *
 * What actually stops bytes moving is closing the sockets — which is what every
 * real client does when you press pause.
 */

/** The subset of `WebTorrent.Torrent` this module touches. */
export type PausableTorrent = {
  infoHash?: string;
  destroyed?: boolean;
  paused?: boolean;
  pause?: () => void;
  resume?: () => void;
  wires?: Array<{ destroyed?: boolean; destroy?: () => void }> | null;
  _peers?: Map<string, { destroyed?: boolean; destroy?: (err?: Error) => void }> | null;
  discovery?: {
    tracker?: { update?: () => void } | null;
    dht?: { lookup?: (infoHash: string) => void } | null;
  } | null;
};

/** How many peers/wires the last {@link haltTransfer} actually tore down. */
export type HaltResult = {
  peersDestroyed: number;
  wiresDestroyed: number;
};

/**
 * Stop a torrent transferring, for real.
 *
 * Order matters. The flag is set *first* so that any peer discovered while we
 * are tearing connections down is rejected on arrival by `_addPeer` rather than
 * slipping in behind us and resuming the download.
 *
 * `peer.destroy()` (webtorrent/lib/peer.js:231) is the clean teardown: it
 * removes the wire from `torrent.wires`, destroys the socket and calls
 * `swarm.removePeer`, so piece reservations are released instead of leaking.
 * Wires are swept afterwards to catch web seeds and any wire whose peer object
 * did not unwind itself.
 */
export function haltTransfer(t: PausableTorrent): HaltResult {
  const result: HaltResult = { peersDestroyed: 0, wiresDestroyed: 0 };
  if (!t || t.destroyed) return result;

  try {
    t.pause?.();
  } catch {
    /* best-effort: the flag is not the part that matters */
  }

  // Snapshot both collections first — destroying a peer mutates them as it unwinds.
  const peers = t._peers ? Array.from(t._peers.values()) : [];
  for (const peer of peers) {
    if (!peer || peer.destroyed) continue;
    try {
      peer.destroy?.(new Error("torrent paused"));
      result.peersDestroyed += 1;
    } catch {
      /* best-effort */
    }
  }

  const wires = Array.isArray(t.wires) ? [...t.wires] : [];
  for (const wire of wires) {
    if (!wire || wire.destroyed) continue;
    try {
      wire.destroy?.();
      result.wiresDestroyed += 1;
    } catch {
      /* best-effort */
    }
  }

  return result;
}

/**
 * Bring a halted torrent back.
 *
 * `torrent.resume()` clears the flag and calls `_drain()`, which dials peers
 * out of `torrent._queue`. Halting emptied that queue, because `peer.destroy()`
 * calls `swarm.removePeer`. A bare `resume()` therefore has nothing to dial and
 * the torrent sits at zero peers until discovery next announces on its own —
 * commonly a 30-minute tracker interval. Resume would look broken for half an
 * hour.
 *
 * Re-announcing immediately closes that gap. The tracker replies with a fresh
 * peer list; each peer now passes `_addPeer` (the flag is already clear) and
 * `_drain` dials it. The DHT lookup is a second, independent source for when
 * the trackers are unreachable.
 *
 * `onBeforeAnnounce` is where the caller re-selects files, so selection and the
 * flag are both correct before any peer can arrive.
 */
export function resumeTransfer(
  t: PausableTorrent,
  onBeforeAnnounce?: (t: PausableTorrent) => void,
): void {
  if (!t || t.destroyed) return;

  try {
    onBeforeAnnounce?.(t);
  } catch {
    /* best-effort */
  }

  try {
    t.resume?.();
  } catch {
    /* best-effort */
  }

  try {
    t.discovery?.tracker?.update?.();
  } catch {
    /* the tracker client may be mid-reconnect */
  }

  try {
    if (t.infoHash) t.discovery?.dht?.lookup?.(t.infoHash);
  } catch {
    /* DHT may be disabled */
  }
}
