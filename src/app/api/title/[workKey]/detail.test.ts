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
  buildEpisodes,
  buildPackCoverage,
  currentEpisodeEvidence,
  pickSeason,
  progressMatchesWork,
  resolveResume,
  type EpisodeBuildInput,
  type LocalRelease,
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

check("cached episode evidence is reparsed after parser fixes", () => {
  const episode = currentEpisodeEvidence({
    title: "[matheousse] Slime 300 S1 MULTi VF/VOSTFR (BD 1080p AAC Opus)",
    episode: {
      season: 1,
      episode: 300,
      label: "S01 Ep 300",
      isBatch: false,
      isSeasonPack: false,
      isMultiSeason: false,
    },
  });
  assert.equal(episode.season, 1);
  assert.equal(episode.episode, undefined);
  assert.equal(episode.isSeasonPack, true);
});

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

// --- pickSeason: remembered manual season (durable persistence fix) --------
//
// A season the user picked by hand on a previous visit. Governs which
// episode LIST the page opens on, so it must beat resume/progress and the
// watch cursor/default — the exact owner repro was a stale resume/progress
// row for a season far ahead of what was picked (Season 2 chosen, an old
// Season 9 progress row won). It must never outrank an explicit `?s=`
// request, which is the one thing that can override even a manual pick.
// Resume itself stays a separate action untouched by this ordering.

check("pickSeason: remembered season wins over resume", () => {
  assert.equal(pickSeason(SEASONS, null, 9, [], null, 2), 2);
});

check("pickSeason: remembered season wins over a bare watching scan", () => {
  const progress = [{ season: 1, updatedAt: new Date() }];
  assert.equal(pickSeason(SEASONS, null, null, progress, null, 2), 2);
});

check("pickSeason: remembered season wins over the watch cursor", () => {
  assert.equal(
    pickSeason(SEASONS, null, null, [], { cursorSeason: 1 }, 3),
    3,
  );
});

check("pickSeason: remembered season wins over the bare default (first season)", () => {
  assert.equal(pickSeason(SEASONS, null, null, [], null, 2), 2);
});

check("pickSeason: an explicit request still overrides a remembered season", () => {
  assert.equal(pickSeason(SEASONS, 3, null, [], null, 1), 3);
});

check("pickSeason: a remembered provider-only season we hold nothing for still wins over resume", () => {
  // Same semantics as an explicit `?s=` request: the client's picker lists
  // provider seasons we hold no local files for, so a remembered pick of one
  // is legitimate. Gating it on the local set was the Rick and Morty defect —
  // remembered Season 2 was discarded and stale resume Season 9 won.
  assert.equal(pickSeason(SEASONS, null, 9, [], { cursorSeason: 1 }, 2), 2);
  assert.equal(pickSeason(SEASONS, null, 9, [], { cursorSeason: 1 }, 99), 99);
});

check("pickSeason: an explicit request beats a remembered provider-only season", () => {
  assert.equal(pickSeason(SEASONS, 5, 9, [], { cursorSeason: 1 }, 2), 5);
});

check("pickSeason: an invalid remembered season falls through to resume", () => {
  assert.equal(pickSeason(SEASONS, null, 2, [], { cursorSeason: 1 }, 0), 2);
  assert.equal(pickSeason(SEASONS, null, 2, [], { cursorSeason: 1 }, -3), 2);
});

check("pickSeason: no remembered season falls through to resume, then watching, then cursor", () => {
  assert.equal(
    pickSeason(SEASONS, null, 2, [], { cursorSeason: 1 }, null),
    2,
  );
  const progress = [{ season: 1, updatedAt: new Date() }];
  assert.equal(
    pickSeason(SEASONS, null, null, progress, { cursorSeason: 2 }, null),
    1,
  );
});

check("pickSeason: no remembered season falls through to the watch cursor", () => {
  assert.equal(
    pickSeason(SEASONS, null, null, [], { cursorSeason: 2 }, null),
    2,
  );
});

// --- pack coverage → episode rows -------------------------------------------
//
// The season-pack defect: a completed S02 pack seeds episode files on disk, but
// each episode row read only its own acquisition and rendered a plain Download.
// These prove the pack now covers those episodes (tick/Play) while leaving the
// episodes it does not contain untouched, and never over-claiming a phantom.

