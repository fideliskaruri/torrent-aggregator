import assert from "node:assert/strict";
import { parseEpisode } from "./episodes";
import { rankResults } from "./ranking";
import type { TorrentResult } from "./types";

function release(id: string, title: string): TorrentResult {
  return {
    id,
    title,
    magnet: `magnet:?xt=urn:btih:${id}`,
    sizeBytes: 1_400_000_000,
    seeders: 100,
    leechers: 2,
    source: "nyaa",
    sourceUrl: "https://example.invalid",
    tags: ["1080p", "WEB-DL"],
  };
}

for (const test of [
  {
    name: "Slime seasonal and absolute numbers remain distinct",
    title:
      "[Asakura] Tensei Shitara Slime Datta Ken 4th Season - 15 [1080p] | That Time I Got Reincarnated as a Slime Season 4 | Episode 87",
    expected: {
      season: 4,
      episode: 15,
      absoluteEpisode: 87,
      label: "S04E15 · absolute 87",
    },
  },
  {
    name: "Bleach dual numbering is interpreted as season then episode",
    title:
      "[Group] Bleach Thousand-Year Blood War 3rd Season - 02 [1080p] | Episode 28",
    expected: {
      season: 3,
      episode: 2,
      absoluteEpisode: 28,
      label: "S03E02 · absolute 28",
    },
  },
  {
    name: "ordinary absolute numbering remains absolute-only",
    title: "[Group] One Piece - 1171 [1080p]",
    expected: {
      season: undefined,
      episode: 1171,
      absoluteEpisode: undefined,
      label: "Ep 1171",
    },
  },
]) {
  const actual = parseEpisode(test.title);
  assert.deepEqual(
    {
      season: actual.season,
      episode: actual.episode,
      absoluteEpisode: actual.absoluteEpisode,
      label: actual.label,
    },
    test.expected,
    test.name,
  );
}

const preserved = [
  {
    title: "Show S04 COMPLETE 1080p",
    expected: { season: 4, pack: true, special: undefined },
  },
  {
    title: "Show Seasons 1-4 Complete 1080p",
    expected: { season: 1, pack: true, special: undefined },
  },
  {
    title: "Show S00E01 OVA 1080p",
    expected: { season: 0, pack: false, special: "ova" },
  },
] as const;
for (const test of preserved) {
  const actual = parseEpisode(test.title);
  assert.deepEqual(
    {
      season: actual.season,
      pack: actual.isSeasonPack,
      special: actual.specialType,
    },
    test.expected,
    test.title,
  );
}

for (const test of [
  {
    name: "Slime S04E16 outranks season episode 15 with absolute number 87",
    query: "That Time I Got Reincarnated as a Slime",
    older:
      "[Asakura] Tensei Shitara Slime Datta Ken 4th Season - 15 [1080p WEB-DL] | That Time I Got Reincarnated as a Slime Season 4 | Episode 87",
    latest:
      "That Time I Got Reincarnated as a Slime S04E16 1080p WEB-DL",
  },
  {
    name: "Attack on Titan seasonal episode beats a larger absolute counter",
    query: "Attack on Titan",
    older:
      "Attack on Titan 4th Season - 07 1080p WEB-DL | Episode 82",
    latest: "Attack on Titan S04E08 1080p WEB-DL",
  },
  {
    name: "Bleach seasonal episode beats its next absolute-series predecessor",
    query: "Bleach Thousand-Year Blood War",
    older:
      "Bleach Thousand-Year Blood War 3rd Season - 02 1080p WEB-DL | Episode 28",
    latest:
      "Bleach Thousand-Year Blood War S03E03 1080p WEB-DL",
  },
]) {
  const ranked = rankResults(
    [release("older", test.older), release("latest", test.latest)],
    test.query,
    1080,
    "anime",
  );
  assert.equal(ranked[0].id, "latest", test.name);
}

const absoluteOnly = rankResults(
  [
    release("1170", "[A] One Piece - 1170 [1080p]"),
    release("1171", "[B] One Piece - 1171 [1080p]"),
  ],
  "One Piece",
  1080,
  "anime",
);
assert.equal(absoluteOnly[0].id, "1171");

for (const test of [
  {
    name: "Slime absolute 88 outranks dual-numbered absolute 87",
    query: "That Time I Got Reincarnated as a Slime",
    dual:
      "That Time I Got Reincarnated as a Slime 4th Season - 15 | Episode 87 1080p WEB-DL",
    absolute:
      "That Time I Got Reincarnated as a Slime - 88 1080p WEB-DL",
  },
  {
    name: "Bleach absolute 29 outranks dual-numbered absolute 28",
    query: "Bleach Thousand-Year Blood War",
    dual:
      "Bleach Thousand-Year Blood War 3rd Season - 02 | Episode 28 1080p WEB-DL",
    absolute:
      "Bleach Thousand-Year Blood War - 29 1080p WEB-DL",
  },
]) {
  const ranked = rankResults(
    [release("dual", test.dual), release("absolute", test.absolute)],
    test.query,
    1080,
    "anime",
  );
  assert.equal(ranked[0].id, "absolute", test.name);
}

const packStillPreserved = rankResults(
  [
    release("pack", "Show S04 COMPLETE 1080p WEB-DL"),
    release("episode", "Show - 88 1080p WEB-DL"),
  ],
  "Show",
  1080,
  "anime",
);
assert.equal(
  packStillPreserved.find((item) => item.id === "pack")?.episode?.isSeasonPack,
  true,
);

console.log("absolute/seasonal ranking: all tests passed");
