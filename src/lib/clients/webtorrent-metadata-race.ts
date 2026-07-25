/**
 * Makes WebTorrent's metadata handshake idempotent.
 *
 * `Torrent.prototype._onMetadata` opens with
 *
 *   if (this.metadata || this.destroyed) return
 *
 * which looks like a guard but is not one: the method is `async`, and
 * `this.metadata` is not assigned until *after* `await parseTorrent(metadata)`
 * (torrent.js:555-575). Every peer that offers metadata calls it — the
 * `ut_metadata` handler at torrent.js:1344 — so when several peers answer at
 * once they all pass the check before any of them sets the flag.
 *
 * Each surviving call then runs `_processParsedTorrent`, which rebuilds the
 * torrent from scratch:
 *
 *   this.bitfield = new BitField(this.pieces.length)   // every bit back to 0
 *   this.pieces   = this.pieces.map(...)               // fresh Piece objects
 *
 * The verification pass kicked off by the *previous* call is still in flight at
 * that point, holding indices into the array that was just replaced. Its
 * callbacks land on the new bitfield and set bits for pieces this torrent has
 * never downloaded. Measured on one torrent: `_onMetadata` ran **4 times**, and
 * a download that had fetched 41 MB of 276 MB was reporting **49.6% complete**
 * seconds after starting — the number the UI showed for freshly added torrents.
 *
 * The fix is a flag set *synchronously*, before the first await, so concurrent
 * callers are rejected on the same tick. On rejection the flag is released so a
 * genuine retry can still get through.
 */

const PATCHED = Symbol.for("torrentflow.metadataRace");
const IN_FLIGHT = Symbol.for("torrentflow.metadataInFlight");

let deduped = 0;

/** Redundant metadata initialisations prevented, for health checks and tests. */
export function dedupedMetadataInits(): number {
  return deduped;
}

/** For tests. */
export function resetDedupedMetadataInits(): void {
  deduped = 0;
}

type MetadataHost = {
  metadata?: unknown;
  destroyed?: boolean;
  [IN_FLIGHT]?: boolean;
};

type MetadataProto = Record<string | symbol, unknown> & {
  _onMetadata?: unknown;
};

export function patchTorrentMetadataRace(torrentPrototype: object): boolean {
  const proto = torrentPrototype as MetadataProto;
  if (proto[PATCHED]) return true;

  const original = proto._onMetadata;
  if (typeof original !== "function") return false;
  const fn = original as (this: unknown, ...args: unknown[]) => unknown;

  Object.defineProperty(proto, PATCHED, { value: true, enumerable: false });

  proto._onMetadata = function patchedOnMetadata(
    this: MetadataHost,
    ...args: unknown[]
  ) {
    // Same conditions as upstream, plus the one it cannot see: another call
    // that has already started but not yet reached `this.metadata = ...`.
    if (this.destroyed) return undefined;
    if (this.metadata || this[IN_FLIGHT]) {
      deduped += 1;
      return undefined;
    }
    this[IN_FLIGHT] = true;

    let result: unknown;
    try {
      result = fn.apply(this, args);
    } catch (err) {
      this[IN_FLIGHT] = false;
      throw err;
    }

    // `_onMetadata` is async; release the latch if it rejects so a later peer
    // can retry. A resolved call has set `this.metadata`, so the latch is
    // redundant from then on and is left in place.
    if (result && typeof (result as Promise<unknown>).catch === "function") {
      return (result as Promise<unknown>).catch((err: unknown) => {
        this[IN_FLIGHT] = false;
        throw err;
      });
    }
    return result;
  };
  return true;
}

/**
 * Resolves the Torrent prototype from the installed package and patches it.
 * Returns whether the patch landed so the caller can log a miss if WebTorrent's
 * internals move.
 */
export async function patchWebTorrentMetadataRace(): Promise<boolean> {
  try {
    const mod: unknown = await import(
      /* webpackIgnore: true */ "webtorrent/lib/torrent.js"
    );
    const Ctor = (mod as { default?: unknown }).default ?? mod;
    const proto = (Ctor as { prototype?: object })?.prototype;
    if (!proto) return false;
    return patchTorrentMetadataRace(proto);
  } catch {
    return false;
  }
}
