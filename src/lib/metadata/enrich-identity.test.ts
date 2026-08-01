import assert from "node:assert/strict";
import type { MediaMetadata } from "@/lib/torrents/types";
import { metadataIdentityCompatible } from "./enrich";

function metadata(
  title: string,
  aliases: string[],
  mediaType: MediaMetadata["mediaType"] = "anime",
  year: number | null = null,
): MediaMetadata {
  return {
    source: mediaType === "anime" ? "anilist" : "tmdb",
    mediaType,
    externalId: `${title}:${year ?? "none"}`,
    title,
    aliases,
    year,
  };
}

const cases = [
  {
    name: "translated Slime release rejects a similarly prefixed sword series",
    release:
      "[Asakura] Tensei Shitara Slime Datta Ken 4th Season - 15 | That Time I Got Reincarnated as a Slime Season 4 | Episode 87",
    query: "That Time I Got Reincarnated as a Slime",
    category: "anime",
    candidate: metadata("Tensei Shitara Ken Deshita 2nd Season", [
      "Reincarnated as a Sword Season 2",
    ]),
    expected: false,
  },
  {
    name: "translated Slime release accepts a provider-backed English alias",
    release:
      "[Asakura] Tensei Shitara Slime Datta Ken 4th Season - 15 | That Time I Got Reincarnated as a Slime Season 4 | Episode 87",
    query: "That Time I Got Reincarnated as a Slime",
    category: "anime",
    candidate: metadata("Tensei Shitara Slime Datta Ken", [
      "That Time I Got Reincarnated as a Slime",
    ]),
    expected: true,
  },
  {
    name: "romaji Attack on Titan release accepts its English provider alias",
    release: "[Group] Shingeki no Kyojin The Final Season - 07 1080p",
    query: "Attack on Titan",
    category: "anime",
    candidate: metadata("Shingeki no Kyojin", ["Attack on Titan"]),
    expected: true,
  },
  {
    name: "shared Titan token cannot attach an unrelated film",
    release: "Attack on Titan S04E07 1080p",
    query: "Attack on Titan",
    category: "anime",
    candidate: metadata("Titan A.E.", [], "movie", 2000),
    expected: false,
  },
  {
    name: "same-name movie from the wrong year is rejected",
    release: "Dune 2021 1080p WEB-DL",
    query: "Dune 2021",
    category: "movies",
    candidate: metadata("Dune", [], "movie", 1984),
    expected: false,
  },
  {
    name: "same-name movie from the selected year is accepted",
    release: "Dune 2021 1080p WEB-DL",
    query: "Dune 2021",
    category: "movies",
    candidate: metadata("Dune", [], "movie", 2021),
    expected: true,
  },
  {
    name: "wrong media type is rejected even for an exact title",
    release: "Severance S02E01 1080p WEB-DL",
    query: "Severance",
    category: "tv",
    candidate: metadata("Severance", [], "movie", 2015),
    expected: false,
  },
  {
    name: "series release year does not replace the canonical first-air year",
    release: "That Time I Got Reincarnated as a Slime S04E16 2026 1080p",
    query: "That Time I Got Reincarnated as a Slime",
    category: "anime",
    candidate: metadata("That Time I Got Reincarnated as a Slime", [], "anime", 2018),
    expected: true,
  },
  {
    name: "numeric film title 1917 uses the later release-year qualifier",
    release: "1917 2019 1080p WEB-DL",
    query: "1917 2019",
    category: "movies",
    candidate: metadata("1917", [], "movie", 2019),
    expected: true,
  },
  {
    name: "numeric film title 2012 does not masquerade as its release year",
    release: "2012 2009 1080p BluRay",
    query: "2012 2009",
    category: "movies",
    candidate: metadata("2012", [], "movie", 2009),
    expected: true,
  },
  {
    name: "numeric title token in 2001 A Space Odyssey is ignored as a qualifier",
    release: "2001 A Space Odyssey 1968 2160p BluRay",
    query: "2001 A Space Odyssey",
    category: "movies",
    candidate: metadata("2001: A Space Odyssey", [], "movie", 1968),
    expected: true,
  },
  {
    name: "numeric film still rejects a wrong later year qualifier",
    release: "1917 2018 1080p WEB-DL",
    query: "1917",
    category: "movies",
    candidate: metadata("1917", [], "movie", 2019),
    expected: false,
  },
] as const;

for (const test of cases) {
  assert.equal(
    metadataIdentityCompatible(
      test.release,
      test.candidate,
      test.query,
      test.category,
    ),
    test.expected,
    test.name,
  );
}

console.log("metadata identity compatibility: all tests passed");
