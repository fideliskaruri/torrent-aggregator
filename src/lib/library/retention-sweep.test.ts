/**
 * Retention sweep tests — destructive cache reclamation fails closed.
 * Run: node node_modules\tsx\dist\cli.mjs src/lib/library/retention-sweep.test.ts
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import prisma from "@/lib/prisma";
import type { ClientConnectionConfig } from "@/lib/clients/types";
import { USER_ORIGIN } from "@/lib/prewarm/types";
import { STREAM_ORIGIN } from "@/lib/streaming/retention";
import {
  listRetentionSweepCandidates,
  sweepRetentionCache,
} from "./retention-sweep";

const userId = `retention-sweep-${randomUUID()}`;
const GB = 1024 * 1024 * 1024;
const now = new Date("2026-07-27T12:00:00.000Z");
const oldComplete = new Date(now.getTime() - 8 * 60 * 60 * 1000);
const config = {
  clientType: "builtin",
  host: "",
  savePath: "D:\\Downloads",
} as ClientConnectionConfig;

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
  lastUsedMinutes?: number;
  completedAt?: Date | null;
  watchListItemId?: string | null;
  title?: string;
}): Promise<string> {
  const hash = hashFor(input.tag);
  await prisma.engineTorrent.create({
    data: {
      userId,
      hash,
      name: input.title ?? input.tag,
      origin: input.origin ?? STREAM_ORIGIN,
      status: input.status ?? "seeding",
      progress: input.progress ?? 1,
      sizeBytes: BigInt((input.sizeGb ?? 1) * GB),
      lastUsedAt: new Date(now.getTime() - (input.lastUsedMinutes ?? 60) * 60_000),
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
  const count = await prisma.engineTorrent.count({
    where: { userId, hash },
  });
  return count > 0;
}

async function runSweep(budgetBytes = 1) {
  deleted = [];
  return sweepRetentionCache({
    userId,
    config,
    budgetBytes,
    now,
    db: prisma,
    mode: "delete",
    _foreground: { active: () => false, hash: () => null },
    _deleteFn: async (_config, hash) => {
      deleted.push(hash);
      return { ok: true, message: "deleted" };
    },
  });
}

async function main(): Promise<void> {
  await prisma.user.upsert({
    where: { id: userId },
    create: { id: userId, name: "retention sweep test" },
    update: {},
  });

  try {
    await resetRows();
    const unknown = await seedTorrent({ tag: "indeterminate", sizeGb: 10 });
    const indeterminate = await runSweep();
    assert.equal(await exists(unknown), true, "indeterminate item survives a sweep");
    assert.deepEqual(deleted, []);
    assert.ok(
      indeterminate.skipped.some(
        (s) => s.hash === unknown && s.reason === "indeterminate-progress",
      ),
    );

    await resetRows();
    const streaming = await seedTorrent({
      tag: "streaming-now",
      completedAt: oldComplete,
      sizeGb: 10,
    });
    deleted = [];
    const protectedResult = await sweepRetentionCache({
      userId,
      config,
      budgetBytes: 1,
      now,
      db: prisma,
      mode: "delete",
      _foreground: { active: () => true, hash: () => streaming },
      _deleteFn: async (_config, hash) => {
        deleted.push(hash);
        return { ok: true, message: "deleted" };
      },
    });
    assert.equal(await exists(streaming), true, "currently streaming item survives");
    assert.deepEqual(deleted, []);
    assert.ok(protectedResult.skipped.some((s) => s.hash === streaming && s.reason === "streaming"));

    await resetRows();
    const downloading = await seedTorrent({
      tag: "still-downloading",
      completedAt: oldComplete,
      status: "downloading",
      progress: 0.5,
      sizeGb: 10,
    });
    const downloadingResult = await runSweep();
    assert.equal(await exists(downloading), true, "still downloading item survives");
    assert.deepEqual(deleted, []);
    assert.ok(downloadingResult.skipped.some((s) => s.hash === downloading && s.reason === "downloading"));

    await resetRows();
    const kept = await seedTorrent({
      tag: "kept",
      origin: USER_ORIGIN,
      completedAt: oldComplete,
      sizeGb: 100,
    });
    const keptResult = await runSweep();
    assert.equal(await exists(kept), true, "KEPT item survives even when over budget");
    assert.deepEqual(deleted, []);
    assert.ok(keptResult.skipped.some((s) => s.hash === kept && s.reason === "kept"));

    await resetRows();
    const item = await prisma.watchListItem.create({
      data: {
        userId,
        mediaType: "tv",
        externalId: "tracked-show",
        title: "Tracked Show",
        monitored: true,
      },
    });
    const tracked = await seedTorrent({
      tag: "tracked",
      title: "Tracked Show",
      completedAt: oldComplete,
      watchListItemId: item.id,
      sizeGb: 10,
    });
    const trackedResult = await runSweep();
    assert.equal(await exists(tracked), true, "tracked/watchlisted item survives");
    assert.deepEqual(deleted, []);
    assert.ok(trackedResult.skipped.some((s) => s.hash === tracked && s.reason === "watchlisted"));


    await resetRows();
    const foregroundRace = await seedTorrent({
      tag: "foreground-race",
      completedAt: oldComplete,
      sizeGb: 10,
    });
    let activeHash: string | null = null;
    deleted = [];
    const foregroundRaceResult = await sweepRetentionCache({
      userId,
      config,
      budgetBytes: 1,
      now,
      db: prisma,
      mode: "delete",
      _foreground: { active: () => activeHash != null, hash: () => activeHash },
      _beforeDeleteCheck: (candidate) => {
        activeHash = candidate.hash;
      },
      _deleteFn: async (_config, hash) => {
        deleted.push(hash);
        return { ok: true, message: "deleted" };
      },
    });
    assert.equal(await exists(foregroundRace), true, "playback that starts during a sweep survives");
    assert.deepEqual(deleted, []);
    assert.ok(foregroundRaceResult.skipped.some((s) => s.hash === foregroundRace && s.reason === "streaming"));

    await resetRows();
    const downloadingRace = await seedTorrent({
      tag: "downloading-race",
      completedAt: oldComplete,
      sizeGb: 10,
    });
    deleted = [];
    const downloadingRaceResult = await sweepRetentionCache({
      userId,
      config,
      budgetBytes: 1,
      now,
      db: prisma,
      mode: "delete",
      _foreground: { active: () => false, hash: () => null },
      _beforeDeleteCheck: async (candidate) => {
        await prisma.engineTorrent.update({
          where: { userId_hash: { userId, hash: candidate.hash } },
          data: { status: "downloading", progress: 0.5 },
        });
      },
      _deleteFn: async (_config, hash) => {
        deleted.push(hash);
        return { ok: true, message: "deleted" };
      },
    });
    assert.equal(await exists(downloadingRace), true, "download that starts during a sweep survives");
    assert.deepEqual(deleted, []);
    assert.ok(downloadingRaceResult.skipped.some((s) => s.hash === downloadingRace && s.reason === "downloading"));


    await resetRows();
    const unknownOrigin = await seedTorrent({
      tag: "unknown-origin",
      origin: "mystery",
      completedAt: oldComplete,
      sizeGb: 10,
    });
    const knownEvictable = await seedTorrent({
      tag: "known-beside-unknown",
      completedAt: oldComplete,
      sizeGb: 10,
    });
    const unknownOriginResult = await runSweep();
    assert.equal(
      await exists(unknownOrigin),
      true,
      "unrecognised origin is indeterminate and survives while budget is exceeded",
    );
    assert.equal(await exists(knownEvictable), false);
    assert.deepEqual(deleted, [knownEvictable]);
    assert.ok(
      unknownOriginResult.skipped.some(
        (s) => s.hash === unknownOrigin && s.reason === "indeterminate-retention",
      ),
    );

    const nullOrigin = hashFor("null-origin");
    const streamBesideNull = hashFor("stream-beside-null");
    const fakeRows = [
      {
        id: "null-row",
        userId,
        hash: nullOrigin,
        name: "null-origin",
        magnet: null,
        savePath: null,
        category: null,
        status: "seeding",
        progress: 1,
        sizeBytes: BigInt(10 * GB),
        error: null,
        origin: null,
        lastUsedAt: new Date(now.getTime() - 900 * 60_000),
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "stream-row",
        userId,
        hash: streamBesideNull,
        name: "stream-beside-null",
        magnet: null,
        savePath: null,
        category: null,
        status: "seeding",
        progress: 1,
        sizeBytes: BigInt(10 * GB),
        error: null,
        origin: STREAM_ORIGIN,
        lastUsedAt: new Date(now.getTime() - 800 * 60_000),
        createdAt: now,
        updatedAt: now,
      },
    ];
    const fakeDb = {
      engineTorrent: {
        findMany: async () => fakeRows,
        findFirst: async ({ where }: { where: { hash: string } }) =>
          fakeRows.find((row) => row.hash === where.hash) ?? null,
        deleteMany: async () => ({ count: 1 }),
      },
      playbackProgress: {
        findMany: async ({ where }: { where: { infoHash: string } }) => [
          {
            completedAt: oldComplete,
            watchListItemId: null,
            title: where.infoHash === nullOrigin ? "null-origin" : "stream-beside-null",
          },
        ],
      },
      watchListItem: {
        count: async () => 0,
      },
    } as unknown as typeof prisma;
    deleted = [];
    const nullOriginResult = await sweepRetentionCache({
      userId,
      config,
      budgetBytes: 1,
      now,
      db: fakeDb,
      mode: "delete",
      _foreground: { active: () => false, hash: () => null },
      _deleteFn: async (_config, hash) => {
        deleted.push(hash);
        return { ok: true, message: "deleted" };
      },
    });
    assert.deepEqual(deleted, [streamBesideNull]);
    assert.ok(
      nullOriginResult.skipped.some(
        (s) => s.hash === nullOrigin && s.reason === "indeterminate-retention",
      ),
      "null origin is indeterminate and survives while budget is exceeded",
    );

    await resetRows();
    const evictable = await seedTorrent({
      tag: "evictable",
      completedAt: oldComplete,
      lastUsedMinutes: 900,
      sizeGb: 10,
    });
    deleted = [];
    const preview = await sweepRetentionCache({
      userId,
      config,
      budgetBytes: 1,
      now,
      db: prisma,
      mode: "preview",
      _foreground: { active: () => false, hash: () => null },
      _deleteFn: async (_config, hash) => {
        deleted.push(hash);
        return { ok: true, message: "deleted" };
      },
    });
    assert.equal(await exists(evictable), true, "preview does not delete");
    assert.deepEqual(deleted, []);
    assert.deepEqual(preview.wouldDelete.map((c) => c.hash), [evictable]);

    const evicted = await runSweep();
    assert.equal(await exists(evictable), false, "genuinely evictable item is evicted");
    assert.deepEqual(deleted, [evictable]);
    assert.deepEqual(evicted.deleted.map((c) => c.hash), [evictable]);
    assert.equal(evicted.satisfied, true);

    await resetRows();
    const old = await seedTorrent({
      tag: "old-complete",
      completedAt: new Date(now.getTime() - 12 * 60 * 60 * 1000),
      lastUsedMinutes: 60,
      sizeGb: 10,
    });
    const lessRecent = await seedTorrent({
      tag: "less-recent",
      completedAt: oldComplete,
      lastUsedMinutes: 900,
      sizeGb: 10,
    });
    const listed = await listRetentionSweepCandidates({
      userId,
      db: prisma,
      now,
      _foreground: { active: () => false, hash: () => null },
    });
    assert.deepEqual(
      listed.candidates.map((c) => c.hash),
      [old, lessRecent],
      "oldest completed sorts before merely least-recently played",
    );
  } finally {
    await resetRows();
    await prisma.user.deleteMany({ where: { id: userId } });
  }

  console.log("retention-sweep.test.ts: all assertions passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
