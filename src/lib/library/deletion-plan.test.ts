/**
 * Library deletion planning rules.
 *
 * Run: npx tsx src/lib/library/deletion-plan.test.ts
 *
 * The cases worth writing are the ones where a plausible-looking matcher is
 * catastrophic: "episode 3" matching a season pack that holds ten episodes,
 * "season 2" reaching into a S01-S03 pack, a size that counts a file the engine
 * already reported gone, and a refusal that reads as "there is nothing here".
 *
 * Nothing in this file touches a filesystem. The module under test is pure by
 * construction, which is the point — the numbers on the confirm dialog and the
 * files the API removes come from one function, so they cannot disagree.
 */
import assert from "node:assert/strict";
import {
  coverageFromName,
  coverageOverlaps,
  coverageWithin,
  deletionPlanSummary,
  heldFilesFromVerifiedJson,
  makeDeletionScope,
  planDeletion,
  statedCoverage,
  type DeletionScope,
  type HeldFile,
  type HeldTorrent,
} from "./deletion-plan";

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures++;
    console.error(`FAIL  ${name}`);
    console.error(`      ${(error as Error).message}`);
  }
}

const GB = 1_000_000_000;

function file(path: string, sizeBytes = GB, presence?: HeldFile["presence"]): HeldFile {
  return presence ? { path, sizeBytes, presence } : { path, sizeBytes };
}

// ── Fixtures ───────────────────────────────────────────────────────────────
// Real release names, because the coverage rules read them through the same
// `parseEpisode` the grabber uses. A hand-built `coverage: {...}` would test the
// containment maths while leaving the name→coverage step — the part that
// actually decides what gets deleted — completely unexercised.

/** Ten episodes in one release. The case this whole module exists for. */
const SEASON_ONE_PACK: HeldTorrent = {
  hash: "pack-s01",
  name: "Severance.S01.1080p.WEB-DL.x265",
  allocatedBytes: 10 * GB,
  files: Array.from({ length: 10 }, (_, i) =>
    file(
      `D:\\Media\\Severance\\Season 01\\Severance.S01E${String(i + 1).padStart(2, "0")}.mkv`,
    ),
  ),
};

const S02E01: HeldTorrent = {
  hash: "s02e01",
  name: "Severance.S02E01.1080p.WEB-DL",
  allocatedBytes: GB,
  files: [file("D:\\Media\\Severance\\Season 02\\Severance.S02E01.mkv")],
};

const S02E02: HeldTorrent = {
  hash: "s02e02",
  name: "Severance.S02E02.1080p.WEB-DL",
  allocatedBytes: GB,
  files: [file("D:\\Media\\Severance\\Season 02\\Severance.S02E02.mkv")],
};

const MULTI_SEASON_PACK: HeldTorrent = {
  hash: "pack-s01-s03",
  name: "Severance.S01-S03.COMPLETE.1080p",
  allocatedBytes: 3 * GB,
  files: [
    file("D:\\Media\\Severance\\Severance.S01E01.mkv"),
    file("D:\\Media\\Severance\\Severance.S02E01.mkv"),
    file("D:\\Media\\Severance\\Severance.S03E01.mkv"),
  ],
};

/**
 * The same two packs, with no recorded file list.
 *
 * These exist because the first mutation run exposed the packs above as weak
 * fixtures: their episode files independently fail containment, so a rule that
 * read the *release name* as merely "overlapping" was still refused, and the
 * test stayed green through a break. A torrent mid-download has no verified
 * files at all, so the name is genuinely the only thing standing between
 * "delete episode 3" and ten episodes.
 */
const SEASON_ONE_PACK_UNLISTED: HeldTorrent = {
  hash: "pack-s01-unlisted",
  name: "Severance.S01.1080p.WEB-DL.x265",
  allocatedBytes: 10 * GB,
  files: [],
};

const MULTI_SEASON_PACK_UNLISTED: HeldTorrent = {
  hash: "pack-s01-s03-unlisted",
  name: "Severance.S01-S03.COMPLETE.1080p",
  allocatedBytes: 30 * GB,
  files: [],
};

/** A film: no episode structure anywhere in the name. */
const FILM: HeldTorrent = {
  hash: "film",
  name: "Dune.Part.Two.2024.2160p.WEB-DL",
  allocatedBytes: 8 * GB,
  files: [file("D:\\Media\\Movies\\Dune.Part.Two.2024.2160p.mkv", 8 * GB)],
};

