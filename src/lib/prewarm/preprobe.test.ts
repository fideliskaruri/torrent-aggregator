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
import {
  preProbeUpcoming,
  normalizePreProbeScope,
  resolvePreProbeScope,
  DEFAULT_PREPROBE_SCOPE,
} from "./preprobe";
import { upcomingTargets } from "./prerank";

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

    await checkAsync("scope resolution: null and unknown default to 'watching'", async () => {
      assert.equal(normalizePreProbeScope(null), "watching");
      assert.equal(normalizePreProbeScope(undefined), "watching");
      assert.equal(normalizePreProbeScope("bogus"), "watching");
      assert.equal(DEFAULT_PREPROBE_SCOPE, "watching");
      // Known values pass through unchanged.
      assert.equal(normalizePreProbeScope("off"), "off");
      assert.equal(normalizePreProbeScope("monitored"), "monitored");
    });

    await checkAsync("scope is read from ClientSettings; a missing row is 'watching'", async () => {
      const fakeDb = (scope: string | null) =>
        ({
          clientSettings: {
            findUnique: async () =>
              scope === null ? null : { preProbeScope: scope },
          },
        }) as unknown as typeof prisma;
      assert.equal(await resolvePreProbeScope("u", fakeDb("monitored")), "monitored");
      assert.equal(await resolvePreProbeScope("u", fakeDb("off")), "off");
      // No row stored → the middle default, not off.
      assert.equal(await resolvePreProbeScope("u", fakeDb(null)), "watching");
    });

    await checkAsync("scope 'off' disables the pass — no targets, no probe", async () => {
      let probeCalls = 0;
      const res = await preProbeUpcoming("someone", {
        db: prisma,
        scope: "off",
        _foregroundActive: () => false,
        _targets: [{ title: "Zzqx Show", mediaType: "movie" }],
        _poolFor: async () => {
          throw new Error("pool was read while scope was off");
        },
        _probeFn: async () => {
          probeCalls += 1;
          return null;
        },
      });
      assert.equal(res.skipped, "disabled");
      assert.equal(res.scope, "off");
      assert.equal(probeCalls, 0, "scope off must not probe anything");
    });

    await checkAsync("scope maps to tiers: 'watching' excludes monitored+watchlist", async () => {
      // A fake db that counts how many times the watchlist table is queried.
      // The "watching" tier only touches playbackProgress (and watchListItem
      // *only* to resolve titles when there are watching rows — none here), so
      // a watching-scoped pass must never query watchListItem.
      let watchListQueries = 0;
      const makeDb = () =>
        ({
          playbackProgress: { findMany: async () => [] },
          watchListItem: {
            findMany: async () => {
              watchListQueries += 1;
              return [];
            },
          },
        }) as unknown as typeof prisma;

      watchListQueries = 0;
      await upcomingTargets("u", { db: makeDb(), sources: ["watching"] });
      assert.equal(
        watchListQueries,
        0,
        "'watching' scope must not reach into monitored or watchlist",
      );

      watchListQueries = 0;
      await upcomingTargets("u", {
        db: makeDb(),
        sources: ["watching", "monitored", "watchlist"],
      });
      assert.equal(
        watchListQueries,
        2,
        "'monitored' scope queries both the monitored and watchlist tiers",
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
