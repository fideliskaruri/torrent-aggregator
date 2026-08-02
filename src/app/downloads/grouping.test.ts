/**
 * Grouping rules for the Downloads page.
 *
 * Run: npx tsx src/app/downloads/grouping.test.ts
 *
 * Every case here is a specific lie the combined row could tell: a percentage
 * that is not the percentage of the bytes, a badge claiming a completion no
 * member has, a season counted twice because it is on disk twice, and a list
 * that rearranges itself between two polls five seconds apart.
 */
import assert from "node:assert/strict";
import {
  combinedProgress,
  combinedState,
  groupDownloads,
  isDownloading,
  isPaused,
  isSeeding,
  type DownloadGroup,
  type SeriesGroup,
  type TransferRow,
} from "./grouping";
import { downloadInTab } from "./media-filter";

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

const MB = 1024 * 1024;
const GB = 1024 * MB;

function row(partial: Partial<TransferRow> & { name: string }): TransferRow {
  return {
    hash: partial.hash ?? partial.name.toLowerCase().replace(/[^a-z0-9]/g, ""),
    name: partial.name,
    // `??` would be wrong here: an explicit `category: null` is the case of a
    // torrent nobody categorised, and defaulting it to "TV" would quietly turn
    // every uncategorised fixture into a series.
    category: "category" in partial ? partial.category : "TV",
    progress: partial.progress ?? 0,
    sizeBytes: partial.sizeBytes ?? 1 * GB,
    dlspeed: partial.dlspeed ?? 0,
    upspeed: partial.upspeed ?? 0,
    state: partial.state ?? "downloading",
  };
}

function seriesGroups<T extends TransferRow>(
  groups: DownloadGroup<T>[],
): SeriesGroup<T>[] {
  return groups.filter((g): g is SeriesGroup<T> => g.kind === "series");
}

// ---------------------------------------------------------------------------

check("combined progress is a fraction of the bytes, never a mean of percents", () => {
  // The owner's own example. Ten finished 100 MB episodes and one untouched
  // 4 GB file is 1000 MB of 5096 MB — a fifth of the work — and the average of
  // the eleven percentages says 91%.
  const members = [
    ...Array.from({ length: 10 }, () => ({ progress: 1, sizeBytes: 100 * MB })),
    { progress: 0, sizeBytes: 4 * GB },
  ];
  const weighted = combinedProgress(members);
  const naiveMean =
    members.reduce((sum, m) => sum + m.progress, 0) / members.length;

  assert.ok(
    Math.abs(weighted - (1000 * MB) / (1000 * MB + 4 * GB)) < 1e-9,
    `expected the byte fraction, got ${weighted}`,
  );
  assert.ok(weighted < 0.25, `${weighted} should be about a fifth, not most`);
  assert.ok(
    naiveMean - weighted > 0.6,
    `the mean (${naiveMean}) and the truth (${weighted}) must not coincide, ` +
      "or this case is not testing the weighting at all",
  );
});

check("combined progress handles the sizes a client actually reports", () => {
  assert.equal(combinedProgress([]), 0);
  assert.equal(combinedProgress([{ progress: 0.5, sizeBytes: 1 * GB }]), 0.5);
  // Metadata has not arrived, so nothing is known and nothing is claimed. An
  // average over rows with no size would put the percent-mean bug back exactly
  // where there is no evidence to catch it.
  assert.equal(combinedProgress([{ progress: 1, sizeBytes: 0 }]), 0);
  // A member with no known size cannot vote; the one with a size decides.
  assert.equal(
    combinedProgress([
      { progress: 0, sizeBytes: 0 },
      { progress: 0.5, sizeBytes: 2 * GB },
    ]),
    0.5,
  );
  // Clients have reported both of these. Neither may leak into a percentage.
  assert.equal(combinedProgress([{ progress: 1.5, sizeBytes: 1 * GB }]), 1);
  assert.equal(combinedProgress([{ progress: -0.2, sizeBytes: 1 * GB }]), 0);
  assert.equal(combinedProgress([{ progress: Number.NaN, sizeBytes: 1 * GB }]), 0);
});

