import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  episodesFromFilenames,
  packEpisodeRange,
  planSeason,
} from "./season-plan";
import type { SwarmVerdict } from "./swarm-probe";
import type { TorrentResult } from "./types";

function result(title: string, seeders = 30): TorrentResult {
  const infoHash = createHash("sha1").update(title).digest("hex");
  return {
    id: infoHash,
    title,
    magnet: `magnet:?xt=urn:btih:${infoHash}`,
    infoHash,
    sizeBytes: 1_400_000_000,
    seeders,
    leechers: 3,
    source: "apibay",
    sourceUrl: "https://example.invalid",
    tags: [],
  };
}

function verdicts(table: Record<string, SwarmVerdict>) {
  return (release: TorrentResult): SwarmVerdict =>
    table[release.title] ?? "unknown";
}

assert.deepEqual(packEpisodeRange("The Show S01E01-E08 1080p"), {
  from: 1,
  to: 8,
});
assert.equal(packEpisodeRange("The Show 2019-2021 Complete"), null);

{
  // A season search returns only packs, and none are live on a first grab, so
  // their file lists cannot be read. The pack is taken on its name, marked
  // unconfirmed — dropping it here is what left whole seasons un-downloadable.
  const pack = result("The Expanse S01 COMPLETE");
  const plan = planSeason({
    season: 1,
    wanted: [1, 2, 3],
    releases: [pack],
    verdictOf: () => "good",
  });
  assert.equal(plan.pack?.release.infoHash, pack.infoHash, "name-only pack is takeable");
  assert.equal(plan.pack?.coverageBasis, "inferred", "its coverage is inferred, not fact");
  assert.equal(plan.coverageConfirmed, false, "an inferred pack is not reported as confirmed");
  assert.deepEqual(plan.covered, [1, 2, 3], "it is credited the whole season it names");
  assert.deepEqual(plan.missing, []);
  assert.match(plan.reason, /should cover/, "the reason states the inference, not a fact");
}

for (const count of [0, 1, 6, 8, 23]) {
  const pack = result(`Blue Eye Samurai S01 COMPLETE ${count}`);
  const wanted = Array.from({ length: 24 }, (_, index) => index + 1);
  const plan = planSeason({
    season: 1,
    wanted,
    releases: [pack],
    verdictOf: () => "good",
    packContents: () => wanted.slice(0, count),
  });
  assert.equal(plan.pack, null, `${count}/24 manifest is rejected`);
  assert.deepEqual(plan.covered, []);
}

for (const count of [24, 26]) {
  const pack = result(`Arcane S01 COMPLETE ${count}`);
  const wanted = Array.from({ length: 24 }, (_, index) => index + 1);
  const plan = planSeason({
    season: 1,
    wanted,
    releases: [pack],
    verdictOf: () => "unknown",
    packContents: () =>
      Array.from({ length: count }, (_, index) => index + 1),
  });
  assert.equal(plan.pack?.release.infoHash, pack.infoHash);
  assert.equal(plan.pack?.coverageBasis, "confirmed");
  assert.deepEqual(plan.covered, wanted);
}

{
  const dead = result("Severance S01 COMPLETE dead", 50);
  const good = result("Severance S01 COMPLETE good", 10);
  const plan = planSeason({
    season: 1,
    wanted: [1, 2, 3],
    releases: [dead, good],
    verdictOf: verdicts({
      [dead.title]: "dead",
      [good.title]: "good",
    }),
    packContents: () => [1, 2, 3],
  });
  assert.equal(plan.pack?.release.infoHash, good.infoHash);
}

{
  const pack = result("The Bear S01 COMPLETE");
  const e1 = result("The Bear S01E01 1080p");
  const e2 = result("The Bear S01E02 1080p");
  const plan = planSeason({
    season: 1,
    wanted: [1, 2],
    releases: [pack, e1, e2],
    verdictOf: verdicts({
      [pack.title]: "dead",
      [e1.title]: "good",
      [e2.title]: "good",
    }),
    packContents: () => [1, 2],
  });
  assert.equal(plan.pack, null, "good exact episodes beat a dead pack");
  assert.deepEqual(
    plan.singles.map((single) => single.episode),
    [1, 2],
  );
}

