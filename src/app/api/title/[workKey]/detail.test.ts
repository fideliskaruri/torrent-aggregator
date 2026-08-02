/**
 * Title-detail resume/season logic tests.
 *
 * These cover the three pure decisions behind "the page opens where I left
 * off": which playback rows belong to this work (`progressMatchesWork`), where
 * playback resumes (`resolveResume`), and which season the page opens on
 * (`pickSeason`). They are the exact rules behind the "Play S02E06 on a fresh
 * work" defect and its fix: a series progress row is matched by its *file*, not
 * by a title that only ever stored an episode label.
 *
 * Table-driven per AGENTS.md. Run: npx tsx "src/app/api/title/[workKey]/detail.test.ts"
 */
import assert from "node:assert/strict";
import {
  pickSeason,
  progressMatchesWork,
  resolveResume,
} from "./detail";
import type { TitleSeason } from "@/components/title/types";

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

// --- Factories --------------------------------------------------------------

function season(n: number): TitleSeason {
  return { season: n, knownEpisodes: 0, pack: null, transfer: null };
}

/** A minimal live local release — resolveResume only reads `hash`. */
function local(hash: string) {
  return {
    hash,
    name: `Show.${hash}`,
    progress: 1,
    status: "downloaded",
    season: 1 as number | null,
    episode: 1 as number | null,
    isPack: false,
    isMultiSeason: false,
    retentionState: "kept" as const,
    fileMissing: false as boolean,
  };
}

function progressRow(
  over: Partial<{
    infoHash: string;
    filePath: string;
    positionSec: number;
    durationSec: number | null;
    completedAt: Date | null;
    season: number | null;
    episode: number | null;
  }> = {},
) {
  return {
    infoHash: "hash-a",
    filePath: "video.mkv",
    positionSec: 600,
    durationSec: 1800,
    completedAt: null as Date | null,
    season: 2 as number | null,
    episode: 5 as number | null,
    ...over,
  };
}

console.log("\ntitle detail: resume + season selection");

// --- progressMatchesWork ----------------------------------------------------

check("progressMatchesWork: a series row matches by its file, not its label", () => {
  // The row's title is only the episode label — it can never match the show's
  // workKey. The live local file is what proves it belongs here.
  const row = { title: "S01E01", infoHash: "HASH-1", watchListItemId: null };
  const hashes = new Set(["hash-1"]);
  assert.equal(progressMatchesWork(row, "severance", hashes, null), true);
});

check("progressMatchesWork: matches by watchlist link when the file is gone", () => {
  const row = { title: "S01E01", infoHash: "gone", watchListItemId: "wl-7" };
  assert.equal(
    progressMatchesWork(row, "severance", new Set(), "wl-7"),
    true,
  );
});

check("progressMatchesWork: a movie row matches by title", () => {
  const row = { title: "Dune", infoHash: "gone", watchListItemId: null };
  assert.equal(progressMatchesWork(row, "dune-2021", new Set(), null), true);
});

check("progressMatchesWork: an unrelated row matches nothing", () => {
  const row = { title: "S01E01", infoHash: "other", watchListItemId: "wl-9" };
  assert.equal(progressMatchesWork(row, "severance", new Set(["mine"]), "wl-1"), false);
});

// --- resolveResume ----------------------------------------------------------

check("resolveResume: genuine series progress resumes its episode", () => {
  const resume = resolveResume(
    [progressRow({ infoHash: "hash-1", season: 2, episode: 5, positionSec: 900 })],
    [local("hash-1")],
  );
  assert.ok(resume, "expected a resume target");
  assert.equal(resume?.infoHash, "hash-1");
  assert.equal(resume?.season, 2);
  assert.equal(resume?.episode, 5);
  assert.equal(resume?.label, "S02E05");
  assert.equal(resume?.positionSec, 900);
});

check("resolveResume: a movie resumes its position with no episode label", () => {
  const resume = resolveResume(
    [progressRow({ infoHash: "hash-m", season: null, episode: null, positionSec: 1200 })],
    [local("hash-m")],
  );
  assert.ok(resume, "expected a resume target");
  assert.equal(resume?.season, null);
  assert.equal(resume?.episode, null);
  assert.equal(resume?.label, null);
  assert.equal(resume?.positionSec, 1200);
});

check("resolveResume: progress for a deleted file resumes nothing", () => {
  const resume = resolveResume(
    [progressRow({ infoHash: "deleted" })],
    [local("still-here")],
  );
  assert.equal(resume, null);
});

check("resolveResume: a finished episode is not a resume target", () => {
  const resume = resolveResume(
    [progressRow({ infoHash: "hash-1", completedAt: new Date() })],
    [local("hash-1")],
  );
  assert.equal(resume, null);
});

// --- pickSeason -------------------------------------------------------------

const SEASONS = [season(1), season(2), season(3)];

check("pickSeason: no progress and no cursor opens on the first season", () => {
  assert.equal(pickSeason(SEASONS, null, null, [], null), 1);
});

check("pickSeason: the resumed season wins over a bare watching scan", () => {
  const progress = [
    { season: 1, updatedAt: new Date() },
    { season: 2, updatedAt: new Date() },
  ];
  // resume says season 2; without it the scan would return season 1 first.
  assert.equal(pickSeason(SEASONS, null, 2, progress, null), 2);
});

check("pickSeason: an explicit request still overrides resume", () => {
  assert.equal(pickSeason(SEASONS, 3, 2, [], null), 3);
});

check("pickSeason: a requested season we hold nothing for is still honoured", () => {
  // The client's picker lists provider seasons we may have no local files for.
  // Answering with a different season than was asked is the flashing-list bug:
  // the requested season never matched the answered one, so every poll read as
  // a season change. A request for season 5 must return 5, empty or not.
  assert.equal(pickSeason(SEASONS, 5, 2, [], { cursorSeason: 1 }), 5);
});

check("pickSeason: a resume season not in the list falls through", () => {
  assert.equal(pickSeason(SEASONS, null, 9, [], { cursorSeason: 2 }), 2);
});

check("pickSeason: empty season list has no season to open", () => {
  assert.equal(pickSeason([], 1, 1, [], null), null);
});

console.log(
  `\n${failures === 0 ? "detail: all tests passed" : `detail: ${failures} failing`}`,
);
process.exit(failures === 0 ? 0 : 1);