/** A local pack release, present on disk unless overridden. */
function packRelease(over: Partial<LocalRelease> = {}): LocalRelease {
  return {
    hash: "packhash",
    name: "Rick and Morty (2013) Season 2 S02 (1080p BluRay)",
    progress: 1,
    status: "seeding",
    season: 2,
    episode: null,
    isPack: true,
    isMultiSeason: false,
    retentionState: "kept",
    fileMissing: false,
    ...over,
  };
}

const RM_S02_FILES = JSON.stringify([
  { path: "D:\\RM S02\\Season 02\\Rick and Morty S02E03 Crewcoo (1080p BluRay).mkv", size: 1_500_000_000, mtimeMs: 1 },
  { path: "D:\\RM S02\\Season 02\\Rick and Morty S02E04 Total Rickall (1080p BluRay).mkv", size: 1_600_000_000, mtimeMs: 1 },
  { path: "D:\\RM S02\\Season 02\\Rick and Morty S02E05 Get Schwifty (1080p BluRay).mkv", size: 1_550_000_000, mtimeMs: 1 },
  { path: "D:\\RM S02\\Featurettes\\Animatics\\01 - A Rickle in Time (Attempt 1).mkv", size: 40_000_000, mtimeMs: 1 },
  { path: "D:\\RM S02\\Season 02\\Rick and Morty S02E03.nfo", size: 2000, mtimeMs: 1 },
  { path: "D:\\RM S02\\Torrent Downloaded From ExtraTorrent.txt", size: 100, mtimeMs: 1 },
]);

function engineMap(hash: string, verifiedFilesJson: string | null) {
  return new Map([
    [
      hash.toLowerCase(),
      {
        progress: 1,
        status: "downloaded",
        verifiedBitfield: verifiedFilesJson ? "AQ==" : null,
        verifiedFilesJson,
      },
    ],
  ]);
}

function episodeInput(over: Partial<EpisodeBuildInput>): EpisodeBuildInput {
  return {
    season: 2,
    localReleases: [],
    cachedReleases: [],
    progress: [],
    cursorSeason: null,
    cursorEpisode: null,
    transfers: new Map(),
    packCoverage: new Map(),
    ...over,
  };
}

check("buildPackCoverage: a ready season pack covers its real episodes", () => {
  const coverage = buildPackCoverage(
    [packRelease()],
    engineMap("packhash", RM_S02_FILES),
    2,
  );
  assert.equal(coverage.get(3)?.availability, "ready");
  assert.equal(coverage.get(3)?.infoHash, "packhash");
  assert.equal(
    coverage.get(3)?.filePath,
    "D:\\RM S02\\Season 02\\Rick and Morty S02E03 Crewcoo (1080p BluRay).mkv",
  );
  assert.ok(coverage.has(4));
  assert.ok(coverage.has(5));
});

check("buildPackCoverage: Featurettes/nfo/txt never create phantom episodes", () => {
  const coverage = buildPackCoverage(
    [packRelease()],
    engineMap("packhash", RM_S02_FILES),
    2,
  );
  assert.equal(coverage.has(1), false); // "01 - A Rickle in Time" is not E1
  assert.equal(coverage.size, 3);
});

check("buildPackCoverage: a pack whose files land elsewhere covers nothing", () => {
  // Different-season files must not map onto this season.
  const coverage = buildPackCoverage(
    [packRelease()],
    engineMap(
      "packhash",
      JSON.stringify([{ path: "D:\\x\\Show S03E01 A.mkv", size: 10 }]),
    ),
    2,
  );
  assert.equal(coverage.size, 0);
});

check("buildPackCoverage: null verifiedFilesJson yields no coverage", () => {
  const coverage = buildPackCoverage(
    [packRelease()],
    engineMap("packhash", null),
    2,
  );
  assert.equal(coverage.size, 0);
});

check("buildPackCoverage: full-length files without verified completion cover nothing", () => {
  const coverage = buildPackCoverage(
    [packRelease({ progress: 0.4, status: "downloading" })],
    new Map([
      [
        "packhash",
        {
          progress: 0.4,
          status: "downloading",
          verifiedBitfield: null,
          verifiedFilesJson: RM_S02_FILES,
        },
      ],
    ]),
    2,
  );
  assert.equal(
    coverage.size,
    0,
    "allocated or sparse full-length files are not proof that their pieces verified",
  );
});

check("buildPackCoverage: a file-missing pack makes no local claim", () => {
  const coverage = buildPackCoverage(
    [packRelease({ fileMissing: true })],
    engineMap("packhash", RM_S02_FILES),
    2,
  );
  assert.equal(coverage.size, 0);
});