check("a group's state is its least finished member, not its first", () => {
  assert.equal(
    isDownloading(combinedState([{ state: "uploading" }, { state: "downloading" }])),
    true,
  );
  assert.equal(
    isSeeding(combinedState([{ state: "uploading" }, { state: "downloading" }])),
    false,
    "nine seeding episodes and one downloading is not a group you can watch through",
  );
  // Paused outranks seeding: unfinished-and-stopped is the thing to act on.
  assert.equal(
    isPaused(combinedState([{ state: "uploading" }, { state: "pausedDL" }])),
    true,
  );
  assert.equal(
    isSeeding(combinedState([{ state: "uploading" }, { state: "pausedDL" }])),
    false,
  );
  // But downloading still outranks paused: something IS happening.
  assert.equal(
    isDownloading(combinedState([{ state: "pausedDL" }, { state: "stalledDL" }])),
    true,
  );
  // All seeding really is seeding.
  assert.equal(
    isSeeding(combinedState([{ state: "uploading" }, { state: "stalledUP" }])),
    true,
  );
  assert.equal(combinedState([]), "");
});

check("a group never badges itself finished while a member is still going", () => {
  const groups = groupDownloads([
    row({ name: "Rick and Morty S01E01 1080p", progress: 1, state: "uploading", sizeBytes: 1 * GB }),
    row({ name: "Rick and Morty S01E02 1080p", progress: 0.1, state: "downloading", sizeBytes: 1 * GB }),
  ]);
  const group = seriesGroups(groups)[0];
  assert.ok(group, "expected one series group");
  assert.equal(isSeeding(group.state), false);
  assert.equal(isDownloading(group.state), true);
  assert.ok(group.progress < 1, `group claimed ${group.progress}`);
});

check("a season pack and its own episodes are not counted twice", () => {
  const groups = groupDownloads([
    row({ name: "Breaking Bad S01 COMPLETE 1080p BluRay x264", hash: "pack", progress: 1, state: "uploading", sizeBytes: 10 * GB }),
    row({ name: "Breaking Bad S01E01 1080p BluRay x264", hash: "e01", progress: 0, state: "pausedDL", sizeBytes: 1 * GB }),
    row({ name: "Breaking Bad S01E02 1080p BluRay x264", hash: "e02", progress: 0, state: "pausedDL", sizeBytes: 1 * GB }),
  ]);
  const group = seriesGroups(groups)[0];
  assert.ok(group, "expected one series group");

  // Counting all three gives 10 GB of 12 GB — a season you hold in full,
  // reported as 83% because you also hold two of its episodes separately.
  assert.equal(group.sizeBytes, 10 * GB, "the pack's bytes, counted once");
  assert.equal(group.progress, 1);

  // The loose episodes have not been hidden: they are real torrents with their
  // own pause and delete controls, and a list that omitted them would leave
  // 2 GB on disk that the page never mentions.
  assert.equal(group.releaseCount, 3);
  assert.equal(group.torrents.length, 3);
  const bySubsumed = group.seasons[0].entries.map((e) => [e.torrent.hash, e.subsumed]);
  assert.deepEqual(bySubsumed, [
    ["pack", false],
    ["e01", true],
    ["e02", true],
  ]);
});

check("a pack still fetching its metadata does not swallow real episodes", () => {
  // `sizeBytes: 0` is what a torrent reports before metadata arrives. Treating
  // that as "contains everything" would drop 1 GB of genuinely held episode
  // out of the group's totals.
  const groups = groupDownloads([
    row({ name: "Breaking Bad S01 COMPLETE 1080p", hash: "pack", progress: 0, state: "metaDL", sizeBytes: 0 }),
    row({ name: "Breaking Bad S01E01 1080p", hash: "e01", progress: 1, state: "uploading", sizeBytes: 1 * GB }),
  ]);
  const group = seriesGroups(groups)[0];
  assert.equal(group.sizeBytes, 1 * GB);
  assert.deepEqual(
    group.seasons[0].entries.map((e) => e.subsumed),
    [false, false],
  );
  // And the group is not "done" merely because the sized member is complete.
  assert.equal(isSeeding(group.state), false);
  assert.equal(isDownloading(group.state), true);
});

