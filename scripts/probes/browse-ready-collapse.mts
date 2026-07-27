import assert from "node:assert/strict";
import { collapseReleasesByWork } from "../../src/lib/browse/collapse";

const releases = [
  "Instant Harness 4242.S01E02.1080p.WEB-DL-GROUPA.mp4",
  "Instant Harness 4242.S01E02.2160p.WEB-DL-GROUPB.mp4",
];

const collapsed = collapseReleasesByWork(
  releases.map((name, index) => ({
    name,
    sortAt: new Date(Date.UTC(2024, 0, 1, 0, index, 0)),
    value: name,
  })),
);

assert.equal(
  collapsed.length,
  1,
  `expected one work card, got ${collapsed.length}: ${collapsed
    .map((work) => work.workKey)
    .join(" | ")}`,
);
assert.equal(collapsed[0]?.releaseCount, 2);
assert.equal(collapsed[0]?.title, "Instant Harness 4242");

console.log("PASS browse ready-card collapse probe");