check("buildPackCoverage: season pack wins over a multi-season pack", () => {
  const seasonPack = packRelease({ hash: "seasonhash" });
  const multi = packRelease({
    hash: "multihash",
    isMultiSeason: true,
    name: "Rick and Morty S01-S05 Complete",
  });
  const engines = new Map<string, {
    progress: number;
    status: string;
    verifiedBitfield: string | null;
    verifiedFilesJson: string | null;
  }>([
    ["seasonhash", {
      progress: 1,
      status: "downloaded",
      verifiedBitfield: "AQ==",
      verifiedFilesJson: JSON.stringify([
        { path: "D:\\season\\Rick and Morty S02E03 SEASON.mkv", size: 100 },
      ]),
    }],
    ["multihash", {
      progress: 1,
      status: "downloaded",
      verifiedBitfield: "AQ==",
      verifiedFilesJson: JSON.stringify([
        { path: "D:\\multi\\Rick and Morty S02E03 MULTI.mkv", size: 999 },
      ]),
    }],
  ]);
  const coverage = buildPackCoverage([multi, seasonPack], engines, 2);
  assert.equal(coverage.get(3)?.infoHash, "seasonhash");
  assert.equal(coverage.get(3)?.filePath, "D:\\season\\Rick and Morty S02E03 SEASON.mkv");
});

check("buildEpisodes: a pack-covered episode stays playable but does not invent a transfer", () => {
  const rows = buildEpisodes(
    episodeInput({
      packCoverage: buildPackCoverage(
        [packRelease()],
        engineMap("packhash", RM_S02_FILES),
        2,
      ),
    }),
  );
  const e3 = rows.find((r) => r.episode === 3);
  assert.equal(e3?.availability, "ready");
  assert.equal(e3?.infoHash, "packhash");
  assert.equal(
    e3?.filePath,
    "D:\\RM S02\\Season 02\\Rick and Morty S02E03 Crewcoo (1080p BluRay).mkv",
  );
  assert.equal(e3?.fromPack, true);
  assert.equal(e3?.transfer, null, "the pack must not masquerade as an episode transfer");
});

check("buildEpisodes: a ready pack does not overwrite an episode's own stuck grab", () => {
  // Download one episode, then the whole season: the single is redundant and
  // may be stuck at 0% ("looking for peers") while the finished pack already
  // holds its file. The pack can make the row playable, but it must not
  // pretend the episode's own transfer is finished.
  const rows = buildEpisodes(
    episodeInput({
      // E3 has its own in-flight grab that has fetched nothing (progress 0).
      transfers: new Map([
        [
          "2:3",
          {
            status: "downloading" as const,
            progress: 0,
            infoHash: "singlehash",
            filePath: null,
            error: null,
          },
        ],
      ]),
      // The stuck single is also a local engine row — this is what made
      // `local != null` wrongly treat the episode as complete.
      localReleases: [
        {
          hash: "singlehash",
          name: "Rick and Morty S02E03 (1080p)",
          progress: 0,
          status: "downloading",
          season: 2,
          episode: 3,
          isPack: false,
          isMultiSeason: false,
          retentionState: "kept",
          fileMissing: false,
        },
      ],
      packCoverage: buildPackCoverage(
        [packRelease()],
        engineMap("packhash", RM_S02_FILES),
        2,
      ),
    }),
  );
  const e3 = rows.find((r) => r.episode === 3);
  assert.equal(e3?.availability, "ready", "the ready pack wins over the stuck single");
  assert.equal(e3?.infoHash, "packhash");
  assert.equal(e3?.transfer?.status, "downloading", "the row keeps the exact episode transfer");
  assert.equal(e3?.fromPack, true);
});

check("buildEpisodes: an episode's own completed file still ties the pack", () => {
  // A genuinely complete own download is kept as-is, not overwritten by the
  // pack — both mean the file exists, and the own one was there first.
  const rows = buildEpisodes(
    episodeInput({
      transfers: new Map([
        [
          "2:3",
          {
            status: "downloaded" as const,
            progress: 1,
            infoHash: "ownhash",
            filePath: "D:\\own\\S02E03.mkv",
            error: null,
          },
        ],
      ]),
      packCoverage: buildPackCoverage(
        [packRelease()],
        engineMap("packhash", RM_S02_FILES),
        2,
      ),
    }),
  );
  const e3 = rows.find((r) => r.episode === 3);
  assert.equal(e3?.infoHash, "ownhash", "the own completed file is kept");
  assert.equal(e3?.fromPack, false);
});

