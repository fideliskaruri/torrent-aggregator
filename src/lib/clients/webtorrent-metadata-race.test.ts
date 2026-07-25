/**
 * `_onMetadata` must run once per torrent.
 *
 * Upstream's guard (`if (this.metadata || this.destroyed) return`) sits in an
 * `async` method that does not set `this.metadata` until after an `await`, so
 * peers answering at the same time all get through and each one rebuilds the
 * torrent's pieces and bitfield from scratch. These tests pin the latch that
 * closes that window.
 */
import assert from "node:assert/strict";
import {
  dedupedMetadataInits,
  patchTorrentMetadataRace,
  resetDedupedMetadataInits,
} from "@/lib/clients/webtorrent-metadata-race";

let failures = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  ✗ ${name}: ${(err as Error).message}`);
  }
}

type Host = {
  metadata?: unknown;
  destroyed?: boolean;
  _onMetadata(m?: unknown): unknown;
};

/**
 * Mimics upstream: async, and only sets `this.metadata` after yielding — the
 * exact shape that makes the guard ineffective.
 */
function makeTorrent(opts: { reject?: boolean } = {}) {
  let inits = 0;
  const proto = {
    async _onMetadata(this: Host) {
      if (this.metadata || this.destroyed) return;
      await Promise.resolve();
      if (opts.reject) throw new Error("parse failed");
      inits += 1;
      this.metadata = { ok: true };
    },
  };
  const patched = patchTorrentMetadataRace(proto);
  const t = Object.create(proto) as Host;
  return { t, patched, inits: () => inits };
}

async function main() {
  console.log("metadata initialisation must happen once…");

  await check("concurrent peers collapse to a single initialisation", async () => {
  resetDedupedMetadataInits();
  const { t, inits } = makeTorrent();
  await Promise.all([
    t._onMetadata("a"),
    t._onMetadata("b"),
    t._onMetadata("c"),
    t._onMetadata("d"),
  ]);
  assert.equal(inits(), 1, "the torrent was rebuilt more than once");
  assert.equal(dedupedMetadataInits(), 3);
});

  await check("a later peer is ignored once metadata is set", async () => {
  const { t, inits } = makeTorrent();
  await t._onMetadata("a");
  await t._onMetadata("b");
  assert.equal(inits(), 1);
});

  await check("a rejecting call releases the latch so a retry gets through", async () => {
  const failing = makeTorrent({ reject: true });
  await assert.rejects(() => failing.t._onMetadata("a") as Promise<unknown>);
  // The latch must be clear, otherwise the torrent can never get metadata.
  await assert.rejects(() => failing.t._onMetadata("b") as Promise<unknown>);
});

  await check("a destroyed torrent does nothing and is not counted", async () => {
  resetDedupedMetadataInits();
  const { t, inits } = makeTorrent();
  t.destroyed = true;
  await t._onMetadata("a");
  assert.equal(inits(), 0);
  assert.equal(dedupedMetadataInits(), 0, "a destroyed torrent is not a dedupe");
});

  await check("patching twice leaves one wrapper", () => {
  const proto = { _onMetadata() {} };
  assert.equal(patchTorrentMetadataRace(proto), true);
  const first = proto._onMetadata;
  assert.equal(patchTorrentMetadataRace(proto), true);
  assert.equal(proto._onMetadata, first);
});

  await check("a prototype without _onMetadata is tolerated", () => {
  assert.equal(patchTorrentMetadataRace({ foo: 1 }), false);
});

}

main().then(() => {
if (failures > 0) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
}
console.log("\nAll metadata-race tests passed.");
});