check("a multi-season pack subsumes nothing and sits outside the numbered seasons", () => {
  // How much of season 1 an S01-S03 pack covers is not something any client
  // reports, so it is counted whole rather than guessed at, and it is not
  // filed under Season 01 as if it were a place in the run.
  const groups = groupDownloads([
    row({ name: "Breaking Bad S01-S03 COMPLETE 1080p", hash: "multi", progress: 0, sizeBytes: 30 * GB }),
    row({ name: "Breaking Bad S01E01 1080p", hash: "e01", progress: 1, sizeBytes: 1 * GB }),
  ]);
  const group = seriesGroups(groups)[0];
  assert.equal(group.sizeBytes, 31 * GB, "nothing was subsumed");
  assert.deepEqual(
    group.seasons.map((s) => [s.label, s.entries.map((e) => e.torrent.hash)]),
    [
      ["Season 01", ["e01"]],
      ["Other", ["multi"]],
    ],
  );
});

check("a series of one episode is still a series", () => {
  // The group is the *work*, and whether a work has episodes is a fact about
  // the work, not about how many of them happen to be on disk right now.
  // Collapsing it would mean the row changes shape — gaining a disclosure
  // triangle and a season heading out of nowhere — the moment episode two
  // arrives, in the middle of a five-second poll.
  const groups = groupDownloads([
    row({ name: "Stuart Fails to Save the Universe S01E01 1080p AMZN WEB-DL", category: "TV" }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].kind, "series");
  const group = seriesGroups(groups)[0];
  assert.equal(group.releaseCount, 1);
  assert.equal(group.seasonCount, 1);
  assert.equal(group.seasons[0].label, "Season 01");
});

check("films stay individual rows, one per torrent", () => {
  // Two prints of one film are two torrents taking two lots of disk. Merging
  // them would hide one behind the other's pause and delete controls.
  const groups = groupDownloads([
    row({ name: "Dune (2021) 2160p WEB-DL x265", hash: "a", category: "Movies" }),
    row({ name: "Dune 2021 1080p BluRay x264-RARBG", hash: "b", category: "Movies" }),
  ]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((g) => g.kind), ["single", "single"]);
  assert.notEqual(groups[0].key, groups[1].key);
});

check("seasons run in order and episodes run in order inside them", () => {
  const groups = groupDownloads([
    row({ name: "Rick and Morty S09E02 1080p", hash: "s9e2" }),
    row({ name: "Rick and Morty S01E02 1080p", hash: "s1e2" }),
    row({ name: "Rick and Morty S09E01 1080p", hash: "s9e1" }),
    row({ name: "Rick and Morty S01 COMPLETE 1080p", hash: "s1pack", sizeBytes: 100 * GB }),
    row({ name: "Rick and Morty S01E01 1080p", hash: "s1e1" }),
  ]);
  const group = seriesGroups(groups)[0];
  assert.deepEqual(
    group.seasons.map((s) => s.label),
    ["Season 01", "Season 09"],
  );
  // The pack heads its season: it covers the whole of it.
  assert.deepEqual(
    group.seasons[0].entries.map((e) => e.torrent.hash),
    ["s1pack", "s1e1", "s1e2"],
  );
  assert.deepEqual(
    group.seasons[1].entries.map((e) => e.torrent.hash),
    ["s9e1", "s9e2"],
  );
});

check("the order cannot be moved by anything that changes between polls", () => {
  // The page re-polls every five seconds and re-renders from the answer. An
  // order that depends on progress, speed or state rearranges rows while the
  // user is reaching for a button — the exact defect `builtin-engine.ts`
  // already sorts its own output to prevent.
  const first = [
    row({ name: "Rick and Morty S01E01 1080p", hash: "a", progress: 0, state: "downloading", dlspeed: 0 }),
    row({ name: "Star Wars The Rise Of Skywalker (2019) 1080p", hash: "b", category: "Movies" }),
    row({ name: "Stuart Fails to Save the Universe S01E01 1080p", hash: "c" }),
    row({ name: "Rick and Morty S09E02 1080p", hash: "d", progress: 0.9, state: "uploading" }),
  ];
  const keysOf = (rows: TransferRow[]) => groupDownloads(rows).map((g) => g.key);
  const baseline = keysOf(first);

  // Same torrents, every moving number different.
  const later = first.map((t) => ({
    ...t,
    progress: 1 - t.progress,
    dlspeed: 5_000_000,
    upspeed: 900_000,
    state: t.state === "downloading" ? "uploading" : "pausedDL",
  }));
  assert.deepEqual(keysOf(later), baseline, "transient state moved a row");

  // And the client is allowed to hand its list over in any order it likes;
  // qBittorrent and Transmission promise nothing about it.
  assert.deepEqual(keysOf([...first].reverse()), baseline, "input order moved a row");
  assert.deepEqual(
    keysOf([first[2], first[0], first[3], first[1]]),
    baseline,
    "input order moved a row",
  );
});

check("every torrent handed in comes back out exactly once", () => {
  // Grouping is a rearrangement, not a filter. A row that disappears here is a
  // download the user can no longer pause, delete or find.
  const rows = [
    row({ name: "Rick and Morty S01E01 1080p", hash: "a" }),
    row({ name: "Rick and Morty S01E02 1080p", hash: "b" }),
    row({ name: "Breaking Bad S01 COMPLETE 1080p", hash: "c", sizeBytes: 50 * GB }),
    row({ name: "Breaking Bad S01E04 1080p", hash: "d" }),
    row({ name: "Star Wars The Rise Of Skywalker (2019) 1080p", hash: "e", category: "Movies" }),
    row({ name: "ubuntu-24.04.1-desktop-amd64.iso", hash: "f", category: null }),
  ];
  const seen: string[] = [];
  for (const group of groupDownloads(rows)) {
    if (group.kind === "single") seen.push(group.torrent.hash);
    else for (const t of group.torrents) seen.push(t.hash);
  }
  assert.deepEqual([...seen].sort(), ["a", "b", "c", "d", "e", "f"]);
  assert.equal(seen.length, new Set(seen).size, "a torrent was listed twice");
});

check("a row with no determinable type is a single row, not a lost one", () => {
  // It cannot be grouped — nothing says it has episodes — so it stays as it
  // is. The media filter puts it under All for the same reason.
  const rows = [row({ name: "ubuntu-24.04.1-desktop-amd64.iso", hash: "iso", category: null })];
  const groups = groupDownloads(rows);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].kind, "single");
  assert.equal(downloadInTab(rows[0], "all"), true);
});

