import assert from "node:assert/strict";
import { workIdentity } from "@/lib/torrents/work-identity";
import { identitiesAgree, resolveTitleIntent } from "./title-intent";

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL  ${name}`);
    console.error(error);
  }
}

console.log("\ntitle identity accuracy");

const intentCases = [
  {
    name: "Dune 2021 selection rejects a same-name 2017 documentary row",
    workKey: "dune-2021",
    selection: { title: "Dune", year: 2021, mediaType: "movie" },
    catalog: { title: "Dune", year: 2017, mediaType: "movie" },
    expected: ["Dune", 2021, "movie", false] as const,
  },
  {
    name: "same title and year but wrong media type cannot replace selection",
    workKey: "the-office-1995",
    selection: { title: "The Office", year: 1995, mediaType: "movie" },
    catalog: { title: "The Office", year: 1995, mediaType: "tv" },
    expected: ["The Office", 1995, "movie", false] as const,
  },
  {
    name: "matching selected identity may use its catalog detail",
    workKey: "arrival-2016",
    selection: { title: "Arrival", year: 2016, mediaType: "movie" },
    catalog: { title: "Arrival", year: 2016, mediaType: "movie" },
    expected: ["Arrival", 2016, "movie", true] as const,
  },
] as const;

for (const fixture of intentCases) {
  check(fixture.name, () => {
    const answer = resolveTitleIntent(fixture);
    assert.deepEqual(
      [answer.title, answer.year, answer.mediaType, answer.catalogAccepted],
      fixture.expected,
    );
  });
}

check("provider-verified English and romaji aliases agree", () => {
  assert.equal(
    identitiesAgree(
      { title: "Attack on Titan", mediaType: "anime" },
      {
        title: "Shingeki no Kyojin",
        aliases: ["Attack on Titan", "進撃の巨人"],
        mediaType: "anime",
      },
    ),
    true,
  );
});

check("Slime English and romaji releases share provider-backed identity", () => {
  const metadata = {
    source: "anilist" as const,
    mediaType: "anime" as const,
    externalId: "101280",
    title: "That Time I Got Reincarnated as a Slime",
    aliases: ["Tensei Shitara Slime Datta Ken"],
  };
  const english = workIdentity(
    "That Time I Got Reincarnated as a Slime S03E24 1080p",
    metadata,
  );
  const romaji = workIdentity(
    "[SubsPlease] Tensei Shitara Slime Datta Ken S03E24 1080p",
    metadata,
  );
  assert.equal(english.key, romaji.key);
});

check("legacy anime metadata can bridge a distinctive translated token", () => {
  const metadata = {
    source: "tmdb" as const,
    mediaType: "tv" as const,
    externalId: "82684",
    title: "That Time I Got Reincarnated as a Slime",
    genres: ["Animation"],
    originalLanguage: "ja",
  };
  assert.equal(
    workIdentity("Tensei Shitara Slime Datta Ken S03E24", metadata).key,
    workIdentity(
      "That Time I Got Reincarnated as a Slime S03E24",
      metadata,
    ).key,
  );
});

check("season and episode variants remain one series", () => {
  const names = [
    "Frieren Beyond Journey's End S02E03 1080p",
    "Frieren Beyond Journey's End Season 2 Complete 1080p",
    "Frieren Beyond Journey's End 2x03 1080p",
  ];
  assert.equal(new Set(names.map((name) => workIdentity(name).key)).size, 1);
});

check("anime companion film does not collapse into the numbered series", () => {
  const series = workIdentity("Made in Abyss S01E03 1080p");
  const movie = workIdentity("Made in Abyss Movie 3 Dawn of the Deep Soul 1080p");
  assert.notEqual(series.key, movie.key);
});

console.log(
  failures === 0
    ? "\ntitle identity accuracy: all tests passed"
    : `\ntitle identity accuracy: ${failures} failing`,
);
process.exit(failures === 0 ? 0 : 1);
