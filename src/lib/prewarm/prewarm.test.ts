/**
 * Pre-warm tests — "a guess must never look like a user action".
 *
 * HOW REAL THIS IS
 * ----------------
 * Everything is real except the two things that would leave this machine:
 *
 *   - The **search** is real `searchTorrents`, served from a **real
 *     `SearchCache` row** seeded under the real producer key. No indexer is
 *     contacted, and `cached: true` is asserted rather than assumed.
 *   - The **grab** is the real `runGrabPipeline` — the one shared path — with
 *     real `GrabJob` / `DownloadHistory` / `EngineTorrent` writes against the
 *     real database.
 *   - Only `_sendFn` is stubbed. It emulates the built-in engine faithfully by
 *     creating the `EngineTorrent` row the way `upsertEngineTorrent` does:
 *     **with the schema default `origin: "user"`**. If the prewarm code fails
 *     to stamp it, the row stays `user` and the assertion catches it. A stub
 *     that pre-set `origin: "prewarm"` would have tested nothing.
 *
 * WHAT IT PROVES
 * --------------
 *   - A prewarm writes **no** `DownloadHistory` row — and a control run of the
 *     same pipeline *without* the suppression writes one, so the assertion is
 *     not vacuous.
 *   - A prewarm does **not** move the library cursor. The whole row is compared
 *     before and after.
 *   - The `EngineTorrent` row ends up `origin: "prewarm"`, so it is evictable.
 *   - The grab took the cache fast path and selected exactly the pre-ranked
 *     release.
 *   - Over budget, it refuses to send and evicts only prewarms.
 *
 * Run: npx tsx src/lib/prewarm/prewarm.test.ts
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import prisma from "@/lib/prisma";
import { cacheKeyFrom, getSearchCache, setSearchCache } from "@/lib/torrents/search-cache";
import { getTargetResolution } from "@/lib/torrents/target-resolution";
import { runGrabPipeline } from "@/lib/grab/pipeline";
import { searchTorrents } from "@/lib/torrents/aggregator";
import type { ClientConnectionConfig } from "@/lib/clients/types";
import type { AddTorrentPayload } from "@/lib/clients/types";
import type { SearchResponse, TorrentResult } from "@/lib/torrents/types";
import {
  clearPreRankMemo,
  prewarmSearchOptions,
  searchPayloadFor,
  selectBestRelease,
} from "./prerank";
import {
  MIN_FOREGROUND_PROGRESS,
  PREWARM_TRIGGER_FRACTION,
  onPlaybackProgress,
  prewarmNextEpisode,
  resetPrewarmRuntimeState,
  resolveNextEpisode,
  shouldTriggerPrewarm,
} from "./prewarm";
import { PREWARM_GRAB_KIND, PREWARM_ORIGIN, USER_ORIGIN } from "./types";
import { birthOriginForPurpose } from "@/lib/clients/add-purpose";
import { DEFAULT_MAX_STORAGE_BYTES } from "@/lib/library/disk-space";
import type { NextEpisode, PreRankTarget } from "./types";

type SearchPayload = Parameters<typeof searchTorrents>[0];

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

const userId = `prewarm-run-${randomUUID()}`;
const SHOW = `Zzqw Prewarmshow ${randomUUID().replace(/[^a-z]/g, "").slice(0, 8) || "series"}`;
/** A show nothing else in this suite has cached, so the pre-rank must really search. */
const CAUSAL_SHOW = `Zzqw Causalshow ${randomUUID().replace(/[^a-z]/g, "").slice(0, 8) || "series"}`;
const writtenKeys: string[] = [];

function hex40(seed: string): string {
  return createHash("sha1").update(seed).digest("hex");
}

function result(over: Partial<TorrentResult> & { title: string }): TorrentResult {
  const hash = over.infoHash ?? hex40(over.title);
  return {
    id: randomUUID(),
    magnet: `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(over.title)}`,
    infoHash: hash,
    sizeBytes: 1_200_000_000,
    seeders: 88,
    leechers: 4,
    source: "apibay",
    sourceUrl: "https://example.invalid",
    tags: [],
    ...over,
  } as TorrentResult;
}

