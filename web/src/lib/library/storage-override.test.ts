/**
 * The storage cap prompt: figures stay separate and the breakdown is scannable.
 *
 * Runs through tests/legacy-ui.test.mjs (Vite SSR), so it is type-checked by
 * `pnpm run typecheck` and executed by `pnpm test`.
 */
import assert from "node:assert/strict";
import { capOverridePrompt, parseStorageOverrideFacts, type StorageOverrideFacts } from "./storage-override";

const gb = 1e9;

function factsFrom(value: unknown): StorageOverrideFacts {
  const facts = parseStorageOverrideFacts(value);
  assert.ok(facts, "facts parse");
  return facts;
}

// Social Network regression: a 1.2 GB release must not read as needing 45.8 GB.
{
  const facts = factsFrom({
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
  const prompt = capOverridePrompt(facts);
  assert.equal(prompt.title, "Over your storage cap");
  assert.match(prompt.body, /This download: 1\.2 GB\./);
  assert.match(prompt.body, /Already queued: 44\.6 GB\./);
  assert.doesNotMatch(prompt.body, /needs about 45\.8/);
  assert.match(prompt.body, /255\.3 GB of 300\.0 GB/);
  assert.deepEqual(
    prompt.rows.map((row) => [row.label, row.value]),
    [
      ["Used", "255.3 GB"],
      ["This download", "1.2 GB"],
      ["Already queued", "44.6 GB"],
      ["Cap", "300.0 GB"],
    ],
  );
  assert.match(prompt.summary, /1\.1 GB over the cap/);
  assert.equal(prompt.note, "Nothing gets deleted, and free disk space stays protected.");
  for (const text of [prompt.title, prompt.summary, prompt.note, prompt.body]) {
    assert.doesNotMatch(text, /\u2014/);
  }
  assert.ok(prompt.bar);
  assert.deepEqual(prompt.bar.segments.map((segment) => segment.key), ["used", "incoming", "queued"]);
  const filled = prompt.bar.segments.reduce((sum, segment) => sum + segment.fraction, 0);
  assert.ok(Math.abs(filled - 1) < 1e-9, "over the cap, the bar is full");
  assert.ok(prompt.bar.markerFraction != null && prompt.bar.markerFraction < 1, "cap tick sits inside the bar");
}

// Unknown size is marked, and the queue is not folded into this download.
{
  const prompt = capOverridePrompt(
    factsFrom({
      limit: "cap",
      usedBytes: 0,
      capBytes: 5 * gb,
      incomingBytes: 2 * gb,
      incomingEstimated: true,
      reservedQueuedBytes: 3 * gb,
      settingsHref: "/settings?tab=folders&focus=cap",
    }),
  );
  assert.match(prompt.body, /This download: 2\.0 GB \(size unknown\)\./);
  assert.match(prompt.body, /Already queued: 3\.0 GB\./);
  assert.equal(prompt.rows.find((row) => row.key === "incoming")?.value, "about 2.0 GB");
  assert.deepEqual(prompt.rows.map((row) => row.key), ["used", "incoming", "queued", "cap"]);
}

// Parsing keeps the queue separate and re-derives overridable from the rule.
{
  const facts = factsFrom({ limit: "cap", usedBytes: 1, capBytes: 2, incomingBytes: 100, reservedQueuedBytes: 200 });
  assert.equal(facts.incomingBytes, 100);
  assert.equal(facts.reservedQueuedBytes, 200);
  assert.equal(facts.overridable, true);
  assert.equal(factsFrom({ limit: "wont-fit", overridable: true }).overridable, false);
}

// Reserve: the combined claim is only used for the free-space leftover.
{
  const prompt = capOverridePrompt(
    factsFrom({
      limit: "reserve",
      usedBytes: 0,
      capBytes: 100 * gb,
      freeBytes: 900 * 1e6,
      incomingBytes: 200 * 1e6,
      reservedQueuedBytes: 300 * 1e6,
      settingsHref: "/settings?tab=folders&focus=cap",
    }),
  );
  assert.match(prompt.body, /This download: 200 MB\./);
  assert.match(prompt.body, /Already queued: 300 MB\./);
  assert.match(prompt.body, /leave about 400 MB free/);
  assert.doesNotMatch(prompt.body, /\u2014/);
  assert.deepEqual(
    prompt.rows.map((row) => [row.label, row.value]),
    [
      ["Free on drive", "900 MB"],
      ["This download", "200 MB"],
      ["Already queued", "300 MB"],
      ["Left after", "400 MB"],
    ],
  );
  assert.equal(prompt.summary, "About 400 MB would be left free.");
  assert.equal(prompt.bar?.markerFraction, null);
}

console.log("# PASS - storage cap prompt");
