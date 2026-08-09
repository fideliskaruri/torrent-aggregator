/**
 * A local claim must not outlive its file.
 *
 * The measured defect: the owner deleted a downloaded series from Explorer.
 * Nothing in the app deletes `EngineTorrent` or `PlaybackProgress` when that
 * happens, so the episode row kept showing **"Partial · Resume at 24:28"** with
 * a Resume button that could only ever open an empty player.
 *
 * The other half of the rule matters just as much: dropping a claim is itself a
 * claim. `absent` requires positive evidence — a path we recorded and the
 * filesystem says is not there. An unreadable directory, a permissions error,
 * or a row with nothing recorded is `unknown`, which changes nothing. This is
 * the same discipline as `browse/availability.ts` (`null` "nobody checked" is
 * not `unavailable` "checked, found nothing") and `torrents/swarm-probe.ts`.
 *
 * Table-driven per AGENTS.md.
 * Run: npx tsx src/lib/library/local-file-presence.test.ts
 */
import assert from "node:assert/strict";
import {
  classifyLocalFiles,
  collectLocalFileEvidence,
  fileConfirmedMissing,
  localFilePresence,
  localFilePresenceLookup,
  recordedFilePaths,
  resetLocalFilePresenceCache,
  type LocalFileEvidence,
  type LocalFilePresence,
  type StatProbe,
} from "./local-file-presence";
import { resolveResume } from "@/app/api/title/[workKey]/detail";
import {
  _resolveLocalOnly as resolveLocalOnly,
  type _TorrentRow as TorrentRow,
} from "@/lib/browse/availability";

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

// ---------------------------------------------------------------------------
// The verdict rule
// ---------------------------------------------------------------------------

interface ClassifyCase {
  name: string;
  evidence: LocalFileEvidence;
  expect: LocalFilePresence;
}

const CLASSIFY_CASES: ClassifyCase[] = [
  {
    name: "a recorded file that is really there is present",
    evidence: { filesRecorded: 1, filesFound: 1, filesMissing: 0, savePath: "exists" },
    expect: "present",
  },
  {
    name: "one surviving file of many keeps the claim",
    evidence: { filesRecorded: 12, filesFound: 1, filesMissing: 11, savePath: "exists" },
    expect: "present",
  },
  {
    name: "a file found under a directory we could not read is still present",
    evidence: { filesRecorded: 1, filesFound: 1, filesMissing: 0, savePath: "unknown" },
    expect: "present",
  },
  {
    // The owner's deleted series.
    name: "every recorded file confirmed gone is absent",
    evidence: { filesRecorded: 10, filesFound: 0, filesMissing: 10, savePath: "exists" },
    expect: "absent",
  },
  {
    name: "a deleted save directory is absent even with nothing recorded",
    evidence: { filesRecorded: 0, filesFound: 0, filesMissing: 0, savePath: "missing" },
    expect: "absent",
  },
  {
    // No recorded paths and a directory that is still there. The directory may
    // hold ten other torrents; its existence proves nothing about this one.
    name: "no recorded paths under a surviving directory is unknown",
    evidence: { filesRecorded: 0, filesFound: 0, filesMissing: 0, savePath: "exists" },
    expect: "unknown",
  },
  {
    name: "no evidence at all is unknown",
    evidence: { filesRecorded: 0, filesFound: 0, filesMissing: 0, savePath: "unknown" },
    expect: "unknown",
  },
  {
    // A permissions error left some paths unchecked. "Some are gone" is not
    // "all are gone", and guessing here deletes a working Play button.
    name: "a partial check with unreadable paths is unknown, never absent",
    evidence: { filesRecorded: 3, filesFound: 0, filesMissing: 2, savePath: "unknown" },
    expect: "unknown",
  },
];

// ---------------------------------------------------------------------------
// Evidence collection from real row shapes
// ---------------------------------------------------------------------------

function verified(paths: string[]): string {
  return JSON.stringify(paths.map((p) => ({ path: p, size: 1024, mtimeMs: 1 })));
}

/** A stat stub: anything listed exists, anything in `unreadable` throws. */
function statStub(present: string[], unreadable: string[] = []): StatProbe {
  const ok = new Set(present);
  const bad = new Set(unreadable);
  return (target) => {
    if (bad.has(target)) return "unknown";
    return ok.has(target) ? "exists" : "missing";
  };
}

