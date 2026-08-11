import assert from "node:assert/strict";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  completedManifestFromRow,
  completedManifestFromTrustedRecordedPaths,
} from "./completed-media";
import { withScratchDir } from "@/lib/test-support/scratch-dir";

async function main() {
  await withScratchDir("completed-media", async (scratch) => {
    const root = path.join(scratch, "download");
    const outside = path.join(scratch, "outside");
    const video = path.join(root, "Show", "Episode.mkv");
    const subtitle = path.join(root, "Show", "Episode.en.srt");
    const escaped = path.join(outside, "escaped.mkv");
    await Promise.all([
      mkdir(path.dirname(video), { recursive: true }),
      mkdir(outside, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(video, "video"),
      writeFile(subtitle, "subtitle"),
      writeFile(escaped, "outside"),
    ]);
    const [videoStat, subtitleStat, escapedStat] = await Promise.all([
      stat(video),
      stat(subtitle),
      stat(escaped),
    ]);
    const manifest = await completedManifestFromRow({
      hash: "abc",
      progress: 1,
      savePath: root,
      verifiedFilesJson: JSON.stringify([
        { path: video, size: videoStat.size, mtimeMs: videoStat.mtimeMs },
        {
          path: subtitle,
          size: subtitleStat.size,
          mtimeMs: subtitleStat.mtimeMs,
        },
        { path: escaped, size: escapedStat.size, mtimeMs: escapedStat.mtimeMs },
      ]),
    });
    assert.deepEqual(manifest?.files.map((file) => file.relativePath).sort(), [
      "Show/Episode.en.srt",
      "Show/Episode.mkv",
    ]);

    const oldShowRoot = path.join(scratch, "old-category", "Show");
    const newShowRoot = path.join(scratch, "new-category", "Show");
    const recordedEpisode = path.join(oldShowRoot, "Moved.mkv");
    const recordedScript = path.join(oldShowRoot, "install.scr");
    await Promise.all([
      mkdir(oldShowRoot, { recursive: true }),
      mkdir(newShowRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(recordedEpisode, "moved-video"),
      writeFile(recordedScript, "MZ"),
    ]);
    const [movedStat, recordedScriptStat] = await Promise.all([
      stat(recordedEpisode),
      stat(recordedScript),
    ]);
    const trustedOriginal = await completedManifestFromTrustedRecordedPaths(
      {
        hash: "trusted-original",
        progress: 1,
        savePath: newShowRoot,
        verifiedFilesJson: JSON.stringify([
          {
            path: recordedEpisode,
            size: movedStat.size,
            mtimeMs: movedStat.mtimeMs,
          },
          {
            path: recordedScript,
            size: recordedScriptStat.size,
            mtimeMs: recordedScriptStat.mtimeMs,
          },
        ]),
      },
      [scratch],
    );
    assert.equal(
      trustedOriginal?.files[0]?.path,
      recordedEpisode,
      "an exact fingerprint under a same-named configured root stays authoritative",
    );
    assert.equal(
      trustedOriginal?.files.length,
      1,
      "trusted recovery exposes only supported media assets",
    );

    const wrongSize = await completedManifestFromTrustedRecordedPaths(
      {
      hash: "wrong-size",
      progress: 1,
      savePath: newShowRoot,
      verifiedFilesJson: JSON.stringify([
        {
            path: recordedEpisode,
          size: movedStat.size + 1,
          mtimeMs: movedStat.mtimeMs,
        },
      ]),
      },
      [scratch],
    );
    assert.equal(
      wrongSize,
      null,
      "a recorded file with the wrong size is rejected",
    );

    const unrelatedRoot = await completedManifestFromTrustedRecordedPaths(
      {
        hash: "unrelated-root",
        progress: 1,
        savePath: root,
        verifiedFilesJson: JSON.stringify([
          {
            path: recordedEpisode,
            size: movedStat.size,
            mtimeMs: movedStat.mtimeMs,
          },
        ]),
      },
      [scratch],
    );
    assert.equal(
      unrelatedRoot,
      null,
      "a different leaf folder is not guessed as the prior save root",
    );

    const untrustedOriginal = await completedManifestFromTrustedRecordedPaths(
      {
        hash: "untrusted-original",
        progress: 1,
        savePath: newShowRoot,
        verifiedFilesJson: JSON.stringify([
          {
            path: recordedEpisode,
            size: movedStat.size,
            mtimeMs: movedStat.mtimeMs,
          },
        ]),
      },
      [newShowRoot],
    );
    assert.equal(
      untrustedOriginal,
      null,
      "files outside configured roots stay rejected",
    );

    const executable = path.join(root, "Show", "Episode.scr");
    await writeFile(executable, "MZ");
    const executableStat = await stat(executable);
    const invalid = await completedManifestFromRow({
      hash: "bad",
      progress: 1,
      savePath: root,
      verifiedFilesJson: JSON.stringify([
        {
          path: executable,
          size: executableStat.size,
          mtimeMs: executableStat.mtimeMs,
        },
      ]),
    });
    assert.equal(invalid, null);
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