{
  const pack = result("Frieren S01E01-E08 COMPLETE");
  const e9 = result("Frieren S01E09 1080p");
  const plan = planSeason({
    season: 1,
    wanted: [1, 2, 3, 4, 5, 6, 7, 8, 9],
    releases: [pack, e9],
    verdictOf: () => "good",
    packContents: () => [1, 2, 3, 4, 5, 6, 7, 8],
  });
  assert.equal(plan.pack, null, "verified partial packs are not eligible");
  assert.deepEqual(plan.covered, [9]);
  assert.deepEqual(plan.missing, [1, 2, 3, 4, 5, 6, 7, 8]);
}

{
  const wrong = result("Shogun S02 COMPLETE");
  const plan = planSeason({
    season: 1,
    wanted: [1, 2],
    releases: [wrong],
    verdictOf: () => "good",
    packContents: () => [1, 2],
  });
  assert.equal(plan.pack, null);
}

{
  // "I picked 1080p but got 4K." All packs share verdict and coverage, so
  // selection used to fall through to input index — and a 2160p upscale sitting
  // at the top of the ranker order beat a 1080p pack with 5x the seeders. An
  // explicit preferredResolution must win among same-verdict packs.
  const uhd = result("Rick and Morty S06 2160p HDR Ai Upscale");
  const hd = result("Rick and Morty Season 6 S06 1080p WEBRip");
  const wanted = [1, 2, 3];
  const withPref = planSeason({
    season: 6,
    wanted,
    releases: [uhd, hd], // 4K first, as the ranker ordered it
    verdictOf: () => "weak", // the real-world case: neither pack is measured good
    preferredResolution: 1080,
  });
  assert.equal(
    withPref.pack?.release.infoHash,
    hd.infoHash,
    "the 1080p pack wins when 1080p was asked for",
  );

  // No preference → the ranker's order stands (4K was first).
  const noPref = planSeason({
    season: 6,
    wanted,
    releases: [uhd, hd],
    verdictOf: () => "weak",
  });
  assert.equal(
    noPref.pack?.release.infoHash,
    uhd.infoHash,
    "with no preference the input order is untouched",
  );

  // 4K only → still downloads (demote, never filter).
  const only4k = planSeason({
    season: 6,
    wanted,
    releases: [uhd],
    verdictOf: () => "weak",
    preferredResolution: 1080,
  });
  assert.equal(
    only4k.pack?.release.infoHash,
    uhd.infoHash,
    "a season available only in 4K is still taken",
  );
}

{
  // Singles honour the explicit resolution too, and never let a wrong-res
  // release win an episode when the asked-for one exists at the same viability.
  const e1_4k = result("Rick and Morty S09E01 2160p WEB");
  const e1_hd = result("Rick and Morty S09E01 1080p WEB");
  const plan = planSeason({
    season: 9,
    wanted: [1],
    releases: [e1_4k, e1_hd], // 4K first
    verdictOf: () => "unknown",
    preferredResolution: 1080,
  });
  assert.equal(plan.singles[0]?.release.infoHash, e1_hd.infoHash, "1080p single wins");
}

{
  // Singles-first: when every wanted episode has its own release, a pack is
  // never downloaded — even a good/unknown one. Per-episode singles seed better
  // and give real progress; grabbing a whole pack instead was the "downloads a
  // garbage pack even though every episode is right there" complaint.
  const pack = result("The Bear S01 COMPLETE");
  const e1 = result("The Bear S01E01 1080p");
  const e2 = result("The Bear S01E02 1080p");
  const e3 = result("The Bear S01E03 1080p");
  const plan = planSeason({
    season: 1,
    wanted: [1, 2, 3],
    releases: [pack, e1, e2, e3],
    // The pack is "good" — under the old planner it would have been taken.
    verdictOf: (r) => (r.title.includes("COMPLETE") ? "good" : "unknown"),
    packContents: () => [1, 2, 3],
  });
  assert.equal(plan.pack, null, "a pack is not chosen when singles cover the season");
  assert.deepEqual(
    plan.singles.map((s) => s.episode).sort((a, b) => a - b),
    [1, 2, 3],
    "every episode is assembled from its own single",
  );
  assert.deepEqual(plan.covered, [1, 2, 3]);
}

