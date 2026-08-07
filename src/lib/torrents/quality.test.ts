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
  scoreRelease,
  verdictTier,
  demotedTier,
  resolutionPreferenceTier,
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
    route: partial.route,
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

console.log("\n--- direct-play hint: cheaper playback wins only inside a quality tie ---");

const DIRECT_PLAY_CASES: Array<{
  name: string;
  items: TorrentResult[];
  expectedOrder: string[];
  expectedSignals?: Array<[string, boolean | null]>;
}> = [
  {
    name: "direct-playable MP4 beats a same-quality MKV/HEVC release",
    items: [
      rel({ id: "transcode", title: "Show S01E01 1080p WEB-DL HEVC DDP5.1.mkv", seeders: 50 }),
      rel({ id: "direct", title: "Show S01E01 1080p WEB-DL H.264 AAC.mp4", seeders: 50 }),
    ],
    expectedOrder: ["direct", "transcode"],
    expectedSignals: [["direct", true], ["transcode", false]],
  },
  {
    name: "quality still beats direct-playability when the quality gap is real",
    items: [
      rel({ id: "direct-sd", title: "Show S01E01 720p WEB-DL H.264 AAC.mp4", seeders: 50 }),
      rel({ id: "transcode-hd", title: "Show S01E01 1080p WEB-DL HEVC DTS.mkv", seeders: 50 }),
    ],
    expectedOrder: ["transcode-hd", "direct-sd"],
    expectedSignals: [["direct-sd", true], ["transcode-hd", false]],
  },
  {
    name: "unknown codec/container is neutral, not the same as known-bad",
    items: [
      rel({ id: "known-bad", title: "Show S01E01 1080p WEB-DL HEVC DDP5.1.mkv", seeders: 50 }),
      rel({ id: "unknown", title: "Show S01E01 1080p WEB-DL", seeders: 50 }),
      rel({ id: "direct", title: "Show S01E01 1080p WEB-DL x264 AAC.mp4", seeders: 50 }),
    ],
    expectedOrder: ["direct", "unknown", "known-bad"],
    expectedSignals: [["direct", true], ["unknown", null], ["known-bad", false]],
  },
  {
    name: "direct-playability never filters anything out",
    items: [
      rel({ id: "direct", title: "Show S01E01 1080p WEB-DL H264 AAC.mp4", seeders: 50 }),
      rel({ id: "unknown", title: "Show S01E01 1080p WEB-DL", seeders: 50 }),
      rel({ id: "mkv", title: "Show S01E01 1080p WEB-DL H264 AAC.mkv", seeders: 50 }),
      rel({ id: "hevc", title: "Show S01E01 1080p WEB-DL x265 TrueHD.mkv", seeders: 50 }),
    ],
    expectedOrder: ["direct", "unknown", "mkv", "hevc"],
    expectedSignals: [["direct", true], ["unknown", null], ["mkv", false], ["hevc", false]],
  },
];

for (const c of DIRECT_PLAY_CASES) {
  check(c.name, () => {
    const ranked = rankResults(c.items, "Show");
    assert.equal(ranked.length, c.items.length, "direct-play tiebreak must not drop candidates");
    assert.deepEqual(new Set(ranked.map((r) => r.id)), new Set(c.items.map((r) => r.id)));
    assert.deepEqual(ranked.map((r) => r.id), c.expectedOrder);
    for (let i = 1; i < ranked.length; i++) {
      assert.ok(
        (ranked[i]!.score ?? 0) <= (ranked[i - 1]!.score ?? 0),
        `score disagrees with direct-play order at ${ranked[i - 1]!.id} → ${ranked[i]!.id}`,
      );
    }
    for (const [id, expected] of c.expectedSignals ?? []) {
      const item = c.items.find((r) => r.id === id);
      assert.ok(item, `missing fixture ${id}`);
      assert.equal(describeRelease(item, "Show").directPlayable, expected, id);
    }
  });
}

console.log("\n--- language hint: English-inclusive releases win comparable ties ---");

