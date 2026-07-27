/**
 * Foreground priority — the causal test.
 *
 * WHAT THIS FILE EXISTS TO PROVE
 * ------------------------------
 * Not "the code contains a `pause()` call" — that is inspection, and inspection
 * is what let a stutter-during-playback bug sit in the plan as "mitigated" for
 * this long. This proves the causal chain end to end:
 *
 *     a pre-warm is running
 *       → a foreground stream starts
 *         → `pause()` was ACTUALLY called on the pre-warm
 *           → and NOT on the user's torrent
 *     → the stream ends / the grace period expires
 *       → `resume()` was ACTUALLY called on the pre-warm
 *
 * Both halves matter and each can pass for the wrong reason. A test that only
 * asserts "suspended" passes trivially if the code suspends unconditionally and
 * never resumes — which would silently disable pre-warming forever, the exact
 * leaked-flag failure this module is designed against. So the resume half is
 * asserted just as hard, and both halves were sabotage-proven.
 *
 * WHY A FAKE CLIENT BUT A REAL DATABASE
 * -------------------------------------
 * The seam under test is `EngineTorrent.origin` → "may I touch this torrent?".
 * That authority lives in a Prisma query, so the rows are real seeded rows; a
 * mocked `findMany` would only confirm the test's own opinion of which hashes
 * are pre-warms and could never catch the query being wrong. WebTorrent itself
 * is faked, because the assertion is about which methods were called on which
 * torrent, and a real swarm can neither be seeded nor observed deterministically.
 *
 * Run: npx tsx src/lib/prewarm/foreground.test.ts
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import prisma from "@/lib/prisma";
import {
  FOREGROUND_IDLE_MS,
  FOREGROUND_MIN_SPEED_BPS,
  foregroundActive,
  foregroundIdleMs,
  foregroundSnapshot,
  markForegroundActive,
  observeForeground,
  resetForegroundState,
  syncPrewarmSuspension,
} from "./foreground";
import { PREWARM_ORIGIN, USER_ORIGIN } from "./types";
import type {
  BuiltinStreamFile,
  BuiltinStreamLookup,
  BuiltinStreamTorrent,
} from "@/lib/clients/builtin-engine";
import type { ClientConnectionConfig } from "@/lib/clients";

let failures = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}: ${(err as Error).message}`);
  }
}

async function checkAsync(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}: ${(err as Error).message}`);
  }
}

const userId = `prewarm-fg-${randomUUID()}`;

const builtinConfig: ClientConnectionConfig = {
  clientType: "builtin",
  host: "",
  userId,
};

const streamedForegroundCases = [
  {
    name: "complete file",
    speed: 0,
    progress: 1,
    message:
      "a completed file serves from disk/cache with no download counter, but " +
      "the viewer is still actively being fed bytes",
  },
  {
    name: "starved stream",
    speed: FOREGROUND_MIN_SPEED_BPS - 1,
    progress: 0.4,
    message:
      "a stream below the foreground speed threshold is the stream that most " +
      "needs pre-warms to get out of the way",
  },
];

function hashFor(tag: string): string {
  return createHash("sha1").update(tag).digest("hex");
}

/**
 * A WebTorrent torrent that records what was done to it.
 *
 * `paused` is a real field rather than a counter alone, because the production
 * code checks it before acting — a fake that never flips it would make the
 * idempotence assertions lie.
 */
class FakeTorrent {
  infoHash: string;
  paused = false;
  downloadSpeed = 0;
  progress = 0.25;
  pauseCalls = 0;
  resumeCalls = 0;
  deselectCalls = 0;
  selectCalls = 0;
  files: Array<{ select: () => void; deselect: () => void }>;
  private listeners = new Map<string, Array<(...a: unknown[]) => void>>();

