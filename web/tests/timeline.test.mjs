import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "vite";

const server = await createServer({
  configFile: false, root: process.cwd(),
  server: { middlewareMode: true, watch: null, hmr: false, ws: false },
});
after(() => server.close());
const { groupTimeline, timelineTime } = await server.ssrLoadModule("/src/app/upcoming/timeline.ts");
const nav = await server.ssrLoadModule("/src/lib/navigation.ts");
const row = (id, at) => ({ id, at });

test("groups local calendar days at midnight, retaining server ordering", () => {
  const now = new Date(2026, 8, 26, 23, 59);
  const groups = groupTimeline([
    row("overdue", new Date(2026, 8, 25).toISOString()),
    row("today", new Date(2026, 8, 26, 23, 59, 59).toISOString()),
    row("tomorrow", new Date(2026, 8, 27).toISOString()),
    row("later", new Date(2026, 8, 28).toISOString()),
    row("unestimated", null),
  ], now);
  assert.deepEqual(groups.map((g) => [g.label, g.entries.map((e) => e.id)]), [
    ["Today", ["overdue", "today", "unestimated"]], ["Tomorrow", ["tomorrow"]], ["Later", ["later"]],
  ]);
});

test("calendar grouping handles month/year rollovers and invalid times without crashing", () => {
  const groups = groupTimeline([
    row("year", new Date(2027, 0, 1).toISOString()), row("bad", "invalid"),
  ], new Date(2026, 11, 31, 23));
  assert.deepEqual(groups.map((g) => [g.label, g.entries[0].id]), [["Today", "bad"], ["Tomorrow", "year"]]);
  assert.deepEqual(groupTimeline([]), []);
});

test("DST uses next local midnight instead of adding 24 hours", () => {
  const previous = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    for (const now of [new Date(2026, 2, 8, 0, 30), new Date(2026, 10, 1, 0, 30)]) {
      const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      assert.equal(groupTimeline([row("next", next.toISOString())], now)[0].label, "Tomorrow");
    }
  } finally {
    if (previous == null) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test("relative times never invent a queue ETA and correctly describe future checks", () => {
  const now = new Date("2026-09-26T12:00:00Z");
  assert.equal(timelineTime(null, now), "Start time not known");
  assert.equal(timelineTime("invalid", now), "Start time not known");
  assert.equal(timelineTime("2026-09-26T11:00:00Z", now), "Due now");
  assert.match(timelineTime("2026-09-26T12:15:00Z", now), /15 minutes/);
});

test("Upcoming sits beside Downloads on desktop and inside mobile More", () => {
  const downloads = nav.DESKTOP_NAV.findIndex((item) => item.href === "/downloads");
  assert.equal(nav.DESKTOP_NAV[downloads + 1].href, "/upcoming");
  assert.ok(nav.SECONDARY_NAV.some((item) => item.href === "/upcoming"));
  assert.ok(!nav.PRIMARY_NAV.some((item) => item.href === "/upcoming"));
  assert.equal(nav.activeNavLabel("/upcoming"), "Upcoming");
  assert.ok(nav.MORE_ACTIVE_PREFIXES.includes("/upcoming"));
});
