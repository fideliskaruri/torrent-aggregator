import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  selectReusableLocalEpisode,
  selectWorkCandidate,
} from "./grab";
import { workKeyFor } from "@/components/title/work-key";
import type { TorrentResult } from "@/lib/torrents/types";

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
  /720p/,
  "when 1080p is absent, 720p beats an oversized 2160p fallback",
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

console.log("grab-selection.test.ts: PASS");
