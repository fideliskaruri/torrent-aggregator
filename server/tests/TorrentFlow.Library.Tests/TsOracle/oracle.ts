// Regenerates ts-oracle.json from the TS original (read-only). From the TS repo root:
//   copy src/lib/library/ondemand.ts to ./ondemand-copy.ts next to this file and append `export { buildEpisodeRungs };`
//   node_modules/.bin/tsx --tsconfig tsconfig.json <this file> > ts-oracle.json
import { buildEpisodeRungs, aliasTitleForms, rankAliases, searchTitleVariants, episodeReleaseMatchesWork } from "./ondemand-copy";
import { matchesTargetEpisode, isEpisodeRangeRelease } from "@/lib/torrents/pack-preference";
import { cleanDisplayTitle } from "@/components/browse/availability";
import { workKeyFor, workKeyMatches, workIdentityFor } from "@/components/title/work-key";
import { summarizeFilmRejection, filmNoMatchMessage, selectWorkCandidate } from "@/app/api/title/[workKey]/grab";

const out: Record<string, unknown> = {};
const rungCases: [string, number, number, string, string[], number | null][] = [
  ["Family Guy", 3, 5, "tv", [], null],
  ["Family Guy", 1, 2, "tv", [], 1080],
  ["Re:ZERO -Starting Life in Another World-", 1, 1, "anime", [], null],
  ["That Time I Got Reincarnated as a Slime", 1, 3, "tv", ["Tensei Shitara Slime Datta Ken", "転生したらスライムだった件"], 720],
  ["Attack on Titan", 2, 4, "anime", ["Shingeki no Kyojin"], null],
  ["Frieren: Beyond Journey's End", 1, 7, "anime", ["Sousou no Frieren"], 1080],
  ["Breaking Bad", 5, 14, "tv", [], 1080],
];
out.rungs = rungCases.map(([t, s, e, m, x, r]) => ({ input: [t, s, e, m, x, r], rungs: buildEpisodeRungs(t, s, e, m, x, r).map((g) => [g.kind, g.query, g.category, g.filters?.minSeeders ?? null, g.filters?.season ?? null, g.filters?.episode ?? null]) }));
const titles = ["Re:ZERO -Starting Life in Another World-", "Dune (2021)", "Frieren: Beyond Journey's End", "Tensei Shitara Slime Datta Ken", "JoJo's Bizarre Adventure", "Mobile Suit Gundam: The Witch from Mercury", "Kaguya-sama wa Kokurasetai: Tensai-tachi no Renai Zunousen", "Dr. Stone"];
out.variants = titles.map((t) => [t, searchTitleVariants(t)]);
out.forms = titles.map((t) => [t, aliasTitleForms(t)]);
out.rank = rankAliases(["Shingeki no Kyojin", "進撃の巨人", "Attack on Titan: Final Season", "AoT", "ShingekiNoKyojin"]);
const releases = [
  "[SubsPlease] Sousou no Frieren - 01 (1080p) [F02B9CEE].mkv",
  "[Erai-raws] Shingeki no Kyojin - The Final Season - 04 [1080p][Multiple Subtitle]",
  "Family.Guy.S03E05.720p.WEB-DL.x264-GROUP",
  "Family Guy S03E05-E07 720p",
  "Family Guy 3x05 HDTV",
  "Breaking.Bad.S05.COMPLETE.1080p.BluRay.x264",
  "Breaking Bad S01-S05 Complete 1080p",
  "[Judas] Re Zero kara Hajimeru Isekai Seikatsu (Season 1) [BD 1080p][HEVC x265 10bit][Dual-Audio][Eng-Subs] (Batch)",
  "[SubsPlease] Re Zero kara Hajimeru Isekai Seikatsu - 01 (1080p)",
  "Tensei.Shitara.Slime.Datta.Ken.S01E03.1080p.WEB.H264",
  "[HorribleSubs] Dr. Stone - 07 [720p].mkv",
  "Attack on Titan S02E04 1080p",
  "Attack.on.Titan.S02E04E05.1080p",
  "One Piece - 1071 [1080p]",
  "Frieren E07 1080p",
];
const targets = [[1, 1], [3, 5], [2, 4], [1, 7], [5, 14], [1, 3]] as const;
out.match = releases.map((r) => [r, targets.map(([s, e]) => matchesTargetEpisode({ title: r } as never, { season: s, episode: e })), isEpisodeRangeRelease(r)]);
const names = [
  "Ninja Assassin (2009) 1080p BrRip x264 - 1.4GB - YIFY",
  "Dune.2021.2160p.UHD.BluRay.x265.10bit.HDR.DTS-HD.MA.5.1-SWTYBLZ",
  "Dune (1984) 1080p BluRay x264",
  "Children.of.Dune.2003.Part1.720p",
  "Dune.Part.Two.2024.1080p.WEB-DL",
  "[SubsPlease] Sousou no Frieren - 01 (1080p) [F02B9CEE].mkv",
  "Breaking.Bad.S05E14.Ozymandias.1080p.WEB-DL",
  "The.Matrix.1999.REMASTERED.1080p.BluRay.x264-[YTS.MX]",
  "Blade Runner 2049 (2017) [2160p] [4K] [WEB] [5.1] [YTS.MX]",
  "2001.A.Space.Odyssey.1968.1080p.BluRay",
  "Oppenheimer 2023 1080p WEBRip 2.3GB x264",
  "www.Torrenting.com - Interstellar.2014.1080p",
];
out.clean = names.map((n) => [n, cleanDisplayTitle(n), workIdentityFor(n)]);
const keyCases: [string, string][] = [["dune-2021", names[1]], ["dune-2021", names[2]], ["dune", names[1]], ["dune-2021", names[3]], ["dune-2021", names[4]], ["the-matrix-1999", names[7]], ["blade-runner-2049-2017", names[8]], ["ninja-assassin-2009", names[0]], ["ninja-assassin-2009-1-4gb", names[0]], ["2001-a-space-odyssey-1968", names[9]], ["interstellar-2014", names[11]], ["oppenheimer-2023", names[10]]];
out.keys = keyCases.map(([k, n]) => { const id = workIdentityFor(n); return [k, n, workKeyMatches(k, id.name, id.year)]; });
out.workKeyFor = [["Dune", 2021], ["Re:ZERO -Starting Life in Another World-", null], ["Frieren: Beyond Journey's End", 2023], ["Tensei Shitara Slime Datta Ken", null]].map(([n, y]) => [n, y, workKeyFor(n as string, y as number | null)]);
out.workMatch = releases.map((r) => [r, episodeReleaseMatchesWork({ title: r } as never, ["Frieren: Beyond Journey's End", "Sousou no Frieren"]), episodeReleaseMatchesWork({ title: r } as never, ["Attack on Titan", "Shingeki no Kyojin"]), episodeReleaseMatchesWork({ title: r } as never, ["Family Guy"])]);
const mk = (title: string, seeders: number, magnet = true) => ({ id: title, title, seeders, magnet: magnet ? "magnet:?xt=urn:btih:" + title.length : undefined }) as never;
const film = [mk("Children.of.Dune.2003.1080p", 90), mk("Dune.2021.720p.WEB", 80), mk("Dune.2021.1080p.BluRay.x264", 0), mk("Dune.2021.2160p.WEB-DL", 40, false), mk("Dune.2021.1080p.WEB-DL.DDP5.1", 30), mk("Dune.2021.S01.1080p", 20)];
out.filmSelect = [(selectWorkCandidate(film, "dune-2021", false, null, "Dune", "movies", 1080) as { title?: string } | null)?.title ?? null, (selectWorkCandidate(film, "dune-2021", false, null, "Dune", "movies", 2160) as { title?: string } | null)?.title ?? null];
out.filmSummary = summarizeFilmRejection(film, "dune-2021", 1080);
out.filmMessages = [
  filmNoMatchMessage({ title: "Dune", minimumResolution: 1080, count: 0 }),
  filmNoMatchMessage({ title: "Dune", minimumResolution: 2160, count: 6, rejection: summarizeFilmRejection(film, "dune-2021", 2160) }),
  filmNoMatchMessage({ title: "Dune", minimumResolution: null, count: 6, rejection: summarizeFilmRejection(film, "dune-2021", null) }),
  filmNoMatchMessage({ title: "Dune", minimumResolution: 1080, count: 0, sources: [{ id: "nyaa", count: 0, error: "timeout" }, { id: "tpb", count: 0, error: "503" }] as never }),
  filmNoMatchMessage({ title: "Dune", minimumResolution: 1080, count: 0, sources: [{ id: "nyaa", count: 0, error: "timeout" }, { id: "tpb", count: 0 }] as never }),
];
console.log(JSON.stringify(out, null, 1));

