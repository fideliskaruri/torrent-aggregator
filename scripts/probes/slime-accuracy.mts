import { writeFileSync } from "node:fs";
import { queryRelevanceTier } from "@/components/search/group-titles";
import {
  detectContentKind,
  resolveSmartPath,
  showFolderName,
} from "@/lib/download/smart-category";
import {
  afterSuccessfulGrab,
  resolveHuntCursor,
} from "@/lib/library/cursor";
import { parseEpisode } from "@/lib/torrents/episodes";
import {
  extractTags,
  rankResults,
  stripReleaseGroup,
} from "@/lib/torrents/ranking";
import type {
  MediaMetadata,
  TorrentResult,
} from "@/lib/torrents/types";
import { workIdentity } from "@/lib/torrents/work-identity";

const CANONICAL = "That Time I Got Reincarnated as a Slime";
const ALIAS = "Tensei Shitara Slime Datta Ken";
const metadata: MediaMetadata = {
  source: "tmdb",
  mediaType: "tv",
  externalId: "82684",
  title: CANONICAL,
  year: 2018,
  genres: ["Animation", "Action & Adventure"],
  originalLanguage: "ja",
  originCountry: ["JP"],
};

type Check = {
  area: string;
  name: string;
  expected: unknown;
  actual: unknown;
  pass: boolean;
};

const checks: Check[] = [];

function same(area: string, name: string, actual: unknown, expected: unknown) {
  checks.push({
    area,
    name,
    expected,
    actual,
    pass: JSON.stringify(actual) === JSON.stringify(expected),
  });
}

function truth(area: string, name: string, actual: boolean, expected = true) {
  same(area, name, actual, expected);
}

function result(
  id: string,
  title: string,
  seeders: number,
  source: TorrentResult["source"] = "nyaa",
): TorrentResult {
  return {
    id,
    title,
    magnet: `magnet:?xt=urn:btih:${id.padEnd(40, "0")}`,
    infoHash: id.padEnd(40, "0"),
    sizeBytes: 750 * 1024 * 1024,
    seeders,
    leechers: 2,
    source,
    sourceUrl: `https://example.invalid/${id}`,
    tags: extractTags(title),
    metadata,
    route: {
      kind: "anime",
      category: "Anime",
      confidence: "high",
    },
  };
}

for (const variant of [
  CANONICAL,
  CANONICAL.toLowerCase(),
  `${CANONICAL}!`,
  "THAT.TIME.I.GOT.REINCARNATED.AS.A.SLIME",
]) {
  same(
    "query-normalization",
    `exact/case/punctuation variant: ${variant}`,
    queryRelevanceTier(variant, CANONICAL),
    0,
  );
}

const englishIdentity = workIdentity(`${CANONICAL} S04E16 1080p WEB-DL`, metadata);
const aliasIdentity = workIdentity(`${ALIAS} S04E16 1080p WEB-DL`, metadata);
same(
  "work-identity",
  "a catalog-confirmed alias shares the canonical series identity",
  aliasIdentity.key,
  englishIdentity.key,
);
same(
  "work-identity",
  "canonical series year is not part of episodic identity",
  englishIdentity.year,
  null,
);
truth(
  "work-identity",
  "movie remains distinct from the series",
  workIdentity(`${CANONICAL} the Movie Scarlet Bond 2022 1080p`, metadata).key !==
    englishIdentity.key,
);
truth(
  "work-identity",
  "OVA remains distinct from the series",
  workIdentity(`${CANONICAL} Visions of Coleus OVA 01 1080p`, metadata).key !==
    englishIdentity.key,
);
truth(
  "work-identity",
  "recap remains distinct from the series",
  workIdentity(`${CANONICAL} Digression Hinata Sakaguchi Recap 1080p`, metadata)
    .key !== englishIdentity.key,
);