  constructor(tag: string, opts: { speed?: number; files?: number } = {}) {
    this.infoHash = hashFor(tag);
    this.downloadSpeed = opts.speed ?? 0;
    const fileCount = opts.files ?? 1;
    this.files = Array.from({ length: fileCount }, () => ({
      select: () => {
        this.selectCalls += 1;
      },
      deselect: () => {
        this.deselectCalls += 1;
      },
    }));
  }

  pause() {
    this.pauseCalls += 1;
    this.paused = true;
  }

  resume() {
    this.resumeCalls += 1;
    this.paused = false;
  }

  on(ev: string, fn: (...a: unknown[]) => void) {
    const list = this.listeners.get(ev) ?? [];
    list.push(fn);
    this.listeners.set(ev, list);
  }

  listenerCount(ev: string) {
    return this.listeners.get(ev)?.length ?? 0;
  }

  /** Simulates the engine delivering a piece. */
  emitDownload() {
    for (const fn of this.listeners.get("download") ?? []) fn(16384);
  }
}

function makeStreamFile(path: string, length: number): BuiltinStreamFile {
  return {
    name: path.split("/").pop() || path,
    path,
    length,
    stream(opts = {}) {
      const start = opts.start ?? 0;
      const end = Math.min(opts.end ?? length - 1, length - 1);
      let offset = start;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset > end) {
            controller.close();
            return;
          }
          const size = Math.min(1024, end - offset + 1);
          offset += size;
          controller.enqueue(new Uint8Array(size));
        },
      });
    },
  };
}

async function serveBytesThroughStreamRoute(
  userTorrent: FakeTorrent,
): Promise<Response> {
  const { handleStreamFileRequest, resetStreamPrefetchForTests } = await import(
    "@/app/api/stream/[infoHash]/[...filePath]/route"
  );
  resetStreamPrefetchForTests();
  const file = makeStreamFile("Show/Episode.mkv", 4096);
  userTorrent.files = [file as unknown as { select: () => void; deselect: () => void }];
  const lookup: BuiltinStreamLookup = {
    status: "found",
    torrent: userTorrent as unknown as BuiltinStreamTorrent,
    file,
  };
  return handleStreamFileRequest(
    new Request(`http://localhost/api/stream/${userTorrent.infoHash}/Show/Episode.mkv`, {
      headers: { range: "bytes=0-1023" },
    }),
    { infoHash: userTorrent.infoHash, filePath: ["Show", "Episode.mkv"] },
    {
      getConfig: async () => builtinConfig,
      findFile: async () => lookup,
      prefetchEdges: async () => undefined,
    },
  );
}

const g = globalThis as unknown as {
  __tfBuiltinEngine?: { client?: { torrents?: unknown[] } | null };
};

function installEngine(torrents: FakeTorrent[]): void {
  g.__tfBuiltinEngine = { client: { torrents } };
}

/** Seeds real rows so `origin` is read from the database, not from the fake. */
async function seed(rows: Array<{ tag: string; origin: string }>): Promise<void> {
  await prisma.engineTorrent.deleteMany({ where: { userId } });
  for (const r of rows) {
    await prisma.engineTorrent.create({
      data: {
        userId,
        hash: hashFor(r.tag),
        name: r.tag,
        origin: r.origin,
        sizeBytes: BigInt(1_000_000),
        progress: 0.25,
        status: "downloading",
      },
    });
  }
}