const SEASON: DeletionScope = { kind: "season", season: 1 };
const EPISODE: DeletionScope = { kind: "episode", season: 1, episode: 3 };
const SHOW: DeletionScope = { kind: "show" };

// ── Coverage read off a name ───────────────────────────────────────────────

check("a name states what it holds, through the one shared parser", () => {
  assert.deepEqual(coverageFromName("Severance.S02E06.1080p.WEB-DL"), {
    kind: "episode",
    season: 2,
    episode: 6,
  });
  assert.deepEqual(coverageFromName("Severance.S01.1080p.WEB-DL.x265"), {
    kind: "season",
    season: 1,
  });
  assert.deepEqual(coverageFromName("Severance.S01-S03.COMPLETE.1080p"), {
    kind: "seasons",
    from: 1,
  });
  // "Complete" is a positive claim to hold more than one thing. Reading it as
  // unknown would make a pack look narrower than it is.
  assert.deepEqual(coverageFromName("Severance.Complete.Pack.1080p"), {
    kind: "seasons",
    from: 1,
  });
  // A film states no episode structure, and inventing one for it would let a
  // season-scoped delete claim it.
  assert.deepEqual(coverageFromName("Dune.Part.Two.2024.2160p.WEB-DL"), {
    kind: "unknown",
  });
  assert.deepEqual(coverageFromName("sample.mkv"), { kind: "unknown" });
  assert.deepEqual(coverageFromName(""), { kind: "unknown" });
});

check("an absolutely-numbered release states an episode but not a season", () => {
  // Anime numbering is the case that must not be guessed at: there is no season
  // in the name, so nothing places it inside or outside season 1.
  assert.deepEqual(coverageFromName("[HatSubs] One Piece 1170 (WEB 1080p)"), {
    kind: "episode",
    season: null,
    episode: 1170,
  });
});

check("a release's coverage is everything it and its files state", () => {
  const stated = statedCoverage(SEASON_ONE_PACK);
  assert.equal(stated.length, 11, "the pack name plus its ten episode files");
  assert.deepEqual(stated[0], { kind: "season", season: 1 });

  // `sample.mkv` and `poster.jpg` state nothing. Counting them as unknown
  // coverage would block every episode-scoped delete on the strength of a JPEG.
  const withExtras: HeldTorrent = {
    hash: "s02e06",
    name: "Severance.S02E06.1080p.WEB-DL",
    allocatedBytes: 2 * GB,
    files: [
      file("D:\\Media\\Severance.S02E06.mkv"),
      file("D:\\Media\\sample.mkv", 5_000_000),
      file("D:\\Media\\poster.jpg", 200_000),
    ],
  };
  assert.deepEqual(statedCoverage(withExtras), [
    { kind: "episode", season: 2, episode: 6 },
    { kind: "episode", season: 2, episode: 6 },
  ]);
});

// ── Containment ────────────────────────────────────────────────────────────

check("containment is containment, never overlap", () => {
  const pack = { kind: "season", season: 1 } as const;
  // A season pack overlaps "episode 3" perfectly well. It still may not be
  // deleted by it: nine other episodes are inside it.
  assert.equal(coverageOverlaps(pack, EPISODE), true);
  assert.equal(coverageWithin(pack, EPISODE), false);

  assert.equal(coverageWithin(pack, SEASON), true);
  assert.equal(coverageWithin(pack, SHOW), true);
});

check("a pack with no stated end can never be contained by one season", () => {
  const open = { kind: "seasons", from: 1 } as const;
  assert.equal(coverageWithin(open, { kind: "season", season: 1 }), false);
  assert.equal(coverageWithin(open, { kind: "season", season: 9 }), false);
  assert.equal(coverageWithin(open, SHOW), true);
  // It is worth reporting against any season it could reach, and no earlier one.
  assert.equal(coverageOverlaps(open, { kind: "season", season: 4 }), true);
  assert.equal(
    coverageOverlaps({ kind: "seasons", from: 5 }, { kind: "season", season: 4 }),
    false,
  );
});

