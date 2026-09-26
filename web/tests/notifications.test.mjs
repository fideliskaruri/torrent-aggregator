import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

function worker() {
  const handlers = {};
  const shown = [];
  const opened = [];
  let focused = 0;
  let windows = [];
  const self = {
    location: { origin: "https://torrentflow.example" },
    addEventListener: (type, handler) => { handlers[type] = handler; },
    registration: { showNotification: async (title, options) => { shown.push({ title, options }); } },
    clients: {
      matchAll: async () => windows,
      openWindow: async url => { opened.push(url); },
    },
  };
  vm.runInNewContext(readFileSync("public/sw.js", "utf8"), { self, URL, console, Response });
  return { handlers, shown, opened, setWindows: value => { windows = value; }, focus: () => { focused++; }, focused: () => focused };
}

test("push displays its payload and constrains links to this app", async () => {
  const w = worker();
  let pending;
  w.handlers.push({ data: { json: () => ({ id: "id1", title: "Approved", body: "Dune", link: "/requests" }) }, waitUntil: p => { pending = p; } });
  await pending;
  assert.equal(w.shown[0].title, "Approved");
  assert.equal(w.shown[0].options.body, "Dune");
  assert.equal(w.shown[0].options.data.link, "https://torrentflow.example/requests");
  w.handlers.push({ data: { json: () => ({ link: "https://evil.example/" }) }, waitUntil: p => { pending = p; } });
  await pending;
  assert.equal(w.shown[1].options.data.link, "https://torrentflow.example/notifications");
});

test("malformed push still displays a safe generic notification", async () => {
  const w = worker();
  let pending;
  w.handlers.push({ data: { json: () => { throw new Error("bad json"); } }, waitUntil: p => { pending = p; } });
  await pending;
  assert.equal(w.shown[0].title, "TorrentFlow");
});

test("notification clicks focus a matching app window without disturbing playback", async () => {
  const w = worker();
  let pending;
  let closed = 0;
  const event = { notification: { data: { link: "/requests" }, close: () => { closed++; } }, waitUntil: p => { pending = p; } };
  w.setWindows([{ url: "https://torrentflow.example/watch", focus: w.focus }]);
  w.handlers.notificationclick(event);
  await pending;
  assert.equal(closed, 1);
  assert.deepEqual(w.opened, ["https://torrentflow.example/requests"]);
  assert.equal(w.focused(), 0);
  w.setWindows([{ url: "https://torrentflow.example/requests", focus: w.focus }]);
  w.handlers.notificationclick(event);
  await pending;
  assert.equal(w.focused(), 1);
  assert.equal(w.opened.length, 1);
});
