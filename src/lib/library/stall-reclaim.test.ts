/**
 * Stall classification and stalled-allocation reclamation.
 *
 * The measured defect: eight torrents sat at `progress: 0` while the engine had
 * preallocated each file at full length, so 36.8 GB of disk was held by rows
 * that contained nothing watchable. `isDownloading` counted every one of them
 * as "still downloading" (its rule was `progress < 1`), so the sweep skipped all
 * of them, the cache could never come under budget, and every Play was refused
 * forever.
 *
 * These tests pin the RULE, not that incident:
 *  - a transfer delivering nothing for hours is reclaimable;
 *  - a transfer that is actually moving — however slowly — is not;
 *  - "we cannot tell yet" is never "dead", exactly as `swarm-probe.ts` treats an
 *    unreachable swarm;
 *  - every existing guard (kept, watchlisted, part-watched, streaming) still
 *    outranks reclamation, whatever the transfer is doing;
 *  - deleting a preallocated row credits back its whole allocation.
 *
 * Table-driven per AGENTS.md.
 * Run: npx tsx src/lib/library/stall-reclaim.test.ts
 */
import assert from "node:assert/strict";
import { runDbTest } from "@/lib/test-support/db-teardown";
import { createHash, randomUUID } from "node:crypto";
import prisma from "@/lib/prisma";
import type { ClientConnectionConfig } from "@/lib/clients/types";
import { USER_ORIGIN } from "@/lib/prewarm/types";
import { STREAM_ORIGIN } from "@/lib/streaming/retention";
import {
  classifyTransfer,
  listRetentionSweepCandidates,
  reclaimForBytes,
  sweepRetentionCache,
  STALL_AFTER_MS,
  type StallThresholds,
  type TransferFacts,
  type TransferState,
} from "./retention-sweep";

