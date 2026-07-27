import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { serveFileRange } from "./http-range";

let failures = 0;

async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main() {
  await check("aborting a range body closes the file descriptor exactly once", async () => {
    const root = await fsp.mkdtemp(path.join(process.cwd(), ".test-http-range-"));
    const file = path.join(root, "movie.mp4");
    const originalClose = fs.close;
    let closeCount = 0;

    try {
      await fsp.writeFile(file, Buffer.alloc(1024 * 1024, 1));
      (fs as unknown as { close: typeof fs.close }).close = function close(
        this: typeof fs,
        ...args
      ) {
        closeCount += 1;
        return originalClose.apply(this, args);
      } as typeof fs.close;

      const response = serveFileRange(file, "movie.mp4", "bytes=0-1048575", {
        cacheControl: "no-store",
      });
      assert.equal(response.status, 206);
      assert.ok(response.body, "range response should have a body");

      const reader = response.body.getReader();
      const first = await reader.read();
      assert.equal(first.done, false, "the stream must have opened before aborting");

      await reader.cancel("viewer seek");
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(closeCount, 1);
    } finally {
      (fs as unknown as { close: typeof fs.close }).close = originalClose;
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  if (failures > 0) {
    console.error(`\nFAIL — ${failures} HTTP range test(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS — all HTTP range tests passed.");
}

void main();
