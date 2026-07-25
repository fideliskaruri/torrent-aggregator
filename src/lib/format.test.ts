/**
 * formatBytes must never produce "819 undefined/s".
 *
 * WebTorrent reports speeds as decaying moving averages, so an idle-but-alive
 * torrent sits at fractions of a byte per second for long stretches. The unit
 * index was clamped at the top but not the bottom, so `Math.log(0.8)` gave -1,
 * `units[-1]` was undefined, and `0.8 / 1024 ** -1` scaled the number *up*.
 * That string shipped straight to the Client page.
 */
import assert from "node:assert/strict";
import { formatBytes, formatDuration } from "@/lib/utils";

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  ✗ ${name}: ${(err as Error).message}`);
  }
}

console.log("formatBytes: sub-byte values…");

const SUB_BYTE = [0.001, 0.1, 0.5, 0.8, 0.999];
for (const bytes of SUB_BYTE) {
  check(`${bytes} renders as bytes`, () => {
    const out = formatBytes(bytes);
    assert.ok(
      !out.includes("undefined"),
      `formatBytes(${bytes}) produced ${JSON.stringify(out)}`,
    );
    assert.ok(out.endsWith(" B"), `expected a B unit, got ${out}`);
    // Must not be scaled up past the input.
    const value = Number.parseFloat(out);
    assert.ok(value <= 1, `value ${value} is larger than the input ${bytes}`);
  });
}

console.log("formatBytes: normal range…");

const CASES: [number, string][] = [
  [0, "0 B"],
  [1, "1 B"],
  [512, "512 B"],
  [1024, "1.0 KB"],
  [1536, "1.5 KB"],
  [1024 ** 2, "1.0 MB"],
  [1024 ** 3, "1.0 GB"],
  [1024 ** 4, "1.0 TB"],
];
for (const [input, expected] of CASES) {
  check(`${input} → ${expected}`, () => {
    assert.equal(formatBytes(input), expected);
  });
}

console.log("formatBytes: unrepresentable values…");

for (const bad of [null, undefined, NaN, -1]) {
  check(`${String(bad)} → em dash`, () => {
    assert.equal(formatBytes(bad as number), "—");
  });
}

check("beyond TB stays in TB rather than indexing off the end", () => {
  const out = formatBytes(1024 ** 6);
  assert.ok(!out.includes("undefined"), out);
  assert.ok(out.endsWith(" TB"), out);
});

console.log("formatDuration…");

const DURATION_CASES: [number, string][] = [
  [0, "0s"],
  [45, "45s"],
  [59, "59s"],
  [60, "1m"],
  [90, "1m"],
  [605, "10m"],
  [3600, "1h"],
  [3660, "1h 1m"],
  [86400, "1d"],
  [576540, "6d 16h"],
  // The value visual QC actually saw on the Client page: 9,609 minutes.
  [9609 * 60, "6d 16h"],
];
for (const [input, expected] of DURATION_CASES) {
  check(`${input}s → ${expected}`, () => {
    assert.equal(formatDuration(input), expected);
  });
}

check("never renders a bare minute count in the thousands", () => {
  for (const s of [9609 * 60, 17574 * 60, 16370 * 60, 11984 * 60]) {
    const out = formatDuration(s);
    assert.ok(
      /^\d+d( \d+h)?$/.test(out),
      `week-scale ETA should roll up to days, got ${out}`,
    );
  }
});

check("at most two units, so the metadata line cannot grow unbounded", () => {
  for (const s of [1, 61, 3661, 90061, 1234567]) {
    assert.ok(
      formatDuration(s).split(" ").length <= 2,
      `${s}s → ${formatDuration(s)}`,
    );
  }
});

for (const bad of [null, undefined, NaN, -1, Infinity]) {
  check(`duration ${String(bad)} → em dash`, () => {
    assert.equal(formatDuration(bad as number), "—");
  });
}

if (failures > 0) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
}
console.log("\nAll formatBytes tests passed.");
