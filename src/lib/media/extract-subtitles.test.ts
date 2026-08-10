import assert from "node:assert/strict";

import {
  buildSubtitleExtractArgs,
  cancelEmbeddedSubtitle,
  PREFETCH_EXTRACT_TIMEOUT_MS,
  extractEmbeddedSubtitle,
} from "./extract-subtitles";
import { SUBTITLE_WINDOW_DURATION_SECONDS } from "./subtitles";

const args = buildSubtitleExtractArgs("http://example.test/video", 2, 480);
const inputIndex = args.indexOf("-i");
const seekIndex = args.indexOf("-ss");
const durationIndex = args.indexOf("-t");

assert.ok(seekIndex >= 0 && seekIndex < inputIndex);
assert.equal(args[seekIndex + 1], "480");
assert.ok(durationIndex > inputIndex);
assert.equal(args[durationIndex + 1], String(SUBTITLE_WINDOW_DURATION_SECONDS));
assert.deepEqual(args.slice(args.indexOf("-map"), args.indexOf("-map") + 2), [
  "-map",
  "0:2",
]);
assert.ok(PREFETCH_EXTRACT_TIMEOUT_MS < 45_000);

console.log("PASS subtitle extraction uses a bounded seekable window");

async function main() {
  const controller = new AbortController();
  controller.abort();
  const canceled = await extractEmbeddedSubtitle({
    infoHash: "canceled-test",
    filePath: "video.mkv",
    streamIndex: 2,
    sourceUrl: "http://example.test/video",
    signal: controller.signal,
  });
  assert.deepEqual(canceled, {
    ok: false,
    error: "aborted",
    message: "subtitle extraction was canceled",
  });
  assert.equal(
    cancelEmbeddedSubtitle({
      infoHash: "missing",
      filePath: "video.mkv",
      streamIndex: 2,
      consumerId: "test",
    }),
    false,
  );
  console.log("PASS aborted subtitle requests do not start extraction");
}

void main();
