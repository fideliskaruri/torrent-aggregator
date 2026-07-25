/**
 * Stops a dead peer socket from taking down the process.
 *
 * A socket is an EventEmitter, and an `error` event with no listener is
 * rethrown by Node as an uncaughtException. WebTorrent registers its handler
 * with `once`:
 *
 *   lib/torrent.js:2134  conn.once('error', err => { ...; peer.destroy(err) })
 *
 * so it hears the *first* error and nothing after it. utp-native routinely
 * emits a second one — the peer resets while the teardown from the first is
 * still in flight — and that one escapes as:
 *
 *   ⨯ uncaughtException: Error: UTP_ECONNRESET { code: 'UTP_ECONNRESET' }
 *
 * Incoming connections are worse: `lib/conn-pool.js:_onConnection` attaches no
 * lasting `error` listener at all except on the early-return path, so any error
 * on an accepted socket is unhandled from the start.
 *
 * A peer connection failing is not an application error — there are thousands
 * of them in a normal session and WebTorrent already retries with backoff. So
 * we attach a permanent listener to every peer socket. It does not replace
 * WebTorrent's own handling: EventEmitter runs every listener, so its `once`
 * still fires and still destroys the peer. Ours only ensures the event is never
 * *unhandled*.
 *
 * This is deliberately scoped to peer sockets. Nothing here touches the process
 * level, so a genuine bug anywhere else still crashes loudly.
 */

type Proto = Record<string, unknown>;

const PATCHED = Symbol.for("torrentflow.connErrorsPatched");

let absorbed = 0;

/** Peer-socket errors swallowed, so a health check can notice a spike. */
export function absorbedConnErrors(): number {
  return absorbed;
}

/** For tests. */
export function resetAbsorbedConnErrors(): void {
  absorbed = 0;
}

type ErrorEmitter = {
  on?: (event: string, fn: (err: unknown) => void) => unknown;
};

const GUARDED = new WeakSet<object>();

/** Idempotent per socket — `_drain` may be re-entered for the same peer. */
export function guardConn(conn: unknown): void {
  if (!conn || typeof conn !== "object") return;
  if (GUARDED.has(conn)) return;
  const on = (conn as ErrorEmitter).on;
  if (typeof on !== "function") return;
  GUARDED.add(conn);
  on.call(conn, "error", () => {
    absorbed += 1;
  });
}

function patchDrain(proto: Proto): void {
  const original = proto._drain;
  if (typeof original !== "function") return;
  const fn = original as (this: unknown) => unknown;
  proto._drain = function patchedDrain(this: {
    _queue?: Array<{ conn?: unknown }>;
  }) {
    // `_drain` shifts this peer off the queue and assigns `peer.conn`, so read
    // the reference before the call and inspect it after.
    const peer = Array.isArray(this?._queue) ? this._queue[0] : undefined;
    const result = fn.call(this);
    if (peer?.conn) guardConn(peer.conn);
    return result;
  };
}

function patchIncoming(proto: Proto): void {
  const original = proto._onConnection;
  if (typeof original !== "function") return;
  const fn = original as (this: unknown, conn: unknown, type: string) => unknown;
  proto._onConnection = function patchedOnConnection(
    this: unknown,
    conn: unknown,
    type: string,
  ) {
    // Guard before the original runs: it can destroy the socket synchronously.
    guardConn(conn);
    return fn.call(this, conn, type);
  };
}

/**
 * Patches both peer-socket seams. Returns whether each one was found, so the
 * caller can log if a webtorrent upgrade moves them.
 */
export async function patchWebTorrentConnErrors(): Promise<{
  outgoing: boolean;
  incoming: boolean;
}> {
  const result = { outgoing: false, incoming: false };

  try {
    const mod: unknown = await import(
      /* webpackIgnore: true */ "webtorrent/lib/torrent.js"
    );
    const Ctor = (mod as { default?: unknown }).default ?? mod;
    const proto = (Ctor as { prototype?: object })?.prototype;
    if (proto && !(proto as Proto)[PATCHED as unknown as string]) {
      Object.defineProperty(proto, PATCHED, { value: true, enumerable: false });
      patchDrain(proto as Proto);
      result.outgoing = typeof (proto as Proto)._drain === "function";
    } else if (proto) {
      result.outgoing = true;
    }
  } catch {
    /* reported as false */
  }

  try {
    const mod: unknown = await import(
      /* webpackIgnore: true */ "webtorrent/lib/conn-pool.js"
    );
    const Ctor = (mod as { default?: unknown }).default ?? mod;
    const proto = (Ctor as { prototype?: object })?.prototype;
    if (proto && !(proto as Proto)[PATCHED as unknown as string]) {
      Object.defineProperty(proto, PATCHED, { value: true, enumerable: false });
      patchIncoming(proto as Proto);
      result.incoming = typeof (proto as Proto)._onConnection === "function";
    } else if (proto) {
      result.incoming = true;
    }
  } catch {
    /* reported as false */
  }

  return result;
}
