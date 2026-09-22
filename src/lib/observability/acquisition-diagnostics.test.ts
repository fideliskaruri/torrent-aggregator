import assert from "node:assert/strict";
import { logAcquisitionDecision } from "./acquisition-diagnostics";

const lines: string[] = [];
const original = console.info;
console.info = (line: string) => { lines.push(line); };
try {
  logAcquisitionDecision({}, "film-selection", { count: 2 });
  logAcquisitionDecision({ verboseDiagnostics: false }, "film-selection");
  assert.equal(lines.length, 0, "diagnostics are opt-in");

  logAcquisitionDecision({ verboseDiagnostics: true }, "film-selection", {
    candidateCount: 16,
    rejectedIdentity: 8,
    rejectedQuality: 3,
    minResolution: 1080,
    source: "yts",
    pathMode: "category",
    // Runtime inputs must be redacted even when a caller bypasses the type.
    ...{ savePath: "C:\\private\\secret", magnet: "magnet:?secret" },
    status: "https://user:password@example.invalid/private",
  });
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.action, "film-selection");
  assert.equal(entry.candidateCount, 16);
  assert.equal(entry.minResolution, 1080);
  assert.equal(entry.source, "yts");
  assert.equal(entry.pathMode, "category");
  assert.equal(entry.status, "[redacted]");
  assert.doesNotMatch(lines[0], /private|password|magnet|savePath/);
  assert.ok(!Number.isNaN(Date.parse(entry.timestamp)));
} finally {
  console.info = original;
}
console.log("PASS acquisition diagnostics are gated, structured and redacted");
