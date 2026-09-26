import assert from "node:assert/strict";
import { after, test } from "node:test";
import path from "node:path";
import { createServer } from "vite";

const server = await createServer({
  configFile: false,
  root: process.cwd(),
  resolve: { alias: { "@": path.resolve("src") } },
  server: { middlewareMode: true, watch: null, hmr: false, ws: false },
});
after(async () => {
  await server.close();
});

const { withTimeout } = await server.ssrLoadModule("/src/lib/with-timeout.ts");

test("withTimeout resolves when the work finishes first", async () => {
  const value = await withTimeout(Promise.resolve(42), 1_000, "too slow");
  assert.equal(value, 42);
});

test("withTimeout rejects with the timeout message when the work never settles", async () => {
  await assert.rejects(
    () => withTimeout(new Promise(() => {}), 20, "Couldn't enable push — check browser notification permission"),
    /Couldn't enable push — check browser notification permission/,
  );
});

test("withTimeout surfaces the original rejection when work fails first", async () => {
  await assert.rejects(
    () => withTimeout(Promise.reject(new Error("denied")), 1_000, "timed out"),
    /denied/,
  );
});