{
  // A pack is still the last resort for episodes no single covers. Here only
  // E1/E2 have singles; E3 exists solely inside the pack, so the pack is pulled
  // in to fill the gap and its now-redundant E1/E2 singles are dropped.
  const pack = result("Old Show S01 COMPLETE");
  const e1 = result("Old Show S01E01 1080p");
  const e2 = result("Old Show S01E02 1080p");
  const plan = planSeason({
    season: 1,
    wanted: [1, 2, 3],
    releases: [pack, e1, e2],
    verdictOf: () => "unknown",
    packContents: () => [1, 2, 3],
  });
  assert.equal(plan.pack?.release.infoHash, pack.infoHash, "the pack fills the gap");
  assert.deepEqual(plan.covered, [1, 2, 3]);
  // The pack delivers E1/E2 too, so their singles are dropped — no double grab.
  assert.equal(plan.singles.length, 0, "singles the pack covers are dropped");
}

{
  // A pack-only season (no singles anywhere) still downloads via the pack.
  const pack = result("Anime S01 COMPLETE");
  const plan = planSeason({
    season: 1,
    wanted: [1, 2, 3],
    releases: [pack],
    verdictOf: () => "unknown",
    packContents: () => [1, 2, 3],
  });
  assert.equal(plan.pack?.release.infoHash, pack.infoHash, "pack-only seasons still work");
  assert.deepEqual(plan.covered, [1, 2, 3]);
}

assert.deepEqual(
  episodesFromFilenames(
    [
      "Severance/Severance.S01E01.1080p.mkv",
      "Severance/Severance.S01E02.1080p.mkv",
      "Severance/E03.mkv",
      "Severance/sample.mkv",
      "Severance/Severance.S02E05.mkv",
    ],
    1,
  ),
  [1, 2, 3],
);

// ── seasonComplete guard ─────────────────────────────────────────────────────
{
  // An airing season leaves a gap (E3 has no single); the pack must be skipped
  // so the planner does not grab a stalled torrent for an unaired episode.
  const pack = result("Airing Show S01 COMPLETE");
  const e1 = result("Airing Show S01E01 1080p");
  const e2 = result("Airing Show S01E02 1080p");
  const plan = planSeason({
    season: 1,
    wanted: [1, 2, 3],
    releases: [pack, e1, e2],
    verdictOf: () => "good",
    packContents: () => [1, 2, 3],
    seasonComplete: false,
  });
  assert.equal(plan.pack, null, "airing season: pack is skipped when singles leave a gap");
  assert.deepEqual(plan.singles.map((s) => s.episode), [1, 2], "only aired singles are taken");
  assert.deepEqual(plan.missing, [3], "unaired episode stays missing");
}

{
  // A pack-only season that is still airing must yield an empty plan — a pack
  // that would cover unaired episodes must not be grabbed.
  const pack = result("Still Airing S01 COMPLETE");
  const plan = planSeason({
    season: 1,
    wanted: [1, 2, 3],
    releases: [pack],
    verdictOf: () => "good",
    packContents: () => [1, 2, 3],
    seasonComplete: false,
  });
  assert.equal(plan.pack, null, "airing season: pack-only releases are also skipped");
  assert.deepEqual(plan.covered, [], "nothing covered");
  assert.deepEqual(plan.missing, [1, 2, 3]);
}

{
  // seasonComplete: true (default) must not change existing behaviour — pack
  // is still chosen when it fills a gap.
  const pack = result("Finished Show S01 COMPLETE");
  const e1 = result("Finished Show S01E01 1080p");
  const e2 = result("Finished Show S01E02 1080p");
  const plan = planSeason({
    season: 1,
    wanted: [1, 2, 3],
    releases: [pack, e1, e2],
    verdictOf: () => "good",
    packContents: () => [1, 2, 3],
    seasonComplete: true,
  });
  assert.equal(plan.pack?.release.infoHash, pack.infoHash, "completed season: pack still chosen");
  assert.deepEqual(plan.covered, [1, 2, 3]);
}

console.log("season-plan.test.ts: PASS (manifest-first selection)");