check("only rows the Series or Anime tab holds are ever grouped", () => {
  const rows = [
    row({ name: "Rick and Morty S09E02 1080p", hash: "a", category: "TV" }),
    row({ name: "[SubsPlease] Frieren - 28 (1080p).mkv", hash: "b", category: "Anime" }),
    row({ name: "Star Wars The Rise Of Skywalker (2019) 1080p", hash: "c", category: "Movies" }),
    row({ name: "Star.Wars.Episode.1.The.Phantom.Menace.1999.1080p", hash: "d", category: "Movies" }),
  ];
  for (const group of seriesGroups(groupDownloads(rows))) {
    for (const t of group.torrents) {
      assert.ok(
        downloadInTab(t, "series") || downloadInTab(t, "anime"),
        `${t.name} was grouped as a series but no series tab holds it`,
      );
    }
  }
  // And the two films did not get grouped.
  assert.equal(groupDownloads(rows).filter((g) => g.kind === "single").length, 2);
});

check("speed is summed over every member, including the double-counted ones", () => {
  // A subsumed episode is still pulling real bytes through the network card.
  // Leaving its rate out would make the group disagree with the totals in the
  // stat strip directly above it.
  const groups = groupDownloads([
    row({ name: "Breaking Bad S01 COMPLETE 1080p", hash: "pack", sizeBytes: 10 * GB, dlspeed: 1_000, upspeed: 10 }),
    row({ name: "Breaking Bad S01E01 1080p", hash: "e01", sizeBytes: 1 * GB, dlspeed: 2_000, upspeed: 20 }),
  ]);
  const group = seriesGroups(groups)[0];
  assert.equal(group.seasons[0].entries[1].subsumed, true, "precondition");
  assert.equal(group.dlspeed, 3_000);
  assert.equal(group.upspeed, 30);
  assert.equal(group.sizeBytes, 10 * GB, "but its bytes are still not counted twice");
});

if (failures > 0) {
  console.error(`\n${failures} downloads grouping test(s) failed.`);
  process.exit(1);
}
console.log("\nAll downloads grouping tests passed.");
