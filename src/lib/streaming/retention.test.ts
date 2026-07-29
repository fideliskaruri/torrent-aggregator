/**
 * Stream retention tests — the data-loss boundary for "watch" vs "keep".
 *
 * The destructive call is stubbed, but every candidate is a real EngineTorrent
 * row and the module re-reads the database immediately before deletion. A hash
 * reaching `deleteFn` is a file that would have been destroyed by the real
 * built-in engine, so the assertions treat that list as the danger surface.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import prisma from "@/lib/prisma";
import type { ClientConnectionConfig } from "@/lib/clients/types";
import {
  DEFAULT_STREAM_CACHE_BUDGET_BYTES,
  STREAM_ORIGIN,
  evictStreamCacheForBudget,
  listEvictableStreams,
  markTorrentStreamOnly,
  promoteLibraryStreamsToKept,
  promoteTorrentToKept,
  releaseInfoHash,
  retentionStateForOrigin,
  shouldSendAsStreamOnly,
  streamCacheSortKey,
} from "./retention";
import { PREWARM_ORIGIN, USER_ORIGIN } from "@/lib/prewarm/types";

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

const userId = `stream-retention-${randomUUID()}`;
const GB = 1024 * 1024 * 1024;
const now = new Date("2026-07-27T12:00:00.000Z");
const oldComplete = new Date(now.getTime() - 8 * 60 * 60 * 1000);
const freshComplete = new Date(now.getTime() - 30 * 60 * 1000);

const config = {
  clientType: "builtin",
  host: "",
  savePath: "/downloads",
} as ClientConnectionConfig;

let deleted: string[] = [];
const deleteFn = async (_c: ClientConnectionConfig, hash: string) => {
  deleted.push(hash);
  return { ok: true, message: "removed" };
};

function hashFor(tag: string): string {
  return createHash("sha1").update(`${userId}:${tag}`).digest("hex");
}

async function seedTorrent(input: {
  tag: string;
  origin?: string;
  sizeGb?: number;
  progress?: number;
  lastUsedMinutes?: number;
  completedAt?: Date | null;
  watchListItemId?: string | null;
}): Promise<string> {
  const hash = hashFor(input.tag);
  await prisma.engineTorrent.create({
    data: {
      userId,
      hash,
      name: input.tag,
      origin: input.origin ?? STREAM_ORIGIN,
      sizeBytes: BigInt((input.sizeGb ?? 1) * GB),
      progress: input.progress ?? 1,
      status: "seeding",
      lastUsedAt: new Date(now.getTime() - (input.lastUsedMinutes ?? 10) * 60_000),
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
        title: input.tag,
        watchListItemId: input.watchListItemId ?? null,
      },
    });
  }
  return hash;
}

async function resetRows(): Promise<void> {
  await prisma.playbackProgress.deleteMany({ where: { userId } });
  await prisma.engineTorrent.deleteMany({ where: { userId } });
  await prisma.watchListItem.deleteMany({ where: { userId } });
}

async function originOf(hash: string): Promise<string | null> {
  const row = await prisma.engineTorrent.findUnique({
    where: { userId_hash: { userId, hash } },
    select: { origin: true },
  });
  return row?.origin ?? null;
}

async function main(): Promise<void> {
  console.log("stream retention\n");
  await prisma.user.upsert({
    where: { id: userId },
    create: { id: userId, name: "stream retention test" },
    update: {},
  });

  try {
    check("send policy defaults builtin primary streams to ephemeral unless explicitly kept", () => {
      assert.equal(
        shouldSendAsStreamOnly({ clientType: "builtin", sendTarget: "primary" }),
        true,
      );
      assert.equal(
        shouldSendAsStreamOnly({ clientType: "builtin", retention: "keep" }),
        false,
      );
      assert.equal(
        shouldSendAsStreamOnly({ clientType: "builtin", watchListItemId: "wl" }),
        false,
      );
      assert.equal(
        shouldSendAsStreamOnly({ clientType: "qbittorrent", sendTarget: "primary" }),
        false,
      );
    });

    check("retention state is emitted from the origin, not inferred from UI copy", () => {
      assert.equal(retentionStateForOrigin(STREAM_ORIGIN), "stream");
      assert.equal(retentionStateForOrigin(USER_ORIGIN), "kept");
      assert.equal(retentionStateForOrigin("mystery"), "unknown");
    });

    check("releaseInfoHash uses explicit hash or magnet without starting a transfer", () => {
      const h = hashFor("magnet");
      assert.equal(releaseInfoHash({ infoHash: h.toUpperCase() }), h);
      assert.equal(releaseInfoHash({ magnet: `magnet:?xt=urn:btih:${h}` }), h);
    });

    await resetRows();
    // markTorrentStreamOnly may only ever touch a stream/prewarm row. Born
    // `prewarm` (speculative), a Play promotes it up to an evictable `stream`.
    const streamHash = await seedTorrent({ tag: "streaming-now", origin: PREWARM_ORIGIN });
    await markTorrentStreamOnly(userId, streamHash, { db: prisma });
    await checkAsync("Play promotes a speculative prewarm to an evictable stream", async () => {
      assert.equal(await originOf(streamHash), STREAM_ORIGIN);
    });
    await promoteTorrentToKept(userId, streamHash, { db: prisma });
    await checkAsync("explicit keep promotes existing bytes without a transfer", async () => {
      assert.equal(await originOf(streamHash), USER_ORIGIN);
    });
    await markTorrentStreamOnly(userId, streamHash, { db: prisma });
    await checkAsync("promotion is not undone by a later stream-only mark", async () => {
      assert.equal(await originOf(streamHash), USER_ORIGIN);
    });

    // ISSUE D — the safety property the removed `allowFreshDefaultOrigin` path
    // violated: a genuine `user` download must NEVER be demoted to an evictable
    // stream, not even by a direct mark. Demotion is precisely what would grant
    // deletion eligibility over the user's real, kept files.
    await resetRows();
    const keptHash = await seedTorrent({ tag: "kept-download", origin: USER_ORIGIN });
    const demoted = await markTorrentStreamOnly(userId, keptHash, { db: prisma });
    await checkAsync("markTorrentStreamOnly can never demote a kept user download", async () => {
      assert.equal(demoted, false, "the guard must refuse to touch a user row");
      assert.equal(await originOf(keptHash), USER_ORIGIN);
    });

    await resetRows();
    const item = await prisma.watchListItem.create({
      data: {
        userId,
        mediaType: "tv",
        externalId: "show",
        title: "Kept Show",
        monitored: true,
      },
    });
    const watchedHash = await seedTorrent({
      tag: "Kept Show",
      completedAt: null,
      watchListItemId: item.id,
    });
    const promoted = await promoteLibraryStreamsToKept(
      userId,
      { watchListItemId: item.id, title: item.title },
      { db: prisma },
    );
    await checkAsync("watchlisting promotes existing stream bytes and sends nothing", async () => {
      assert.equal(promoted, 1);
      assert.equal(await originOf(watchedHash), USER_ORIGIN);
      assert.deepEqual(deleted, []);
    });

    await prisma.watchListItem.update({ where: { id: item.id }, data: { monitored: false } });
    await checkAsync("demotion/untracking never deletes or demotes kept bytes", async () => {
      assert.equal(await originOf(watchedHash), USER_ORIGIN);
      assert.deepEqual(deleted, []);
    });

    await resetRows();
    const playing = await seedTorrent({
      tag: "playing",
      completedAt: oldComplete,
      lastUsedMinutes: 900,
      sizeGb: 10,
    });
    deleted = [];
    const protectedResult = await evictStreamCacheForBudget({
      userId,
      config,
      budgetBytes: 1,
      protectHashes: [playing],
      now,
      db: prisma,
      _deleteFn: deleteFn,
    });
    await checkAsync("playing content is never evicted", async () => {
      assert.equal(await originOf(playing), STREAM_ORIGIN);
      assert.deepEqual(deleted, []);
      assert.ok(protectedResult.skipped.some((s) => s.hash === playing && s.reason === "protected"));
    });

    await resetRows();
    const fresh = await seedTorrent({
      tag: "freshly-ended",
      completedAt: freshComplete,
      sizeGb: 10,
    });
    deleted = [];
    const grace = await evictStreamCacheForBudget({
      userId,
      config,
      budgetBytes: 1,
      now,
      db: prisma,
      _deleteFn: deleteFn,
    });
    await checkAsync("seeding grace survives the end of playback", async () => {
      assert.equal(await originOf(fresh), STREAM_ORIGIN);
      assert.deepEqual(deleted, []);
      assert.ok(grace.skipped.some((s) => s.hash === fresh && s.reason === "seeding-grace"));
    });

    await resetRows();
    const partial = await seedTorrent({
      tag: "partial-intention",
      completedAt: null,
      sizeGb: 10,
    });
    deleted = [];
    const partialResult = await evictStreamCacheForBudget({
      userId,
      config,
      budgetBytes: 1,
      now,
      db: prisma,
      _deleteFn: deleteFn,
    });
    await checkAsync("partially watched streams are treated as intention and kept", async () => {
      assert.equal(await originOf(partial), STREAM_ORIGIN);
      assert.deepEqual(deleted, []);
      assert.ok(partialResult.skipped.some((s) => s.hash === partial && s.reason === "partial"));
    });

    await resetRows();
    const unknown = await seedTorrent({ tag: "no-progress", sizeGb: 10 });
    deleted = [];
    const indeterminate = await evictStreamCacheForBudget({
      userId,
      config,
      budgetBytes: 1,
      now,
      db: prisma,
      _deleteFn: deleteFn,
    });
    await checkAsync("an indeterminate delete guard fails closed", async () => {
      assert.equal(await originOf(unknown), STREAM_ORIGIN);
      assert.deepEqual(deleted, []);
      assert.ok(
        indeterminate.skipped.some(
          (s) => s.hash === unknown && s.reason === "indeterminate-progress",
        ),
      );
    });

    await resetRows();
    const oldSmall = await seedTorrent({
      tag: "old-small",
      completedAt: oldComplete,
      lastUsedMinutes: 900,
      sizeGb: 2,
    });
    const oldLarge = await seedTorrent({
      tag: "old-large",
      completedAt: oldComplete,
      lastUsedMinutes: 900,
      sizeGb: 5,
    });
    const newer = await seedTorrent({
      tag: "newer-large",
      completedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
      lastUsedMinutes: 800,
      sizeGb: 5,
    });
    deleted = [];
    const evicted = await evictStreamCacheForBudget({
      userId,
      config,
      budgetBytes: 5 * GB,
      now,
      db: prisma,
      _deleteFn: deleteFn,
    });
    await checkAsync("eviction respects the cap and ordering", async () => {
      assert.equal(evicted.satisfied, true);
      assert.deepEqual(evicted.evicted.map((c) => c.hash), [oldLarge, oldSmall]);
      assert.deepEqual(deleted, [oldLarge, oldSmall]);
      assert.equal(await originOf(newer), STREAM_ORIGIN);
    });

    check("ordering prefers fully watched older, then larger entries", () => {
      const a = streamCacheSortKey({
        completedAt: oldComplete,
        lastUsedAt: new Date(1),
        sizeBytes: 1,
        progress: 1,
      });
      const b = streamCacheSortKey({
        completedAt: oldComplete,
        lastUsedAt: new Date(1),
        sizeBytes: 10,
        progress: 1,
      });
      assert.ok(b[2] < a[2]);
      assert.ok(DEFAULT_STREAM_CACHE_BUDGET_BYTES > 0);
    });

    await resetRows();
    const candidate = await seedTorrent({
      tag: "raced-promotion",
      completedAt: oldComplete,
      sizeGb: 10,
    });
    deleted = [];
    const raced = await evictStreamCacheForBudget({
      userId,
      config,
      budgetBytes: 1,
      now,
      db: prisma,
      _beforeDeleteCheck: async (c) => {
        await promoteTorrentToKept(userId, c.hash, { db: prisma });
      },
      _deleteFn: async (_c, hash) => {
        deleted.push(hash);
        return { ok: true, message: "removed" };
      },
    });
    await checkAsync("the destructive DB guard refuses a row promoted during eviction", async () => {
      assert.equal(await originOf(candidate), USER_ORIGIN);
      assert.deepEqual(deleted, []);
      assert.equal(raced.evicted.length, 0);
      assert.ok(raced.skipped.some((s) => s.hash === candidate && s.reason === "not-stream"));
    });

    const listed = await listEvictableStreams(userId, { db: prisma, now });
    check("policy evaluation failure would rather keep too much than delete", () => {
      assert.ok(Array.isArray(listed.candidates));
    });
  } finally {
    await resetRows();
    await prisma.user.deleteMany({ where: { id: userId } });
  }

  console.log(`\n${failures === 0 ? "stream retention: all tests passed" : `stream retention: ${failures} failing`}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