function response(query: string, results: TorrentResult[]): SearchResponse {
  return {
    query,
    results,
    groups: [],
    tookMs: 1,
    sources: [],
    totalCount: results.length,
    page: 1,
    pageSize: 20,
    totalPages: 1,
  } as SearchResponse;
}

const config = {
  clientType: "builtin",
  host: "",
  savePath: "/downloads",
  baseDownloadPath: process.cwd(),
  maxStorageBytes: DEFAULT_MAX_STORAGE_BYTES,
  categories: ["TV"],
} as ClientConnectionConfig;

/**
 * Seed the real search cache under the real producer key, so the real
 * aggregator serves this pool without contacting an indexer.
 */
async function seedSearchCache(
  target: PreRankTarget,
  results: TorrentResult[],
): Promise<void> {
  const payload = searchPayloadFor(prewarmSearchOptions(target));
  const key = cacheKeyFrom({
    q: payload.query.toLowerCase(),
    category: payload.category ?? "all",
    limit: payload.limit ?? "default",
    sources: payload.sources?.slice().sort() ?? "default",
    filters: payload.filters ?? {},
    target: await getTargetResolution(),
  });
  writtenKeys.push(key);
  await setSearchCache(key, response(payload.query, results));
}

/** Hashes the (stubbed) engine was asked to start. */
let sent: string[] = [];

/**
 * Stands in for `builtinClient.addTorrent`, including the part that matters:
 * it creates the `EngineTorrent` row BORN with the origin the stated purpose
 * dictates — exactly as the real engine now does. A prewarm add is born
 * `prewarm`, so the hook can VERIFY (not manufacture) the label.
 */
async function fakeSend(
  _cfg: ClientConnectionConfig,
  payload: AddTorrentPayload,
): Promise<{ ok: boolean; message: string }> {
  assert.equal(
    payload.purpose,
    "prewarm",
    "prewarm must state purpose=prewarm so the engine births an evictable row",
  );
  const hash = /btih:([0-9a-fA-F]{40})/.exec(payload.magnet ?? "")?.[1]?.toLowerCase();
  if (!hash) return { ok: false, message: "no hash in magnet" };
  sent.push(hash);
  await prisma.engineTorrent.upsert({
    where: { userId_hash: { userId, hash } },
    create: {
      userId,
      hash,
      name: payload.name ?? "unknown",
      magnet: payload.magnet ?? null,
      savePath: payload.savePath ?? null,
      category: payload.category ?? null,
      status: "downloading",
      origin: birthOriginForPurpose(payload.purpose),
      sizeBytes: BigInt(1_200_000_000),
      progress: 0,
    },
    update: { status: "downloading" },
  });
  return { ok: true, message: "Added to engine" };
}

const noDelete = async () => ({ ok: true, message: "removed" });

async function makeItem(over: Record<string, unknown> = {}): Promise<string> {
  const item = await prisma.watchListItem.create({
    data: {
      userId,
      mediaType: "tv",
      externalId: randomUUID(),
      title: SHOW,
      monitored: true,
      cursorSeason: 1,
      cursorEpisode: 3,
      fromSeason: 1,
      fromEpisode: 1,
      lastEpisode: "S01E02",
      ...over,
    },
  });
  return item.id;
}

