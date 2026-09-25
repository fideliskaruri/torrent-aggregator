import assert from "node:assert/strict";

import {
  patchPeerHandshake,
  patchWebTorrentPeerHandshake,
} from "./webtorrent-peer-handshake";

async function main() {
  const mod = (await import("webtorrent/lib/peer.js")) as unknown as {
    default: { prototype: Record<string, unknown> };
  };
  const proto = mod.default.prototype;

  const makePeer = (swarm: unknown) => {
    const destroyed: unknown[] = [];
    const peer = Object.create(proto) as Record<string, unknown>;
    Object.assign(peer, {
      swarm,
      destroyed: false,
      wire: { handshake: () => { throw new Error("must not handshake"); } },
      destroy(err: unknown) {
        destroyed.push(err);
        this.destroyed = true;
      },
    });
    return { peer, destroyed };
  };

  // Unpatched 3.0.16 really throws on the null swarm — the crash we guard.
  {
    const { peer } = makePeer(null);
    assert.throws(
      () => (proto.handshake as () => void).call(peer),
      /reading 'private'/,
    );
  }

  assert.equal(await patchWebTorrentPeerHandshake(), true);
  // Idempotent.
  assert.equal(patchPeerHandshake(proto), true);
  const once = proto.handshake;
  patchPeerHandshake(proto);
  assert.equal(proto.handshake, once);

  for (const swarm of [null, { destroyed: true }]) {
    const { peer, destroyed } = makePeer(swarm);
    assert.doesNotThrow(() => (proto.handshake as () => void).call(peer));
    assert.equal(destroyed.length, 1, "peer destroyed when swarm is gone");
  }

  // A live swarm still handshakes normally.
  {
    let sent: unknown[] = [];
    const { peer } = makePeer({
      destroyed: false,
      private: false,
      infoHash: "ab",
      client: { dht: {}, peerId: "me" },
    });
    peer.wire = { handshake: (...args: unknown[]) => { sent = args; } };
    (proto.handshake as () => void).call(peer);
    assert.equal(sent[0], "ab");
    assert.equal(peer.sentHandshake, true);
  }
  console.log("PASS webtorrent peer handshake guard");
}

main().catch((err) => {
  console.error("FAIL webtorrent peer handshake guard", err);
  process.exit(1);
});
