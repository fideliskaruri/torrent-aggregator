import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

import prisma from "@/lib/prisma";
import { DEFAULT_MAX_STORAGE_BYTES } from "./disk-space";
import {
  acquireSeason,
  resolveSeasonPlan,
  seasonAliasQueryNames,
  seasonSearchQueries,
  seasonSearchQuery,
  seasonSearchFailureReason,
} from "./season-acquire";
import type { TorrentResult } from "@/lib/torrents/types";
import type { SeasonItemResult } from "./season-acquire";

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

  await checkAsync("season search is alias-aware and stays single-episode", async () => {
    const romaji = (episode: number) =>
      result(
        `[SubsPlease] Tensei Shitara Slime Datta Ken S01E0${episode} 1080p`,
        {
          isSeasonPack: false,
          season: 1,
          episode,
        } as TorrentResult["episode"],
      );
    const wrongShow = result("Lucky 2026 S01E01 1080p WEB h264-ETHEL", {
      isSeasonPack: false,
      season: 1,
      episode: 1,
    } as TorrentResult["episode"]);
    const aliasPack = result(
      "[SubsPlease] Tensei Shitara Slime Datta Ken S01 COMPLETE 1080p",
      { isSeasonPack: true, season: 1 } as TorrentResult["episode"],
    );
    const queries: string[] = [];
    const resolved = await resolveSeasonPlan(
      {
        userId: `u_${randomUUID()}`,
        title: "That Time I Got Reincarnated as a Slime",
        aliases: [
          "Tensei Shitara Slime Datta Ken, Dai Kenja no Deshi ni Natta",
        ],
        mediaType: "anime",
        season: 1,
        episodes: [1, 2],
      },
      {
        _searchFn: (async (opts: { query: string }) => {
          queries.push(opts.query);
          // The English catalog title indexers do not carry.
          if (/Reincarnated as a Slime/i.test(opts.query)) {
            return searchResponse(opts.query, []);
          }
          if (/Tensei Shitara Slime/i.test(opts.query)) {
            return searchResponse(opts.query, [
              wrongShow,
              aliasPack,
              romaji(1),
              romaji(2),
            ]);
          }
          return searchResponse(opts.query, []);
        }) as never,
      },
    );
    assert.ok(
      queries.some((q) => /Tensei Shitara Slime/i.test(q)),
      `romaji alias never searched; tried: ${queries.join(" | ")}`,
    );
    assert.deepEqual(
      resolved.plan.singles.map((single) => single.episode),
      [1, 2],
      "both episodes resolve to exact singles under the alias",
    );
    assert.equal(resolved.plan.pack, null, "a retained season pack is never planned");
    assert.equal(
      resolved.releases.some((r) => /Lucky 2026/i.test(r.title)),
      false,
      "a wrong show found under a broad alias query is rejected",
    );
  });

  await checkAsync("ordinary TV season search issues no alias queries", async () => {
    const queries: string[] = [];
    await resolveSeasonPlan(
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
          return searchResponse(opts.query, []);
        }) as never,
      },
    );
    assert.equal(
      queries.every((q) => /^The Show/i.test(q)),
      true,
      `no non-canonical queries expected; tried: ${queries.join(" | ")}`,
    );
  });

  await checkAsync("alias query names are bounded and drop punctuation-only forms", async () => {
    assert.deepEqual(
      seasonAliasQueryNames("Re:ZERO -Starting Life in Another World-", [
        "Re:Zero kara Hajimeru Isekai Seikatsu",
        "リゼロ",
        "Third Alias Name",
      ]).length <= 2,
      true,
    );
    assert.deepEqual(
      seasonAliasQueryNames("The Show", ["The Show", "The  Show"]),
      [],
      "an alias that is the canonical title respelled buys no extra search",
    );
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

  // ── Regression: the "13 wanted, 2 acquired" season ───────────────────────
  //
  // The reported failure was a thirteen-episode season one click away from
  // complete coming back with two episodes. Reproduced here in fixtures: the
  // broad season/title queries answer with a handful of rows that are *not
  // usable* — below the user's floor, zero seeders, wrong show — and only the
  // exact `Show S01Exx` query returns the real release. Coverage bookkeeping
  // that counted those unusable rows skipped the exact query for every episode
  // they touched, so those episodes were dropped with no search ever made.
  await checkAsync(
    "a sparse season query is rescued by per-episode lookups for all 13 episodes",
    async () => {
      const wanted = Array.from({ length: 13 }, (_, i) => i + 1);
      const padded = (n: number) => String(n).padStart(2, "0");
      const junkForEpisode = (episode: number): TorrentResult[] => {
        const rows: TorrentResult[] = [];
        // Below the 1080p floor — eligible-looking, ineligible in fact.
        rows.push(
          result(`The Mountain Town S01E${padded(episode)} 480p DVDRip`, {
            isSeasonPack: false,
            season: 1,
            episode,
          } as TorrentResult["episode"]),
        );
        // Dead swarm: advertised, unusable.
        const dead = result(
          `The Mountain Town S01E${padded(episode)} 1080p WEB-DL`,
          { isSeasonPack: false, season: 1, episode } as TorrentResult["episode"],
        );
        rows.push({ ...dead, seeders: 0 });
        return rows;
      };
      const good = (episode: number) =>
        result(`The Mountain Town S01E${padded(episode)} 1080p BluRay`, {
          isSeasonPack: false,
          season: 1,
          episode,
        } as TorrentResult["episode"]);

      const queries: string[] = [];
      const resolved = await resolveSeasonPlan(
        {
          userId: `u_${randomUUID()}`,
          title: "The Mountain Town",
          mediaType: "tv",
          season: 1,
          episodes: wanted,
          preferredResolution: 1080,
        },
        {
          _searchFn: (async (opts: { query: string }) => {
            queries.push(opts.query);
            // The season-shaped queries only ever return the junk rows, plus a
            // pack (never acquirable) — this is the real shape of the bug.
            if (/^The Mountain Town(\s|$)/i.test(opts.query) && !/E\d\d/i.test(opts.query)) {
              return searchResponse(opts.query, [
                result("The Mountain Town S01 COMPLETE 1080p", {
                  isSeasonPack: true,
                  season: 1,
                } as TorrentResult["episode"]),
                ...wanted.flatMap((e) => junkForEpisode(e)),
              ]);
            }
            const m = opts.query.match(/S01E(\d\d)/i);
            if (m) return searchResponse(opts.query, [good(parseInt(m[1], 10))]);
            return searchResponse(opts.query, []);
          }) as never,
        },
      );

      for (const episode of wanted) {
        assert.ok(
          queries.includes(`The Mountain Town S01E${padded(episode)}`),
          `no exact search was issued for E${padded(episode)}`,
        );
      }
      assert.deepEqual(
        resolved.plan.singles.map((s) => s.episode),
        wanted,
        "every wanted episode resolves to its own exact release",
      );
      assert.deepEqual(resolved.plan.missing, []);
      assert.equal(resolved.plan.coverageLabel, "13 of 13 episodes");
      assert.equal(resolved.plan.pack, null, "no pack is ever planned");
      assert.equal(
        resolved.plan.singles.every((s) => /1080p BluRay/.test(s.release.title)),
        true,
        "sub-floor and zero-seeder rows are never selected",
      );
    },
  );

  await checkAsync(
    "an episode already covered at the floor is not searched again",
    async () => {
      const queries: string[] = [];
      const e1 = result("The Show S01E01 1080p WEB-DL", {
        isSeasonPack: false,
        season: 1,
        episode: 1,
      } as TorrentResult["episode"]);
      const e2low = result("The Show S01E02 720p WEB-DL", {
        isSeasonPack: false,
        season: 1,
        episode: 2,
      } as TorrentResult["episode"]);
      const resolved = await resolveSeasonPlan(
        {
          userId: `u_${randomUUID()}`,
          title: "The Show",
          mediaType: "tv",
          season: 1,
          episodes: [1, 2],
          preferredResolution: 1080,
        },
        {
          _searchFn: (async (opts: { query: string }) => {
            queries.push(opts.query);
            if (opts.query === "The Show S01") {
              return searchResponse(opts.query, [e1, e2low]);
            }
            return searchResponse(opts.query, []);
          }) as never,
        },
      );
      assert.equal(
        queries.includes("The Show S01E01"),
        false,
        "an episode already covered at the floor must not be searched again",
      );
      assert.equal(
        queries.includes("The Show S01E02"),
        true,
        "an episode only covered below the floor must still be searched",
      );
      assert.deepEqual(
        resolved.plan.singles.map((s) => s.episode),
        [1],
      );
      assert.deepEqual(resolved.plan.missing, [2]);
    },
  );

  await checkAsync(
    "a rate-limited provider is reported honestly, not as an empty season",
    async () => {
      const queries: string[] = [];
      const resolved = await resolveSeasonPlan(
        {
          userId: `u_${randomUUID()}`,
          title: "The Show",
          mediaType: "tv",
          season: 1,
          episodes: [1, 2, 3, 4, 5, 6],
        },
        {
          _searchFn: (async (opts: { query: string }) => {
            queries.push(opts.query);
            throw new Error("429 Too Many Requests");
          }) as never,
        },
      );
      assert.equal(resolved.plan.singles.length, 0);
      assert.deepEqual(resolved.plan.missing, [1, 2, 3, 4, 5, 6]);
      assert.ok(resolved.searchErrors.length > 0, "the 429 is recorded");
      assert.equal(
        resolved.searchErrors.some((e) => e.retryable),
        true,
        "a 429 is retryable, not a verdict on the season",
      );
      assert.equal(resolved.searchAborted, true, "the failing ladder stops early");
      assert.ok(
        queries.length <= 4,
        `a refusing provider must not be hammered once per episode; issued ${queries.length}`,
      );
      assert.match(
        seasonSearchFailureReason(resolved.searchErrors) ?? "",
        /retry shortly/i,
      );
    },
  );

  await checkAsync(
    "a provider omission inside an otherwise-ok search is recorded",
    async () => {
      const e1 = result("The Show S01E01 1080p", {
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
        },
        {
          _searchFn: (async (opts: { query: string }) => ({
            ...searchResponse(opts.query, opts.query === "The Show S01" ? [e1] : []),
            sources: [
              { id: "apibay", count: opts.query === "The Show S01" ? 1 : 0 },
              { id: "nyaa", count: 0, error: "rate limited (429)" },
            ],
          })) as never,
        },
      );
      assert.equal(resolved.searchAborted, false, "one healthy source keeps the ladder alive");
      assert.equal(
        resolved.searchErrors.some(
          (e) => e.source === "nyaa" && e.retryable,
        ),
        true,
        "the omitted provider is named",
      );
      assert.deepEqual(
        resolved.plan.singles.map((s) => s.episode),
        [1],
        "a partial provider outage still delivers what was found",
      );
    },
  );

  await checkAsync(
    "acquire reports a reason for every episode it could not send",
    async () => {
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
      const e2 = result("The Show S01E02 1080p WEB-DL", {
        isSeasonPack: false,
        season: 1,
        episode: 2,
      } as TorrentResult["episode"]);
      const sentTitles: string[] = [];
      let acquired;
      try {
        acquired = await acquireSeason(
          {
            userId,
            title: "The Show",
            mediaType: "tv",
            season: 1,
            episodes: [1, 2, 3],
            preferredResolution: 1080,
          },
          {
            _searchFn: (async (opts: { query: string }) => {
              if (opts.query === "The Show S01E02") {
                return searchResponse(opts.query, [e2]);
              }
              if (opts.query === "The Show S01E03") {
                throw new Error("429 Too Many Requests");
              }
              return searchResponse(opts.query, []);
            }) as never,
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

      assert.deepEqual(acquired.acquired, [2]);
      assert.equal(acquired.coverageLabel, "1 of 3 episodes");
      assert.equal(sentTitles.length, 1, "exactly one torrent per covered episode");
      const reported = new Map(
        acquired.items
          .filter((i) => i.episode != null)
          .map((i) => [i.episode as number, i]),
      );
      for (const episode of [1, 2, 3]) {
        assert.ok(reported.has(episode), `E0${episode} has no item at all`);
      }
      assert.equal(reported.get(1)?.status, "failed");
      assert.match(reported.get(1)?.message ?? "", /1080p|No release/i);
      assert.equal(reported.get(3)?.status, "failed");
      assert.match(
        reported.get(3)?.message ?? "",
        /retry shortly/i,
        "a rate-limited episode says retry, not 'does not exist'",
      );
      assert.equal(
        acquired.items.some((i) => i.kind === "pack"),
        false,
        "season acquisition never sends a pack",
      );
    },
  );

  await checkAsync(
    "verbose diagnostics emit safe season counts only when enabled",
    async () => {
      const e1 = result("The Show S01E01 1080p WEB-DL", {
        isSeasonPack: false,
        season: 1,
        episode: 1,
      } as TorrentResult["episode"]);

      const runWith = async (verbose: boolean): Promise<string[]> => {
        const userId = `u_${randomUUID()}`;
        await prisma.user.create({ data: { id: userId } });
        await prisma.clientSettings.create({
          data: {
            userId,
            clientType: "builtin",
            baseDownloadPath: process.cwd(),
            maxStorageBytes: BigInt(DEFAULT_MAX_STORAGE_BYTES),
            storageCapConfigured: true,
            verboseDiagnostics: verbose,
          },
        });
        const lines: string[] = [];
        const original = console.info;
        console.info = (...args: unknown[]) => {
          lines.push(args.map((a) => String(a)).join(" "));
        };
        try {
          await acquireSeason(
            {
              userId,
              title: "The Show",
              mediaType: "tv",
              season: 1,
              episodes: [1, 2],
              preferredResolution: 1080,
            },
            {
              _releases: [e1],
              _sendFn: (async () => ({ ok: true, message: "queued" })) as never,
            },
          );
        } finally {
          console.info = original;
          await prisma.grabJob.deleteMany({ where: { userId } }).catch(() => {});
          await prisma.downloadHistory.deleteMany({ where: { userId } }).catch(() => {});
          await prisma.clientSettings.deleteMany({ where: { userId } }).catch(() => {});
          await prisma.user.delete({ where: { id: userId } }).catch(() => {});
        }
        return lines.filter((l) => l.includes('"component":"acquisition"'));
      };

      assert.deepEqual(await runWith(false), [], "diagnostics stay silent when off");

      const lines = await runWith(true);
      assert.ok(lines.length > 0, "verbose diagnostics emit acquisition lines");
      const entries = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
      const plan = entries.find((e) => e.action === "season_plan");
      assert.ok(plan, "a plan line is emitted");
      assert.equal(plan?.wanted, 2);
      assert.equal(plan?.covered, 1);
      assert.equal(plan?.missing, 1);
      assert.equal(plan?.minResolution, 1080);
      assert.ok(
        entries.some(
          (e) => e.action === "season_send" && e.episode === 1 && e.status === "sent",
        ),
        "the send is logged with its episode and status",
      );
      assert.ok(
        entries.some(
          (e) => e.action === "season_episode_missing" && e.episode === 2,
        ),
        "the missing episode is logged with a reason code",
      );
      // Nothing content-bearing may appear in any line.
      for (const line of lines) {
        assert.equal(/magnet:|The Show|[a-f0-9]{40}/i.test(line), false, line);
        assert.equal(
          line.includes(process.cwd()) || /[A-Za-z]:\\\\/.test(line),
          false,
          `a path leaked into diagnostics: ${line}`,
        );
      }
    },
  );

  await checkAsync(
    "an alias pass never evicts a release a canonical query already vouched for",
    async () => {
      // The same release comes back under both the canonical query and the
      // broad alias query, and its scene name does not re-identify to the work.
      // Provenance, not a second identity parse, decides: it stays.
      const shared = result("Slime.S01E01.1080p.WEB.x264-GROUP", {
        isSeasonPack: false,
        season: 1,
        episode: 1,
      } as TorrentResult["episode"]);
      const wrongShow = result("Lucky 2026 S01E02 1080p WEB h264-ETHEL", {
        isSeasonPack: false,
        season: 1,
        episode: 2,
      } as TorrentResult["episode"]);
      const resolved = await resolveSeasonPlan(
        {
          userId: `u_${randomUUID()}`,
          title: "That Time I Got Reincarnated as a Slime",
          aliases: ["Tensei Shitara Slime Datta Ken"],
          mediaType: "anime",
          season: 1,
          episodes: [1, 2],
        },
        {
          _searchFn: (async (opts: { query: string }) => {
            if (/Reincarnated as a Slime/i.test(opts.query)) {
              return searchResponse(opts.query, [shared]);
            }
            if (/Tensei Shitara Slime/i.test(opts.query)) {
              return searchResponse(opts.query, [shared, wrongShow]);
            }
            return searchResponse(opts.query, []);
          }) as never,
        },
      );
      assert.equal(
        resolved.releases.some((r) => r.infoHash === shared.infoHash),
        true,
        "a canonically-found release must survive the alias identity guard",
      );
      assert.equal(
        resolved.releases.some((r) => /Lucky 2026/i.test(r.title)),
        false,
        "a wrong show introduced by the alias query is still rejected",
      );
      assert.deepEqual(
        resolved.plan.singles.map((s) => s.episode),
        [1],
      );
    },
  );

  await checkAsync(
    "a permanent search failure is never dressed up as retry-shortly",
    async () => {
      const resolved = await resolveSeasonPlan(
        {
          userId: `u_${randomUUID()}`,
          title: "The Show",
          mediaType: "tv",
          season: 1,
          episodes: [1, 2, 3],
        },
        {
          _searchFn: (async () => {
            throw new Error("400 Bad Request: unsupported category");
          }) as never,
        },
      );
      assert.equal(resolved.searchAborted, true);
      assert.equal(
        resolved.searchErrors.some((e) => e.retryable),
        false,
        "three permanent failures must not produce a retryable abort sentinel",
      );
      const reason = seasonSearchFailureReason(resolved.searchErrors) ?? "";
      assert.match(reason, /Search failed/i);
      assert.equal(/retry shortly/i.test(reason), false, reason);
    },
  );

  await checkAsync(
    "an episode's logged reason code matches the sentence it is shown",
    async () => {
      const userId = `u_${randomUUID()}`;
      await prisma.user.create({ data: { id: userId } });
      await prisma.clientSettings.create({
        data: {
          userId,
          clientType: "builtin",
          baseDownloadPath: process.cwd(),
          maxStorageBytes: BigInt(DEFAULT_MAX_STORAGE_BYTES),
          storageCapConfigured: true,
          verboseDiagnostics: true,
        },
      });
      const lines: string[] = [];
      const original = console.info;
      console.info = (...args: unknown[]) => {
        lines.push(args.map((a) => String(a)).join(" "));
      };
      let acquired: Awaited<ReturnType<typeof acquireSeason>> | undefined;
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
            _searchFn: (async () => {
              throw new Error("400 Bad Request: unsupported category");
            }) as never,
            _sendFn: (async () => ({ ok: true, message: "queued" })) as never,
          },
        );
      } finally {
        console.info = original;
        await prisma.grabJob.deleteMany({ where: { userId } }).catch(() => {});
        await prisma.downloadHistory.deleteMany({ where: { userId } }).catch(() => {});
        await prisma.clientSettings.deleteMany({ where: { userId } }).catch(() => {});
        await prisma.user.delete({ where: { id: userId } }).catch(() => {});
      }

      assert.deepEqual(acquired?.acquired, []);
      const entries = lines
        .filter((l) => l.includes('"component":"acquisition"'))
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .filter((e) => e.action === "season_episode_missing");
      assert.equal(entries.length, 3, "one reason per missing episode");
      for (const entry of entries) {
        const item: SeasonItemResult | undefined = acquired?.items.find(
          (i) => i.episode === entry.episode,
        );
        assert.ok(item, `no item for E0${entry.episode}`);
        const saysRetry = /retry shortly/i.test(item?.message ?? "");
        const codeSaysRetry = String(entry.status).includes("retryable");
        assert.equal(
          saysRetry,
          codeSaysRetry,
          `code ${String(entry.status)} disagrees with message "${item?.message}"`,
        );
        assert.equal(
          String(entry.status),
          "search_aborted",
          "a permanent abort logs a permanent code",
        );
      }
    },
  );

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
