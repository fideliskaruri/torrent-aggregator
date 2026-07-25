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
 * Idempotent — the prototype is shared process-wide and `getWtClient` may run
 * more than once across a dev hot reload.
 */
export function patchTorrentPieceRace(torrentPrototype: object): void {
  const proto = torrentPrototype as TorrentProto;
  if (proto[PATCHED as unknown as string]) return;
  Object.defineProperty(proto, PATCHED, { value: true, enumerable: false });

  // `_request` returns a boolean meaning "a block was requested". Reporting
  // false makes its callers move on to the next piece, which is what we want.
  wrap(proto, "_request", () => false);
  // `_updateWire` returns nothing meaningful; the scheduler re-runs it.
  wrap(proto, "_updateWire", () => undefined);

  // Getters reached from timers rather than from wires. `downloaded` is read by
  // the tracker announce every ~30s per torrent; `numPeers` reads `wires.length`
  // which is nulled on destroy.
  wrapGetter(proto, "downloaded", 0);
  wrapGetter(proto, "progress", 0);
  wrapGetter(proto, "timeRemaining", Infinity);
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