async function main(): Promise<void> {
  console.log("prewarm foreground priority\n");

  await prisma.user.upsert({
    where: { id: userId },
    create: { id: userId, name: "prewarm foreground test" },
    update: {},
  });

  try {
    // ── the flag cannot leak ────────────────────────────────────────────
    check("a never-marked foreground is not active", () => {
      resetForegroundState();
      assert.equal(foregroundActive(), false);
      assert.equal(foregroundIdleMs(), Infinity);
    });

    check("foreground is a timestamp, so it expires on its own", () => {
      resetForegroundState();
      markForegroundActive(hashFor("user-movie"));
      assert.equal(foregroundActive(), true, "should be active right after a beacon");
      // Nothing calls a cleanup function here. This is the point: a stream
      // route that dies mid-request leaves no flag behind to leak.
      const later = Date.now() + FOREGROUND_IDLE_MS + 1;
      assert.equal(
        foregroundActive(later),
        false,
        "an unrefreshed foreground must expire by itself",
      );
    });

    check("the grace period holds across a gap between range requests", () => {
      resetForegroundState();
      markForegroundActive(hashFor("user-movie"));
      const midGrace = Date.now() + Math.floor(FOREGROUND_IDLE_MS / 2);
      assert.equal(
        foregroundActive(midGrace),
        true,
        "a buffering player must not look idle",
      );
    });

    // ── the engine-byte signal ──────────────────────────────────────────
    check("a moving non-prewarm torrent is the foreground", () => {
      resetForegroundState();
      const user = new FakeTorrent("user-movie", { speed: 2_000_000 });
      installEngine([user]);
      const seen = observeForeground(new Set());
      assert.equal(seen, user.infoHash);
      assert.equal(foregroundActive(), true);
    });

    check("a moving PRE-WARM is not mistaken for the foreground", () => {
      resetForegroundState();
      const pre = new FakeTorrent("pre-ep4", { speed: 5_000_000 });
      installEngine([pre]);
      const seen = observeForeground(new Set([pre.infoHash]));
      assert.equal(
        seen,
        null,
        "the pre-warm's own bytes must never count as playback — that would " +
          "make it suspend itself forever",
      );
      assert.equal(foregroundActive(), false);
    });

    check("an idle user torrent is not the foreground", () => {
      resetForegroundState();
      const user = new FakeTorrent("user-movie", {
        speed: FOREGROUND_MIN_SPEED_BPS - 1,
      });
      installEngine([user]);
      assert.equal(observeForeground(new Set()), null);
      assert.equal(foregroundActive(), false);
    });

    // ── THE CAUSAL CHAIN ────────────────────────────────────────────────
    await checkAsync(
      "CAUSAL: a running pre-warm is actually suspended when a stream starts, " +
        "and actually resumed when it ends",
      async () => {
        resetForegroundState();
        await seed([
          { tag: "user-movie", origin: USER_ORIGIN },
          { tag: "pre-ep4", origin: PREWARM_ORIGIN },
        ]);
        const user = new FakeTorrent("user-movie");
        const pre = new FakeTorrent("pre-ep4", { speed: 3_000_000, files: 2 });
        installEngine([user, pre]);

        // 1. Pre-warm running, nobody watching anything.
        const idle = await syncPrewarmSuspension({ userId });
        assert.equal(idle.foreground, false, "nothing is streaming yet");
        assert.equal(pre.pauseCalls, 0, "a pre-warm must run freely when nobody is watching");
        assert.equal(pre.paused, false);

        // 2. The user presses play. Bytes start moving on the user torrent.
        user.downloadSpeed = 4_000_000;
        const during = await syncPrewarmSuspension({ userId });

        assert.equal(during.foreground, true, "a streaming user torrent is the foreground");
        assert.equal(
          pre.pauseCalls,
          1,
          `the pre-warm must actually be paused, got ${pre.pauseCalls} pause() calls`,
        );
        assert.equal(pre.paused, true, "the pre-warm must be left in the paused state");
        assert.equal(
          pre.deselectCalls,
          2,
          "every file must be deselected so no further pieces are requested",
        );
        assert.deepEqual(during.suspended, [pre.infoHash]);

        // The half that would be data loss: the user's own torrent.
        assert.equal(
          user.pauseCalls,
          0,
          "the torrent the user is WATCHING was paused — this is the bug this " +
            "whole module exists to prevent",
        );
        assert.equal(user.deselectCalls, 0, "the foreground torrent must not be deselected");
        assert.equal(user.paused, false);

        // 3. The stream ends. The beacon is not refreshed and the grace expires.
        user.downloadSpeed = 0;
        const after = await syncPrewarmSuspension({
          userId,
          now: Date.now() + FOREGROUND_IDLE_MS + 1_000,
        });

        assert.equal(after.foreground, false, "playback stopped, so the foreground is over");
        assert.equal(
          pre.resumeCalls,
          1,
          `the pre-warm must actually be resumed, got ${pre.resumeCalls} resume() calls`,
        );
        assert.equal(pre.paused, false, "the pre-warm must be left running again");
        assert.equal(
          pre.selectCalls,
          2,
          "every file must be re-selected or the torrent resumes without asking for pieces",
        );
        assert.deepEqual(after.resumed, [pre.infoHash]);
        assert.deepEqual(after.parked, [], "nothing may be left parked once playback ends");

        assert.equal(user.resumeCalls, 0, "the user torrent was never paused, so never resume it");
      },
    );

    await checkAsync(
      "CAUSAL: the first foreground byte suspends immediately, without waiting for a sample",
      async () => {
        resetForegroundState();
        await seed([
          { tag: "user-movie", origin: USER_ORIGIN },
          { tag: "pre-ep4", origin: PREWARM_ORIGIN },
        ]);
        // The user torrent reports NO speed — an averaged counter has not caught
        // up yet. Only the `download` event knows.
        const user = new FakeTorrent("user-movie", { speed: 0 });
        const pre = new FakeTorrent("pre-ep4");
        installEngine([user, pre]);

        await syncPrewarmSuspension({ userId });
        assert.ok(
          user.listenerCount("download") > 0,
          "a download listener must be attached to the foreground torrent",
        );
        assert.equal(pre.paused, false, "no bytes yet, so nothing to suspend");

        user.emitDownload();
        assert.equal(
          foregroundActive(),
          true,
          "one delivered piece is enough to count as playback",
        );

        const during = await syncPrewarmSuspension({ userId });
        assert.equal(during.foreground, true);
        assert.equal(pre.paused, true, "the pre-warm must be parked on the first byte");
      },
    );

    for (const c of streamedForegroundCases) {
      await checkAsync(
        `WIRING: streamed bytes are foreground for a ${c.name}`,
        async () => {
          resetForegroundState();
          await seed([
            { tag: `user-${c.name}`, origin: USER_ORIGIN },
            { tag: `pre-${c.name}`, origin: PREWARM_ORIGIN },
          ]);
          const user = new FakeTorrent(`user-${c.name}`, { speed: c.speed });
          user.progress = c.progress;
          const pre = new FakeTorrent(`pre-${c.name}`, { speed: 5_000_000 });
          installEngine([user, pre]);

          const res = await serveBytesThroughStreamRoute(user);
          assert.equal(res.status, 206, c.name);
          assert.equal((await res.arrayBuffer()).byteLength, 1024, c.name);

          const during = await syncPrewarmSuspension({ userId });
          assert.equal(during.foreground, true, `${c.name}: ${c.message}`);
          assert.equal(pre.paused, true, `${c.name}: the pre-warm kept competing`);
          assert.equal(user.pauseCalls, 0, `${c.name}: the user torrent was paused`);
        },
      );
    }

    await checkAsync("listeners are not stacked when the module is re-entered", async () => {
      resetForegroundState();
      await seed([{ tag: "user-movie", origin: USER_ORIGIN }]);
      const user = new FakeTorrent("user-movie");
      installEngine([user]);

      await syncPrewarmSuspension({ userId });
      await syncPrewarmSuspension({ userId });
      await syncPrewarmSuspension({ userId });
      assert.equal(
        user.listenerCount("download"),
        1,
        "a hot reload must not stack listeners on the same torrent",
      );
    });

    // ── never touch what is not ours ────────────────────────────────────
    await checkAsync(
      "a user torrent is NEVER suspended, even under sustained playback",
      async () => {
        resetForegroundState();
        await seed([
          { tag: "user-a", origin: USER_ORIGIN },
          { tag: "user-b", origin: USER_ORIGIN },
          { tag: "user-c", origin: USER_ORIGIN },
        ]);
        const a = new FakeTorrent("user-a", { speed: 9_000_000 });
        const b = new FakeTorrent("user-b", { speed: 1_000_000 });
        const c = new FakeTorrent("user-c");
        installEngine([a, b, c]);

        for (let i = 0; i < 5; i += 1) await syncPrewarmSuspension({ userId });

        for (const [name, t] of [["user-a", a], ["user-b", b], ["user-c", c]] as const) {
          assert.equal(t.pauseCalls, 0, `${name} was paused — that is a user download`);
          assert.equal(t.deselectCalls, 0, `${name} was deselected — that is a user download`);
          assert.equal(t.paused, false, `${name} was left paused`);
        }
      },
    );

    await checkAsync("a torrent the engine holds but the DB does not know is left alone", async () => {
      resetForegroundState();
      await seed([{ tag: "pre-ep4", origin: PREWARM_ORIGIN }]);
      const unknown = new FakeTorrent("not-in-db", { speed: 5_000_000 });
      const pre = new FakeTorrent("pre-ep4");
      installEngine([unknown, pre]);

      await syncPrewarmSuspension({ userId });
      assert.equal(
        unknown.pauseCalls,
        0,
        "an unrecognised torrent must be treated as the user's, not as ours to pause",
      );
      assert.equal(pre.paused, true, "an unknown moving torrent still counts as foreground");
    });

    // ── only un-pause what we paused ────────────────────────────────────
    await checkAsync("a pre-warm paused by someone else is not resumed by us", async () => {
      resetForegroundState();
      await seed([{ tag: "pre-ep4", origin: PREWARM_ORIGIN }]);
      const pre = new FakeTorrent("pre-ep4");
      pre.paused = true; // paused by the user, or by the engine on startup
      installEngine([pre]);

      const result = await syncPrewarmSuspension({ userId });
      assert.equal(result.foreground, false);
      assert.equal(
        pre.resumeCalls,
        0,
        "we only ever resume torrents WE parked; anything else is overriding the user",
      );
    });

    await checkAsync("suspension is idempotent under repeated pings", async () => {
      resetForegroundState();
      await seed([{ tag: "pre-ep4", origin: PREWARM_ORIGIN }]);
      const pre = new FakeTorrent("pre-ep4");
      installEngine([pre]);

      for (let i = 0; i < 4; i += 1) {
        await syncPrewarmSuspension({ userId, _foregroundActive: true });
      }
      assert.equal(pre.pauseCalls, 1, "a paused torrent must not be paused again every ping");
    });

    // ── the leak case, stated as its own assertion ──────────────────────
    await checkAsync(
      "LEAK GUARD: a stream route that dies without cleanup cannot disable pre-warming forever",
      async () => {
        resetForegroundState();
        await seed([{ tag: "pre-ep4", origin: PREWARM_ORIGIN }]);
        const pre = new FakeTorrent("pre-ep4");
        // Nothing else in the engine: the "stream" vanished mid-request, so no
        // torrent is moving bytes and no cleanup call will ever arrive.
        installEngine([pre]);

        markForegroundActive(hashFor("stream-that-died"));
        const during = await syncPrewarmSuspension({ userId });
        assert.equal(during.foreground, true);
        assert.equal(pre.paused, true);

        // Time passes. No cleanup. No further beacons.
        const after = await syncPrewarmSuspension({
          userId,
          now: Date.now() + FOREGROUND_IDLE_MS + 5_000,
        });
        assert.equal(
          after.foreground,
          false,
          "a dead stream must not hold the foreground flag open",
        );
        assert.equal(
          pre.paused,
          false,
          "pre-warming was left disabled forever — the exact silent failure this guards",
        );
        assert.deepEqual(after.parked, []);
      },
    );

    // ── it must never take anything down with it ────────────────────────
    await checkAsync("no engine at all is survivable", async () => {
      resetForegroundState();
      await seed([{ tag: "pre-ep4", origin: PREWARM_ORIGIN }]);
      g.__tfBuiltinEngine = undefined;
      const result = await syncPrewarmSuspension({ userId });
      assert.equal(result.foreground, false);
      assert.deepEqual(result.suspended, []);
    });

    await checkAsync("a torrent whose pause() throws does not abort the sweep", async () => {
      resetForegroundState();
      await seed([
        { tag: "pre-bad", origin: PREWARM_ORIGIN },
        { tag: "pre-good", origin: PREWARM_ORIGIN },
      ]);
      const bad = new FakeTorrent("pre-bad");
      bad.pause = () => {
        throw new Error("engine exploded");
      };
      const good = new FakeTorrent("pre-good");
      installEngine([bad, good]);

      const result = await syncPrewarmSuspension({ userId, _foregroundActive: true });
      assert.equal(
        good.paused,
        true,
        "one broken torrent must not stop the others being parked",
      );
      assert.ok(result.suspended.includes(good.infoHash));
    });

    await checkAsync("a database failure leaves every torrent untouched", async () => {
      resetForegroundState();
      const pre = new FakeTorrent("pre-ep4");
      const user = new FakeTorrent("user-movie");
      installEngine([pre, user]);

      const brokenDb = {
        engineTorrent: {
          findMany: async () => {
            throw new Error("database is locked");
          },
        },
      } as unknown as typeof prisma;

      const result = await syncPrewarmSuspension({
        userId,
        db: brokenDb,
        _foregroundActive: true,
      });
      assert.equal(result.suspended.length, 0);
      assert.equal(
        pre.pauseCalls + user.pauseCalls,
        0,
        "without a trustworthy origin lookup we must touch NOTHING, not guess",
      );
    });

    // ── the wiring, through the real entry point ────────────────────────
    // `syncPrewarmSuspension` working in isolation proves nothing about
    // production if nothing calls it. `onPlaybackProgress` is the exact
    // function `POST /api/progress` invokes, so this asserts the wire is
    // connected — not just that the far end works.
    await checkAsync(
      "WIRING: a progress ping suspends a running pre-warm via onPlaybackProgress",
      async () => {
        resetForegroundState();
        await seed([
          { tag: "user-movie", origin: USER_ORIGIN },
          { tag: "pre-ep4", origin: PREWARM_ORIGIN },
        ]);
        const user = new FakeTorrent("user-movie", { speed: 6_000_000 });
        const pre = new FakeTorrent("pre-ep4");
        installEngine([user, pre]);

        const { onPlaybackProgress } = await import("./prewarm");

        // Deliberately BELOW the 15% trigger: suspension must be reconciled on
        // every ping, not only on the ones that would start a new pre-warm.
        await onPlaybackProgress({
          userId,
          infoHash: hashFor("user-movie"),
          title: "Some Show S01E03",
          season: 1,
          episode: 3,
          positionSec: 30,
          durationSec: 3000,
        });

        assert.equal(
          pre.pauseCalls,
          1,
          "a progress ping did not reach the suspension path — the feature is " +
            "unwired and would never fire in production",
        );
        assert.equal(pre.paused, true);
        assert.equal(user.pauseCalls, 0, "the torrent being watched was paused");
      },
    );

    // ── diagnostics must not overclaim ──────────────────────────────────
    check("the snapshot reports 'never seen' as null, not as zero", () => {
      resetForegroundState();
      const snap = foregroundSnapshot();
      assert.equal(snap.active, false);
      assert.equal(
        snap.idleMs,
        null,
        "0ms idle would read as 'just streamed' — never-determined must stay null",
      );
      assert.equal(snap.hash, null);
    });
  } finally {
    g.__tfBuiltinEngine = undefined;
    resetForegroundState();
    await prisma.engineTorrent.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  }

  console.log(
    failures === 0
      ? "\nPASS — foreground playback wins, and pre-warms come back"
      : `\nFAIL — ${failures} failing check(s)`,
  );
  process.exit(failures ? 1 : 0);
}

void main();
