import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  resolveEpisodeSearchIdentity,
  selectReusableLocalEpisode,
  selectWorkCandidate,
} from "./grab";
import { workKeyFor } from "@/components/title/work-key";
import type { TorrentResult } from "@/lib/torrents/types";
import type { MediaMetadata } from "@/lib/torrents/types";

function release(title: string): TorrentResult {
  const hash = createHash("sha1").update(title).digest("hex");
  return {
    id: hash,
    title,
    magnet: `magnet:?xt=urn:btih:${hash}`,
    infoHash: hash,
    sizeBytes: 4_000_000_000,
    seeders: 20,
    leechers: 1,
    source: "apibay",
    sourceUrl: "https://example.test",
    tags: [],
  };
}

const movieKey = workKeyFor("Dune", 2021);
const movies = [2160, 1080, 720].map((resolution) =>
  release(`Dune 2021 ${resolution}p WEB-DL`),
);
for (const resolution of [2160, 1080, 720]) {
  assert.match(
    selectWorkCandidate(
      movies,
      movieKey,
      false,
      resolution,
      "Dune",
      "movies",
    )?.title ?? "",
    new RegExp(`${resolution}p`),
    `${resolution}p affinity is honored for whole-work acquisition`,
  );
}
assert.match(
  selectWorkCandidate(
    [movies[0], movies[2]],
    movieKey,
    false,
    1080,
    "Dune",
    "movies",
  )?.title ?? "",
  /2160p/,
  "when 1080p is absent, 2160p is eligible while 720p is below the floor",
);
assert.equal(
  selectWorkCandidate(
    [movies[2]],
    movieKey,
    false,
    1080,
    "Dune",
    "movies",
  ),
  null,
  "a whole-work download never falls below its selected minimum",
);
assert.match(
  selectWorkCandidate(
    [movies[2]],
    movieKey,
    false,
    1080,
    "Dune",
    "movies",
    null,
  )?.title ?? "",
  /720p/,
  "a stream keeps preferred-quality ranking without imposing a download floor",
);

const exactHash = createHash("sha1").update("exact-local").digest("hex");
const rows = [
  {
    hash: createHash("sha1").update("range").digest("hex"),
    name: "The Bear S01E01-E08 1080p",
    status: "downloading",
    origin: "stream",
  },
  {
    hash: createHash("sha1").update("pack").digest("hex"),
    name: "The Bear S01 COMPLETE",
    status: "downloading",
    origin: "stream",
  },
  {
    hash: exactHash,
    name: "The Bear S01E01 1080p WEB-DL",
    status: "downloading",
    origin: "stream",
  },
];
assert.equal(
  selectReusableLocalEpisode(rows, { season: 1, episode: 1 })?.hash,
  exactHash,
  "server-known exact local episode is reusable while ranges and packs are not",
);
assert.equal(
  selectReusableLocalEpisode(rows, {
    season: 1,
    episode: 1,
    minimumResolution: 2160,
  }),
  null,
  "a lower-quality stream allocation is not promoted into a higher-quality kept download",
);
assert.equal(
  selectReusableLocalEpisode(
    [{ ...rows[2], name: "The Bear S01E01 WEB-DL" }],
    { season: 1, episode: 1, minimumResolution: 1080 },
  ),
  null,
  "unknown-quality stream allocations cannot bypass a configured floor",
);
assert.equal(
  selectReusableLocalEpisode(
    [{ ...rows[2], origin: "user" }],
    { season: 1, episode: 1 },
  ),
  null,
  "only an existing streaming allocation takes the reuse path",
);
assert.equal(
  selectReusableLocalEpisode(
    [{ ...rows[2], hash: "client-controlled-not-a-hash" }],
    { season: 1, episode: 1 },
  ),
  null,
  "an invalid hash is never promoted",
);
assert.equal(
  selectReusableLocalEpisode([], { season: 1, episode: 1 }),
  null,
  "missing local state falls back to discovery",
);

const slimeMetadata: MediaMetadata = {
  source: "anilist",
  mediaType: "anime",
  externalId: "101280",
  title: "Tensei Shitara Slime Datta Ken",
  aliases: ["That Time I Got Reincarnated as a Slime", "転生したらスライムだった件"],
  year: 2018,
};
async function verifyAnimeAliasRecovery() {
  const recovered = await resolveEpisodeSearchIdentity(
    {
      resolvedTitle: "That Time I Got Reincarnated as a Slime",
      resolvedYear: 2018,
      resolvedMediaType: "tv",
      resolvedAliases: [],
    },
    async () => [slimeMetadata],
  );
  assert.equal(recovered.mediaType, "anime");
  assert.ok(recovered.aliases.includes("Tensei Shitara Slime Datta Ken"));

  const collision = await resolveEpisodeSearchIdentity(
    {
      resolvedTitle: "The Bear",
      resolvedYear: 2022,
      resolvedMediaType: "tv",
      resolvedAliases: [],
    },
    async () => [
      {
        ...slimeMetadata,
        title: "The Bear",
        aliases: [],
        year: 2004,
      },
    ],
  );
  assert.deepEqual(
    collision,
    { mediaType: "tv", aliases: [] },
    "a same-name anime from another year cannot redirect a TV download",
  );
}

void verifyAnimeAliasRecovery()
  .then(() => console.log("grab-selection.test.ts: PASS"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
