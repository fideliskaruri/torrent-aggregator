import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? files(full) : [full];
  });
}

const all = files("src");
const defined = new Set(
  all.filter((f) => f.endsWith(".css"))
    .flatMap((f) => [...readFileSync(f, "utf8").matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1])),
);
// Set at runtime by Radix, or undefined leftovers tracked in docs/todo-list.md.
const allowed = new Set(["--radix-dropdown-menu-content-available-height", "--surface", "--surface-2", "--text-primary"]);

test("every CSS variable the UI reads is defined", () => {
  const missing = new Map();
  for (const file of all.filter((f) => /\.(tsx?|css)$/.test(f))) {
    for (const [, name] of readFileSync(file, "utf8").matchAll(/var\((--[a-z0-9-]+)/g)) {
      if (!defined.has(name) && !allowed.has(name)) missing.set(name, file);
    }
  }
  assert.deepEqual([...missing], []);
});

test("--warning is gone; warnings use the amber accent text", () => {
  assert.ok(!defined.has("--warning"));
  for (const file of all.filter((f) => /\.tsx?$/.test(f))) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /var\(--warning\)/, file);
  }
});