const parsingCases = [
  {
    name: "numbered episode",
    title: `${CANONICAL} S03E12 1080p WEB-DL`,
    expected: {
      season: 3,
      episode: 12,
      isSeasonPack: false,
      isMultiSeason: false,
    },
  },
  {
    name: "single-season pack",
    title: `${CANONICAL} Season 3 Complete 1080p`,
    expected: {
      season: 3,
      episode: undefined,
      isSeasonPack: true,
      isMultiSeason: false,
    },
  },
  {
    name: "multi-season pack",
    title: `${CANONICAL} S01-S03 Complete 1080p`,
    expected: {
      season: 1,
      episode: undefined,
      isSeasonPack: true,
      isMultiSeason: true,
    },
  },
  {
    name: "absolute-only episode",
    title: `[SubsPlease] ${ALIAS} - 72 (1080p)`,
    expected: {
      season: undefined,
      episode: 72,
      isSeasonPack: false,
      isMultiSeason: false,
    },
  },
];

for (const test of parsingCases) {
  const parsed = parseEpisode(test.title);
  same(
    "release-parsing",
    test.name,
    {
      season: parsed.season,
      episode: parsed.episode,
      isSeasonPack: parsed.isSeasonPack,
      isMultiSeason: parsed.isMultiSeason,
    },
    test.expected,
  );
}

for (const [kind, title] of [
  ["ova", `${CANONICAL} Visions of Coleus OVA 01 1080p`],
  ["movie", `${CANONICAL} the Movie Scarlet Bond 2022 1080p`],
  ["recap", `${CANONICAL} Digression Hinata Sakaguchi Recap 1080p`],
] as const) {
  const parsed = parseEpisode(title) as ReturnType<typeof parseEpisode> & {
    specialType?: string;
  };
  same(
    "release-parsing",
    `${kind} has an explicit structured distinction`,
    parsed.specialType ?? null,
    kind,
  );
}

const tagged = `[SubsPlease] ${CANONICAL} S04E16 1080p WEB-DL Dual Audio Multi-Subs English Dub`;
const tags = extractTags(tagged);
for (const tag of ["1080p", "WEB-DL", "Dual", "Multi", "Sub", "Dub"]) {
  truth("release-metadata", `${tag} metadata is extracted`, tags.includes(tag));
}
same(
  "release-metadata",
  "release group is exposed as structured metadata",
  (rankResults([result("group", tagged, 20)], CANONICAL)[0] as TorrentResult & {
    releaseGroup?: string;
  }).releaseGroup ?? null,
  "SubsPlease",
);
same(
  "release-metadata",
  "release group can at least be stripped from stable identity",
  stripReleaseGroup(tagged).startsWith(CANONICAL),
  true,
);

const relevance = rankResults(
  [
    result("exact", `${CANONICAL} S04E16 1080p WEB-DL`, 20),
    result("unrelated", "The Strongest Slime S01E01 1080p WEB-DL", 5_000),
  ],
  CANONICAL,
  1080,
  "anime",
);
same(
  "ranking",
  "healthy exact work outranks an unrelated high-swarm title",
  relevance[0]?.id,
  "exact",
);

const aliasIntent = rankResults(
  [
    result(
      "movie",
      `[Erai-raws] ${ALIAS}: Soukai no Namida-hen - Movie [1080p WEB-DL]`,
      379,
    ),
    result("episode", `[Erai-raws] ${ALIAS} 4th Season - 16 [1080p WEB-DL]`, 45),
  ],
  ALIAS,
  1080,
  "anime",
);
same(
  "ranking",
  "series-alias intent ranks the current series episode ahead of a movie",
  aliasIntent[0]?.id,
  "episode",
);

const latest = rankResults(
  [
    result("older", `${CANONICAL} S04E15 1080p WEB-DL`, 325),
    result("latest", `${CANONICAL} S04E16 1080p WEB-DL`, 30),
  ],
  CANONICAL,
  1080,
  "anime",
);
same(
  "ranking",
  "bare-series intent ranks the latest current-season episode first",
  latest[0]?.id,
  "latest",
);

