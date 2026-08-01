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
import { prisma } from "@/lib/prisma";
import type { TorrentResult } from "@/lib/torrents/types";
import {
  preProbeUpcoming,
  normalizePreProbeScope,
  resolvePreProbeScope,
  DEFAULT_PREPROBE_SCOPE,
  MAX_PREPROBE_CONCURRENCY,
} from "./preprobe";
import { upcomingTargets } from "./prerank";
import { recordSwarmMeasurement } from "@/lib/torrents/swarm-probe";
import { markForegroundActive, releaseForeground } from "./foreground";

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

    await checkAsync("foreground playback aborts an active speculative probe", async () => {
      const candidate = result({ title: "Probe interrupted by playback" });
      releaseForeground();
      try {
        const res = await preProbeUpcoming("someone", {
          db: prisma,
          limitTargets: 1,
          limitCandidates: 1,
          _foregroundActive: () => false,
          _targets: [{ title: "Target", mediaType: "movie" }],
          _findLive: () => null,
          _poolFor: async () => [candidate],
          _probeFn: async (_input, deps) => {
            const signal = deps?.signal;
            assert.ok(signal, "the active swarm probe receives a cancellation signal");
            markForegroundActive(candidate.infoHash);
            assert.equal(
              signal.aborted,
              true,
              "foreground start aborts the signal immediately",
            );
            return null;
          },
        });

        assert.equal(res.skipped, "foreground");
        assert.deepEqual(
          res.probed,
          [],
          "an interrupted probe is not reported as a completed measurement",
        );
      } finally {
        releaseForeground();
      }
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

    await checkAsync("fresh measurements (even unknown) are skipped and actual probes are globally capped", async () => {
      const freshUnknown = result({ title: "Fresh unknown" });
      const a = result({ title: "A" });
      const b = result({ title: "B" });
      const c = result({ title: "C" });
      const now = Date.now();
      await recordSwarmMeasurement(
        {
          infoHash: freshUnknown.infoHash!,
          peersConnected: 0,
          peersUnchoked: 0,
          bytesReceived: 0,
          elapsedMs: 8000,
          effectiveBps: 0,
          requiredBps: 1_000_000,
          verdict: "unknown",
          measuredAt: now,
          fromLiveDownload: false,
        },
        { db: prisma, ttlMs: 60_000, now },
      );

      const probed: string[] = [];
      let inFlight = 0;
      let maxInFlight = 0;
      try {
        const res = await preProbeUpcoming("someone", {
          db: prisma,
          limitTargets: 2,
          limitCandidates: 3,
          limitProbes: 2,
          _foregroundActive: () => false,
          _targets: [
            { title: "Target One", mediaType: "movie" },
            { title: "Target Two", mediaType: "movie" },
          ],
          _findLive: () => null,
          _poolFor: async (target) =>
            target.title === "Target One" ? [freshUnknown, a, b] : [c],
          _probeFn: async (input) => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            probed.push(input.infoHash ?? "");
            await new Promise((r) => setTimeout(r, 1));
            inFlight -= 1;
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

        assert.deepEqual(res.skippedFresh, [freshUnknown.infoHash]);
        assert.equal(res.verdicts[freshUnknown.infoHash!], "unknown");
        assert.deepEqual(probed, [a.infoHash, b.infoHash], "the third actual probe is stopped by the global cap");
        assert.equal(res.capped, true, "the result reports that the hard cap stopped the pass");
        assert.equal(maxInFlight, MAX_PREPROBE_CONCURRENCY, "probes are sequential, never concurrent");
      } finally {
        await prisma.swarmMeasurement.deleteMany({ where: { infoHash: freshUnknown.infoHash! } });
      }
    });

    await checkAsync("scope resolution: null and unknown default to 'monitored'", async () => {
      assert.equal(normalizePreProbeScope(null), "monitored");
      assert.equal(normalizePreProbeScope(undefined), "monitored");
      assert.equal(normalizePreProbeScope("bogus"), "monitored");
      assert.equal(DEFAULT_PREPROBE_SCOPE, "monitored");
      // Known values pass through unchanged.
      assert.equal(normalizePreProbeScope("off"), "off");
      assert.equal(normalizePreProbeScope("monitored"), "monitored");
    });

    await checkAsync("scope is read from ClientSettings; a missing row is 'monitored'", async () => {
      const fakeDb = (scope: string | null) =>
        ({
          clientSettings: {
            findUnique: async () =>
              scope === null ? null : { preProbeScope: scope },
          },
        }) as unknown as typeof prisma;
      assert.equal(await resolvePreProbeScope("u", fakeDb("monitored")), "monitored");
      assert.equal(await resolvePreProbeScope("u", fakeDb("off")), "off");
      // No row stored → the bounded monitored default, not off.
      assert.equal(await resolvePreProbeScope("u", fakeDb(null)), "monitored");
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

    await checkAsync("target priority is tracked shows, watchlist, then continue-watching", async () => {
      const db = {
        playbackProgress: {
          findMany: async () => [
            {
              userId: "u",
              watchListItemId: "watching-id",
              season: 1,
              episode: 2,
              completedAt: null,
              updatedAt: new Date(),
            },
          ],
        },
        watchListItem: {
          findMany: async (args: { where?: Record<string, unknown> }) => {
            const where = args.where ?? {};
            if ((where.id as { in?: string[] } | undefined)?.in) {
              return [{ id: "watching-id", title: "Continue Show", mediaType: "tv" }];
            }
            if (where.monitored === true) {
              return [
                {
                  id: "tracked-id",
                  title: "Tracked Show",
                  mediaType: "tv",
                  monitored: true,
                  cursorSeason: 2,
                  cursorEpisode: 5,
                },
              ];
            }
            return [
              {
                id: "watchlist-id",
                title: "Watchlist Show",
                mediaType: "tv",
                monitored: false,
                cursorSeason: 3,
                cursorEpisode: 7,
                status: "planned",
              },
            ];
          },
        },
      } as unknown as typeof prisma;

      const targets = await upcomingTargets("u", {
        db,
        sources: ["monitored", "watchlist", "watching"],
        limit: 3,
      });
      assert.deepEqual(
        targets.map((t) => `${t.title} S${t.season}E${t.episode}`),
        ["Tracked Show S2E5", "Watchlist Show S3E7", "Continue Show S1E3"],
      );
    });

    await checkAsync("scope maps to tiers: monitored/watchlist are prioritised before watching", async () => {
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
        sources: ["monitored", "watchlist", "watching"],
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
