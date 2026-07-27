/**
 * Season acquisition orchestration tests.
 *
 * The pure planner is tested exhaustively in `season-plan.test.ts`. These
 * guard the *feeding* layer's two non-negotiable rules, both proven RED first:
 *
 *   1. Speculative probing must never compete with a viewer (`foregroundActive`).
 *   2. A live download is never probed — the guard that protects a user's real
 *      files, applied before we even queue a probe.
 *
 * They use the real Prisma verdict store (empty → everything reads `unknown`,
 * which is the neutral default) but inject the probe, live-check and foreground
 * signals so no swarm is ever touched.
 *
 * Run: node node_modules/tsx/dist/cli.mjs src/lib/library/season-acquire.test.ts
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import prisma from "@/lib/prisma";
import { resolveSeasonPlan, seasonSearchQuery } from "./season-acquire";
import type { TorrentResult } from "@/lib/torrents/types";

let failures = 0;

async function checkAsync(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}: ${(err as Error).message}`);
  }
}

function result(over: Partial<TorrentResult> & { title: string }): TorrentResult {
  const hash = over.infoHash ?? createHash("sha1").update(randomUUID()).digest("hex");
  return {
    id: randomUUID(),
    magnet: `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(over.title)}`,
    infoHash: hash,
    sizeBytes: 1_400_000_000,
    seeders: 30,
    leechers: 3,
    source: "apibay",
    sourceUrl: "https://example.invalid",
    tags: [],
    episode: { isSeasonPack: true } as TorrentResult["episode"],
    ...over,
  } as TorrentResult;
}

async function main(): Promise<void> {
  console.log("season acquisition orchestration\n");

  await checkAsync("seasonSearchQuery pads the season", () => {
    assert.equal(seasonSearchQuery("The Bear", 1), "The Bear S01");
    return Promise.resolve();
  });

  await checkAsync("a viewer is active → resolve probes nothing", async () => {
    // RED check: removing the `!isForeground()` gate lets the probe run while
    // someone is watching — the exact contention the whole subsystem yields to.
    let probeCalled = false;
    const pack = result({ title: "The Show S01 COMPLETE" });
    const res = await resolveSeasonPlan(
      { userId: `u_${randomUUID()}`, title: "The Show", mediaType: "tv", season: 1, episodes: [1, 2] },
      {
        _releases: [pack],
        _foregroundActive: () => true,
        _findLive: () => null,
        _probeFn: (async () => {
          probeCalled = true;
          return null;
        }) as never,
      },
    );
    assert.equal(probeCalled, false, "probe must not run while foreground is active");
    assert.deepEqual(res.probed, []);
    // The plan is still built from cached verdicts (all unknown → pack eligible).
    assert.ok(res.plan.pack, "unknown pack stays eligible with no probe");
  });

  await checkAsync("a live download is never probed while resolving", async () => {
    // RED check: dropping the `findLive(hash)` skip queues a probe against a
    // hash the engine already holds as a real download.
    const livePack = result({ title: "The Show S01 COMPLETE LIVE" });
    const liveHash = livePack.infoHash!.toLowerCase();
    const probedHashes: string[] = [];
    const res = await resolveSeasonPlan(
      { userId: `u_${randomUUID()}`, title: "The Show", mediaType: "tv", season: 1, episodes: [1, 2] },
      {
        _releases: [livePack],
        _foregroundActive: () => false,
        _findLive: (h) => (h === liveHash ? { infoHash: liveHash } : null),
        _probeFn: (async (input: { infoHash?: string | null }) => {
          probedHashes.push(input.infoHash ?? "");
          return null;
        }) as never,
      },
    );
    assert.equal(
      probedHashes.includes(liveHash),
      false,
      "a live download must never be probed",
    );
    assert.deepEqual(res.probed, []);
  });

  await checkAsync("resolve caps the number of synchronous probes", async () => {
    const packs = Array.from({ length: 6 }, (_, i) =>
      result({ title: `The Show S01 COMPLETE v${i}` }),
    );
    let calls = 0;
    const res = await resolveSeasonPlan(
      { userId: `u_${randomUUID()}`, title: "The Show", mediaType: "tv", season: 1, episodes: [1, 2] },
      {
        _releases: packs,
        maxProbes: 2,
        _foregroundActive: () => false,
        _findLive: () => null,
        _probeFn: (async () => {
          calls += 1;
          return null;
        }) as never,
      },
    );
    assert.equal(calls, 2, "must not exceed maxProbes");
    assert.equal(res.probed.length, 2);
  });

  console.log(
    failures === 0
      ? "\nPASS — season orchestration yields to viewers and never probes a live download"
      : `\nFAIL — ${failures} failing check(s)`,
  );
  process.exit(failures ? 1 : 0);
}

void main().finally(async () => {
  await prisma.$disconnect();
});
