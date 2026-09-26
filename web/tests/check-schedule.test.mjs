import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import path from "node:path";

const server = await createServer({
  configFile: false, root: process.cwd(),
  resolve: { alias: { "@": path.resolve("src") } },
  server: { middlewareMode: true, watch: null, hmr: false, ws: false },
});
after(() => server.close());
const { CheckSchedule } = await server.ssrLoadModule("/src/components/library/check-schedule.tsx");
const { automationStateCopy } = await server.ssrLoadModule("/src/components/library/library-state.ts");
const props = { monitored: true, status: "watching", nextCheckAt: "2099-09-26T12:00:00.000Z" };
const render = (extra) => renderToStaticMarkup(createElement(CheckSchedule, { ...props, ...extra }));

test("schedule names the wait and exposes an absolute machine-readable time", () => {
  for (const [reason, label] of [["not aired yet", "Not aired yet"], ["waiting for seeders", "Waiting for seeders"], ["next check", "Next check"]]) {
    const html = render({ nextCheckReason: reason });
    assert.ok(html.includes(label));
    assert.ok(html.includes(`dateTime="${props.nextCheckAt}"`));
    assert.ok(html.includes("data-check-schedule"));
    assert.ok(html.includes("text-[var(--text-tertiary)]"));
  }
});

test("inactive, missing and invalid schedules do not show misleading wait text", () => {
  for (const extra of [{ automationEnabled: false }, { monitored: false }, { status: "completed" }, { status: "dropped" }, { nextCheckAt: null }, { nextCheckAt: "bad date" }])
    assert.equal(render(extra), "");
});

test("overdue checks do not promise a future appointment", () => {
  assert.match(render({ nextCheckAt: "2000-01-01T00:00:00Z" }), /Check due/);
});

test("enabled automation describes per-title rather than fixed checks", () => {
  assert.match(automationStateCopy(30), /each title's schedule/);
  assert.match(automationStateCopy(0), /won't download automatically/);
});
