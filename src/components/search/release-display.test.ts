import assert from "node:assert/strict";

import type { TorrentResult } from "@/lib/torrents/types";
import { searchReleaseDisplay } from "./release-display";

function release(overrides: Partial<TorrentResult> = {}): TorrentResult {
  return {
    id: "r1",
    title: "The.Boys.S05E03.1080p.WEB.h264-ETHEL",
    magnet: "magnet:?xt=urn:btih:abc",
    sizeBytes: 4_400_000_000,
    seeders: 1099,
    leechers: 12,
    source: "apibay",
    sourceUrl: "https://example.test",
    tags: [],
    health: 88,
    ...overrides,
  };
}

const display = searchReleaseDisplay(release(), {
  workTitle: "The Boys",
  workYear: 2019,
});

assert.equal(display.headline, "The Boys (2019) · S05E03");
assert.equal(display.rawTitle, "The.Boys.S05E03.1080p.WEB.h264-ETHEL");
assert.deepEqual(display.facts, ["1080p", "WEB-DL"]);
assert.deepEqual(display.healthLabel, {
  label: "Health",
  value: "88%",
});

const fallback = searchReleaseDisplay(
  release({ title: "Some.Movie.2024.2160p.WEB-DL.x265", health: undefined }),
  { workTitle: "Some Movie", workYear: 2024 },
);
assert.equal(fallback.headline, "Some Movie (2024)");
assert.deepEqual(fallback.facts, ["2160p", "WEB-DL"]);
assert.equal(fallback.healthLabel, null);

console.log("search release display tests passed.");
