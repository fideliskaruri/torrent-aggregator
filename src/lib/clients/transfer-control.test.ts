/**
 * Pause has to stop the transfer, not just claim to.
 *
 * `torrent.pause()` upstream sets `paused = true` and returns
 * (webtorrent/lib/torrent.js:2078). That flag is only read on the peer
 * *acquisition* paths — `_addPeer`, the inbound handler and `_drain`. The
 * request pump `_update` → `_updateWireWrapper` → `_updateWire`
 * (torrent.js:1580-1602) never looks at it, so already-connected peers carry on
 * downloading and uploading while the UI shows "Paused".
 *
 * These tests pin the two halves of the fix: pausing closes the connections,
 * and resuming goes and gets new ones instead of waiting on the next tracker
 * interval.
 */
import assert from "node:assert/strict";
import {
  haltTransfer,
  resumeTransfer,
  type PausableTorrent,
} from "@/lib/clients/transfer-control";

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  ✗ ${name}: ${(err as Error).message}`);
  }
}

type FakePeer = { id: string; destroyed: boolean; destroy: (err?: Error) => void };
type FakeWire = { destroyed: boolean; destroy: () => void };

/**
 * Mirrors the real object closely enough to matter: `pause()` only sets the
 * flag, and `peer.destroy()` removes itself from both `_peers` and `wires`
 * exactly as `lib/peer.js:231` does — which is why the production code has to
 * snapshot before iterating.
 */
function makeTorrent(peerCount: number, webSeedCount = 0) {
  const announces: string[] = [];
  const t: PausableTorrent & { _peers: Map<string, FakePeer>; wires: FakeWire[] } = {
    infoHash: "aabbccddeeff00112233445566778899aabbccdd",
    destroyed: false,
    paused: false,
    _peers: new Map<string, FakePeer>(),
    wires: [] as FakeWire[],
    pause() {
      t.paused = true;
    },
    resume() {
      t.paused = false;
      announces.push("drain");
    },
    discovery: {
      tracker: {
        update() {
          announces.push("tracker.update");
        },
      },
      dht: {
        lookup(hash: string) {
          announces.push(`dht.lookup:${hash}`);
        },
      },
    },
  };

  for (let i = 0; i < peerCount; i++) {
    const wire: FakeWire = { destroyed: false, destroy: () => { wire.destroyed = true; } };
    const peer: FakePeer = {
      id: `peer-${i}`,
      destroyed: false,
      destroy() {
        peer.destroyed = true;
        wire.destroy();
        // lib/peer.js:251,258 — the peer removes its own wire and itself.
        const at = t.wires.indexOf(wire);
        if (at >= 0) t.wires.splice(at, 1);
        t._peers.delete(peer.id);
      },
    };
    t._peers.set(peer.id, peer);
    t.wires.push(wire);
  }

  // Web seeds live in `wires` with no entry in `_peers`.
  for (let i = 0; i < webSeedCount; i++) {
    const wire: FakeWire = { destroyed: false, destroy: () => { wire.destroyed = true; } };
    t.wires.push(wire);
  }

  return { t, announces };
}

console.log("transfer-control");

check("pause closes every peer connection, not just the flag", () => {
  const { t } = makeTorrent(5);
  const before = Array.from(t._peers.values());

  const result = haltTransfer(t);

  assert.equal(t.paused, true, "flag should still be set");
  assert.equal(result.peersDestroyed, 5);
  assert.ok(
    before.every((p) => p.destroyed),
    "every peer must be destroyed — a live wire keeps downloading while paused",
  );
  assert.equal(t.wires.length, 0, "no wire may survive a pause");
});

check("pause tears down web seeds that have no peer object", () => {
  const { t } = makeTorrent(2, 3);

  const result = haltTransfer(t);

  assert.equal(result.peersDestroyed, 2);
  assert.equal(result.wiresDestroyed, 3, "the three web seeds need the wire sweep");
  assert.ok(
    t.wires.every((w) => w.destroyed),
    "web seeds keep transferring unless their wire is destroyed",
  );
});

check("pause sets the flag before dropping peers", () => {
  // A peer discovered mid-teardown must be rejected by _addPeer on arrival,
  // which only happens if `paused` is already true.
  const seen: boolean[] = [];
  const { t } = makeTorrent(3);
  for (const peer of Array.from(t._peers.values()) as FakePeer[]) {
    const inner = peer.destroy;
    peer.destroy = (err?: Error) => {
      seen.push(t.paused === true);
      inner(err);
    };
  }

  haltTransfer(t);

  assert.ok(seen.length === 3 && seen.every(Boolean), "paused must be true throughout teardown");
});

check("pause survives a peer whose destroy throws", () => {
  const { t } = makeTorrent(3);
  const peers = Array.from(t._peers.values());
  peers[1].destroy = () => {
    throw new Error("socket already gone");
  };

  haltTransfer(t);

  assert.ok(peers[0].destroyed, "a later failure must not skip earlier peers");
  assert.ok(peers[2].destroyed, "an earlier failure must not abort the sweep");
});

check("pause is a no-op on a destroyed torrent", () => {
  const { t } = makeTorrent(2);
  t.destroyed = true;

  const result = haltTransfer(t);

  assert.deepEqual(result, { peersDestroyed: 0, wiresDestroyed: 0 });
});

check("pause then resume leaves the torrent unpaused", () => {
  const { t } = makeTorrent(4);
  haltTransfer(t);
  resumeTransfer(t);
  assert.equal(t.paused, false);
});

check("resume re-announces instead of waiting for the tracker interval", () => {
  const { t, announces } = makeTorrent(4);
  haltTransfer(t);
  announces.length = 0;

  resumeTransfer(t);

  assert.ok(
    announces.includes("tracker.update"),
    "pausing emptied the peer queue, so resume must ask the tracker for peers",
  );
  assert.ok(
    announces.some((a) => a.startsWith("dht.lookup:")),
    "the DHT is the fallback when trackers are unreachable",
  );
});

check("resume re-selects files before any peer can arrive", () => {
  const { t, announces } = makeTorrent(1);
  haltTransfer(t);
  announces.length = 0;
  const order: string[] = [];

  resumeTransfer(t, () => order.push("select"));

  order.push(...announces);
  assert.equal(order[0], "select", "selection must precede resume and the announce");
  assert.ok(order.indexOf("tracker.update") > order.indexOf("select"));
});

check("resume survives a torrent with no discovery attached", () => {
  const { t } = makeTorrent(1);
  t.discovery = null;
  resumeTransfer(t);
  assert.equal(t.paused, false);
});

check("resume is a no-op on a destroyed torrent", () => {
  const { t, announces } = makeTorrent(1);
  t.destroyed = true;
  resumeTransfer(t);
  assert.equal(announces.length, 0);
});

if (failures > 0) {
  console.error(`\n${failures} transfer-control test(s) failed`);
  process.exit(1);
}
console.log("transfer-control: all passed\n");