const health = rankResults(
  [
    result("dead", `${CANONICAL} S04E16 1080p WEB-DL`, 0),
    result("healthy", `${CANONICAL} S04E16 720p WEB-DL`, 25),
  ],
  CANONICAL,
  1080,
  "anime",
);
same(
  "ranking",
  "healthy exact match outranks a dead exact match",
  health[0]?.id,
  "healthy",
);

const quality = rankResults(
  [
    result("preferred", `${CANONICAL} S04E16 1080p WEB-DL`, 20),
    result("popular-low", `${CANONICAL} S04E16 720p WEB-DL`, 5_000),
  ],
  CANONICAL,
  1080,
  "anime",
);
same(
  "ranking",
  "preferred healthy quality beats a much larger lower-quality swarm",
  quality[0]?.id,
  "preferred",
);

const canonicalEpisodePath = resolveSmartPath("/downloads", "anime", "Anime", {
  title: `${CANONICAL} S04E16 1080p WEB-DL`,
  metadata,
});
same(
  "smart-path",
  "known season uses canonical show root and Season NN",
  canonicalEpisodePath,
  `/downloads/Anime/${CANONICAL}/Season 04`,
);

const aliasEpisodePath = resolveSmartPath("/downloads", "anime", "Anime", {
  title: `${ALIAS} S04E16 1080p WEB-DL`,
  metadata,
});
same(
  "smart-path",
  "catalog-confirmed alias uses the same canonical show root",
  aliasEpisodePath,
  `/downloads/Anime/${CANONICAL}/Season 04`,
);

const absolutePath = resolveSmartPath("/downloads", "anime", "Anime", {
  title: `[SubsPlease] ${CANONICAL} - 72 (1080p)`,
  metadata,
});
same(
  "smart-path",
  "absolute-only episode stays at show root",
  absolutePath,
  `/downloads/Anime/${CANONICAL}`,
);

const multiSeasonPath = resolveSmartPath("/downloads", "anime", "Anime", {
  title: `[EMBER] ${CANONICAL} S01-S03 Complete 1080p`,
  metadata,
});
same(
  "smart-path",
  "multi-season pack stays at show root",
  multiSeasonPath,
  `/downloads/Anime/${CANONICAL}`,
);
truth(
  "smart-path",
  "release group and site junk do not enter the show folder",
  !/EMBER|SubsPlease|www\.|\.org/i.test(
    `${showFolderName(`[EMBER] ${CANONICAL} S01-S03 Complete`)} ${canonicalEpisodePath}`,
  ),
);
same(
  "smart-path",
  "Japanese animated TV metadata classifies as anime",
  detectContentKind({
    title: `${CANONICAL} S04E16 1080p WEB-DL`,
    metadata,
    source: "eztv",
  }),
  "anime",
);

const hunt = resolveHuntCursor({
  title: CANONICAL,
  mediaType: "tv",
  cursorSeason: 4,
  cursorEpisode: 16,
});
same(
  "automation",
  "monitored title targets its exact next cursor episode",
  hunt,
  {
    query: `${CANONICAL} S04E16`,
    cursor: { season: 4, episode: 16 },
  },
);
same(
  "automation",
  "successful acquisition advances without re-requesting the acquired episode",
  afterSuccessfulGrab(
    CANONICAL,
    { season: 4, episode: 16 },
    `${CANONICAL} S04E16 1080p WEB-DL`,
  ),
  {
    lastEpisode: "S04E16",
    cursorSeason: 4,
    cursorEpisode: 17,
    nextEpisodeHint: `${CANONICAL} S04E17`,
  },
);

const failures = checks.filter((check) => !check.pass);
const report = {
  title: CANONICAL,
  generatedAt: new Date().toISOString(),
  summary: {
    checks: checks.length,
    passed: checks.length - failures.length,
    failed: failures.length,
  },
  checks,
};

const outputArg = process.argv.find((arg) => arg.startsWith("--output="));
if (outputArg) {
  writeFileSync(outputArg.slice("--output=".length), JSON.stringify(report, null, 2));
}

console.log(JSON.stringify(report, null, 2));
process.exitCode = failures.length ? 1 : 0;
