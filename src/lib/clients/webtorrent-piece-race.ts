/**
 * Works around an upstream WebTorrent race that throws from its own timers.
 *
 * WebTorrent nulls entries in `torrent.pieces[]` as soon as a piece verifies
 * (`_markVerified`, and again inside the async `store.put` callback). Its
 * request scheduler does not re-check for that null, so a wire that was already
 * mid-flight for a piece that just completed dereferences `null`:
 *
 *   lib/torrent.js:1941  piece.reserve()          -> "reading 'reserve'"
 *   lib/torrent.js:1705  self.pieces[i].missing   -> "reading 'missing'"
 *   lib/torrent.js:227   piece.length             -> "reading 'length'"
 *
 * Those calls happen inside wire callbacks and interval timers, not on our
 * request path, so no amount of defensive reading in our own code can catch
 * them — they surface as `uncaughtException` several times a second on a box
 * with active torrents, which buries every real error in the log.
 *
 * The race is benign: the piece threw *because it finished*. `_updateWire` and
 * `_request` are both re-entered on the next scheduler tick, so skipping the
 * throwing call loses nothing. We therefore wrap exactly those two methods and
 * swallow exactly this error shape. Anything else rethrows untouched.
 */

/** Properties WebTorrent reads off a piece that may already be nulled. */
const NULLED_PIECE_PROPS = ["reserve", "missing", "length", "reserveRemaining"];

/**
 * True only for the "read a property off a nulled piece" TypeError. Matching on
 * the message is unpleasant but it is the only signal available: the throw
 * comes from library code we do not control and carries no error code.
 */
export function isNullPieceError(err: unknown): boolean {
  if (!(err instanceof TypeError)) return false;
  const msg = err.message;
  if (!msg.includes("of null")) return false;
  return NULLED_PIECE_PROPS.some((p) => msg.includes(`'${p}'`));
}

type TorrentProto = Record<string, unknown>;

const PATCHED = Symbol.for("torrentflow.pieceRacePatched");

/** Number of races swallowed, exposed so a health check can notice a spike. */
let swallowed = 0;

export function swallowedPieceRaces(): number {
  return swallowed;
}

/** For tests. */
export function resetSwallowedPieceRaces(): void {
  swallowed = 0;
  repairedPieces = 0;
}

/** Leaked pieces reinstated so the scheduler can request them again. */
let repairedPieces = 0;

export function repairedPieceCount(): number {
  return repairedPieces;
}

function wrap(proto: TorrentProto, method: string, onRace: () => unknown) {
  const original = proto[method];
  if (typeof original !== "function") return;
  const fn = original as (...args: unknown[]) => unknown;
  proto[method] = function patched(this: unknown, ...args: unknown[]) {
    try {
      return fn.apply(this, args);
    } catch (err) {
      if (!isNullPieceError(err)) throw err;
      swallowed += 1;
      return onRace();
    }
  };
}

/**
 * Last value each getter returned before it started racing. Substituting the
 * previous reading beats substituting zero: `downloaded` feeds the tracker
 * announce (`left`) and the progress bar, and both would visibly jump backwards
 * to nothing for one tick.
 */
const lastGood = new WeakMap<object, Map<string, unknown>>();

function rememberLastGood(inst: object, name: string, value: unknown) {
  let m = lastGood.get(inst);
  if (!m) lastGood.set(inst, (m = new Map()));
  m.set(name, value);
}

/**
 * Guards a getter. `downloaded` is the important one: it walks the piece array
 * directly, and `progress`, `timeRemaining` and the tracker's `getAnnounceOpts`
 * (torrent.js:390) all delegate to it — so a single wrap here covers every
 * internal caller, present and future, including ones on the announce interval
 * that no request-path guard could ever see.
 */
function wrapGetter(proto: TorrentProto, name: string, fallback: unknown) {
  const desc = Object.getOwnPropertyDescriptor(proto, name);
  if (!desc?.get) return;
  const get = desc.get;
  Object.defineProperty(proto, name, {
    ...desc,
    get(this: object) {
      try {
        const value = get.call(this);
        rememberLastGood(this, name, value);
        return value;
      } catch (err) {
        if (!isNullPieceError(err)) throw err;
        swallowed += 1;
        const prev = lastGood.get(this)?.get(name);
        return prev === undefined ? fallback : prev;
      }
    },
  });
}

/**
 * Replaces `get downloaded` with a total version of the same computation.
 *
 * The upstream getter (`torrent.js:219`) is:
 *
 *   if (this.bitfield.get(index)) downloaded += pieceLength
 *   else                          downloaded += piece.length - piece.missing
 *
 * and `_markVerified` (`torrent.js:872`) does:
 *
 *   this.pieces[index] = null      // ← nulled first
 *   this.bitfield.set(index, true) // ← bitfield set second
 *
 * so there is a window on *every* verified piece where the piece is null and
 * the bitfield still says false, and the getter throws. `progress`,
 * `timeRemaining` and the tracker's `left` all delegate here.
 *
 * Swallowing that throw and returning the last good value was worse than the
 * crash it replaced: because the throw recurs on essentially every read once a
 * torrent starts verifying pieces, the number froze. Measured on a real
 * download: reported 69.92% and never moved for 60s while the bitfield said
 * 51.86% — a progress bar and ETA that are confidently, permanently wrong.
 *
 * Skipping the nulled piece instead is exact. A piece that is null while its
 * bit is unset has just been verified, so the true contribution is a whole
 * piece; counting 0 under-reports by at most one piece for the microseconds
 * until `bitfield.set` runs on the very next line.
 */
