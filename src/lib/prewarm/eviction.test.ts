/**
 * LRU eviction of pre-warms — the data-loss test.
 *
 * THE ONE THING THIS FILE EXISTS TO PROVE
 * ---------------------------------------
 * `origin === "user"` rows are never deleted. Not when the disk is full, not
 * when they are the oldest thing on it, not when they are the *only* thing on
 * it. Evicting a download the user explicitly asked for is data loss dressed up
 * as cache management, and it is a named risk in the roadmap.
 *
 * WHY IT USES REAL DATABASE ROWS
 * ------------------------------
 * The guard lives in a Prisma `where` clause. A mock that answers "here are the
 * rows you asked for" cannot tell you whether the clause you wrote actually
 * excludes anything — it tests your intent, not your query. So every row here
 * is a real seeded `EngineTorrent`, and every assertion re-reads the database
 * after the fact rather than trusting the return value.
 *
 * The client-side removal is stubbed (`_deleteFn`) because that is a network
 * call to a torrent engine and a `deleteFiles: true` against a real one. The
 * stub records what it was asked to delete, which is itself an assertion
 * target: a hash reaching the stub is a file that would really have been
 * destroyed.
 *
 * Run: npx tsx src/lib/prewarm/eviction.test.ts
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import prisma from "@/lib/prisma";
import type { ClientConnectionConfig } from "@/lib/clients/types";
import {
  evictPrewarmsForBytes,
  listEvictablePrewarms,
  markPrewarmUsed,
  onDiskBytes,
} from "./eviction";
import { PREWARM_ORIGIN, USER_ORIGIN } from "./types";

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

const userId = `prewarm-evict-${randomUUID()}`;

const GB = 1024 * 1024 * 1024;

const config = {
  clientType: "builtin",
  host: "",
  savePath: "/downloads",
} as ClientConnectionConfig;

/** Hashes handed to the (stubbed) client for real deletion. */
let deleted: string[] = [];
const deleteFn = async (_c: ClientConnectionConfig, hash: string) => {
  deleted.push(hash);
  return { ok: true, message: "removed" };
};

function hashFor(tag: string): string {
  // Deterministic 40-hex per tag, so assertions can name rows and two tags can
  // never collide on the [userId, hash] unique key.
  return createHash("sha1").update(tag).digest("hex");
}

async function seed(rows: Array<{
  tag: string;
  origin: string;
  sizeBytes: number;
  progress: number;
  ageMinutes: number;
}>): Promise<void> {
  await prisma.engineTorrent.deleteMany({ where: { userId } });
  await prisma.playbackProgress.deleteMany({ where: { userId } });
  for (const r of rows) {
    await prisma.engineTorrent.create({
      data: {
        userId,
        hash: hashFor(r.tag),
        name: r.tag,
        origin: r.origin,
        sizeBytes: BigInt(r.sizeBytes),
        progress: r.progress,
        status: "downloading",
        lastUsedAt: new Date(Date.now() - r.ageMinutes * 60_000),
      },
    });
  }
}

async function originsInDb(): Promise<Record<string, string>> {
  const rows = await prisma.engineTorrent.findMany({ where: { userId } });
  return Object.fromEntries(rows.map((r) => [r.name, r.origin]));
}

