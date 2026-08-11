import assert from "node:assert/strict";
import type { AcquisitionWorkRow } from "@/lib/work/store";
import { acquisitionIntentByHash } from "./acquisition-intent";

function target(
  season: number,
  episode: number,
): AcquisitionWorkRow {
  return {
    infoHash: "ABC123",
    workId: "work-1",
    workKey: "example",
    canonicalTitle: "Example",
    year: 2024,
    mediaType: "tv",
    scope: "episode",
    season,
    episode,
  };
}

const sameSeason = acquisitionIntentByHash([
  target(1, 1),
  target(1, 2),
  target(1, 3),
]).get("abc123");
assert.equal(sameSeason?.scope, "season");
assert.equal(sameSeason?.season, 1);
assert.equal(sameSeason?.episode, null);

const multipleSeasons = acquisitionIntentByHash([
  target(1, 8),
  target(2, 1),
  target(2, 2),
]).get("abc123");
assert.equal(multipleSeasons?.scope, "season");
assert.equal(
  multipleSeasons?.season,
  null,
  "a multi-season pack must not be labelled as whichever season was folded first",
);
assert.equal(multipleSeasons?.episode, null);

console.log("acquisition intent: all passed");
