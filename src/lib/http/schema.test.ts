/**
 * The schema combinator must behave exactly like the hand-rolled ladder it
 * replaces: same per-field validation, first failure wins in declaration order,
 * and a fully typed record on success.
 *
 * Run: npx tsx src/lib/http/schema.test.ts
 */
import assert from "node:assert/strict";
import { f, q, parseFields, parseQuery } from "./schema";

let failures = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err instanceof Error ? err.message : String(err)}`);
  }
}

function fields(obj: Record<string, unknown>): ReadonlyMap<string, unknown> {
  return new Map(Object.entries(obj));
}

console.log("schema.test.ts");

check("parseFields returns the whole typed record on success", () => {
  const result = parseFields(
    fields({ season: 2, episode: 5, retention: "keep", tags: ["a", "b"] }),
    {
      season: f.number({ required: true, integer: true, min: 1 }),
      episode: f.number({ required: true, integer: true, min: 1 }),
      retention: f.enum(["stream", "keep"] as const),
      tags: f.stringArray(),
    },
  );
  assert.ok(result.ok, "should parse");
  if (!result.ok) return;
  assert.deepEqual(result.value, {
    season: 2,
    episode: 5,
    retention: "keep",
    tags: ["a", "b"],
  });
});

check("optional fields absent come back as undefined, not missing keys", () => {
  const result = parseFields(fields({ season: 1, episode: 1 }), {
    season: f.number({ required: true }),
    episode: f.number({ required: true }),
    title: f.string(),
  });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.title, undefined);
  assert.equal("title" in result.value, true);
});

check("first failure in declaration order wins", () => {
  const result = parseFields(fields({ season: 0, episode: "nope" }), {
    season: f.number({ required: true, min: 1 }),
    episode: f.number({ required: true }),
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  // season fails its min check before episode's type check is reached.
  assert.equal(result.field, "season");
  assert.match(result.error, /at least 1/);
});

check("a required-but-missing field fails with its own name", () => {
  const result = parseFields(fields({ episode: 3 }), {
    season: f.number({ required: true }),
    episode: f.number({ required: true }),
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.field, "season");
});

check("enum rejects an out-of-set value", () => {
  const result = parseFields(fields({ retention: "burn" }), {
    retention: f.enum(["stream", "keep"] as const),
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.field, "retention");
});

check("parseQuery parses and clamps query params", () => {
  const result = parseQuery(new URLSearchParams("q=dune&limit=5"), {
    q: q.string({ required: true }),
    limit: q.number({ integer: true, min: 1, max: 50 }),
  });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.q, "dune");
  assert.equal(result.value.limit, 5);
});

check("parseQuery fails a required missing param", () => {
  const result = parseQuery(new URLSearchParams(""), {
    q: q.string({ required: true }),
  });
  assert.equal(result.ok, false);
});

if (failures > 0) {
  console.error(`schema.test.ts: ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("schema.test.ts: all assertions passed");




