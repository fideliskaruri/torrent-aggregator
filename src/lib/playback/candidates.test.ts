/**
 * Candidate-listing tests: the selector must show every offerable release in
 * the ranker's order, annotated with quality shape and cached verdict, and it
 * must honour the invariant that runs through this codebase — `unknown` is not
 * `dead`. An unmeasured release is a normal menu item; only an explicit `dead`
 * measurement means "we watched this deliver nothing".
 */
import assert from "node:assert/strict";

import {
  describeReleaseShape,
  listCandidates,
  unknownVerdictReader,
  type SwarmVerdict,
} from "./candidates";
import type { TorrentResult } from "@/lib/torrents/types";
import type { PreRankTarget } from "@/lib/prewarm/types";

const MB = 1024 * 1024;
const TARGET: PreRankTarget = { title: "The Bear", mediaType: "tv", season: 1, episode: 1 };

function hash(n: number): string {
  return String(n).padStart(40, "0");
}
function rel(n: number, title: string, seeders: number): TorrentResult {
  return {
    id: `r${n}`,
    title,
    magnet: `magnet:?xt=urn:btih:${hash(n)}`,
    infoHash: hash(n),
    sizeBytes: 1000 * MB,
    seeders,
    leechers: 0,
    source: "apibay",
    sourceUrl: "https://example.test",
    tags: [],
  };
}

async function run() {
  // ── Shape parsing is honest ────────────────────────────────────────────
  {
    const s = describeReleaseShape("The Bear S01E01 2160p BluRay x265 HEVC DDP5.1 Atmos");
    assert.equal(s.resolution, 2160, "reads 2160p");
    assert.equal(s.sourceLabel, "BluRay", "reads BluRay source");
    assert.equal(s.codec, "HEVC", "reads HEVC codec");
    assert.equal(s.audio, "Atmos", "reads Atmos audio");

    const w = describeReleaseShape("The Bear S01E01 720p WEB-DL H.264 AAC");
    assert.equal(w.resolution, 720);
    assert.equal(w.sourceLabel, "WEB-DL");
    assert.equal(w.codec, "H.264");
    assert.equal(w.audio, "AAC");
  }

  // ── Playability is the third axis, from the media layer's one capability model ─
  {
    // Clean MP4/H.264/AAC → the browser plays it natively, no transcode.
    assert.equal(
      describeReleaseShape("The Bear S01E01 720p WEB-DL H.264 AAC.mp4").playability,
      "direct",
      "a clean mp4/h264/aac release is direct-playable",
    );
    // An MKV container is a hard obstacle for MSE even with fine codecs inside →
    // playable, but only via server transcode/remux, never instantly.
    assert.equal(
      describeReleaseShape("The Bear S01E01 1080p BluRay x265 HEVC DTS-HD.mkv").playability,
      "transcode",
      "an mkv/DTS release needs transcode — offered, but flagged not-instant",
    );
    // A bare name says nothing about codec or container → unknown, offered like
    // any other (unknown is not "cannot play", exactly as unknown swarm ≠ dead).
    assert.equal(
      describeReleaseShape("The Bear S01E01").playability,
      "unknown",
      "a name with no codec/container evidence is unknown, not broken",
    );
  }

  // ── unknown is NOT dead: an unmeasured release is listed normally ──────
  {
    const pool = [
      rel(1, "The Bear S01E01 1080p WEB-DL", 28),
      rel(2, "The Bear S01E01 720p WEB-DL", 4),
    ];
    // No verdicts at all — the swarm-probe module has not landed / not measured.
    const out = await listCandidates(TARGET, {
      rankedResults: async () => pool,
      readVerdicts: unknownVerdictReader,
    });
    assert.equal(out.length, 2, "every unmeasured release is still offered — none hidden");
    assert.ok(
      out.every((c) => c.verdict === "unknown"),
      "unmeasured releases read unknown, not dead",
    );
  }

  // ── A dead verdict is surfaced, not hidden; unknown stays offerable ────
  {
    const pool = [
      rel(1, "The Bear S01E01 1080p WEB-DL", 28),
      rel(2, "The Bear S01E01 720p WEB-DL", 4),
      rel(3, "The Bear S01E01 480p WEBRip", 1),
    ];
    const verdicts = new Map<string, SwarmVerdict>([
      [hash(1), "dead"], // the 1080p pick the indexer loved — measured dead
      [hash(2), "good"],
      // hash(3) unmeasured → unknown
    ]);
    const out = await listCandidates(TARGET, {
      currentInfoHash: hash(1),
      rankedResults: async () => pool,
      readVerdicts: async () => verdicts,
    });

    assert.equal(out.length, 3, "a dead release is still listed — the viewer decides, not us");
    assert.deepEqual(
      out.map((c) => c.infoHash),
      [hash(1), hash(2), hash(3)],
      "listing preserves the ranker's order verbatim; it annotates, never re-sorts",
    );
    assert.deepEqual(
      out.map((c) => c.verdict),
      ["dead", "good", "unknown"],
      "each verdict reported; the unmeasured one is unknown, not dead",
    );
    assert.equal(out[0].isCurrent, true, "the playing release is flagged");
    assert.equal(out[1].isCurrent, false);
    assert.equal(out[0].resolution, 1080, "annotated with resolution");
    assert.equal(out[1].resolution, 720);
    assert.ok(
      out.every((c) => c.playability === "direct" || c.playability === "transcode" || c.playability === "unknown"),
      "every listing carries a playability signal alongside its swarm verdict",
    );
  }

  // ── Releases with no infoHash are dropped; duplicates collapse ─────────
  {
    const noHash: TorrentResult = { ...rel(9, "The Bear S01E01 1080p", 5), infoHash: undefined, magnet: undefined };
    const pool = [
      rel(1, "The Bear S01E01 1080p WEB-DL", 28),
      noHash,
      rel(1, "The Bear S01E01 1080p WEB-DL dupe", 28), // same infoHash as #1
    ];
    const out = await listCandidates(TARGET, { rankedResults: async () => pool });
    assert.equal(out.length, 1, "unselectable (no infoHash) dropped and duplicate collapsed");
    assert.equal(out[0].infoHash, hash(1));
  }

  // ── A verdict-reader failure degrades to unknown, never blanks the menu ─
  {
    const pool = [rel(1, "The Bear S01E01 1080p WEB-DL", 28)];
    const out = await listCandidates(TARGET, {
      rankedResults: async () => pool,
      readVerdicts: async () => {
        throw new Error("probe store offline");
      },
    });
    assert.equal(out.length, 1, "a verdict lookup failure must not empty the selector");
    assert.equal(out[0].verdict, "unknown", "falls back to unknown, which is offered normally");
  }

  console.log("candidates.test.ts: PASS");
}

run().catch((err) => {
  console.error("candidates.test.ts: FAIL");
  console.error(err);
  process.exit(1);
});