function replaceDownloadedGetter(proto: TorrentTotals): boolean {
  const desc = Object.getOwnPropertyDescriptor(proto, "downloaded");
  if (!desc?.get) return false;
  Object.defineProperty(proto, "downloaded", {
    ...desc,
    get(this: TorrentTotals) {
      const bitfield = this.bitfield;
      const pieces = this.pieces;
      if (!bitfield || !pieces) return 0;
      let downloaded = 0;
      const len = pieces.length;
      for (let index = 0; index < len; index++) {
        if (bitfield.get(index)) {
          downloaded +=
            index === len - 1
              ? (this.lastPieceLength ?? 0)
              : (this.pieceLength ?? 0);
          continue;
        }
        const piece = pieces[index];
        if (piece) downloaded += piece.length - piece.missing;
      }
      return downloaded;
    },
  });
  return true;
}

type TorrentTotals = {
  bitfield?: { get: (i: number) => boolean };
  pieces?: Array<{ length: number; missing: number } | null>;
  pieceLength?: number;
  lastPieceLength?: number;
};

/**
 * `_request(wire, index, hotswap)` reads `self.pieces[index]` and immediately
 * calls `.reserve()` on it (`torrent.js:1941`). Nothing upstream re-checks that
 * the piece survived: the scheduler walks pieces the peer advertises, and on a
 * half-complete torrent roughly half of those are already verified and
 * therefore nulled.
 *
 * Catching the resulting TypeError is correct but ruinously expensive — a real
 * 50%-complete download threw **513,000 times in 70 seconds** (~7,300/s), and
 * V8 pays stack capture on every one, on the same event loop that serves the
 * UI. Checking for null first costs one property read and removes the throw
 * entirely; the `try/catch` in {@link wrap} stays as a backstop for the races
 * this cannot see (the piece can still be nulled inside the original call).
 *
 * Returning false is what the original does when a piece has nothing left to
 * reserve, so callers already handle it: they move on to the next piece.
 *
 * A null piece means one of two things, and they need opposite handling:
 *
 *  - **bit set** — the piece is verified and complete. Nothing to request.
 *  - **bit unset** — the piece has *leaked*. This is not a race: `_markVerified`
 *    (torrent.js:872-875) nulls the piece and sets the bit on adjacent
 *    synchronous lines, so single-threaded JS can never observe the gap. The
 *    entry is simply stuck — the scheduler will skip it forever, and the
 *    torrent plateaus below 100% with peers connected and zero throughput.
 *    Measured on a fresh 276 MB torrent: 328 of 1055 pieces leaked this way.
 *
 * Upstream's own repair for an unusable piece is `_markUnverified` — it
 * reinstates a fresh `Piece` of the right length, clears the bit (already
 * clear here) and re-selects the range so the scheduler asks for it again.
 * Reusing it keeps piece-length and selection logic in one place. If it is
 * ever renamed, we fall back to skipping, which is today's behaviour.
 */
function guardRequest(proto: TorrentProto): void {
  const original = proto._request;
  if (typeof original !== "function") return;
  const fn = original as (this: unknown, ...args: unknown[]) => unknown;
  proto._request = function patchedRequest(
    this: {
      pieces?: Array<unknown>;
      bitfield?: { get(i: number): boolean };
      _markUnverified?: (i: number) => void;
    },
    ...args: unknown[]
  ) {
    const index = args[1] as number;
    const pieces = this?.pieces;
    if (pieces && pieces[index] == null) {
      if (this.bitfield?.get(index) !== false) return false;
      if (typeof this._markUnverified !== "function") return false;
      this._markUnverified(index);
      repairedPieces += 1;
      if (this.pieces?.[index] == null) return false;
    }
    try {
      return fn.apply(this, args);
    } catch (err) {
      if (!isNullPieceError(err)) throw err;
      swallowed += 1;
      return false;
    }
  };
}
export function patchTorrentPieceRace(torrentPrototype: object): void {
  const proto = torrentPrototype as TorrentProto;
  if (proto[PATCHED as unknown as string]) return;
  Object.defineProperty(proto, PATCHED, { value: true, enumerable: false });

  // `_request` returns a boolean meaning "a block was requested". The null
  // piece is checked up front rather than caught — see guardRequest.
  guardRequest(proto);
  // `_updateWire` returns nothing meaningful; the scheduler re-runs it.
  wrap(proto, "_updateWire", () => undefined);

  // `downloaded` is fixed rather than swallowed, so `progress` and
  // `timeRemaining` — which both delegate to it — become correct for free.
  replaceDownloadedGetter(proto as TorrentTotals);

  // `numPeers` reads `wires.length`, which is nulled on destroy. There is no
  // meaningful value to compute there, so the last-good guard still applies.
  wrapGetter(proto, "numPeers", 0);
}

/**
 * Resolves the Torrent prototype from a live client and patches it. Returns
 * whether the patch was applied, so the caller can log a miss if WebTorrent's
 * internals ever move.
 */
export async function patchWebTorrentPieceRace(): Promise<boolean> {
  try {
    // Deep import: webtorrent has no `exports` map, and the Torrent class is
    // not reachable from the package entry point. No types ship for it.
    const mod: unknown = await import(
      /* webpackIgnore: true */ "webtorrent/lib/torrent.js"
    );
    const Ctor = (mod as { default?: unknown }).default ?? mod;
    const proto = (Ctor as { prototype?: object })?.prototype;
    if (!proto) return false;
    patchTorrentPieceRace(proto);
    return true;
  } catch {
    return false;
  }
}
