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

const {
  capOverridePrompt,
  parseStorageOverrideFacts,
} = await server.ssrLoadModule("/src/lib/library/storage-override.ts");

const gb = 1e9;

test("cap dialog separates this download from already-queued reservations", () => {
  // Social Network regression: chosen 1.2 GB release must not read as needing 45.8 GB.
  const facts = parseStorageOverrideFacts({
    limit: "cap",
    overridable: true,
    usedBytes: 255.3 * gb,
    capBytes: 300 * gb,
    freeBytes: 500 * gb,
    incomingBytes: 1.2 * gb,
    incomingEstimated: false,
    reservedQueuedBytes: 44.6 * gb,
    settingsHref: "/settings?tab=folders&focus=cap",
    message: "ignored",
  });
  assert.ok(facts);
  const prompt = capOverridePrompt(facts);
  assert.equal(prompt.title, "This exceeds your storage cap");
  assert.match(prompt.body, /This download: 1\.2 GB\./);
  assert.match(prompt.body, /Already queued: 44\.6 GB\./);
  assert.doesNotMatch(prompt.body, /needs about 45\.8/);
  assert.doesNotMatch(prompt.body, /—/);
  assert.match(prompt.body, /255\.3 GB of 300\.0 GB/);
});

test("cap dialog marks unknown size without folding in the queue", () => {
  const facts = parseStorageOverrideFacts({
    limit: "cap",
    usedBytes: 0,
    capBytes: 5 * gb,
    incomingBytes: 2 * gb,
    incomingEstimated: true,
    reservedQueuedBytes: 3 * gb,
    settingsHref: "/settings?tab=folders&focus=cap",
  });
  const body = capOverridePrompt(facts).body;
  assert.match(body, /This download: 2\.0 GB \(size unknown\)\./);
  assert.match(body, /Already queued: 3\.0 GB\./);
});

test("parseStorageOverrideFacts keeps reservedQueuedBytes separate", () => {
  const facts = parseStorageOverrideFacts({
    limit: "cap",
    usedBytes: 1,
    capBytes: 2,
    incomingBytes: 100,
    reservedQueuedBytes: 200,
  });
  assert.equal(facts.incomingBytes, 100);
  assert.equal(facts.reservedQueuedBytes, 200);
  assert.equal(facts.overridable, true);
});

test("reserve dialog uses combined claim only for free-space leftover math", () => {
  const facts = parseStorageOverrideFacts({
    limit: "reserve",
    usedBytes: 0,
    capBytes: 100 * gb,
    freeBytes: 900 * 1e6,
    incomingBytes: 200 * 1e6,
    reservedQueuedBytes: 300 * 1e6,
    settingsHref: "/settings?tab=folders&focus=cap",
  });
  const body = capOverridePrompt(facts).body;
  assert.match(body, /This download: 200 MB\./);
  assert.match(body, /Already queued: 300 MB\./);
  // 900 - (200+300) = 400 MB left
  assert.match(body, /leave about 400 MB free/);
  assert.doesNotMatch(body, /—/);
});