check("buildEpisodes: an episode the pack lacks stays null", () => {
  const rows = buildEpisodes(
    episodeInput({
      packCoverage: buildPackCoverage(
        [packRelease()],
        engineMap("packhash", RM_S02_FILES),
        2,
      ),
    }),
  );
  // Highest covered episode is 5; episodes 1 and 2 are not in the pack.
  const e1 = rows.find((r) => r.episode === 1);
  const e2 = rows.find((r) => r.episode === 2);
  assert.equal(e1?.availability ?? null, null);
  assert.equal(e1?.infoHash ?? null, null);
  assert.equal(e2?.availability ?? null, null);
  assert.equal(e2?.fromPack, false);
});

check("buildEpisodes: the episode's own file wins over the pack fallback", () => {
  const own: LocalRelease = {
    hash: "ownhash",
    name: "Rick and Morty S02E03 720p",
    progress: 1,
    status: "seeding",
    season: 2,
    episode: 3,
    isPack: false,
    isMultiSeason: false,
    retentionState: "kept",
    fileMissing: false,
  };
  const rows = buildEpisodes(
    episodeInput({
      localReleases: [own],
      packCoverage: buildPackCoverage(
        [packRelease()],
        engineMap("packhash", RM_S02_FILES),
        2,
      ),
    }),
  );
  const e3 = rows.find((r) => r.episode === 3);
  assert.equal(e3?.infoHash, "ownhash"); // its own file, not the pack
  assert.equal(e3?.fromPack, false);
});

check("buildEpisodes: an in-flight season single shows as downloading", () => {
  // A season download grabs each episode as its own release and writes no
  // per-episode acquisition row — only a live engine torrent. The episode must
  // still read as "downloading" (its own transfer), or the card shows a plain,
  // re-clickable Download icon while bytes arrive.
  const rows = buildEpisodes(
    episodeInput({
      localReleases: [
        {
          hash: "e1hash",
          name: "Rick and Morty S02E01 1080p WEB",
          progress: 0.32,
          status: "downloading",
          season: 2,
          episode: 1,
          isPack: false,
          isMultiSeason: false,
          retentionState: "kept",
          fileMissing: false,
        },
      ],
    }),
  );
  const e1 = rows.find((r) => r.episode === 1);
  assert.equal(e1?.transfer?.status, "downloading", "its own transfer is downloading");
  assert.equal(e1?.transfer?.progress, 0.32);
  assert.equal(e1?.transfer?.infoHash, "e1hash");
  assert.equal(e1?.availability, "warm");
});

check("buildEpisodes: a just-queued 0% season single already shows downloading", () => {
  // The grab returns before the first byte arrives; the row must react
  // immediately, not wait for progress > 0. availability stays as computed
  // (nothing to play at 0%) but the transfer says downloading.
  const rows = buildEpisodes(
    episodeInput({
      cachedReleases: [{ season: 2, episode: 1, isPack: false, viable: true }],
      localReleases: [
        {
          hash: "q1hash",
          name: "Rick and Morty S02E01 1080p WEB",
          progress: 0,
          status: "downloading",
          season: 2,
          episode: 1,
          isPack: false,
          isMultiSeason: false,
          retentionState: "kept",
          fileMissing: false,
        },
      ],
    }),
  );
  const e1 = rows.find((r) => r.episode === 1);
  assert.equal(e1?.transfer?.status, "downloading", "0% queued single reads as downloading");
  assert.equal(e1?.transfer?.progress, 0);
  assert.equal(e1?.availability, "fetchable", "but nothing is playable yet");
});

check("buildEpisodes: a stream-cache partial is not shown as downloading", () => {
  // A reclaimable stream cache holds only the bytes playback touched; its
  // fraction is not download progress and must not turn a Play into a spinner.
  const rows = buildEpisodes(
    episodeInput({
      localReleases: [
        {
          hash: "streamhash",
          name: "Rick and Morty S02E01 1080p WEB",
          progress: 0.42,
          status: "downloading",
          season: 2,
          episode: 1,
          isPack: false,
          isMultiSeason: false,
          retentionState: "stream",
          fileMissing: false,
        },
      ],
    }),
  );
  const e1 = rows.find((r) => r.episode === 1);
  assert.equal(e1?.transfer ?? null, null, "a stream cache is not a download");
});

console.log(
  `\n${failures === 0 ? "detail: all tests passed" : `detail: ${failures} failing`}`,
);
process.exit(failures === 0 ? 0 : 1);
