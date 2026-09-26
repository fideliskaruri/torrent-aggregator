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

const { seasonGrabFailureDescription } = await server.ssrLoadModule(
  "/src/components/title/season-grab-state.ts",
);

test("season failure description prefers planReason", () => {
  const text = seasonGrabFailureDescription({
    season: 1,
    totalEpisodes: 2,
    coveredEpisodes: 0,
    strategy: "singles",
    coverageConfirmed: true,
    planReason: "Planner said no releases matched the floor.",
    episodes: [
      { episode: 1, status: "missing", reason: "no release found" },
      { episode: 2, status: "missing", reason: "rate limited" },
    ],
  });
  assert.equal(text, "Planner said no releases matched the floor.");
});

test("season failure description summarizes distinct episode reasons", () => {
  const text = seasonGrabFailureDescription({
    season: 2,
    totalEpisodes: 4,
    coveredEpisodes: 0,
    strategy: "singles",
    coverageConfirmed: true,
    episodes: [
      { episode: 1, status: "missing", reason: "no release found" },
      { episode: 2, status: "missing", reason: "no release found" },
      { episode: 3, status: "missing", reason: "no release found" },
      { episode: 4, status: "missing", reason: "rate limited" },
    ],
  });
  assert.equal(text, "3 episodes: no release found; 1: rate limited");
});

test("season failure description caps length near 160 chars", () => {
  const long = "x".repeat(200);
  const text = seasonGrabFailureDescription({
    season: 1,
    totalEpisodes: 1,
    coveredEpisodes: 0,
    strategy: "singles",
    coverageConfirmed: true,
    planReason: long,
    episodes: [],
  });
  assert.ok(text);
  assert.ok(text.length <= 160);
  assert.equal(text.endsWith("…"), true);
});

await server.close();