let failures = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function checkAsync(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err instanceof Error ? err.message : String(err)}`);
  }
}

const GB = 1024 * 1024 * 1024;
const HOUR = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// classifyTransfer — the pure rule
// ---------------------------------------------------------------------------

interface ClassifyCase {
  name: string;
  facts: TransferFacts;
  expect: TransferState;
}

const CLASSIFY_CASES: ClassifyCase[] = [
  {
    name: "a finished file is complete",
    facts: { progress: 1, sizeBytes: 8 * GB, observedForMs: 40 * HOUR, idleForMs: 40 * HOUR },
    expect: "complete",
  },
  {
    // The live case: preallocated at full length, zero bytes delivered, nobody
    // has touched it since it was created. This is the row that must be freeable.
    name: "0% for a day, untouched for a day, is stalled",
    facts: { progress: 0, sizeBytes: 12 * GB, observedForMs: 24 * HOUR, idleForMs: 24 * HOUR },
    expect: "stalled",
  },
  {
    name: "a 4 GB season pack at 0.2% over 30 hours is stalled",
    facts: { progress: 0.002, sizeBytes: 4 * GB, observedForMs: 30 * HOUR, idleForMs: 30 * HOUR },
    expect: "stalled",
  },
  {
    // A genuinely-progressing transfer is never dead weight. 42% is meaningful
    // delivery whatever the clock says, so no timer can reclassify it.
    name: "a transfer at 42% is progressing, however old",
    facts: { progress: 0.42, sizeBytes: 20 * GB, observedForMs: 90 * HOUR, idleForMs: 90 * HOUR },
    expect: "progressing",
  },
  {
    name: "a transfer at 5% is progressing (above the dead-weight floor)",
    facts: { progress: 0.05, sizeBytes: 2 * GB, observedForMs: 50 * HOUR, idleForMs: 50 * HOUR },
    expect: "progressing",
  },
  {
    // Slow but real: 0.9% of 60 GB over 3 hours is ~50 KB/s actually arriving.
    // Under the fraction floor, but bytes are landing, so it is not dead weight.
    name: "slow-but-real delivery is progressing, not stalled",
    facts: { progress: 0.009, sizeBytes: 60 * GB, observedForMs: 3 * HOUR, idleForMs: 3 * HOUR },
    expect: "progressing",
  },
  {
    name: "a torrent started ten minutes ago is unknown, not stalled",
    facts: { progress: 0, sizeBytes: 6 * GB, observedForMs: 10 * 60_000, idleForMs: 10 * 60_000 },
    expect: "unknown",
  },
  {
    name: "a row touched five minutes ago is unknown, not stalled",
    facts: { progress: 0, sizeBytes: 6 * GB, observedForMs: 40 * HOUR, idleForMs: 5 * 60_000 },
    expect: "unknown",
  },
  {
    name: "a missing observation window is unknown",
    facts: { progress: 0, sizeBytes: 6 * GB, observedForMs: null, idleForMs: 40 * HOUR },
    expect: "unknown",
  },
  {
    name: "a missing idle timestamp is unknown",
    facts: { progress: 0, sizeBytes: 6 * GB, observedForMs: 40 * HOUR, idleForMs: null },
    expect: "unknown",
  },
  {
    name: "a NaN observation window is unknown",
    facts: { progress: 0, sizeBytes: 6 * GB, observedForMs: Number.NaN, idleForMs: 40 * HOUR },
    expect: "unknown",
  },
  {
    name: "exactly at the observation threshold is old enough to judge",
    facts: {
      progress: 0,
      sizeBytes: GB,
      observedForMs: STALL_AFTER_MS,
      idleForMs: STALL_AFTER_MS,
    },
    expect: "stalled",
  },
  {
    name: "an unknown size with no progress is still stalled",
    facts: { progress: 0, sizeBytes: 0, observedForMs: 20 * HOUR, idleForMs: 20 * HOUR },
    expect: "stalled",
  },
];

// ---------------------------------------------------------------------------
// Sweep behaviour against a real database
// ---------------------------------------------------------------------------

const userId = `stall-reclaim-${randomUUID()}`;
const now = new Date("2026-08-02T09:00:00.000Z");
const config = {
  clientType: "builtin",
  host: "",
  savePath: "D:\\Downloads",
} as ClientConnectionConfig;

/** Thresholds shrunk so a test can express "hours" without waiting hours. */
const stall: StallThresholds = {
  stallAfterMs: HOUR,
  stallProgressMax: 0.01,
  minDeliveryBps: 32 * 1024,
};

let deleted: string[] = [];

function hashFor(tag: string): string {
  return createHash("sha1").update(`${userId}:${tag}`).digest("hex");
}

async function resetRows(): Promise<void> {
  await prisma.playbackProgress.deleteMany({ where: { userId } });
  await prisma.engineTorrent.deleteMany({ where: { userId } });
  await prisma.watchListItem.deleteMany({ where: { userId } });
}

async function seedTorrent(input: {
  tag: string;
  origin?: string;
  status?: string;
  progress?: number;
  sizeGb?: number;
  /** How long ago the row was created — the observation window. */
  createdHoursAgo?: number;
  /** How long ago playback last touched it. Defaults to the creation age. */
  usedHoursAgo?: number;
  completedAt?: Date | null;
  watchListItemId?: string | null;
  title?: string;
}): Promise<string> {
  const hash = hashFor(input.tag);
  const createdAgo = input.createdHoursAgo ?? 24;
  await prisma.engineTorrent.create({
    data: {
      userId,
      hash,
      name: input.title ?? input.tag,
      origin: input.origin ?? STREAM_ORIGIN,
      status: input.status ?? "downloading",
      progress: input.progress ?? 0,
      sizeBytes: BigInt(Math.round((input.sizeGb ?? 1) * GB)),
      createdAt: new Date(now.getTime() - createdAgo * HOUR),
      lastUsedAt: new Date(now.getTime() - (input.usedHoursAgo ?? createdAgo) * HOUR),
    },
  });
  if (input.completedAt !== undefined) {
    await prisma.playbackProgress.create({
      data: {
        userId,
        infoHash: hash,
        filePath: `${input.tag}.mkv`,
        positionSec: input.completedAt ? 1200 : 300,
        durationSec: 1200,
        completedAt: input.completedAt,
        title: input.title ?? input.tag,
        watchListItemId: input.watchListItemId ?? null,
      },
    });
  }
  return hash;
}

async function exists(hash: string): Promise<boolean> {
  return (await prisma.engineTorrent.count({ where: { userId, hash } })) > 0;
}

async function runSweep(budgetBytes: number, opts?: { protectHashes?: string[] }) {
  deleted = [];
  return sweepRetentionCache({
    userId,
    config,
    budgetBytes,
    now,
    db: prisma,
    stall,
    mode: "delete",
    protectHashes: opts?.protectHashes,
    _foreground: { active: () => false, hash: () => null },
    _deleteFn: async (_config, hash) => {
      deleted.push(hash);
      return { ok: true, message: "deleted" };
    },
  });
}

async function skipReason(hash: string): Promise<string | null> {
  const listed = await listRetentionSweepCandidates({
    userId,
    db: prisma,
    now,
    stall,
    _foreground: { active: () => false, hash: () => null },
  });
  return listed.skipped.find((s) => s.hash === hash)?.reason ?? null;
}

async function main(): Promise<void> {
  console.log("classifyTransfer");
  for (const testCase of CLASSIFY_CASES) {
    check(testCase.name, () => {
      assert.equal(classifyTransfer(testCase.facts, stall), testCase.expect);
    });
  }

  check("thresholds are overridable without changing the verdict order", () => {
    const facts: TransferFacts = {
      progress: 0,
      sizeBytes: GB,
      observedForMs: 3 * HOUR,
      idleForMs: 3 * HOUR,
    };
    assert.equal(classifyTransfer(facts, { stallAfterMs: HOUR }), "stalled");
    assert.equal(classifyTransfer(facts, { stallAfterMs: 100 * HOUR }), "unknown");
  });

  await prisma.user.upsert({
    where: { id: userId },
    create: { id: userId, name: "stall reclaim test" },
    update: {},
  });

  console.log("sweep");
  try {
    // ── The deadlock itself ────────────────────────────────────────────────
    await resetRows();
    const dead = await seedTorrent({ tag: "stalled-preallocation", sizeGb: 12 });
    await checkAsync(
      "a stalled 0% stream preallocation is reclaimable, and credits its whole allocation",
      async () => {
        const result = await runSweep(1);
        assert.deepEqual(deleted, [dead], "the stalled allocation was deleted");
        assert.equal(await exists(dead), false, "its row is gone too");
        assert.equal(
          result.reclaimedBytes,
          12 * GB,
          "a preallocated file frees its full length, not size × progress",
        );
        assert.equal(result.satisfied, true);
      },
    );

    // ── The guard the deadlock was protecting ──────────────────────────────
    await resetRows();
    const moving = await seedTorrent({
      tag: "genuinely-downloading",
      progress: 0.37,
      sizeGb: 9,
    });
    await checkAsync("a genuinely-progressing transfer is never reclaimed", async () => {
      const result = await runSweep(1);
      assert.deepEqual(deleted, []);
      assert.equal(await exists(moving), true);
      assert.equal(result.reclaimedBytes, 0);
      assert.equal(await skipReason(moving), "downloading");
    });

    await resetRows();
    const fresh = await seedTorrent({
      tag: "just-started",
      progress: 0,
      sizeGb: 30,
      createdHoursAgo: 0.1,
    });
    await checkAsync("a transfer too young to judge is left alone", async () => {
      await runSweep(1);
      assert.deepEqual(deleted, []);
      assert.equal(await exists(fresh), true);
      assert.equal(await skipReason(fresh), "downloading");
    });

    await resetRows();
    const touched = await seedTorrent({
      tag: "recently-streamed",
      progress: 0,
      sizeGb: 30,
      createdHoursAgo: 40,
      usedHoursAgo: 0.05,
    });
    await checkAsync("a row playback touched moments ago is left alone", async () => {
      await runSweep(1);
      assert.deepEqual(deleted, []);
      assert.equal(await exists(touched), true);
    });

    // ── Every pre-existing guard still outranks a stall verdict ────────────
    await resetRows();
    const kept = await seedTorrent({
      tag: "kept-download",
      origin: USER_ORIGIN,
      progress: 0,
      sizeGb: 25,
    });
    await checkAsync("a kept (user-origin) download is never reclaimed, stalled or not", async () => {
      await runSweep(1);
      assert.deepEqual(deleted, []);
      assert.equal(await exists(kept), true);
      assert.equal(await skipReason(kept), "kept");
    });

    await resetRows();
    const watchItem = await prisma.watchListItem.create({
      data: {
        userId,
        externalId: `stall-reclaim-${randomUUID()}`,
        title: "Watchlisted Show",
        mediaType: "tv",
      },
    });
    const watchlisted = await seedTorrent({
      tag: "watchlisted-stall",
      progress: 0,
      sizeGb: 14,
      title: "Watchlisted Show",
      completedAt: null,
      watchListItemId: watchItem.id,
    });
    await checkAsync("a watchlisted stalled row is never reclaimed", async () => {
      await runSweep(1);
      assert.deepEqual(deleted, []);
      assert.equal(await exists(watchlisted), true);
      assert.equal(await skipReason(watchlisted), "watchlisted");
    });

    await resetRows();
    // The "Partial · Resume at 24:28" case: whole-file progress under 1% because
    // streaming only fetched the pieces playback touched, but the viewer is
    // 24 minutes into it and means to come back.
    const partWatched = await seedTorrent({
      tag: "part-watched-stall",
      progress: 0.004,
      sizeGb: 18,
      completedAt: null,
    });
    await checkAsync("a part-watched row is never reclaimed, however little arrived", async () => {
      await runSweep(1);
      assert.deepEqual(deleted, []);
      assert.equal(await exists(partWatched), true);
      assert.equal(await skipReason(partWatched), "partial");
    });

    await resetRows();
    const watching = await seedTorrent({ tag: "on-screen-now", progress: 0, sizeGb: 11 });
    await checkAsync("the stream on screen right now is never reclaimed", async () => {
      await runSweep(1, { protectHashes: [watching] });
      assert.deepEqual(deleted, []);
      assert.equal(await exists(watching), true);
      assert.equal(
        (
          await listRetentionSweepCandidates({
            userId,
            db: prisma,
            now,
            stall,
            protectHashes: [watching],
            _foreground: { active: () => false, hash: () => null },
          })
        ).skipped.find((s) => s.hash === watching)?.reason,
        "streaming",
      );
    });

    await resetRows();
    const foreground = await seedTorrent({ tag: "foreground-stall", progress: 0, sizeGb: 11 });
    await checkAsync("the foreground hash is never reclaimed", async () => {
      deleted = [];
      await sweepRetentionCache({
        userId,
        config,
        budgetBytes: 1,
        now,
        db: prisma,
        stall,
        mode: "delete",
        _foreground: { active: () => true, hash: () => foreground },
        _deleteFn: async (_config, hash) => {
          deleted.push(hash);
          return { ok: true, message: "deleted" };
        },
      });
      assert.deepEqual(deleted, []);
      assert.equal(await exists(foreground), true);
    });

    // ── Ordering: dead weight goes before watched media ────────────────────
    await resetRows();
    const stalledRow = await seedTorrent({ tag: "order-stalled", progress: 0, sizeGb: 5 });
    const watchedRow = await seedTorrent({
      tag: "order-watched",
      status: "seeding",
      progress: 1,
      sizeGb: 5,
      createdHoursAgo: 200,
      completedAt: new Date(now.getTime() - 100 * HOUR),
    });
    await checkAsync("a stalled allocation is reclaimed before a file the viewer watched", async () => {
      const listed = await listRetentionSweepCandidates({
        userId,
        db: prisma,
        now,
        stall,
        _foreground: { active: () => false, hash: () => null },
      });
      assert.deepEqual(
        listed.candidates.map((c) => c.hash),
        [stalledRow, watchedRow],
      );
      assert.deepEqual(
        listed.candidates.map((c) => c.kind),
        ["stalled", "watched"],
      );
    });

    // ── reclaimForBytes: deficit in, guarded sweep out ─────────────────────
    await resetRows();
    const smallStall = await seedTorrent({ tag: "reclaim-small", progress: 0, sizeGb: 4 });
    const bigKept = await seedTorrent({
      tag: "reclaim-kept",
      origin: USER_ORIGIN,
      progress: 1,
      status: "seeding",
      sizeGb: 40,
    });
    await checkAsync("reclaimForBytes frees only what the deficit asks for", async () => {
      deleted = [];
      const result = await reclaimForBytes({
        userId,
        config,
        neededBytes: 2 * GB,
        now,
        db: prisma,
        stall,
        mode: "delete",
        _foreground: { active: () => false, hash: () => null },
        _deleteFn: async (_config, hash) => {
          deleted.push(hash);
          return { ok: true, message: "deleted" };
        },
      });
      assert.deepEqual(deleted, [smallStall], "only the stalled cache row was freed");
      assert.equal(await exists(bigKept), true, "kept media is never collateral");
      assert.equal(result.reclaimedBytes, 4 * GB);
    });

    await resetRows();
    const onlyKept = await seedTorrent({
      tag: "nothing-to-free",
      origin: USER_ORIGIN,
      progress: 1,
      status: "seeding",
      sizeGb: 30,
    });
    await checkAsync("reclaimForBytes frees nothing when nothing is cache", async () => {
      deleted = [];
      const result = await reclaimForBytes({
        userId,
        config,
        neededBytes: 10 * GB,
        now,
        db: prisma,
        stall,
        mode: "delete",
        _foreground: { active: () => false, hash: () => null },
        _deleteFn: async (_config, hash) => {
          deleted.push(hash);
          return { ok: true, message: "deleted" };
        },
      });
      assert.deepEqual(deleted, []);
      assert.equal(await exists(onlyKept), true);
      assert.equal(result.reclaimedBytes, 0);
    });

    // ── Preview never touches anything ─────────────────────────────────────
    await resetRows();
    const previewed = await seedTorrent({ tag: "preview-only", progress: 0, sizeGb: 16 });
    await checkAsync("preview mode reports the stalled row without deleting it", async () => {
      deleted = [];
      const result = await sweepRetentionCache({
        userId,
        config,
        budgetBytes: 1,
        now,
        db: prisma,
        stall,
        mode: "preview",
        _foreground: { active: () => false, hash: () => null },
        _deleteFn: async () => {
          throw new Error("preview must never delete");
        },
      });
      assert.deepEqual(deleted, []);
      assert.equal(await exists(previewed), true);
      assert.deepEqual(
        result.wouldDelete.map((c) => c.hash),
        [previewed],
      );
      assert.equal(result.reclaimedBytes, 16 * GB);
    });
  } finally {
    await resetRows();
    await prisma.user.deleteMany({ where: { id: userId } });
  }

  if (failures > 0) {
    console.error(`stall-reclaim.test.ts: ${failures} assertion(s) failed`);
    await prisma.$disconnect();
    process.exit(1);
  }
  console.log("stall-reclaim.test.ts: all assertions passed");
  await prisma.$disconnect();
}

runDbTest(main);
