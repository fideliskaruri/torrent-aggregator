/**
 * Speculative pre-probe tests.
 *
 * WHAT THESE ARE GUARDING
 * -----------------------
 * The one invariant that must never regress: **probing is speculative work and
 * must never compete with a viewer.** When a foreground stream is active the
 * pass does nothing at all — no pool read, no probe. The engine's upload
 * throttle already yields to the foreground; a probe that opened connections
 * behind its back would defeat the point.
 *
 * The rest of the pass is bounded and observable: it probes at most the top few
 * candidates of the top few targets, skips anything with a fresh verdict, and
 * skips anything already live.
 *
 * Run: node node_modules/tsx/dist/cli.mjs src/lib/prewarm/preprobe.test.ts
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import prisma from "@/lib/prisma";
import type { TorrentResult } from "@/lib/torrents/types";
import { preProbeUpcoming } from "./preprobe";

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
    magnet: `magnet:?xt=urn:btih:${hash}`,
    infoHash: hash,
    sizeBytes: 1_400_000_000,
    seeders: 40,
    leechers: 3,
    source: "apibay",
    sourceUrl: "https://example.invalid",
    tags: [],
    ...over,
  } as TorrentResult;
}

async function main(): Promise<void> {
  console.log("prewarm pre-probe\n");

  try {
    await checkAsync("a foreground stream stops the pass dead — no probe runs", async () => {
      let probeCalls = 0;
      const res = await preProbeUpcoming("nobody", {
        db: prisma,
        _foregroundActive: () => true,
        _probeFn: async () => {
          probeCalls += 1;
          return null;
        },
        _poolFor: async () => {
          throw new Error("pool was read while a viewer was active");
        },
      });
      assert.equal(res.skipped, "foreground");
      assert.equal(probeCalls, 0, "no probe may run while the user is watching");
    });

    await checkAsync("the top candidates get probed, live ones skipped, capped", async () => {
      const live = result({ title: "Live download" });
      const a = result({ title: "A" });
      const b = result({ title: "B" });
      const c = result({ title: "C" }); // beyond the cap of 3 (live+a+b)
      const d = result({ title: "D" });

      const probed: string[] = [];
      const res = await preProbeUpcoming("someone", {
        db: prisma,
        limitTargets: 1,
        limitCandidates: 3,
        _foregroundActive: () => false,
        _targets: [{ title: "Zzqx Show", mediaType: "movie" }],
        _findLive: (h) => (h === live.infoHash ? ({} as unknown) : null),
        _poolFor: async () => [live, a, b, c, d],
        _probeFn: async (input) => {
          probed.push(input.infoHash ?? "");
          return {
            infoHash: input.infoHash ?? "",
            peersConnected: 3,
            peersUnchoked: 2,
            bytesReceived: 10_000_000,
            elapsedMs: 8000,
            effectiveBps: 5_000_000,
            requiredBps: 1_000_000,
            verdict: "good",
            measuredAt: Date.now(),
            fromLiveDownload: false,
          };
        },
      });

      assert.deepEqual(
        res.skippedLive,
        [live.infoHash],
        "a live download is skipped, never probed",
      );
      // The cap is on candidates *considered* (live + a + b), and the live one
      // is then skipped — so a and b are probed, c and d are beyond the cap.
      assert.deepEqual(
        probed,
        [a.infoHash, b.infoHash],
        "only the non-live candidates within the top-3 cap are probed",
      );
      assert.ok(
        !probed.includes(live.infoHash!),
        "the live download must never be probed",
      );
      assert.ok(
        !probed.includes(c.infoHash!) && !probed.includes(d.infoHash!),
        "candidates beyond the cap are never probed",
      );
    });
  } finally {
    await prisma.$disconnect();
  }

  console.log(
    failures === 0
      ? "\nPASS — pre-probe yields to the viewer and stays bounded"
      : `\nFAIL — ${failures} failing check(s)`,
  );
  process.exit(failures ? 1 : 0);
}

void main();
