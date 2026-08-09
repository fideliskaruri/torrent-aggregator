import assert from "node:assert/strict";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { completedManifestFromRow } from "./completed-media";
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
        { path: subtitle, size: subtitleStat.size, mtimeMs: subtitleStat.mtimeMs },
        { path: escaped, size: escapedStat.size, mtimeMs: escapedStat.mtimeMs },
      ]),
    });
    assert.deepEqual(
      manifest?.files.map((file) => file.relativePath).sort(),
      ["Show/Episode.en.srt", "Show/Episode.mkv"],
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