check("an episode with no season cannot be placed, so it is never swept up", () => {
  const absolute = { kind: "episode", season: null, episode: 1170 } as const;
  assert.equal(coverageWithin(absolute, { kind: "season", season: 1 }), false);
  assert.equal(
    coverageWithin(absolute, { kind: "episode", season: 1, episode: 1170 }),
    false,
  );
  // But it cannot be ruled out either, so it is reported rather than ignored.
  assert.equal(coverageOverlaps(absolute, { kind: "season", season: 1 }), true);
});

check("show contains everything, including what nothing places", () => {
  assert.equal(coverageWithin({ kind: "unknown" }, SHOW), true);
  assert.equal(coverageWithin({ kind: "seasons", from: 1 }, SHOW), true);
  assert.equal(coverageWithin({ kind: "episode", season: null, episode: 9 }, SHOW), true);
});

// ── The plan ───────────────────────────────────────────────────────────────

check("episode 3 cannot delete the pack that holds episodes 1-10", () => {
  const plan = planDeletion([SEASON_ONE_PACK], EPISODE);
  assert.equal(plan.outcome, "blocked");
  assert.deepEqual(plan.releases, [], "nothing may be removed");
  assert.deepEqual(plan.files, [], "no file may be named for deletion");
  assert.equal(plan.totalBytes, 0);
  assert.equal(plan.blocked.length, 1);
  assert.equal(plan.blocked[0].reason, "covers-more");
  assert.equal(plan.blocked[0].covers, "Season 1");
  assert.equal(plan.blocked[0].fileCount, 10, "the user must see what was at stake");
});

check("the release name alone stops an episode request eating a whole pack", () => {
  // Nothing but `Severance.S01` says what is inside this. If the containment
  // rule ever softened to "overlaps", ten episodes would go for a request that
  // named one — and the file-level coverages that mask that in the fixture
  // above would not be there to catch it.
  const plan = planDeletion([SEASON_ONE_PACK_UNLISTED], EPISODE);
  assert.equal(plan.outcome, "blocked");
  assert.deepEqual(plan.releases, []);
  assert.deepEqual(plan.files, []);
  assert.equal(plan.blocked[0].covers, "Season 1");
  assert.equal(plan.blocked[0].bytes, 10 * GB, "the user must see what was at stake");
});

check("the release name alone stops a season request eating a wider pack", () => {
  const plan = planDeletion([MULTI_SEASON_PACK_UNLISTED], { kind: "season", season: 2 });
  assert.equal(plan.outcome, "blocked");
  assert.deepEqual(plan.releases, []);
  assert.deepEqual(plan.files, []);
  assert.equal(plan.blocked[0].covers, "Season 1 and later");
  assert.equal(plan.blocked[0].bytes, 30 * GB);
});

check("the same pack is deletable by the season it actually covers", () => {
  const plan = planDeletion([SEASON_ONE_PACK], SEASON);
  assert.equal(plan.outcome, "deletes");
  assert.deepEqual(
    plan.releases.map((r) => r.hash),
    ["pack-s01"],
  );
  assert.equal(plan.fileCount, 10);
  assert.equal(plan.files.length, 10);
  assert.equal(plan.totalBytes, 10 * GB);
  assert.deepEqual(plan.blocked, []);
});

check("deleting a season does not touch another season", () => {
  const plan = planDeletion([SEASON_ONE_PACK, S02E01, S02E02], {
    kind: "season",
    season: 2,
  });
  assert.deepEqual(
    plan.releases.map((r) => r.hash),
    ["s02e01", "s02e02"],
  );
  assert.equal(
    plan.files.some((p) => p.includes("Season 01")),
    false,
    "no season 1 file may be named",
  );
  assert.equal(plan.totalBytes, 2 * GB);
  // Season 1 is not "blocked" — it is none of this request's business, and
  // listing it would bury the warnings that matter.
  assert.deepEqual(plan.blocked, []);
});

check("deleting the show includes everything held, even what is unplaceable", () => {
  const plan = planDeletion([SEASON_ONE_PACK, S02E01, FILM], SHOW);
  assert.equal(plan.outcome, "deletes");
  assert.deepEqual(
    plan.releases.map((r) => r.hash),
    ["pack-s01", "s02e01", "film"],
  );
  assert.equal(plan.fileCount, 12);
  assert.equal(plan.totalBytes, 19 * GB);
  assert.deepEqual(plan.blocked, []);
});