check("English-inclusive language hints beat foreign-sub-only hints inside a tie", () => {
  const ranked = rankResults(
    [
      rel({ id: "foreign-subs", title: "Show S01E06 1080p WEBRip VOSTFR", seeders: 50 }),
      rel({ id: "english", title: "Show S01E06 1080p WEB-DL DUAL AUDIO", seeders: 50 }),
    ],
    "Show",
  );
  assert.deepEqual(ranked.map((r) => r.id), ["english", "foreign-subs"]);
});

check("language hint does not override relevance", () => {
  const ranked = rankResults(
    [
      rel({ id: "right-title", title: "Show S01E06 1080p WEBRip VOSTFR", seeders: 50 }),
      rel({ id: "wrong-title", title: "Other Series S01E06 1080p WEB-DL DUAL AUDIO", seeders: 50 }),
    ],
    "Show",
  );
  assert.equal(ranked[0]?.id, "right-title");
});

check("language hint does not override selected category", () => {
  const ranked = rankResults(
    [
      rel({
        id: "wrong-category",
        title: "Show S01E06 1080p WEB-DL DUAL AUDIO",
        seeders: 50,
        route: { kind: "music", category: "Music", confidence: "high" },
      }),
      rel({
        id: "right-category",
        title: "Show S01E06 1080p WEBRip VOSTFR",
        seeders: 50,
        route: { kind: "tv", category: "TV", confidence: "high" },
      }),
    ],
    "Show",
    DEFAULT_TARGET_RESOLUTION,
    "tv",
  );
  assert.equal(ranked[0]?.id, "right-category");
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

console.log("\n--- regressions found by review of the shipped diff ---");

// [3] stripEpisodeTokens must not corrupt "NxN" titles into a generic word.
check("leading NxN is a title, not an episode token", () => {
  assert.equal(stripEpisodeTokens("3x3 Eyes"), "3x3 Eyes");
  assert.equal(stripEpisodeTokens("3x3 Eyes S01E05"), "3x3 Eyes");
  assert.equal(stripEpisodeTokens("5x5"), "5x5");
  // A genuine episode token always trails a show name.
  assert.equal(stripEpisodeTokens("Family Guy 1x05"), "Family Guy");
  assert.equal(stripEpisodeTokens("The Wire 2x11"), "The Wire");
});

check("stripping never empties the relevance key", () => {
  for (const q of ["S01E05", "Season 2", "Episode 7", "5x5", ""]) {
    const out = stripEpisodeTokens(q);
    if (q !== "") {
      assert.ok(out.length > 0, `stripping emptied the query: "${q}"`);
    }
  }
});

check("years survive stripping", () => {
  assert.equal(stripEpisodeTokens("Blade Runner 2049"), "Blade Runner 2049");
});

// [4] "Cam" (2018) is a real film; bare CAM is only junk as trailing metadata.
check("a film titled Cam is not a camrip", () => {
  assert.ok(!isJunkSource("Cam 2018 1080p WEB-DL"), "Cam (2018) flagged as junk");
  assert.ok(!isJunkSource("The Cam 1080p"), "The Cam flagged as junk");
  assert.ok(!isJunkSource("Camp 1080p"));
  assert.ok(!isJunkSource("webcam show 1080p"));
  assert.ok(!isJunkSource("Scam 1992 1080p"));
});

check("bare CAM in the metadata block is still junk", () => {
  assert.ok(isJunkSource("Movie 2024 CAM XviD-GROUP"));
  assert.ok(isJunkSource("Movie.2024.CAM.x264"));
  assert.ok(isJunkSource("Some Movie 1080p CAM"));
  assert.ok(isJunkSource("Movie 2024 HDCAM"));
  assert.ok(isJunkSource("Movie 2024 CamRip"));
});

check("a junk-flagged release loses to a clean one regardless of swarm", () => {
  const junk = rel({ id: "junk", title: "Movie 2024 CAM XviD", seeders: 20_000 });
  const clean = rel({ id: "clean", title: "Movie 2024 1080p WEB-DL", seeders: 3 });
  assert.equal(winner(junk, clean), "clean");
});

// [10] standalone UHD is a real 2160 signal, unlike marketing "4k".
check("standalone UHD reads as 2160", () => {
  assert.equal(parseResolution("Movie UHD BluRay REMUX"), 2160);
  assert.equal(parseResolution("Movie 2160p UHD"), 2160);
  // Bare 4k stays marketing text.
  assert.equal(parseResolution("Movie 4k Remastered 1080p BluRay"), 1080);
});

// [5] The user-settable target is the newest surface; every target must keep a
// strict total order over resolutions, or two resolutions tie and ordering
// silently falls through to seeders — the original bug.
const SELECTABLE_TARGETS = [480, 720, 1080, 2160];
const ALL_RES = [360, 480, 576, 720, 1080, 2160];

check("every selectable target yields a strict order over resolutions", () => {
  for (const target of SELECTABLE_TARGETS) {
    const affinities = ALL_RES.map((r) => resolutionAffinity(r, target));
    const unique = new Set(affinities);
    assert.equal(
      unique.size,
      ALL_RES.length,
      `target ${target}: affinity collision ${JSON.stringify(
        ALL_RES.map((r, i) => [r, affinities[i]]),
      )}`,
    );
    // Unknown must rank below every known resolution.
    const unknown = resolutionAffinity(null, target);
    for (const a of affinities) {
      assert.ok(a > unknown, `target ${target}: unknown outranks a known res`);
    }
    // The target itself must win outright.
    const best = Math.max(...affinities);
    assert.equal(
      affinities[ALL_RES.indexOf(target)],
      best,
      `target ${target} is not the top-ranked resolution`,
    );
  }
});

check("above-target sinks below every at-or-below-target option", () => {
  for (const target of SELECTABLE_TARGETS) {
    const below = ALL_RES.filter((r) => r <= target);
    const above = ALL_RES.filter((r) => r > target);
    for (const hi of above) {
      for (const lo of below) {
        assert.ok(
          resolutionAffinity(lo, target) > resolutionAffinity(hi, target),
          `target ${target}: ${hi} outranked ${lo}`,
        );
      }
    }
  }
});

check("at every target, seeders never buy a resolution downgrade", () => {
  for (const target of SELECTABLE_TARGETS) {
    for (const lo of ALL_RES) {
      for (const hi of ALL_RES) {
        if (resolutionAffinity(hi, target) <= resolutionAffinity(lo, target)) {
          continue;
        }
        for (const loSeeders of SEEDER_SWEEP) {
          for (const hiSeeders of SEEDER_SWEEP) {
            const ranked = rankResults(
              [
                rel({ id: "lo", title: `Show ${lo}p WEB-DL`, seeders: loSeeders }),
                rel({ id: "hi", title: `Show ${hi}p WEB-DL`, seeders: hiSeeders }),
              ],
              "Show",
              target,
            );
            assert.equal(
              ranked[0].id,
              "hi",
              `target ${target}: ${lo}p@${loSeeders} beat ${hi}p@${hiSeeders}`,
            );
          }
        }
      }
    }
  }
});

// [6] Every existing test leaves publishedAt undefined, so recency is pinned
// at 0 and the "score can never disagree with the comparator" claim is only
// proven on a sub-lattice. Drive recency and seeders to their ceilings.
check("score encoding agrees with the comparator when recency is live", () => {
  const now = Date.now();
  const ages = [0, 2, 10, 40, 400].map(
    (d) => new Date(now - d * 86_400_000).toISOString(),
  );
  const pool: TorrentResult[] = [];
  for (const res of [480, 720, 1080, 2160]) {
    for (const seeders of [3, 150, 20_000]) {
      for (const publishedAt of ages) {
        pool.push(
          rel({
            id: `${res}-${seeders}-${publishedAt}`,
            title: `Show ${res}p WEB-DL`,
            seeders,
            publishedAt,
          }),
        );
      }
    }
  }

  for (const target of SELECTABLE_TARGETS) {
    const ranked = rankResults(pool, "Show", target);
    for (let i = 0; i < ranked.length - 1; i += 1) {
      const a = ranked[i];
      const b = ranked[i + 1];
      // The encoded score is what the UI groups on; it must never contradict
      // the comparator that produced the order.
      assert.ok(
        (a.score ?? 0) >= (b.score ?? 0),
        `target ${target}: score inverted at ${i} (${a.title} ${a.score} < ${b.title} ${b.score})`,
      );
      const cmp = compareReleases(
        describeRelease(a, "Show", target),
        describeRelease(b, "Show", target),
      );
      assert.ok(cmp <= 0, `target ${target}: comparator disagrees with rank at ${i}`);
    }
  }
});


// ── scoreRelease: shared verdict+resolution total-order ─────────────────────

check("scoreRelease: verdictTier contracts", () => {
  assert.equal(verdictTier("good"), 0);
  assert.equal(verdictTier("unknown"), 1);
  assert.equal(verdictTier("weak"), 2);
  assert.equal(verdictTier("dead"), 3);
});

check("scoreRelease: demotedTier contracts", () => {
  assert.equal(demotedTier("good"), 0);
  assert.equal(demotedTier("unknown"), 0);
  assert.equal(demotedTier("weak"), 1);
  assert.equal(demotedTier("dead"), 1);
});

check("scoreRelease: resolutionPreferenceTier contracts", () => {
  assert.equal(resolutionPreferenceTier("Show 1080p", 1080), 0, "exact match");
  assert.equal(resolutionPreferenceTier("Show 2160p", 1080), 2, "known mismatch");
  assert.equal(resolutionPreferenceTier("Show HDTV", 1080), 1, "resolution unknown");
  assert.equal(resolutionPreferenceTier("Show 1080p", null), 0, "no preference → 0");
});

check("scoreRelease: viable always beats dead/weak", () => {
  // Any viable release (good or unknown) must score higher than any non-viable
  // (weak or dead) release regardless of resolution match.
  const viable = scoreRelease("good", "Show 480p", 1080);
  const demoted = scoreRelease("weak", "Show 1080p", 1080); // exact res but demoted
  assert.ok(
    viable > demoted,
    `viable 480p (${viable}) must beat demoted 1080p (${demoted})`,
  );
});

check("scoreRelease: within viable, exact resolution beats unknown beats mismatch", () => {
  const exact   = scoreRelease("good", "Show 1080p", 1080);
  const unknown = scoreRelease("good", "Show HDTV",  1080);
  const mismatch = scoreRelease("good", "Show 2160p", 1080);
  assert.ok(exact > unknown,  `exact (${exact}) > unknown (${unknown})`);
  assert.ok(unknown > mismatch, `unknown (${unknown}) > mismatch (${mismatch})`);
});

check("scoreRelease: within same resolution tier, good > unknown > weak > dead", () => {
  const good    = scoreRelease("good",    "Show 1080p", 1080);
  const unknown = scoreRelease("unknown", "Show 1080p", 1080);
  const weak    = scoreRelease("weak",    "Show 1080p", 1080);
  const dead    = scoreRelease("dead",    "Show 1080p", 1080);
  assert.ok(good > unknown, `good (${good}) > unknown (${unknown})`);
  assert.ok(unknown > weak, `unknown (${unknown}) > weak (${weak})`);
  assert.ok(weak > dead,    `weak (${weak}) > dead (${dead})`);
});

check("scoreRelease: positional — no lower-priority field compensates for a higher one", () => {
  // A dead release with a perfect resolution should never beat a viable unknown.
  const deadExact   = scoreRelease("dead",    "Show 1080p", 1080);
  const viableWrong = scoreRelease("unknown", "Show 2160p", 1080);
  assert.ok(
    viableWrong > deadExact,
    `viable-wrong-res (${viableWrong}) must beat dead-exact-res (${deadExact})`,
  );
});

if (failures > 0) process.exit(1);