function main(): void {
  console.log("classifyLocalFiles");
  for (const testCase of CLASSIFY_CASES) {
    check(testCase.name, () => {
      assert.equal(classifyLocalFiles(testCase.evidence), testCase.expect);
    });
  }

  console.log("recordedFilePaths");
  check("absolute paths are read out of the engine's verified-files record", () => {
    assert.deepEqual(
      recordedFilePaths(verified(["D:\\Downloads\\Show\\S01E01.mkv"])),
      ["D:\\Downloads\\Show\\S01E01.mkv"],
    );
  });
  check("malformed, empty and absent records yield no paths rather than throwing", () => {
    assert.deepEqual(recordedFilePaths(null), []);
    assert.deepEqual(recordedFilePaths(""), []);
    assert.deepEqual(recordedFilePaths("   "), []);
    assert.deepEqual(recordedFilePaths("{not json"), []);
    assert.deepEqual(recordedFilePaths('{"path":"x"}'), []);
    assert.deepEqual(recordedFilePaths('[{"size":1},{"path":""},null,7]'), []);
  });

  console.log("collectLocalFileEvidence");
  check("unreadable paths are counted as neither found nor missing", () => {
    const evidence = collectLocalFileEvidence(
      {
        hash: "h",
        savePath: "D:\\Downloads\\Show",
        verifiedFilesJson: verified(["D:\\a.mkv", "D:\\b.mkv", "D:\\c.mkv"]),
      },
      statStub(["D:\\Downloads\\Show"], ["D:\\c.mkv"]),
    );
    assert.deepEqual(evidence, {
      filesRecorded: 3,
      filesFound: 0,
      filesMissing: 2,
      savePath: "exists",
    });
    assert.equal(classifyLocalFiles(evidence), "unknown", "an incomplete check stays unknown");
  });

  console.log("localFilePresence");
  const PRESENCE_CASES: Array<{
    name: string;
    row: { hash: string; savePath?: string | null; verifiedFilesJson?: string | null };
    stat: StatProbe;
    expect: LocalFilePresence;
  }> = [
    {
      name: "a downloaded episode still on disk is present",
      row: {
        hash: "aaa",
        savePath: "D:\\Downloads\\Severance",
        verifiedFilesJson: verified(["D:\\Downloads\\Severance\\S02E06.mkv"]),
      },
      stat: statStub(["D:\\Downloads\\Severance", "D:\\Downloads\\Severance\\S02E06.mkv"]),
      expect: "present",
    },
    {
      name: "a series the owner deleted by hand is absent",
      row: {
        hash: "bbb",
        savePath: "D:\\Downloads\\Deleted Show",
        verifiedFilesJson: verified([
          "D:\\Downloads\\Deleted Show\\S01E01.mkv",
          "D:\\Downloads\\Deleted Show\\S01E02.mkv",
        ]),
      },
      stat: statStub([]),
      expect: "absent",
    },
    {
      name: "a stream cache row the engine never verified is unknown",
      row: { hash: "ccc", savePath: "D:\\Downloads", verifiedFilesJson: null },
      stat: statStub(["D:\\Downloads"]),
      expect: "unknown",
    },
    {
      name: "a row with no recorded path and no save path is unknown",
      row: { hash: "ddd" },
      stat: statStub([]),
      expect: "unknown",
    },
  ];

  for (const testCase of PRESENCE_CASES) {
    check(testCase.name, () => {
      resetLocalFilePresenceCache();
      assert.equal(
        localFilePresence(testCase.row, { stat: testCase.stat }),
        testCase.expect,
      );
    });
  }

  check("only a proven-absent file disqualifies a claim", () => {
    assert.equal(fileConfirmedMissing("absent"), true);
    assert.equal(fileConfirmedMissing("unknown"), false, "unknown must never drop a claim");
    assert.equal(fileConfirmedMissing("present"), false);
  });

  check("the lookup answers per hash and is case/whitespace insensitive", () => {
    resetLocalFilePresenceCache();
    const lookup = localFilePresenceLookup(
      [
        { hash: "AAA", savePath: "D:\\keep", verifiedFilesJson: verified(["D:\\keep\\a.mkv"]) },
        { hash: "bbb", savePath: "D:\\gone", verifiedFilesJson: verified(["D:\\gone\\b.mkv"]) },
      ],
      { stat: statStub(["D:\\keep", "D:\\keep\\a.mkv"]) },
    );
    assert.equal(lookup("aaa"), "present");
    assert.equal(lookup("  BBB "), "absent");
    assert.equal(lookup("never-seen"), "unknown", "an unseen hash is unknown, not absent");
  });

  check("verdicts are memoised within the window and re-read after it", () => {
    resetLocalFilePresenceCache();
    let calls = 0;
    const counting: StatProbe = (target) => {
      calls += 1;
      return target === "D:\\here" ? "exists" : "missing";
    };
    const row = { hash: "eee", savePath: "D:\\here", verifiedFilesJson: null };
    localFilePresence(row, { stat: counting, now: 1_000 });
    localFilePresence(row, { stat: counting, now: 5_000 });
    assert.equal(calls, 1, "the second read inside the window did not touch the disk");
    localFilePresence(row, { stat: counting, now: 1_000 + 60_000 });
    assert.equal(calls, 2, "the disk is re-read once the window elapses");
  });

  // ── The user-visible degrade ─────────────────────────────────────────────
  console.log("resolveResume");

  function localRelease(hash: string, fileMissing: boolean) {
    return {
      hash,
      name: `Show.${hash}`,
      progress: 0.4,
      status: "downloading",
      season: 1 as number | null,
      episode: 3 as number | null,
      isPack: false,
      isMultiSeason: false,
      retentionState: "stream" as const,
      fileMissing,
    };
  }

  function progressRow(hash: string) {
    return {
      infoHash: hash,
      filePath: "S01E03.mkv",
      positionSec: 1468, // 24:28 — the exact claim the owner was shown
      durationSec: 2700,
      completedAt: null,
      season: 1 as number | null,
      episode: 3 as number | null,
    };
  }

  check("a resume claim survives while its file does", () => {
    const resume = resolveResume([progressRow("kept")], [localRelease("kept", false)]);
    assert.ok(resume, "expected a resume target");
    assert.equal(resume?.positionSec, 1468);
  });

  check("a resume claim does not outlive its file", () => {
    const resume = resolveResume([progressRow("gone")], [localRelease("gone", true)]);
    assert.equal(resume, null, '"Partial · Resume at 24:28" must not survive the file');
  });

  check("one deleted file does not take the surviving episode's resume with it", () => {
    const resume = resolveResume(
      [progressRow("gone"), progressRow("kept")],
      [localRelease("gone", true), localRelease("kept", false)],
    );
    assert.ok(resume, "expected the surviving episode to still resume");
    assert.equal(resume?.infoHash, "kept");
  });

  // ── The browse-rail degrade ──────────────────────────────────────────────
  console.log("resolveLocalOnly");

  const rows: TorrentRow[] = [
    {
      hash: "ready-kept",
      name: "Severance S01E01 1080p",
      progress: 1,
      status: "downloaded",
      verifiedBitfield: "AQ==",
      verifiedFilesJson: verified(["D:\\Downloads\\Severance\\S01E01.mkv"]),
    },
    { hash: "warm-kept", name: "Andor S01E04 1080p", progress: 0.4, status: "downloading" },
  ];
  const enginePresent = () => "present" as const;

  const AVAILABILITY_CASES: Array<{
    name: string;
    query: { title: string; season?: number | null; episode?: number | null };
    presence: (hash: string) => LocalFilePresence;
    expect: unknown;
  }> = [
    {
      name: "a complete file still on disk stays ready",
      query: { title: "Severance", season: 1, episode: 1 },
      presence: () => "present",
      expect: { state: "ready", infoHash: "ready-kept" },
    },
    {
      // "we have not looked" must never move a claim. Presence defaults to
      // unknown everywhere the probe has not run.
      name: "an unchecked file leaves the claim exactly as it was",
      query: { title: "Severance", season: 1, episode: 1 },
      presence: () => "unknown",
      expect: { state: "ready", infoHash: "ready-kept" },
    },
    {
      // The honest degrade: no local claim at all, so the caller falls through
      // to the search cache. It is NOT a manufactured `unavailable`.
      name: "a deleted file drops the local claim rather than faking one",
      query: { title: "Severance", season: 1, episode: 1 },
      presence: () => "absent",
      expect: null,
    },
    {
      name: "a deleted partial file drops its warm claim too",
      query: { title: "Andor", season: 1, episode: 4 },
      presence: () => "absent",
      expect: null,
    },
    {
      name: "deleting one title does not disturb another",
      query: { title: "Andor", season: 1, episode: 4 },
      presence: (hash) => (hash === "ready-kept" ? "absent" : "present"),
      expect: { state: "warm", infoHash: "warm-kept", progress: 0.4 },
    },
  ];

  for (const testCase of AVAILABILITY_CASES) {
    check(testCase.name, () => {
      assert.deepEqual(
        resolveLocalOnly(testCase.query, rows, enginePresent, testCase.presence),
        testCase.expect,
      );
    });
  }

  if (failures > 0) {
    console.error(`local-file-presence.test.ts: ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("local-file-presence.test.ts: all assertions passed");
}

main();