check("a multi-season pack is refused by one season and released by the show", () => {
  const blocked = planDeletion([MULTI_SEASON_PACK], { kind: "season", season: 2 });
  assert.equal(blocked.outcome, "blocked");
  assert.equal(blocked.blocked[0].covers, "Season 1 and later");
  assert.equal(blocked.fileCount, 0);

  const whole = planDeletion([MULTI_SEASON_PACK], SHOW);
  assert.equal(whole.outcome, "deletes");
  assert.equal(whole.fileCount, 3);
  assert.equal(whole.totalBytes, 3 * GB);
});

check("extras inside a single-episode release do not block it", () => {
  const release: HeldTorrent = {
    hash: "s02e06",
    name: "Severance.S02E06.1080p.WEB-DL",
    allocatedBytes: 2 * GB,
    files: [
      file("D:\\Media\\Severance.S02E06.mkv", 2 * GB),
      file("D:\\Media\\sample.mkv", 5_000_000),
    ],
  };
  const plan = planDeletion([release], { kind: "episode", season: 2, episode: 6 });
  assert.equal(plan.outcome, "deletes");
  assert.equal(plan.fileCount, 2, "the whole release goes, extras included");
  assert.equal(plan.totalBytes, 2 * GB + 5_000_000);
});

check("a release nothing can place is refused by a season and kept by the show", () => {
  const anime: HeldTorrent = {
    hash: "op1170",
    name: "[HatSubs] One Piece 1170 (WEB 1080p)",
    allocatedBytes: GB,
    files: [file("D:\\Media\\One Piece\\[HatSubs] One Piece 1170.mkv")],
  };
  const refused = planDeletion([anime], { kind: "season", season: 1 });
  assert.equal(refused.outcome, "blocked");
  assert.equal(
    refused.blocked[0].reason,
    "unrecognised",
    "'covers more' would be advice to delete a season it may not be in",
  );

  assert.equal(planDeletion([anime], SHOW).outcome, "deletes");
});

check("a release with no coverage at all is show-only", () => {
  const nameless: HeldTorrent = {
    hash: "blob",
    name: "unsorted-download",
    allocatedBytes: 4 * GB,
    files: [file("D:\\Media\\blob.bin", 4 * GB)],
  };
  const refused = planDeletion([nameless], { kind: "season", season: 1 });
  assert.equal(refused.outcome, "blocked");
  assert.equal(refused.blocked[0].reason, "unrecognised");
  assert.equal(refused.blocked[0].covers, "not stated");

  assert.equal(planDeletion([nameless], SHOW).outcome, "deletes");
});

// ── Honest arithmetic ──────────────────────────────────────────────────────

check("a file the engine says is gone is not counted, and is not hidden", () => {
  const release: HeldTorrent = {
    hash: "s02e06",
    name: "Severance.S02E06.1080p.WEB-DL",
    allocatedBytes: 2 * GB,
    files: [
      file("D:\\Media\\Severance.S02E06.mkv", 2 * GB, "present"),
      file("D:\\Media\\Severance.S02E06.sample.mkv", 500_000_000, "absent"),
    ],
  };
  const plan = planDeletion([release], { kind: "episode", season: 2, episode: 6 });
  assert.equal(plan.outcome, "deletes");
  assert.equal(plan.fileCount, 1, "only the file that is really there");
  assert.equal(plan.totalBytes, 2 * GB, "the missing 500 MB is not freed by anyone");
  assert.deepEqual(plan.files, ["D:\\Media\\Severance.S02E06.mkv"]);
  assert.deepEqual(plan.missingFiles, ["D:\\Media\\Severance.S02E06.sample.mkv"]);
});

check("`unknown` presence counts — only proven absence does not", () => {
  // Same discipline as local-file-presence.ts: an unreadable directory is not
  // evidence the file is gone, and dropping it would under-report the delete.
  const release: HeldTorrent = {
    hash: "s02e07",
    name: "Severance.S02E07.1080p.WEB-DL",
    allocatedBytes: GB,
    files: [file("D:\\Media\\Severance.S02E07.mkv", GB, "unknown")],
  };
  const plan = planDeletion([release], { kind: "episode", season: 2, episode: 7 });
  assert.equal(plan.fileCount, 1);
  assert.equal(plan.totalBytes, GB);
});