async function main(): Promise<void> {
  console.log("prewarm eviction\n");

  await prisma.user.upsert({
    where: { id: userId },
    create: { id: userId, name: "prewarm eviction test" },
    update: {},
  });

  try {
    // ── onDiskBytes ────────────────────────────────────────────────────
    check("onDiskBytes counts only what is actually on disk", () => {
      assert.equal(onDiskBytes({ sizeBytes: 1000, progress: 0.5 }), 500);
      assert.equal(onDiskBytes({ sizeBytes: BigInt(1000), progress: 1 }), 1000);
      assert.equal(onDiskBytes({ sizeBytes: 1000, progress: 0 }), 0);
    });

    check("onDiskBytes clamps nonsense rather than inventing space", () => {
      assert.equal(onDiskBytes({ sizeBytes: 1000, progress: 5 }), 1000);
      assert.equal(onDiskBytes({ sizeBytes: 1000, progress: -3 }), 0);
      assert.equal(onDiskBytes({ sizeBytes: -1, progress: 1 }), 0);
      assert.equal(onDiskBytes({ sizeBytes: 1000, progress: NaN }), 0);
    });

    // ── THE INVARIANT ──────────────────────────────────────────────────
    // Four user downloads, huge and ancient. One small, recent pre-warm.
    // Then ask for more space than exists on Earth.
    await seed([
      { tag: "user-ancient", origin: USER_ORIGIN, sizeBytes: 40 * GB, progress: 1, ageMinutes: 60_000 },
      { tag: "user-old", origin: USER_ORIGIN, sizeBytes: 30 * GB, progress: 1, ageMinutes: 50_000 },
      { tag: "user-mid", origin: USER_ORIGIN, sizeBytes: 20 * GB, progress: 1, ageMinutes: 40_000 },
      { tag: "user-recent", origin: USER_ORIGIN, sizeBytes: 10 * GB, progress: 1, ageMinutes: 1 },
      { tag: "prewarm-only", origin: PREWARM_ORIGIN, sizeBytes: 1 * GB, progress: 1, ageMinutes: 2 },
    ]);
    deleted = [];

    const extreme = await evictPrewarmsForBytes({
      userId,
      neededBytes: 999 * GB,
      config,
      db: prisma,
      _deleteFn: deleteFn,
    });

    await checkAsync(
      "extreme disk pressure NEVER evicts an origin=user torrent",
      async () => {
        const after = await originsInDb();
        for (const tag of ["user-ancient", "user-old", "user-mid", "user-recent"]) {
          assert.equal(
            after[tag],
            USER_ORIGIN,
            `${tag} was deleted — a download the user asked for is gone`,
          );
        }
        assert.equal(
          Object.keys(after).length,
          4,
          "expected the 4 user rows to survive and the prewarm to be gone",
        );
      },
    );

    check("no user-origin hash is ever handed to the client for deletion", () => {
      const userHashes = ["user-ancient", "user-old", "user-mid", "user-recent"].map(hashFor);
      for (const h of userHashes) {
        assert.ok(
          !deleted.includes(h),
          `client was asked to delete ${h} — that is a real file destroyed`,
        );
      }
      assert.deepEqual(deleted, [hashFor("prewarm-only")]);
    });

    check("every evicted row was origin=prewarm", () => {
      for (const c of extreme.evicted) {
        assert.equal(c.origin, PREWARM_ORIGIN, `evicted ${c.name} with origin ${c.origin}`);
      }
      assert.equal(extreme.evicted.length, 1);
    });

    check("it reports failure honestly when it cannot free enough", () => {
      assert.equal(
        extreme.satisfied,
        false,
        "claimed to satisfy a 999 GB request by freeing 1 GB",
      );
      assert.equal(extreme.freedBytes, 1 * GB);
      assert.equal(extreme.neededBytes, 999 * GB);
    });

    // ── The budget is respected: it stops as soon as it has enough ──────
    await seed([
      { tag: "pw-oldest", origin: PREWARM_ORIGIN, sizeBytes: 2 * GB, progress: 1, ageMinutes: 500 },
      { tag: "pw-middle", origin: PREWARM_ORIGIN, sizeBytes: 2 * GB, progress: 1, ageMinutes: 400 },
      { tag: "pw-newest", origin: PREWARM_ORIGIN, sizeBytes: 2 * GB, progress: 1, ageMinutes: 300 },
      { tag: "user-keep", origin: USER_ORIGIN, sizeBytes: 9 * GB, progress: 1, ageMinutes: 9_000 },
    ]);
    deleted = [];

    const budgeted = await evictPrewarmsForBytes({
      userId,
      neededBytes: 3 * GB,
      config,
      db: prisma,
      _deleteFn: deleteFn,
    });

    await checkAsync(
      "eviction stops at the budget — it does not clear the cache",
      async () => {
        assert.equal(budgeted.satisfied, true, "should have freed enough");
        assert.equal(
          budgeted.evicted.length,
          2,
          `needed 3 GB from 2 GB rows → exactly 2 evictions, got ${budgeted.evicted.length}`,
        );
        const after = await originsInDb();
        assert.ok(after["pw-newest"], "the most recent pre-warm must survive");
        assert.ok(after["user-keep"], "the user download must survive");
        assert.equal(Object.keys(after).length, 2);
      },
    );

    check("eviction order is least-recently-used first", () => {
      assert.deepEqual(
        budgeted.evicted.map((c) => c.name),
        ["pw-oldest", "pw-middle"],
      );
    });

    // ── Protections that apply to prewarms too ─────────────────────────
    await seed([
      { tag: "pw-watched", origin: PREWARM_ORIGIN, sizeBytes: 5 * GB, progress: 1, ageMinutes: 900 },
      { tag: "pw-playing", origin: PREWARM_ORIGIN, sizeBytes: 5 * GB, progress: 1, ageMinutes: 800 },
      { tag: "pw-free", origin: PREWARM_ORIGIN, sizeBytes: 5 * GB, progress: 1, ageMinutes: 700 },
      { tag: "pw-empty", origin: PREWARM_ORIGIN, sizeBytes: 5 * GB, progress: 0, ageMinutes: 600 },
    ]);
    await prisma.playbackProgress.create({
      data: {
        userId,
        infoHash: hashFor("pw-watched"),
        filePath: "a.mkv",
        positionSec: 30,
        durationSec: 1400,
        title: "pw-watched",
      },
    });
    deleted = [];

    const listed = await listEvictablePrewarms(userId, {
      db: prisma,
      protectHashes: [hashFor("pw-playing")],
    });

    check("a pre-warm the user started watching is no longer speculative", () => {
      const names = listed.candidates.map((c) => c.name);
      assert.ok(!names.includes("pw-watched"), "a watched pre-warm was offered up");
      assert.ok(
        listed.skipped.some(
          (s) => s.hash === hashFor("pw-watched") && s.reason === "watched",
        ),
        "the watched row should be reported as deliberately skipped",
      );
    });

    check("the torrent on screen is protected explicitly", () => {
      const names = listed.candidates.map((c) => c.name);
      assert.ok(!names.includes("pw-playing"), "the playing torrent was offered up");
      assert.ok(
        listed.skipped.some(
          (s) => s.hash === hashFor("pw-playing") && s.reason === "protected",
        ),
      );
    });

    const protectedRun = await evictPrewarmsForBytes({
      userId,
      neededBytes: 100 * GB,
      config,
      db: prisma,
      protectHashes: [hashFor("pw-playing")],
      _deleteFn: deleteFn,
    });

    await checkAsync(
      "under pressure, protected and watched pre-warms still survive",
      async () => {
        const after = await originsInDb();
        assert.ok(after["pw-watched"], "watched pre-warm was deleted");
        assert.ok(after["pw-playing"], "playing torrent was deleted");
        assert.ok(after["pw-empty"], "a 0-byte-on-disk row was pointlessly deleted");
        assert.ok(!after["pw-free"], "the one evictable row should be gone");
        assert.deepEqual(protectedRun.evicted.map((c) => c.name), ["pw-free"]);
      },
    );

    check("a row holding nothing is not evicted — it frees nothing", () => {
      assert.ok(
        protectedRun.skipped.some(
          (s) => s.hash === hashFor("pw-empty") && s.reason === "frees-nothing",
        ),
      );
    });

    // ── Zero-byte request is a no-op ───────────────────────────────────
    deleted = [];
    const none = await evictPrewarmsForBytes({
      userId,
      neededBytes: 0,
      config,
      db: prisma,
      _deleteFn: deleteFn,
    });
    check("asking for 0 bytes deletes nothing", () => {
      assert.equal(none.evicted.length, 0);
      assert.equal(none.satisfied, true);
      assert.deepEqual(deleted, []);
    });

    // ── A client that refuses must not leave a phantom DB row ──────────
    await seed([
      { tag: "pw-stuck", origin: PREWARM_ORIGIN, sizeBytes: 4 * GB, progress: 1, ageMinutes: 1000 },
    ]);
    const refused = await evictPrewarmsForBytes({
      userId,
      neededBytes: 4 * GB,
      config,
      db: prisma,
      _deleteFn: async () => ({ ok: false, message: "engine busy" }),
    });
    await checkAsync(
      "when the client refuses, the row stays and nothing is claimed freed",
      async () => {
        const after = await originsInDb();
        assert.ok(after["pw-stuck"], "row deleted despite the client refusing");
        assert.equal(refused.freedBytes, 0);
        assert.equal(refused.satisfied, false);
        assert.ok(
          refused.skipped.some((s) => s.reason.startsWith("client-refused")),
        );
      },
    );

    // ── markPrewarmUsed drives the LRU ─────────────────────────────────
    await seed([
      { tag: "pw-a", origin: PREWARM_ORIGIN, sizeBytes: 1 * GB, progress: 1, ageMinutes: 900 },
      { tag: "pw-b", origin: PREWARM_ORIGIN, sizeBytes: 1 * GB, progress: 1, ageMinutes: 800 },
    ]);
    await markPrewarmUsed(userId, hashFor("pw-a"), { db: prisma });

    await checkAsync("markPrewarmUsed moves a row to the back of the queue", async () => {
      const after = await listEvictablePrewarms(userId, { db: prisma });
      assert.deepEqual(
        after.candidates.map((c) => c.name),
        ["pw-b", "pw-a"],
        "pw-a was just used and must now be the last thing evicted",
      );
    });

    await checkAsync("markPrewarmUsed on an unknown hash is a quiet no-op", async () => {
      const ok = await markPrewarmUsed(userId, hashFor("nope"), { db: prisma });
      assert.equal(ok, false);
    });
  } finally {
    await prisma.playbackProgress.deleteMany({ where: { userId } });
    await prisma.engineTorrent.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  }

  console.log(
    failures === 0
      ? "\nPASS — eviction can never touch a user download"
      : `\nFAIL — ${failures} failing check(s)`,
  );
  process.exit(failures ? 1 : 0);
}

void main();
