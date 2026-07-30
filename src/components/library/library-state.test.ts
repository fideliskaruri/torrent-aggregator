import assert from "node:assert/strict";
import {
  automationStateCopy,
  libraryItemState,
  libraryPageSummary,
} from "./library-state";

let failures = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err instanceof Error ? err.message : String(err)}`);
  }
}

const series = {
  mediaType: "tv",
  title: "Example Show",
  monitored: true,
  cursorSeason: 2,
  cursorEpisode: 3,
  nextEpisodeHint: "Example Show S02E03",
  latestReleaseMagnet: null,
};

console.log("\nlibrary state copy");

check("libraryPageSummary: reports viewer state, not monitored counts", () => {
  const summary = libraryPageSummary([
    { ...series, latestReleaseMagnet: "magnet:?xt=urn:btih:abc" },
    series,
    { ...series, monitored: false },
  ]);

  assert.equal(summary, "3 titles · 1 ready · 1 waiting · 1 paused");
  assert.doesNotMatch(summary, /monitored|cursor/i);
});

check("libraryItemState: ready item answers whether it will play", () => {
  assert.deepEqual(
    libraryItemState(
      { ...series, latestReleaseMagnet: "magnet:?xt=urn:btih:abc" },
      { sending: false, canStream: true },
    ),
    {
      kind: "ready",
      label: "Ready to watch",
      detail: "S02E03 is ready here.",
      nextLabel: "S02E03",
    },
  );
});

check("libraryItemState: pending grab is state, not a permanent explanation", () => {
  const state = libraryItemState(series, { sending: true, canStream: true });

  assert.equal(state.kind, "getting");
  assert.equal(state.label, "Getting S02E03 ready…");
  assert.doesNotMatch(`${state.label} ${state.detail}`, /cursor/i);
});

check("libraryItemState: unchecked is not unavailable", () => {
  assert.deepEqual(
    libraryItemState(series, { sending: false, canStream: true }),
    {
      kind: "waiting",
      label: "Waiting for S02E03",
      detail: "Not downloaded yet.",
      nextLabel: "S02E03",
    },
  );
});

check("libraryItemState: paused names the control outcome", () => {
  const state = libraryItemState(
    { ...series, monitored: false },
    { sending: false, canStream: true },
  );

  assert.equal(state.label, "Paused at S02E03");
  assert.equal(state.detail, "Paused — new episodes won't be added until you resume.");
});

check("automationStateCopy: off state belongs to the control", () => {
  assert.equal(automationStateCopy(0), "New episodes won't download automatically");
  assert.equal(automationStateCopy(30), "Checks for new episodes every 30 minutes");
  assert.equal(automationStateCopy(120), "Checks for new episodes every 2 hours");
});

console.log(
  `\n${failures === 0 ? "library state: all tests passed" : `library state: ${failures} failing`}`,
);
process.exit(failures === 0 ? 0 : 1);