check("a release whose every file is gone frees nothing, and says so", () => {
  // The allocation fallback must not fire here: it would re-add the bytes we
  // have just proved are not on the disk.
  const release: HeldTorrent = {
    hash: "s03e01",
    name: "Severance.S03E01.1080p.WEB-DL",
    allocatedBytes: 4 * GB,
    files: [file("D:\\Media\\Severance.S03E01.mkv", 4 * GB, "absent")],
  };
  const plan = planDeletion([release], { kind: "episode", season: 3, episode: 1 });
  assert.equal(plan.outcome, "deletes", "the engine row still has to go");
  assert.equal(plan.fileCount, 0);
  assert.equal(plan.totalBytes, 0);
  assert.equal(plan.releases[0].filesRecorded, true);
});

check("a release the engine never listed reports its allocation, not zero", () => {
  // A torrent at 1% has already had its whole length written to disk, so a
  // report of 0 bytes would tell the user that removing it frees nothing.
  const release: HeldTorrent = {
    hash: "s04e01",
    name: "Severance.S04E01.1080p.WEB-DL",
    allocatedBytes: 1_900_000_000,
    files: [],
  };
  const plan = planDeletion([release], { kind: "episode", season: 4, episode: 1 });
  assert.equal(plan.outcome, "deletes");
  assert.equal(plan.fileCount, 0);
  assert.equal(plan.totalBytes, 1_900_000_000);
  assert.equal(plan.releases[0].filesRecorded, false);
});

// ── Empty is not the same as refused ───────────────────────────────────────

check("holding nothing and refusing everything are different answers", () => {
  const empty = planDeletion([], EPISODE);
  assert.equal(empty.outcome, "nothing-held");
  assert.deepEqual(empty.blocked, []);

  const refused = planDeletion([SEASON_ONE_PACK], EPISODE);
  assert.equal(refused.outcome, "blocked");
  assert.notEqual(refused.outcome, empty.outcome);

  // A season we hold nothing for is also empty, not refused: the pack does not
  // reach season 5, so there is nothing to explain.
  const elsewhere = planDeletion([SEASON_ONE_PACK], { kind: "season", season: 5 });
  assert.equal(elsewhere.outcome, "nothing-held");
});

// ── The sentence the user reads ────────────────────────────────────────────

check("the summary states the count and a human size", () => {
  assert.equal(
    deletionPlanSummary(planDeletion([SEASON_ONE_PACK], SEASON)),
    "Deletes 10 files · 10.0 GB from Season 1.",
  );
  assert.equal(
    deletionPlanSummary(planDeletion([SEASON_ONE_PACK, S02E01, FILM], SHOW)),
    "Deletes 12 files · 19.0 GB from this title.",
  );
});

check("the summary refuses in full, and names the way forward", () => {
  assert.equal(
    deletionPlanSummary(planDeletion([SEASON_ONE_PACK], EPISODE)),
    "Nothing can be deleted for S01E03: 1 release covers Season 1, not just S01E03. " +
      "10 files · 10.0 GB left in place. " +
      "A single episode cannot be removed from a pack — delete Season 1 to remove it.",
  );
  assert.equal(
    deletionPlanSummary(planDeletion([MULTI_SEASON_PACK], { kind: "season", season: 2 })),
    "Nothing can be deleted for Season 2: 1 release covers Season 1 and later, not just Season 2. " +
      "3 files · 3.0 GB left in place. Delete the whole title to remove it.",
  );
});

check("the summary never claims a size it cannot free", () => {
  const release: HeldTorrent = {
    hash: "s02e06",
    name: "Severance.S02E06.1080p.WEB-DL",
    allocatedBytes: 2 * GB,
    files: [
      file("D:\\Media\\Severance.S02E06.mkv", 2 * GB, "present"),
      file("D:\\Media\\Severance.S02E06.sample.mkv", 500_000_000, "absent"),
    ],
  };
  const summary = deletionPlanSummary(
    planDeletion([release], { kind: "episode", season: 2, episode: 6 }),
  );
  assert.equal(
    summary,
    "Deletes 1 file · 2.0 GB from S02E06. " +
      "1 recorded file already gone from disk, so not counted.",
  );
  // 2.5 GB is what the recorded sizes add up to. Printing it would promise the
  // user half a gigabyte that nothing on the disk can give back.
  assert.equal(summary.includes("2.5 GB"), false);
});

