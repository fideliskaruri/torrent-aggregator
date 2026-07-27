import assert from "node:assert/strict";

import {
  describePlayback,
  waitOutcome,
  type PlaybackActionOutcome,
  type PlaybackNarration,
} from "./narration";

const WAIT = waitOutcome({ reason: "connecting" });
const SELECTED = { infoHash: "1".padStart(40, "0"), title: "The Bear S01E01 720p", seeders: 4 };
const SWITCH: PlaybackActionOutcome = {
  kind: "switch-source",
  reason: "delivery",
  selected: SELECTED,
  alternatives: [],
  remainingCount: 0,
};
const EXHAUSTED: PlaybackActionOutcome = {
  kind: "none-available",
  reason: "all-sources-failed",
  triedCount: 1,
  totalCandidates: 1,
  seededCandidateCount: 1,
};

interface Case {
  name: string;
  state: PlaybackNarration;
  headline: string;
  detail?: string;
}

const cases: Case[] = [
  {
    name: "first start says starting, not mechanism",
    state: { phase: "starting", attempt: 1, outcome: WAIT },
    headline: "Starting playback…",
  },
  {
    name: "a later attempt says trying another",
    state: { phase: "starting", attempt: 2, outcome: WAIT },
    headline: "Trying another source…",
  },
  {
    name: "playing is a plain state",
    state: { phase: "playing" },
    headline: "Playing",
  },
  {
    name: "a delivery switch names the next release",
    state: { phase: "switching", cause: "delivery", triedCount: 1, nextName: "The Bear S01E01 720p", outcome: SWITCH },
    headline: "This source stalled — trying another…",
    detail: "Switching to “The Bear S01E01 720p”.",
  },
  {
    name: "a switch without a name still reads as state",
    state: { phase: "switching", cause: "delivery", triedCount: 2, nextName: null, outcome: SWITCH },
    headline: "This source stalled — trying another…",
    detail: "Switching to another release.",
  },
  {
    name: "a playability switch says the device can't play it, not that it stalled",
    state: {
      phase: "switching",
      cause: "playability",
      triedCount: 1,
      nextName: "The Bear S01E01 720p",
      outcome: { ...SWITCH, reason: "playability" },
    },
    headline: "Your device can’t play this one — trying another…",
    detail: "Switching to “The Bear S01E01 720p”.",
  },
  {
    name: "exhausted with one source uses singular copy",
    state: { phase: "exhausted", cause: "delivery", triedCount: 1, outcome: EXHAUSTED },
    headline: "Couldn’t start this — no working source right now",
    detail: "We tried the only source we could find and none were delivering. Try again later.",
  },
  {
    name: "exhausted with several sources uses plural copy",
    state: { phase: "exhausted", cause: "delivery", triedCount: 4, outcome: { ...EXHAUSTED, triedCount: 4, totalCandidates: 4 } },
    headline: "Couldn’t start this — no working source right now",
    detail: "We tried all 4 sources we could find and none were delivering. Try again later.",
  },
  {
    name: "exhausted for playability says nothing was playable, not that nothing delivered",
    state: {
      phase: "exhausted",
      cause: "playability",
      triedCount: 3,
      outcome: { ...EXHAUSTED, reason: "no-playable-sources", triedCount: 3, totalCandidates: 3 },
    },
    headline: "Couldn’t play this — nothing your device supports right now",
    detail: "We tried all 3 sources we could find and none were ones your device can play. Try again later.",
  },
  {
    name: "a pinned stall is held, not switched",
    state: {
      phase: "stalled-held",
      outcome: { kind: "choose-source", reason: "manual-source-stalled", alternatives: [], alternativeCount: 0 },
    },
    headline: "The source you chose has stalled",
    detail: "No other release is available right now. You can keep waiting or try again later.",
  },
];

function run() {
  for (const tc of cases) {
    const copy = describePlayback(tc.state);
    assert.equal(copy.headline, tc.headline, `${tc.name}: headline`);
    assert.equal(copy.detail, tc.detail, `${tc.name}: detail`);

    // The presentation seam must never leak mechanism: no absolute paths, no
    // byte rates, no peer counts standing in for an explanation.
    const text = `${copy.headline} ${copy.detail ?? ""}`;
    assert.ok(!/[A-Za-z]:\\/.test(text), `${tc.name}: no Windows path`);
    assert.ok(!/\bpeers?\b/i.test(text), `${tc.name}: no peer count`);
    assert.ok(!/\bKB\/s|MB\/s|bytes?\b/i.test(text), `${tc.name}: no byte rate`);
  }

  console.log(`narration.test.ts: PASS (${cases.length} cases)`);
}

try {
  run();
} catch (err) {
  console.error("narration.test.ts: FAIL");
  console.error(err);
  process.exit(1);
}
