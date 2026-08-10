import assert from "node:assert/strict";
import fs from "node:fs";
import type { ProgressEntry } from "@/lib/browse/types";
import { resumeLookupKey, resumePositionForTarget } from "./resume-progress";

function entry(overrides: Partial<ProgressEntry> = {}): ProgressEntry {
  return {
    id: "progress-1",
    infoHash: "abc",
    filePath: "Show/S01E01.mkv",
    positionSec: 120,
    durationSec: 1200,
    fraction: 0.1,
    completedAt: null,
    title: "Show",
    season: 1,
    episode: 1,
    posterUrl: null,
    watchListItemId: null,
    updatedAt: "2026-08-08T00:00:00.000Z",
    ...overrides,
  };
}

assert.equal(
  resumePositionForTarget(
    [
      entry({ id: "newer-other-episode", episode: 1, positionSec: 400 }),
      entry({ id: "target", episode: 2, positionSec: 175 }),
    ],
    { season: 1, episode: 2 },
  ),
  175,
  "season packs resume the requested episode rather than the newest sibling",
);

assert.equal(
  resumePositionForTarget(
    [entry({ episode: 1, positionSec: 400 })],
    { season: 1, episode: 2 },
  ),
  null,
  "a missing episode row starts at zero instead of borrowing a sibling position",
);

assert.equal(
  resumePositionForTarget(
    [
      entry({ id: "episode-1", episode: 1, positionSec: 400 }),
      entry({ id: "episode-2", episode: 2, positionSec: 175 }),
    ],
    {},
  ),
  null,
  "callers without coordinates never guess between multiple files in one hash",
);

assert.equal(
  resumePositionForTarget(
    [
      entry({ id: "episode-1", episode: 1, positionSec: 400 }),
      entry({ id: "episode-2", episode: 2, positionSec: 175 }),
    ],
    { season: 1, episode: null },
  ),
  null,
  "a season-pack target never guesses between multiple episodes in that season",
);

assert.equal(
  resumePositionForTarget(
    [
      entry({ completedAt: "2026-08-08T00:00:00.000Z", positionSec: 1190 }),
      entry({ id: "active", positionSec: 80 }),
    ],
    {},
  ),
  80,
  "completed rows are not resume targets",
);

assert.equal(
  resumePositionForTarget([entry({ positionSec: 5 })], {}),
  null,
  "tiny bookkeeping positions still start from the beginning",
);

assert.notEqual(
  resumeLookupKey("ABC", { season: 1, episode: 1 }),
  resumeLookupKey("abc", { season: 1, episode: 2 }),
  "same-hash season-pack episodes have distinct reload lookup identities",
);
assert.equal(
  resumeLookupKey(" ABC ", { season: 1, episode: 2 }),
  resumeLookupKey("abc", { season: 1, episode: 2 }),
  "hash formatting does not split one exact episode lookup",
);

const overlaySource = fs.readFileSync(
  "src/components/browse/play-overlay.tsx",
  "utf8",
);
assert.match(
  overlaySource,
  /const lookupKey =[\s\S]*?resumeLookupKey\(infoHash,[\s\S]*?season: resolvedSeason,[\s\S]*?episode: resolvedEpisode,/,
  "the reload lookup is keyed by the exact requested episode",
);
assert.match(
  overlaySource,
  /lookedUpResume\?\.key === lookupKey/,
  "a stale same-hash sibling lookup cannot release the player",
);

console.log("PASS resume progress selection");