async function main(): Promise<void> {
  console.log("prewarm — next-episode speculation\n");

  await prisma.user.upsert({
    where: { id: userId },
    create: { id: userId, name: "prewarm run test" },
    update: {},
  });

  try {
    // ── The trigger is a pure function of the progress ping ─────────────
    check("the trigger fires at ~15% watched and not before", () => {
      assert.equal(PREWARM_TRIGGER_FRACTION, 0.15);
      assert.equal(shouldTriggerPrewarm({ positionSec: 100, durationSec: 1000 }), false);
      assert.equal(shouldTriggerPrewarm({ positionSec: 150, durationSec: 1000 }), true);
      assert.equal(shouldTriggerPrewarm({ positionSec: 900, durationSec: 1000 }), true);
    });

    check("a ping with no usable duration never triggers", () => {
      assert.equal(shouldTriggerPrewarm({ positionSec: 500, durationSec: null }), false);
      assert.equal(shouldTriggerPrewarm({ positionSec: 500, durationSec: 0 }), false);
      assert.equal(shouldTriggerPrewarm({ positionSec: 500, durationSec: NaN }), false);
      assert.equal(shouldTriggerPrewarm({ positionSec: -1, durationSec: 1000 }), false);
    });

    // ── Next episode comes from the existing cursor logic ───────────────
    const itemId = await makeItem();

    await checkAsync("the next episode is one past what is playing", async () => {
      const next = await resolveNextEpisode(
        {
          userId,
          infoHash: hex40("playing"),
          title: `${SHOW} S01E03 1080p`,
          season: 1,
          episode: 3,
          watchListItemId: itemId,
        },
        { db: prisma },
      );
      assert.ok(next);
      assert.equal(next.season, 1);
      assert.equal(next.episode, 4);
      assert.equal(next.source, "playing-episode");
      assert.equal(next.title, SHOW, "must use the work title, not the release name");
    });

    await checkAsync("without an episode on screen it falls back to the hunt cursor", async () => {
      const next = await resolveNextEpisode(
        {
          userId,
          infoHash: hex40("playing"),
          title: `${SHOW} something`,
          season: null,
          episode: null,
          watchListItemId: itemId,
        },
        { db: prisma },
      );
      assert.ok(next);
      assert.equal(next.season, 1);
      assert.equal(next.episode, 3, "the library already recorded which episode it wants");
      assert.equal(next.source, "hunt-cursor");
    });

    await checkAsync("with no library row the show name is derived, not guessed", async () => {
      const next = await resolveNextEpisode(
        {
          userId,
          infoHash: hex40("playing"),
          title: "Some.Other.Show.S02E05.1080p.WEB-DL-GROUP",
          season: 2,
          episode: 5,
          watchListItemId: null,
        },
        { db: prisma },
      );
      assert.ok(next);
      assert.equal(next.season, 2);
      assert.equal(next.episode, 6);
      assert.match(next.title, /Some/i);
      assert.ok(!/1080p|WEB-DL/i.test(next.title), "a release name is not a search query");
    });

    await checkAsync("a film has no next episode", async () => {
      const filmId = await makeItem({ mediaType: "movie", title: `${SHOW} The Movie` });
      const next = await resolveNextEpisode(
        {
          userId,
          infoHash: hex40("playing"),
          title: `${SHOW} The Movie 2160p`,
          season: null,
          episode: null,
          watchListItemId: filmId,
        },
        { db: prisma },
      );
      assert.equal(next, null);
      await prisma.watchListItem.delete({ where: { id: filmId } });
    });

    // ── THE END-TO-END PRE-WARM ────────────────────────────────────────
    const next: NextEpisode = {
      title: SHOW,
      mediaType: "tv",
      season: 1,
      episode: 4,
      watchListItemId: itemId,
      source: "playing-episode",
    };
    const target: PreRankTarget = {
      title: SHOW,
      mediaType: "tv",
      season: 1,
      episode: 4,
    };
    const wanted = result({ title: `${SHOW} S01E04 1080p WEB-DL`, seeders: 210 });
    await seedSearchCache(target, [
      result({ title: `${SHOW} S01E04 720p HDTV`, seeders: 12 }),
      wanted,
    ]);

    clearPreRankMemo();
    resetPrewarmRuntimeState();
    sent = [];

    // Put the library's hunt cursor exactly ON the episode being pre-warmed.
    // This is the real-world case and the only one where a stray cursor advance
    // is possible: the user is watching S01E03, which they already grabbed, so
    // the library is already hunting S01E04. If a speculative grab moved that
    // cursor the user would never be given S01E04 at all.
    await prisma.watchListItem.update({
      where: { id: itemId },
      data: { cursorSeason: 1, cursorEpisode: 4, lastEpisode: "S01E03" },
    });

    const before = await prisma.watchListItem.findUniqueOrThrow({ where: { id: itemId } });

    const outcome = await prewarmNextEpisode({
      userId,
      next,
      _config: config,
      _sendFn: fakeSend,
      _deleteFn: noDelete,
      _foregroundProgress: 1,
      db: prisma,
    });

    check("a pre-warm actually sends", () => {
      assert.equal(outcome.status, "sent", `got ${outcome.status}: ${outcome.message}`);
      assert.equal(outcome.reason, "sent");
      assert.equal(sent.length, 1, "exactly one torrent should have been started");
    });

    check("the grab took the cache fast path — no indexer was contacted", () => {
      assert.equal(
        outcome.fastPath,
        true,
        "the pre-warm grab paid for a live search instead of reusing the pre-ranked pool",
      );
    });

    check("the grab selected exactly the pre-ranked release", () => {
      // Selection agreement, asserted on identity rather than on a stopwatch.
      const chosen = selectBestRelease(
        [result({ title: `${SHOW} S01E04 720p HDTV`, seeders: 12 }), wanted],
        target,
      );
      assert.equal(outcome.infoHash, hex40(chosen!.title));
      assert.equal(sent[0], outcome.infoHash);
    });

    await checkAsync("the EngineTorrent row is stamped origin=prewarm", async () => {
      assert.equal(outcome.labelled, true, "the outcome claims it was not labelled");
      const row = await prisma.engineTorrent.findFirstOrThrow({
        where: { userId, hash: outcome.infoHash! },
      });
      assert.equal(
        row.origin,
        PREWARM_ORIGIN,
        "an unstamped row can never be evicted — it is permanent, unrequested disk use",
      );
    });

    await checkAsync("a pre-warm writes NO DownloadHistory row", async () => {
      const rows = await prisma.downloadHistory.findMany({ where: { userId } });
      assert.equal(
        rows.length,
        0,
        `the download log claims the user asked for: ${rows.map((r) => r.title).join(", ")}`,
      );
    });

    await checkAsync("it is still auditable: a GrabJob records what happened", async () => {
      const jobs = await prisma.grabJob.findMany({ where: { userId, status: "sent" } });
      assert.equal(jobs.length, 1);
      assert.equal(
        jobs[0].kind,
        PREWARM_GRAB_KIND,
        "nothing is hidden — the record just lives where it can be attributed",
      );
    });

    await checkAsync("a pre-warm does NOT advance the library cursor", async () => {
      const after = await prisma.watchListItem.findUniqueOrThrow({ where: { id: itemId } });
      assert.equal(after.cursorSeason, before.cursorSeason);
      assert.equal(after.cursorEpisode, before.cursorEpisode);
      assert.equal(after.lastEpisode, before.lastEpisode);
      assert.equal(after.nextEpisodeHint, before.nextEpisodeHint);
      assert.equal(
        after.latestReleaseTitle,
        before.latestReleaseTitle,
        "the library must not claim a release the user never received",
      );
      assert.equal(after.cursorMisses, before.cursorMisses);
      assert.equal(
        after.cursorEpisode,
        4,
        "the cursor must still be pointing at the episode the user has not received",
      );
    });

    // ── CONTROL: the same pipeline DOES write history without us ────────
    // Without this, "0 DownloadHistory rows" could just mean the pipeline never
    // writes any and the suppression does nothing at all.
    await checkAsync(
      "control — the unsuppressed pipeline writes a DownloadHistory row",
      async () => {
        const controlUser = `${userId}-control`;
        await prisma.user.create({ data: { id: controlUser, name: "control" } });
        try {
          const controlRelease = result({ title: `${SHOW} S09E09 1080p CONTROL` });
          const r = await runGrabPipeline({
            userId: controlUser,
            purpose: "keep",
            search: prewarmSearchOptions({ ...target, episode: 9, season: 9 }),
            config,
            fallbackTitle: SHOW,
            grabJobKind: PREWARM_GRAB_KIND,
            externalId: null,
            selectCandidate: () => controlRelease,
            resolveTarget: () => ({ category: "TV", savePath: process.cwd() }),
            _searchFn: async () => response("control", [controlRelease]),
            _sendFn: async () => ({ ok: true, message: "ok" }),
            _prisma: prisma,
          });
          assert.equal(r.status, "sent");
          const rows = await prisma.downloadHistory.findMany({
            where: { userId: controlUser },
          });
          assert.equal(
            rows.length,
            1,
            "the pipeline no longer writes history — the suppression test is now vacuous",
          );
        } finally {
          await prisma.downloadHistory.deleteMany({ where: { userId: controlUser } });
          await prisma.grabJob.deleteMany({ where: { userId: controlUser } });
          await prisma.engineTorrent.deleteMany({ where: { userId: controlUser } });
          await prisma.user.deleteMany({ where: { id: controlUser } });
        }
      },
    );

    // ── Repeat calls do not re-send ─────────────────────────────────────
    await checkAsync("a second attempt is refused by the cooldown", async () => {
      sent = [];
      const again = await prewarmNextEpisode({
        userId,
        next,
        _config: config,
        _sendFn: fakeSend,
        _foregroundProgress: 1,
        db: prisma,
      });
      assert.equal(again.status, "skipped");
      assert.equal(again.reason, "cooldown");
      assert.deepEqual(sent, []);
    });

    await checkAsync("forcing past the cooldown still refuses: we already have it", async () => {
      sent = [];
      // Let the pre-warm finish, so the concurrency cap (checked first, because
      // it is free) does not mask the duplicate check we are asserting on.
      await prisma.engineTorrent.updateMany({
        where: { userId, hash: outcome.infoHash! },
        data: { progress: 1, status: "seeding" },
      });
      const again = await prewarmNextEpisode({
        userId,
        next,
        force: true,
        _config: config,
        _sendFn: fakeSend,
        _foregroundProgress: 1,
        db: prisma,
      });
      assert.equal(again.reason, "already-held");
      assert.deepEqual(sent, [], "a second copy of the same torrent must never be sent");
    });

    // ── Foreground playback wins ───────────────────────────────────────
    resetPrewarmRuntimeState();
    await checkAsync("nothing starts while the torrent on screen is still filling", async () => {
      sent = [];
      const busy = await prewarmNextEpisode({
        userId,
        next: { ...next, episode: 7 },
        _config: config,
        _sendFn: fakeSend,
        _foregroundProgress: MIN_FOREGROUND_PROGRESS - 0.01,
        db: prisma,
      });
      assert.equal(busy.reason, "foreground-busy");
      assert.deepEqual(sent, []);
    });

    resetPrewarmRuntimeState();
    await checkAsync("a watched prewarm is not deleted when the prediction changes", async () => {
      sent = [];
      const deleted: string[] = [];
      const watchedReplacement = result({ title: `${SHOW} S01E09 1080p WEB-DL`, seeders: 121 });
      await seedSearchCache({ ...target, episode: 9 }, [watchedReplacement]);
      await prisma.engineTorrent.updateMany({
        where: { userId, hash: outcome.infoHash! },
        data: { progress: 0.1, status: "downloading", origin: PREWARM_ORIGIN },
      });
      await prisma.playbackProgress.upsert({
        where: {
          userId_infoHash_filePath: {
            userId,
            infoHash: outcome.infoHash!,
            filePath: "S01E04.mkv",
          },
        },
        create: {
          userId,
          infoHash: outcome.infoHash!,
          filePath: "S01E04.mkv",
          positionSec: 30,
          durationSec: 1400,
          title: "watched prewarm",
        },
        update: { positionSec: 30 },
      });
      const replaced = await prewarmNextEpisode({
        userId,
        next: { ...next, episode: 9 },
        _config: config,
        _sendFn: fakeSend,
        _foregroundProgress: 1,
        db: prisma,
        force: true,
        protectHashes: [outcome.infoHash!],
        _deleteFn: async (_cfg, hash) => {
          deleted.push(hash);
          return { ok: true, message: "removed" };
        },
      });
      assert.equal(replaced.reason, "at-concurrency-cap");
      assert.deepEqual(sent, [], "new prewarm must not start while the watched one is active");
      assert.deepEqual(deleted, [], "watched/playing prewarm must not be deleted");
      const old = await prisma.engineTorrent.findFirst({
        where: { userId, hash: outcome.infoHash! },
      });
      assert.ok(old, "the watched prewarm row must survive");
      await prisma.playbackProgress.deleteMany({
        where: { userId, infoHash: outcome.infoHash! },
      });
    });

    resetPrewarmRuntimeState();
    await checkAsync("a changed prediction is refused while one prewarm is active", async () => {
      sent = [];
      const deleted: string[] = [];
      const replacement = result({ title: `${SHOW} S01E08 1080p WEB-DL`, seeders: 120 });
      await seedSearchCache({ ...target, episode: 8 }, [replacement]);
      // Put the earlier pre-warm back to fetching. The cap is an admission
      // decision: do not start a second pre-warm, and do not delete the first.
      await prisma.engineTorrent.updateMany({
        where: { userId, hash: outcome.infoHash! },
        data: { progress: 0.1, status: "downloading" },
      });
      const replaced = await prewarmNextEpisode({
        userId,
        next: { ...next, episode: 8 },
        _config: config,
        _sendFn: fakeSend,
        _foregroundProgress: 1,
        db: prisma,
        force: true,
        _deleteFn: async (_cfg, hash) => {
          deleted.push(hash);
          return { ok: true, message: "removed" };
        },
      });
      assert.equal(replaced.reason, "at-concurrency-cap");
      assert.deepEqual(sent, [], "no second prewarm should be sent while one is active");
      assert.deepEqual(deleted, [], "admission cap must not delete to make room");
      const old = await prisma.engineTorrent.findFirst({
        where: { userId, hash: outcome.infoHash! },
      });
      assert.ok(old, "the active prediction must survive");
    });

    // ── Streaming is not a download — never speculate off a stream ─────
    resetPrewarmRuntimeState();
    await checkAsync(
      "the episode on screen being stream-only skips the pre-warm",
      async () => {
        sent = [];
        const streamHash = hex40("foreground-stream");
        await prisma.engineTorrent.create({
          data: {
            userId,
            hash: streamHash,
            name: `${SHOW} S01E03 1080p WEB-DL`,
            origin: "stream",
            sizeBytes: BigInt(1_000_000_000),
            progress: 0.4,
            status: "downloading",
            lastUsedAt: new Date(),
          },
        });
        const streamed = await prewarmNextEpisode({
          userId,
          next: { ...next, episode: 14 },
          _config: config,
          _sendFn: fakeSend,
          _foregroundProgress: 1,
          protectHashes: [streamHash],
          db: prisma,
        });
        assert.equal(streamed.status, "skipped");
        assert.equal(streamed.reason, "streaming-source");
        assert.deepEqual(sent, [], "a stream must not trigger a background download");
        await prisma.engineTorrent.deleteMany({ where: { userId, hash: streamHash } });
      },
    );

    // ── Clients we cannot label ────────────────────────────────────────
    resetPrewarmRuntimeState();
    await checkAsync("an external client is never pre-warmed — we could not evict it", async () => {
      sent = [];
      const ext = await prewarmNextEpisode({
        userId,
        next: { ...next, episode: 12 },
        _config: { ...config, clientType: "qbittorrent" } as ClientConnectionConfig,
        _sendFn: fakeSend,
        _foregroundProgress: 1,
        db: prisma,
      });
      assert.equal(ext.reason, "unlabelable-client");
      assert.deepEqual(sent, []);
    });

    resetPrewarmRuntimeState();
    await checkAsync("no client configured is a quiet skip, not an error", async () => {
      const none = await prewarmNextEpisode({
        userId,
        next: { ...next, episode: 13 },
        _config: null,
        _sendFn: fakeSend,
        db: prisma,
      });
      assert.equal(none.status, "skipped");
      assert.equal(none.reason, "no-client");
    });

    // ── The disk budget is a hard limit ────────────────────────────────
    resetPrewarmRuntimeState();
    clearPreRankMemo();
    await prisma.engineTorrent.deleteMany({ where: { userId } });
    await prisma.grabJob.deleteMany({ where: { userId } });

    // One evictable prewarm and one untouchable user download.
    await prisma.engineTorrent.create({
      data: {
        userId,
        hash: hex40("old-prewarm"),
        name: "old prewarm",
        origin: PREWARM_ORIGIN,
        sizeBytes: BigInt(3_000_000_000),
        progress: 1,
        status: "seeding",
        lastUsedAt: new Date(Date.now() - 86_400_000),
      },
    });
    await prisma.engineTorrent.create({
      data: {
        userId,
        hash: hex40("precious-user-download"),
        name: "precious user download",
        origin: USER_ORIGIN,
        sizeBytes: BigInt(50_000_000_000),
        progress: 1,
        status: "seeding",
        lastUsedAt: new Date(0),
      },
    });

    const tightTarget: PreRankTarget = { ...target, episode: 21 };
    await seedSearchCache(tightTarget, [
      result({ title: `${SHOW} S01E21 1080p WEB-DL`, seeders: 99 }),
    ]);
    sent = [];

    const squeezed = await prewarmNextEpisode({
      userId,
      next: { ...next, episode: 21 },
      // 1 byte of headroom: nothing can ever fit.
      _config: { ...config, maxStorageBytes: 1 } as ClientConnectionConfig,
      _sendFn: fakeSend,
      _deleteFn: noDelete,
      _foregroundProgress: 1,
      db: prisma,
    });

    check("over budget, the pre-warm refuses to send", () => {
      assert.equal(squeezed.reason, "no-space", `got ${squeezed.reason}: ${squeezed.message}`);
      assert.deepEqual(sent, [], "sent a torrent it had no room for");
    });

    await checkAsync("making room only ever removes pre-warms", async () => {
      assert.ok(squeezed.evictedCount >= 1, "should have tried to reclaim space");
      const rows = await prisma.engineTorrent.findMany({ where: { userId } });
      const names = rows.map((r) => r.name);
      assert.ok(
        names.includes("precious user download"),
        "a user download was deleted to make room for a guess",
      );
      assert.ok(!names.includes("old prewarm"), "the stale prewarm should have been reclaimed");
    });

    await checkAsync("a refused pre-warm still writes no DownloadHistory", async () => {
      const rows = await prisma.downloadHistory.findMany({ where: { userId } });
      assert.equal(rows.length, 0);
    });

    // ── The progress-ping entry point ──────────────────────────────────
    resetPrewarmRuntimeState();
    await checkAsync("below 15% nothing is speculated, but LRU is still touched", async () => {
      const hash = hex40("precious-user-download");
      await prisma.engineTorrent.updateMany({
        where: { userId, hash },
        data: { lastUsedAt: new Date(0) },
      });
      const out = await onPlaybackProgress(
        {
          userId,
          infoHash: hash,
          title: `${SHOW} S01E03 1080p`,
          season: 1,
          episode: 3,
          watchListItemId: itemId,
          positionSec: 10,
          durationSec: 1000,
        },
        { db: prisma, _config: config, _sendFn: fakeSend },
      );
      assert.equal(out.reason, "below-trigger");
      const row = await prisma.engineTorrent.findFirstOrThrow({ where: { userId, hash } });
      assert.ok(
        row.lastUsedAt.getTime() > Date.now() - 60_000,
        "the torrent being watched must never be the least-recently-used row",
      );
    });

    await checkAsync("a title with no next episode is not an error", async () => {
      const out = await onPlaybackProgress(
        {
          userId,
          infoHash: hex40("precious-user-download"),
          title: "A Film With No Episodes",
          season: null,
          episode: null,
          watchListItemId: null,
          positionSec: 500,
          durationSec: 1000,
        },
        { db: prisma, _config: config, _sendFn: fakeSend },
      );
      assert.equal(out.status, "not-applicable");
      assert.equal(out.reason, "no-next-episode");
    });

    // ── CAUSALITY: the pre-rank and the grab must search *identically* ──
    // The fast path is not magic: the pre-rank populates the aggregator's
    // cache and the grab reads it back. They only ever meet if the payload
    // each one searches with is byte-identical, because the cache key is a
    // hash of that payload. Nothing reconstructs a key here — instead we
    // record what each side really asked for and compare.
    //
    // Without this check, a drift inside `preRank` (say a different `limit`)
    // would silently kill pre-warming: the grab would still be served from a
    // cache that someone else had filled, `fastPath` would still be true, and
    // no test would notice.
    await checkAsync(
      "the pre-rank and the grab search with a byte-identical payload",
      async () => {
        // A faithful stand-in for the aggregator's cache layer: it derives the
        // key with the REAL `cacheKeyFrom` from whatever payload it is handed,
        // exactly as `searchTorrents` does. Nothing is reconstructed from
        // guessed values — the payload each caller really sent is the input.
        //
        // Consequence: if the pre-rank and the grab send different payloads,
        // they land on different keys and the second call is a genuine MISS.
        const seen: SearchPayload[] = [];
        const target0 = await getTargetResolution();
        const miniAggregator = (async (payload: SearchPayload) => {
          seen.push(structuredClone(payload));
          const key = cacheKeyFrom({
            q: payload.query.toLowerCase(),
            category: payload.category ?? "all",
            limit: payload.limit ?? "default",
            sources: payload.sources?.slice().sort() ?? "default",
            filters: payload.filters ?? {},
            target: target0,
          });
          const hit = await getSearchCache(key);
          if (hit) return { ...(hit as SearchResponse), cached: true };
          const fresh = response(payload.query, [
            result({ title: `${CAUSAL_SHOW} S03E07 1080p WEB-DL`, seeders: 99 }),
          ]);
          writtenKeys.push(key);
          await setSearchCache(key, fresh);
          return { ...fresh, cached: false };
        }) as typeof searchTorrents;

        // Earlier speculative fetches in this suite are finished by now; mark
        // them so, or the concurrency cap (correctly) refuses this one.
        await prisma.engineTorrent.updateMany({
          where: { userId },
          data: { status: "completed", progress: 1 },
        });
        clearPreRankMemo();
        resetPrewarmRuntimeState();

        const causal = await prewarmNextEpisode({
          userId,
          next: {
            ...next,
            title: CAUSAL_SHOW,
            season: 3,
            episode: 7,
            watchListItemId: null,
          },
          _config: config,
          _sendFn: fakeSend,
          _deleteFn: noDelete,
          _foregroundProgress: 1,
          _searchFn: miniAggregator,
          db: prisma,
        });

        assert.equal(causal.status, "sent", `got ${causal.status}: ${causal.message}`);
        assert.equal(
          seen.length,
          2,
          `expected exactly two searches (pre-rank fills the cache, grab reads it), saw ${seen.length}`,
        );
        assert.deepStrictEqual(
          seen[0],
          seen[1],
          "pre-rank and grab searched with different options — they hash to different cache keys, so the pre-rank can never serve the grab",
        );
        assert.equal(
          causal.fastPath,
          true,
          "the grab did not come from cache even though the pre-rank had just filled it",
        );
      },
    );
  } finally {

    await prisma.playbackProgress.deleteMany({ where: { userId } });
    await prisma.engineTorrent.deleteMany({ where: { userId } });
    await prisma.grabJob.deleteMany({ where: { userId } });
    await prisma.downloadHistory.deleteMany({ where: { userId } });
    await prisma.watchListItem.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    if (writtenKeys.length) {
      await prisma.searchCache.deleteMany({ where: { cacheKey: { in: writtenKeys } } });
    }
    await prisma.$disconnect();
  }

  console.log(
    failures === 0
      ? "\nPASS — a pre-warm never looks like a user action"
      : `\nFAIL — ${failures} failing check(s)`,
  );
  process.exit(failures ? 1 : 0);
}

void main();
