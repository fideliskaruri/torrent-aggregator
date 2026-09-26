import assert from "node:assert/strict";
import { after, test } from "node:test";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
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

const windows = await server.ssrLoadModule("/src/lib/download-windows.ts");
const { waitReasonLabel } = await server.ssrLoadModule("/src/app/downloads/release-display.ts");
const { DownloadWindowsPanel } = await server.ssrLoadModule("/src/components/settings/download-windows-panel.tsx");

test("a draft round-trips to the API shape with MB/s converted to bytes and blanks as no limit", () => {
  const draft = { ...windows.newWindowDraft(), days: [5, 1, 1], startHour: 22, endHour: 6, maxDownloadMbps: "2.5" };
  const body = windows.toWindow(draft, 0);
  assert.deepEqual(body, {
    days: [1, 5], startHour: 22, endHour: 6,
    maxActiveDownloads: null, maxDownloadRate: 2_500_000, maxUploadRate: null,
  });
  assert.deepEqual(windows.toDraft(body), { ...draft, days: [1, 5], maxDownloadMbps: "2.5" });
  // Missing caps from the server (it omits nulls) stay blank.
  assert.equal(windows.toDraft({ days: [0], startHour: 0, endHour: 24 }).maxUploadMbps, "");
});

test("validation mirrors the server rules", () => {
  const ok = windows.newWindowDraft();
  assert.equal(windows.validateDraft(ok), null);
  assert.equal(windows.validateDraft({ ...ok, startHour: 0, endHour: 24 }), null);
  assert.match(windows.validateDraft({ ...ok, days: [] }), /day/);
  assert.match(windows.validateDraft({ ...ok, startHour: 7, endHour: 7 }), /differ/);
  assert.match(windows.validateDraft({ ...ok, maxActiveDownloads: "0" }), /1 to 20/);
  assert.match(windows.validateDraft({ ...ok, maxActiveDownloads: "2.5" }), /whole/);
  assert.match(windows.validateDraft({ ...ok, maxDownloadMbps: "-1" }), /download speed/);
  assert.match(windows.validateDraft({ ...ok, maxUploadMbps: "abc" }), /upload speed/);
  assert.throws(() => windows.toWindow({ ...ok, days: [] }, 2), /rule 3/);
});

test("summaries read like a schedule", () => {
  const base = windows.newWindowDraft();
  assert.equal(windows.describeWindow(base), "Weekdays 01:00–07:00");
  assert.equal(
    windows.describeWindow({ ...base, days: [0, 6], startHour: 22, endHour: 6, maxActiveDownloads: "3", maxUploadMbps: "1" }),
    "Weekends 22:00–06:00 (next day) · 3 at once · 1 MB/s up",
  );
  assert.equal(windows.describeWindow({ ...base, days: [0, 1, 2, 3, 4, 5, 6], startHour: 0, endHour: 24 }), "Every day all day");
  assert.equal(windows.describeWindow({ ...base, startHour: 9, endHour: 24 }), "Weekdays 09:00–24:00");
  // A saved rate that is not a round MB/s value survives an untouched save.
  assert.equal(windows.toWindow(windows.toDraft({ days: [1], startHour: 1, endHour: 2, maxDownloadRate: 2_345_678 }), 0).maxDownloadRate, 2_345_678);
});

test("wait reasons are labelled only on queued rows", () => {
  assert.equal(waitReasonLabel("queued", "outside-window"), "Waiting for download hours");
  assert.equal(waitReasonLabel("queued", "queue-full"), "Waiting for a free slot");
  assert.equal(waitReasonLabel("queued", "lower-lane"), "Waiting behind higher-priority downloads");
  assert.equal(waitReasonLabel("downloading", "queue-full"), null);
  assert.equal(waitReasonLabel("queued", null), null);
  assert.equal(waitReasonLabel("queued", "something-new"), null);
});

test("the panel shows an add button when empty and one fieldset per rule with its status", () => {
  const empty = renderToStaticMarkup(createElement(DownloadWindowsPanel, { windows: [], onChange() {}, open: null }));
  assert.match(empty, /data-download-window-add/);
  assert.match(empty, /Downloads can start at any time/);
  assert.doesNotMatch(empty, /data-download-window-status/);

  const html = renderToStaticMarkup(createElement(DownloadWindowsPanel, {
    windows: [windows.newWindowDraft(), { ...windows.newWindowDraft(), days: [] }],
    onChange() {},
    open: false,
  }));
  assert.equal(html.match(/data-download-window="/g).length, 2);
  assert.equal(html.match(/data-download-window-day="/g).length, 14);
  assert.match(html, /data-download-window-status="closed"/);
  assert.equal(html.match(/data-download-window-error/g).length, 1);
});