check("the summary admits when a size is an allocation rather than files", () => {
  const release: HeldTorrent = {
    hash: "s04e01",
    name: "Severance.S04E01.1080p.WEB-DL",
    allocatedBytes: 1_900_000_000,
    files: [],
  };
  assert.equal(
    deletionPlanSummary(
      planDeletion([release], { kind: "episode", season: 4, episode: 1 }),
    ),
    "Deletes 1 release · 1.9 GB from S04E01. " +
      "1 release with no recorded file list; the size shown is the full allocation.",
  );
});

check("a partial plan still reports what it left behind", () => {
  // Season 1 holds a single episode we can address and a S01-S03 pack we cannot.
  const single: HeldTorrent = {
    hash: "s01e04",
    name: "Severance.S01E04.1080p.WEB-DL",
    allocatedBytes: GB,
    files: [file("D:\\Media\\Severance.S01E04.mkv")],
  };
  const plan = planDeletion([single, MULTI_SEASON_PACK], SEASON);
  assert.equal(plan.outcome, "deletes");
  assert.equal(plan.fileCount, 1);
  assert.equal(plan.blocked.length, 1);
  assert.equal(
    deletionPlanSummary(plan),
    "Deletes 1 file · 1.0 GB from Season 1. " +
      "1 release left alone: Severance.S01-S03.COMPLETE.1080p covers Season 1 and later.",
  );
});

check("nothing held reads as nothing held, not as a refusal", () => {
  assert.equal(
    deletionPlanSummary(planDeletion([], EPISODE)),
    "No files held for S01E03. Nothing to delete.",
  );
});

// ── Request parsing ────────────────────────────────────────────────────────

check("a scope is only built from numbers that are actually there", () => {
  assert.deepEqual(makeDeletionScope("show"), { kind: "show" });
  assert.deepEqual(makeDeletionScope("season", 2), { kind: "season", season: 2 });
  assert.deepEqual(makeDeletionScope("episode", 2, 3), {
    kind: "episode",
    season: 2,
    episode: 3,
  });

  // A season scope with no season silently becoming "the whole show" is the
  // shape of accident this feature cannot afford.
  assert.equal(makeDeletionScope("season"), null);
  assert.equal(makeDeletionScope("season", null), null);
  assert.equal(makeDeletionScope("season", 0), null);
  assert.equal(makeDeletionScope("season", 1.5), null);
  assert.equal(makeDeletionScope("episode", 2), null);
  assert.equal(makeDeletionScope("episode", 2, 0), null);
  assert.equal(makeDeletionScope("everything"), null);
  assert.equal(makeDeletionScope(null), null);
});

check("a recorded file list is read for path and size, or not at all", () => {
  assert.deepEqual(
    heldFilesFromVerifiedJson(
      JSON.stringify([
        { path: "D:\\a.mkv", size: 1000, mtimeMs: 1 },
        { path: "D:\\b.mkv", size: 2000, mtimeMs: 2 },
      ]),
    ),
    [
      { path: "D:\\a.mkv", sizeBytes: 1000 },
      { path: "D:\\b.mkv", sizeBytes: 2000 },
    ],
  );
  assert.deepEqual(heldFilesFromVerifiedJson(null), []);
  assert.deepEqual(heldFilesFromVerifiedJson(""), []);
  assert.deepEqual(heldFilesFromVerifiedJson("not json"), []);
  assert.deepEqual(heldFilesFromVerifiedJson('{"path":"D:\\\\a.mkv"}'), []);
  assert.deepEqual(heldFilesFromVerifiedJson(JSON.stringify([{ size: 10 }])), []);
  // A size we cannot trust becomes 0 rather than NaN: a NaN would poison the
  // total and print "? " where the user expects a number of gigabytes.
  assert.deepEqual(
    heldFilesFromVerifiedJson(JSON.stringify([{ path: "D:\\a.mkv", size: "big" }])),
    [{ path: "D:\\a.mkv", sizeBytes: 0 }],
  );
});

if (failures > 0) {
  console.error(`\n${failures} deletion-plan test(s) failed.`);
  process.exit(1);
}
console.log("\nAll deletion-plan tests passed.");
