import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { createServer } from "vite";

const server = await createServer({
  configFile: false,
  root: process.cwd(),
  resolve: { alias: { "@": path.resolve("src") } },
  server: { middlewareMode: true, watch: null, hmr: false, ws: false },
});

try {
  const { postTitleAction } = await server.ssrLoadModule(
    "/src/components/title/title-action-request.ts",
  );
  test("episode grab preserves the server's short rejection summary for the toast", async () => {
    const message = "Couldn't find a release for S01E05 at 1080p or higher. 12 results checked: 9 were a different episode; 3 were below 1080p.";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
      ok: false,
      message,
      noReleaseFound: { candidates: [], reason: "no_release" },
    }), { status: 409, headers: { "content-type": "application/json" } });
    try {
      await assert.rejects(postTitleAction({
        workKey: "example-show",
        title: "Example Show",
        mediaType: "tv",
        action: { season: 1, episode: 5 },
        retention: "keep",
        resolution: 1080,
      }), { message });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
} finally {
  await server.close();
}
