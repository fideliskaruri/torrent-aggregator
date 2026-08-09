import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

import prisma from "@/lib/prisma";
import { DEFAULT_MAX_STORAGE_BYTES } from "./disk-space";
import {
  acquireSeason,
  resolveSeasonPlan,
  seasonSearchQueries,
  seasonSearchQuery,
} from "./season-acquire";
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

function result(
  title: string,
  episode: TorrentResult["episode"],
): TorrentResult {
  const infoHash = createHash("sha1").update(`${title}:${randomUUID()}`).digest("hex");
  return {
    id: randomUUID(),
    title,
    magnet: `magnet:?xt=urn:btih:${infoHash}`,
    infoHash,
    sizeBytes: 1_400_000_000,
    seeders: 30,
    leechers: 3,
    source: "apibay",
    sourceUrl: "https://example.invalid",
    tags: [],
    episode,
  };
}

function searchResponse(query: string, rows: TorrentResult[]) {
  return {
    query,
    results: rows,
    groups: [],
    tookMs: 0,
    sources: [],
    totalCount: rows.length,
    page: 1,
    pageSize: 40,
    totalPages: 1,
  };
}

async function main(): Promise<void> {
  console.log("season acquisition orchestration\n");

  await checkAsync("season query forms remain broad enough to find singles", async () => {
    assert.equal(seasonSearchQuery("The Bear", 1), "The Bear S01");
    assert.deepEqual(seasonSearchQueries("Rick and Morty", 9), [
      "Rick and Morty S09",
      "Rick and Morty Season 9",
      "Rick and Morty S09 COMPLETE",
      "Rick and Morty Season 9 COMPLETE",
      "Rick and Morty",
    ]);
  });

  await checkAsync("resolve walks the full query ladder for exact episodes", async () => {
    const singles = [1, 2, 3].map((episode) =>
      result(`Rick and Morty S09E0${episode} 1080p`, {
        isSeasonPack: false,
        season: 9,
        episode,
      } as TorrentResult["episode"]),
    );
    const queries: string[] = [];
    const resolved = await resolveSeasonPlan(
      {
        userId: `u_${randomUUID()}`,
        title: "Rick and Morty",
        mediaType: "tv",
        season: 9,
        episodes: [1, 2, 3],
      },
      {
        _searchFn: (async (opts: { query: string }) => {
          queries.push(opts.query);
          return searchResponse(
            opts.query,
            opts.query === "Rick and Morty" ? singles : [],
          );
        }) as never,
      },
    );
    assert.ok(queries.includes("Rick and Morty S09"));
    assert.ok(queries.includes("Rick and Morty"));
    assert.deepEqual(
      resolved.plan.singles.map((single) => single.episode),
      [1, 2, 3],
    );
  });

  await checkAsync("a pack never stops exact episode gap-fill", async () => {
    const pack = result("The Show S01 COMPLETE", {
      isSeasonPack: true,
      season: 1,
    } as TorrentResult["episode"]);
    const e1 = result("The Show S01E01 1080p", {
      isSeasonPack: false,
      season: 1,
      episode: 1,
    } as TorrentResult["episode"]);
    const queries: string[] = [];
    const resolved = await resolveSeasonPlan(
      {
        userId: `u_${randomUUID()}`,
        title: "The Show",
        mediaType: "tv",
        season: 1,
        episodes: [1],
      },
      {
        _searchFn: (async (opts: { query: string }) => {
          queries.push(opts.query);
          if (opts.query === "The Show S01") {
            return searchResponse(opts.query, [pack]);
          }
          if (opts.query === "The Show S01E01") {
            return searchResponse(opts.query, [e1]);
          }
          return searchResponse(opts.query, []);
        }) as never,
      },
    );
    assert.ok(queries.includes("The Show S01E01"));
    assert.equal(resolved.plan.pack, null);
    assert.equal(resolved.plan.singles[0]?.episode, 1);
  });

  await checkAsync("exact episode selection honors preferred resolution", async () => {
    const single = (resolution: number) =>
      result(`The Show S01E01 ${resolution}p WEB-DL`, {
        isSeasonPack: false,
        season: 1,
        episode: 1,
      } as TorrentResult["episode"]);
    const resolved = await resolveSeasonPlan(
      {
        userId: `u_${randomUUID()}`,
        title: "The Show",
        mediaType: "tv",
        season: 1,
        episodes: [1],
        preferredResolution: 720,
      },
      { _releases: [single(2160), single(1080), single(720)] },
    );
    assert.match(resolved.plan.singles[0]?.release.title ?? "", /720p/);
  });

  await checkAsync("season selection never fills an episode below the quality floor", async () => {
    const single = (resolution: number) =>
      result(`The Show S01E01 ${resolution}p WEB-DL`, {
        isSeasonPack: false,
        season: 1,
        episode: 1,
      } as TorrentResult["episode"]);
    const higher = await resolveSeasonPlan(
      {
        userId: `u_${randomUUID()}`,
        title: "The Show",
        mediaType: "tv",
        season: 1,
        episodes: [1],
        preferredResolution: 1080,
      },
      { _releases: [single(720), single(2160)] },
    );
    assert.match(higher.plan.singles[0]?.release.title ?? "", /2160p/);

    const lowerOnly = await resolveSeasonPlan(
      {
        userId: `u_${randomUUID()}`,
        title: "The Show",
        mediaType: "tv",
        season: 1,
        episodes: [1],
        preferredResolution: 1080,
      },
      { _releases: [single(720), single(480)] },
    );
    assert.deepEqual(lowerOnly.plan.singles, []);
    assert.deepEqual(lowerOnly.plan.missing, [1]);
    assert.equal(lowerOnly.plan.coverageLabel, "0 of 1 episodes");
  });

  await checkAsync("acquire sends exact singles and leaves pack-only gaps missing", async () => {
    const pack = result("The Show S01 COMPLETE", {
      isSeasonPack: true,
      season: 1,
    } as TorrentResult["episode"]);
    const e3 = result("The Show S01E03 1080p", {
      isSeasonPack: false,
      season: 1,
      episode: 3,
    } as TorrentResult["episode"]);
    const sentTitles: string[] = [];
    const userId = `u_${randomUUID()}`;
    await prisma.user.create({ data: { id: userId } });
    await prisma.clientSettings.create({
      data: {
        userId,
        clientType: "builtin",
        baseDownloadPath: process.cwd(),
        maxStorageBytes: BigInt(DEFAULT_MAX_STORAGE_BYTES),
        storageCapConfigured: true,
      },
    });

    let acquired;
    try {
      acquired = await acquireSeason(
        {
          userId,
          title: "The Show",
          mediaType: "tv",
          season: 1,
          episodes: [1, 2, 3],
        },
        {
          _releases: [pack, e3],
          _sendFn: (async (_config: unknown, request: { name?: string }) => {
            sentTitles.push(request.name ?? "");
            return { ok: true, message: "queued" };
          }) as never,
        },
      );
    } finally {
      await prisma.grabJob.deleteMany({ where: { userId } }).catch(() => {});
      await prisma.downloadHistory.deleteMany({ where: { userId } }).catch(() => {});
      await prisma.clientSettings.deleteMany({ where: { userId } }).catch(() => {});
      await prisma.user.delete({ where: { id: userId } }).catch(() => {});
    }

    assert.deepEqual(acquired.acquired, [3]);
    assert.equal(acquired.plan.pack, null);
    assert.deepEqual(acquired.plan.missing, [1, 2]);
    assert.equal(sentTitles.some((title) => /complete/i.test(title)), false);
    assert.equal(sentTitles.some((title) => /S01E03/i.test(title)), true);
  });

  console.log(
    failures === 0
      ? "\nPASS — season acquisition uses exact episode torrents only"
      : `\nFAIL — ${failures} failing check(s)`,
  );
  process.exitCode = failures ? 1 : 0;
}

void main().finally(async () => {
  await prisma.$disconnect();
});
