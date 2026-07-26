/**
 * Failure-mode suite for release ordering.
 *
 * The original bug was not "one wrong number". It was that ordering was an
 * additive score, and every additive score has a crossover point where enough
 * seeders buy a quality downgrade. Fixing it by re-tuning constants would have
 * moved the crossover, not removed it.
 *
 * So these checks are written as **properties over a matrix**, not as examples.
 * An example test ("1080p beats 480p at 500 vs 50 seeders") passes happily
 * against a score that still breaks at 5,000 vs 5. The fuzz below sweeps the
 * seeder ratio across four orders of magnitude precisely so that a
 * reintroduced sum cannot pass.
 *
 * Run with: npx tsx src/lib/torrents/quality.test.ts
 */
import assert from "node:assert/strict";
import {
  compareReleases,
  describeRelease,
  isJunkSource,
  isImplausible,
  isViable,
  parseResolution,
  relevanceTier,
  resolutionAffinity,
  stripEpisodeTokens,
  MIN_VIABLE_SEEDERS,
  DEFAULT_TARGET_RESOLUTION,
} from "./quality";
import { extractTags, rankResults } from "./ranking";
import type { TorrentResult } from "./types";

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL  ${name}`);
    console.error(`      ${(err as Error).message}`);
  }
}

function rel(partial: Partial<TorrentResult> & { title: string }): TorrentResult {
  return {
    id: partial.id ?? partial.title,
    title: partial.title,
    sizeBytes: partial.sizeBytes ?? 2_000_000_000,
    seeders: partial.seeders ?? 50,
    leechers: partial.leechers ?? 5,
    source: partial.source ?? "nyaa",
    sourceUrl: "https://example.com",
    tags: partial.tags ?? extractTags(partial.title),
    magnet: partial.magnet ?? "magnet:?xt=urn:btih:deadbeef",
    infoHash: partial.infoHash,
    publishedAt: partial.publishedAt,
    sizeLabel: partial.sizeLabel,
  };
}

/** Order two releases under the same query; returns the winner's id. */
function winner(a: TorrentResult, b: TorrentResult, query = ""): string {
  const da = describeRelease(a, query);
  const db = describeRelease(b, query);
  const forward = compareReleases(da, db);
  const backward = compareReleases(db, da);
  assertAntisymmetric(forward, backward, `"${a.title}" vs "${b.title}"`);
  return forward <= 0 ? a.id : b.id;
}

/** `Math.sign` yields `-0`, which `assert.equal` treats as distinct from `0`. */
function assertAntisymmetric(forward: number, backward: number, ctx: string) {
  if (forward === 0) {
    assert.equal(backward, 0, `comparator is not antisymmetric for ${ctx}`);
    return;
  }
  assert.ok(
    forward > 0 !== backward > 0,
    `comparator is not antisymmetric for ${ctx}`,
  );
}

// A wide sweep of swarm sizes. The old score used log10(seeders)*25, so the
// gap between 1 and 20000 was worth ~106 points against a +6 quality bonus.
const SEEDER_SWEEP = [3, 5, 12, 40, 150, 800, 2_500, 20_000];

console.log("\n--- resolution parsing ---");

check("parses the real-world titles on disk", () => {
  const cases: Array<[string, number | null]> = [
    ["The.Bear.S03E01.1080p.WEB-DL.HEVC.x265-MeGusta", 1080],
    ["Frieren.Beyond.Journeys.End.S01E12.1080p.x265-Arg0", 1080],
    ["The Punisher S01 2160p x265", 2160],
    ["[SubsPlease] One Piece - 1170 (1080p) [F1B2C3D4]", 1080],
    ["[Erai-raws] One Piece - 1170 [1080p][Multiple Subtitle]", 1080],
    ["Some Movie 2019 480p WEBRip", 480],
    ["Some Show S01E01 720p HDTV", 720],
    ["Old Doc 576p PAL DVD", 576],
    ["Grainy Upload 360p", 360],
    ["Show 1920x1080 WEB", 1080],
    ["Show 1280x720 WEB", 720],
    ["Show FHD WEB-DL", 1080],
    ["Show 1440p WEB-DL", 1080],
    ["Movie [4K] BluRay", 2160],
    ["Movie 4k-UHD BluRay", 2160],
    // No token at all is the normal Nyaa case and must stay unknown.
    ["[Erai-raws] Some Show - 05", null],
    ["Random Upload Without Quality Info", null],
  ];
  for (const [title, expected] of cases) {
    assert.equal(parseResolution(title), expected, `parseResolution(${title})`);
  }
});

check("a downscale is not an upscale, and marketing '4k' is not a resolution", () => {
  // "4kto1080p" literally says it was downscaled to 1080p.
  assert.equal(parseResolution("Movie 4kto1080p WEB-DL"), 1080);
  // Bare "4k" is marketing text that appears on 1080p uploads; only the
  // bracketed/hyphenated forms are real tokens.
  assert.equal(
    parseResolution("Movie 4k Remastered 1080p BluRay"),
    1080,
    "'4k' as an adjective must not promote a 1080p file to 2160p",
  );
});

console.log("\n--- the reported bug: seeders must never buy a quality change ---");

check("1080p beats 480p at EVERY seeder ratio", () => {
  for (const s1080 of SEEDER_SWEEP) {
    for (const s480 of SEEDER_SWEEP) {
      const a = rel({ title: "Show S01E01 1080p WEB-DL", id: "hd", seeders: s1080 });
      const b = rel({ title: "Show S01E01 480p WEBRip", id: "sd", seeders: s480 });
      assert.equal(
        winner(a, b),
        "hd",
        `480p won with ${s480} seeders vs 1080p with ${s1080}`,
      );
    }
  }
});

check("among viable releases, no lower-affinity resolution ever outranks a higher one", () => {
  // The honest form of the guarantee. Viability is compared above resolution
  // on purpose, so this property holds *among releases that can finish* — see
  // the deliberate inverse below.
  const ladder = ["480p", "720p", "1080p"]; // ascending affinity toward target
  for (let hi = 1; hi < ladder.length; hi++) {
    for (let lo = 0; lo < hi; lo++) {
      for (const sHi of SEEDER_SWEEP) {
        for (const sLo of SEEDER_SWEEP) {
          const a = rel({ title: `Show S01E01 ${ladder[hi]} WEB-DL`, id: "hi", seeders: sHi });
          const b = rel({ title: `Show S01E01 ${ladder[lo]} WEB-DL`, id: "lo", seeders: sLo });
          assert.equal(
            winner(a, b),
            "hi",
            `${ladder[lo]}@${sLo} beat ${ladder[hi]}@${sHi}`,
          );
        }
      }
    }
  }
});

check("2160p does NOT beat the 1080p target — oversized is the expensive wrong answer", () => {
  // Preferring "more pixels" is the mirror image of the reported bug: a 4K
  // grab is 15-60 GB of disk and hours of transfer for a file he did not ask
  // for. The target model must reject it in favour of an equally healthy
  // 1080p, and must do so at every seeder ratio too.
  for (const s4k of SEEDER_SWEEP) {
    for (const sHd of SEEDER_SWEEP) {
      const a = rel({ title: "Show S01E01 2160p WEB-DL", id: "uhd", seeders: s4k });
      const b = rel({ title: "Show S01E01 1080p WEB-DL", id: "hd", seeders: sHd });
      assert.equal(winner(a, b), "hd", `2160p@${s4k} beat 1080p@${sHd}`);
    }
  }
});

check("raising the target makes 2160p the exact match, with no special-casing", () => {
  assert.ok(
    resolutionAffinity(2160, 2160) > resolutionAffinity(1080, 2160),
    "with a 2160 target, 4K must win",
  );
  assert.ok(
    resolutionAffinity(1080, 1080) > resolutionAffinity(2160, 1080),
    "with a 1080 target, 4K must lose",
  );
});

check("below-target degrades gracefully; above-target sinks below all of it", () => {
  const t = DEFAULT_TARGET_RESOLUTION;
  const order = [1080, 720, 576, 480, 360, 2160, null].map((r) =>
    resolutionAffinity(r, t),
  );
  for (let i = 1; i < order.length; i++) {
    assert.ok(
      order[i - 1]! > order[i]!,
      `affinity not strictly descending at index ${i}: ${order.join(" > ")}`,
    );
  }
});

console.log("\n--- junk sources: worse than any resolution is good ---");

check("2160p HDCAM never beats 480p WEB-DL, at any seeder ratio", () => {
  for (const sJunk of SEEDER_SWEEP) {
    for (const sReal of SEEDER_SWEEP) {
      const a = rel({ title: "Big Movie 2024 2160p HDCAM", id: "junk", seeders: sJunk });
      const b = rel({ title: "Big Movie 2024 480p WEB-DL", id: "real", seeders: sReal });
      assert.equal(winner(a, b), "real", `HDCAM@${sJunk} beat 480p@${sReal}`);
    }
  }
});

check("junk detection covers the real tokens", () => {
  for (const t of [
    "Movie 2024 HDCAM",
    "Movie 2024 CAMRip",
    "Movie 2024 CAM",
    "Movie.2024.TELESYNC.x264",
    "Movie 2024 HDTS",
    "Movie 2024 DVDSCR",
    "Movie 2024 Screener",
    "Movie.2024.HDTC",
  ]) {
    assert.ok(isJunkSource(t), `should be junk: ${t}`);
  }
});

check("junk detection does not fire on innocent words", () => {
  // `\bcam\b` is the risky one — these are the collisions that would silently
  // bury legitimate releases at the bottom of every search.
  for (const t of [
    "Camp Cretaceous S01E01 1080p WEB-DL",
    "Cameron Diaz Documentary 1080p",
    "The Camera Man 1943 1080p BluRay",
    "Scam 1992 S01E01 1080p",
    "Camelot S01E01 720p",
    "Camden Town Docu 1080p",
  ]) {
    assert.equal(isJunkSource(t), false, `false positive: ${t}`);
  }
});

console.log("\n--- fake sizes: demote, never reject ---");

check("a 40 MB '1080p' is demoted", () => {
  const fake = rel({ title: "Show S01E01 1080p WEB-DL", id: "fake", sizeBytes: 40 * 1024 * 1024 });
  const real = rel({ title: "Show S01E01 720p WEB-DL", id: "real", sizeBytes: 900 * 1024 * 1024 });
  assert.ok(isImplausible(fake));
  assert.equal(winner(fake, real), "real", "a 40 MB 1080p must lose to a real 720p");
});

check("short legitimate content is NOT treated as fake", () => {
  // A 12-minute anime episode or an OVA at 1080p can sit at 150-250 MB. A flat
  // "1080p must exceed 300 MB" rule — the obvious version of this check —
  // would discard these outright. Runtime is not stored anywhere in this app,
  // so a proper MB-per-minute bound cannot be computed honestly.
  for (const bytes of [150, 200, 250, 480]) {
    const r = rel({ title: "[Group] Short Anime - 05 (1080p)", sizeBytes: bytes * 1024 * 1024 });
    assert.equal(isImplausible(r), false, `${bytes} MB 1080p wrongly called fake`);
  }
});

check("unknown size is never held against a release", () => {
  for (const sizeBytes of [0, null as unknown as number, undefined as unknown as number]) {
    const r = rel({ title: "Show S01E01 1080p WEB-DL", sizeBytes });
    assert.equal(isImplausible(r), false, `sizeBytes=${sizeBytes} wrongly called fake`);
  }
});

check("samples are demoted regardless of size or resolution", () => {
  assert.ok(isImplausible(rel({ title: "Show S01E01 1080p WEB-DL sample", sizeBytes: 5_000_000_000 })));
});

console.log("\n--- viability: the 'never finishes' trap ---");

check("a thin 1080p deliberately loses to a healthy 480p", () => {
  // This is the one case where a lower resolution wins, and it is intentional.
  // Ordering purely by resolution would grab a 1-seeder 1080p that sits at 0%
  // forever: this app has no stall detector and no blocklist, so a dead grab
  // is never retried. A watchable 480p beats an unwatchable 1080p.
  const thin = rel({ title: "Show S01E01 1080p WEB-DL", id: "thin", seeders: 1 });
  const healthy = rel({ title: "Show S01E01 480p WEB-DL", id: "healthy", seeders: 500 });
  assert.equal(winner(thin, healthy), "healthy");
});

check("viability threshold is the only thing that flips resolution order", () => {
  const healthy480 = rel({ title: "Show 480p WEB-DL", id: "sd", seeders: 500 });
  // Just below the line loses; exactly on the line wins.
  const below = rel({ title: "Show 1080p WEB-DL", id: "hd", seeders: MIN_VIABLE_SEEDERS - 1 });
  const atLine = rel({ title: "Show 1080p WEB-DL", id: "hd", seeders: MIN_VIABLE_SEEDERS });
  assert.equal(winner(below, healthy480), "sd");
  assert.equal(winner(atLine, healthy480), "hd");
});

check("zero-seed releases sort last but are never discarded", () => {
  assert.equal(isViable(rel({ title: "x", seeders: 0 })), false);
  const ranked = rankResults(
    [
      rel({ title: "Show S01E01 1080p WEB-DL", id: "dead", seeders: 0 }),
      rel({ title: "Show S01E01 720p WEB-DL", id: "alive", seeders: 100 }),
    ],
    "Show",
  );
  assert.equal(ranked.length, 2, "nothing may be dropped");
  assert.equal(ranked[0]?.id, "alive");
});

console.log("\n--- relevance: the wrong show is always wrong ---");

check("a 2160p of the wrong show never beats a 1080p of the right one", () => {
  const wrong = rel({ title: "Completely Different Movie 2160p WEB-DL", id: "wrong", seeders: 9000 });
  const right = rel({ title: "The Bear S03E01 1080p WEB-DL", id: "right", seeders: 10 });
  assert.equal(winner(wrong, right, "The Bear"), "right");
});

check("the SxxEyy automation token does not hand victory to a scene-named 480p", () => {
  // `resolveHuntCursor` builds "One Piece S01E05", but Nyaa names the file
  // "[SubsPlease] One Piece - 05 (1080p)" — which does not contain "s01e05".
  // Without stripping the token the fansub release drops a relevance tier and
  // the scene-formatted 480p wins on naming coincidence, reintroducing the
  // exact bug being fixed.
  const fansub = rel({ title: "[SubsPlease] One Piece - 05 (1080p)", id: "fansub", seeders: 300 });
  const scene = rel({ title: "One Piece S01E05 480p WEBRip", id: "scene", seeders: 300 });
  assert.equal(winner(fansub, scene, "One Piece S01E05"), "fansub");
});

check("stripEpisodeTokens removes selectors but keeps the show name", () => {
  const cases: Array<[string, string]> = [
    ["One Piece S01E05", "One Piece"],
    ["The Bear Season 3", "The Bear"],
    ["Frieren Episode 12", "Frieren"],
    ["Some Show 1x05", "Some Show"],
    ["Blade Runner 2049", "Blade Runner 2049"], // a year is not an episode
    ["One Piece", "One Piece"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(stripEpisodeTokens(input).replace(/\s+/g, " "), expected, input);
  }
});

check("an empty query makes everything equally relevant instead of equally irrelevant", () => {
  // RSS/browse paths pass no query. If that collapsed every release to tier 0
  // it would still be uniform, but a blank query must never *reorder* on
  // relevance noise.
  assert.equal(relevanceTier("Anything At All 1080p", ""), 0);
  assert.equal(relevanceTier("Something Else 720p", ""), 0);
});

console.log("\n--- structural guarantees ---");

check("ranking never drops a release", () => {
  const input = [
    rel({ title: "Show S01E01 1080p WEB-DL", id: "a" }),
    rel({ title: "Show S01E01 480p HDCAM", id: "b", seeders: 0 }),
    rel({ title: "[Erai-raws] Show - 01", id: "c" }),
    rel({ title: "Show S01E01 2160p REMUX", id: "d", sizeBytes: 60_000_000_000 }),
    rel({ title: "sample", id: "e", sizeBytes: 1024 }),
  ];
  const out = rankResults(input, "Show");
  assert.equal(out.length, input.length);
  assert.deepEqual(new Set(out.map((r) => r.id)), new Set(input.map((r) => r.id)));
});

check("unknown resolution ranks below known ones but above nothing", () => {
  const ranked = rankResults(
    [
      rel({ title: "[Erai-raws] Show - 01", id: "unknown", seeders: 100 }),
      rel({ title: "Show - 01 1080p", id: "hd", seeders: 100 }),
      rel({ title: "Show - 01 480p", id: "sd", seeders: 100 }),
    ],
    "Show",
  );
  assert.deepEqual(ranked.map((r) => r.id), ["hd", "sd", "unknown"]);
});

check("the comparator is a valid total order (sort would otherwise be undefined)", () => {
  const titles = [
    "Show S01E01 1080p WEB-DL",
    "Show S01E01 720p WEB-DL",
    "Show S01E01 480p HDCAM",
    "Show S01E01 2160p REMUX",
    "[Erai-raws] Show - 01",
    "Show S01E01 1080p sample",
    "Wrong Title 2160p",
  ];
  const items = titles.map((t, i) =>
    describeRelease(rel({ title: t, id: `i${i}`, seeders: (i + 1) * 7 }), "Show"),
  );
  for (const a of items) {
    for (const b of items) {
      assertAntisymmetric(compareReleases(a, b), compareReleases(b, a), "matrix pair");
      for (const c of items) {
        // Transitivity: a<=b and b<=c implies a<=c.
        if (compareReleases(a, b) <= 0 && compareReleases(b, c) <= 0) {
          assert.ok(compareReleases(a, c) <= 0, "transitivity");
        }
      }
    }
  }
});

check("the score encoding never disagrees with the comparator", () => {
  // `groupReleases` and the search API sort by `score`. If score drifted from
  // the comparator, the "Best" badge would land on a different row than the
  // ordering picked — the exact class of bug where the UI quietly lies.
  const pool = [
    rel({ title: "Show S01E01 1080p WEB-DL", id: "a", seeders: 5 }),
    rel({ title: "Show S01E01 720p WEB-DL", id: "b", seeders: 900 }),
    rel({ title: "Show S01E01 480p WEB-DL", id: "c", seeders: 20000 }),
    rel({ title: "Show S01E01 2160p WEB-DL", id: "d", seeders: 400 }),
    rel({ title: "Show S01E01 1080p HDCAM", id: "e", seeders: 800 }),
    rel({ title: "[Erai-raws] Show - 01", id: "f", seeders: 60 }),
    rel({ title: "Show S01E01 1080p WEB-DL", id: "g", seeders: 1 }),
  ];
  const ranked = rankResults(pool, "Show");
  for (let i = 1; i < ranked.length; i++) {
    assert.ok(
      (ranked[i]!.score ?? 0) <= (ranked[i - 1]!.score ?? 0),
      `score rose from ${ranked[i - 1]!.id} (${ranked[i - 1]!.score}) to ${ranked[i]!.id} (${ranked[i]!.score})`,
    );
  }
});

check("the UI resolution chip always agrees with the ranker", () => {
  // These drifted apart before: extractTags did a naive uppercase substring
  // match while the ranker parsed properly, so a card could show "1080p" on a
  // release the ranker had read as something else entirely.
  const titles = [
    "Show 1080p WEB-DL",
    "Show 2160p REMUX",
    "Show 720p HDTV",
    "Show 480p WEBRip",
    "Show 1920x1080 WEB",
    "Movie [4K] BluRay",
    "Movie 4kto1080p WEB-DL",
    "Movie 4k Remastered 1080p BluRay",
    "Show FHD",
    "[Erai-raws] Show - 05",
  ];
  for (const t of titles) {
    const res = parseResolution(t);
    const chips = extractTags(t).filter((c) => /^\d+p$/.test(c));
    if (res == null) {
      assert.equal(chips.length, 0, `chip shown for unknown resolution: ${t} → ${chips}`);
    } else {
      assert.deepEqual(chips, [`${res}p`], `chip disagrees with parser for: ${t}`);
    }
  }
});

check("short tags do not fire on substrings of longer words", () => {
  // "DV" inside "DVDRip" would claim Dolby Vision on a DVD rip.
  assert.ok(!extractTags("Movie 2001 DVDRip x264").includes("DV"));
  assert.ok(extractTags("Movie 2160p DV HDR10 REMUX").includes("DV"));
  assert.ok(extractTags("Movie 2160p Dolby Vision REMUX").includes("DV"));
});

console.log(
  failures === 0
    ? "\nquality.test.ts: all assertions passed"
    : `\nquality.test.ts: ${failures} FAILED`,
);
if (failures > 0) process.exit(1);
