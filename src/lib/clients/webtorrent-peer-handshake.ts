/**
 * Guards WebTorrent 3.0.16's `Peer.prototype.handshake` against a gone swarm.
 *
 * An incoming peer can finish its handshake after the torrent it targets was
 * destroyed (a queue park, a delete, a completed download being parked). The
 * peer's `swarm` is then null or destroyed and
 *
 *   lib/peer.js:201  this.swarm.private  -> "Cannot read properties of null (reading 'private')"
 *
 * throws from a socket callback as an uncaught exception, taking the process
 * down. There is nothing left to handshake with, so the patched method
 * destroys the peer instead.
 */

type PeerProto = Record<string, unknown>;

type PeerLike = {
  swarm?: { destroyed?: boolean } | null;
  destroyed?: boolean;
  destroy?: (err?: Error) => void;
};

const PATCHED = Symbol.for("torrentflow.peerHandshakePatched");

export function patchPeerHandshake(peerPrototype: object): boolean {
  const proto = peerPrototype as PeerProto;
  if (proto[PATCHED as unknown as string]) return true;
  const original = proto.handshake;
  if (typeof original !== "function") return false;
  const fn = original as (this: unknown, ...args: unknown[]) => unknown;
  proto.handshake = function guardedHandshake(this: PeerLike, ...args: unknown[]) {
    const swarm = this.swarm;
    if (!swarm || swarm.destroyed) {
      if (!this.destroyed) {
        try {
          this.destroy?.(new Error("swarm already destroyed"));
        } catch {
          /* best-effort */
        }
      }
      return undefined;
    }
    return fn.apply(this, args);
  };
  Object.defineProperty(proto, PATCHED, { value: true, enumerable: false });
  return true;
}

export async function patchWebTorrentPeerHandshake(): Promise<boolean> {
  try {
    const mod: unknown = await import(
      /* webpackIgnore: true */ "webtorrent/lib/peer.js"
    );
    const m = mod as { default?: unknown; Peer?: unknown };
    const candidate = (m.default ?? mod) as { Peer?: unknown; prototype?: object };
    const Ctor = (m.Peer ?? candidate.Peer ?? candidate) as { prototype?: object };
    const proto = Ctor?.prototype;
    if (!proto || typeof (proto as PeerProto).handshake !== "function") return false;
    return patchPeerHandshake(proto);
  } catch {
    return false;
  }
}
