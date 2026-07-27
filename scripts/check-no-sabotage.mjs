/**
 * Fail the build if a deliberate-sabotage edit was left in the working tree.
 *
 * ## Why this exists
 *
 * This repo has a hard rule that a new assertion is not trusted until it has
 * been proven to go RED — you break the code on purpose, watch the test fail,
 * then restore. That rule caught three genuinely vacuous test suites here, so
 * it stays.
 *
 * The cost of the rule is that, for a few seconds at a time, the working tree
 * contains code that is *deliberately wrong*. Three separate parallel agents
 * were each found mid-verification with their break still in place:
 *
 *   - `src/lib/catalog/works.ts`   — every catalog title left as the raw scene
 *     release name ("House.of.the.Dragon.S03E06.1080p.AMZN.WEB-DL..."), which
 *     silently took the whole discovery catalog's poster hit-rate to zero,
 *     because you cannot look up artwork for a filename.
 *   - `src/lib/browse/discovery.ts` — `availability: "unavailable"` hard-coded
 *     on rows nobody had checked, violating the invariant that `null` means
 *     "not determined" and must stay neutral and clickable.
 *   - `src/lib/prewarm/prerank.ts`  — the opaque search-cache key rebuilt by
 *     hand, which is the exact historical bug the seam test was written for.
 *
 * Every one of those was *invisible*: the suite was green, the types checked,
 * the server started, and the page rendered. Only a human looking at real data
 * would have caught them — and a human looking at real data is precisely what
 * does not happen at 4am. So the guard is mechanical.
 *
 * ## What counts as a marker
 *
 * The convention is that a deliberate break is announced in a comment. That is
 * good practice and this file depends on it: the marker is the contract. Any
 * of the spellings below, in any tracked source file, fails the run.
 *
 * This is intentionally a *dumb* text scan and not a clever AST rule. A
 * sabotage edit is arbitrary by nature — there is no shape to detect — so the
 * only reliable signal is the comment the author already agreed to write.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");

/**
 * The announced-break spellings seen in practice, plus the obvious neighbours.
 *
 * Case-insensitive. `SABOTAGE-6:` and `DELIBERATE BREAK A (temporary)` were
 * both real, and they were written by different agents on the same day, so the
 * vocabulary is deliberately wide rather than a single blessed token.
 *
 * Each pattern requires the full *announcement* form rather than a bare
 * mention of the word. The first version matched `/\bsabotage\b/i`, which
 * flagged this guard's own filename in `test-all.mjs` and the word "sabotage"
 * in a doc comment — noise that trains people to ignore the gate. A marker is
 * a structured announcement (`SABOTAGE-6:`, `BREAK A (temporary)`); prose
 * about the practice is not.
 */
const MARKERS = [
  /\bDELIBERATE\s+BREAK\b/i,
  /\bSABOTAGE\s*-?\s*\d+\s*:/i,
  /\bTEMPORARY\s+BREAK\b/i,
  /\bINTENTIONAL\s+BREAK\b/i,
  /\bBREAK\s+[A-Z]\b\s*\(\s*temporary\s*\)/i,
  /-{2,}\s*END\s+BREAK\s+[A-Z]\b/i,
];

/**
 * Files that are *allowed* to name the markers: this guard, and prose that
 * documents the practice. Without this the guard trips over itself, and the
 * handover notes could never explain the rule they enforce.
 */
const ALLOWED = new Set(
  [
    "scripts/check-no-sabotage.mjs",
    "docs/handover.md",
    "docs/netflix-roadmap.html",
    "README.md",
  ].map((p) => p.replace(/\//g, path.sep)),
);

/** Only source-ish files; a match inside a lockfile or an image is noise. */
const SCANNED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".cjs",
  ".css",
  ".prisma",
]);

/**
 * Ask git for the file list rather than walking the disk.
 *
 * It is the only source that already knows about `.gitignore`, so `.next/`,
 * `node_modules/`, build output and the local database never reach the scan —
 * and a marker that only exists in generated output is not a real finding.
 *
 * `--others --exclude-standard` is load-bearing and was added after this guard
 * reported a confident PASS over three real, live sabotage edits: every file
 * carrying one was brand new and therefore *untracked*, and a plain
 * `git ls-files` lists only what is already in the index. A guard that cannot
 * see new work is worse than no guard, because it is trusted.
 */
function trackedFiles() {
  const out = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  // `--cached` and `--others` can both name the same path; dedupe so a finding
  // is never reported twice.
  return [...new Set(out.split("\0").filter(Boolean))];
}

async function main() {
  let files;
  try {
    files = trackedFiles();
  } catch (err) {
    // A missing git binary must not be a silent pass: this guard exists to be
    // load-bearing, so an inability to run it is a failure, not a skip.
    console.error("check-no-sabotage: could not list tracked files");
    console.error(String(err?.message ?? err));
    process.exitCode = 1;
    return;
  }

  const findings = [];

  for (const rel of files) {
    const nativeRel = rel.replace(/\//g, path.sep);
    if (ALLOWED.has(nativeRel)) continue;
    if (!SCANNED_EXTENSIONS.has(path.extname(rel))) continue;

    let text;
    try {
      text = await readFile(path.join(ROOT, rel), "utf8");
    } catch {
      continue; // Deleted between listing and reading; not this guard's problem.
    }

    // Cheap pre-filter so the regex army only runs on plausible files.
    if (!/break|sabotage/i.test(text)) continue;

    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      if (MARKERS.some((re) => re.test(line))) {
        findings.push({ file: rel, line: i + 1, text: line.trim() });
      }
    });
  }

  if (findings.length === 0) {
    console.log("PASS no deliberate-sabotage markers in tracked source");
    return;
  }

  console.error(
    `FAIL ${findings.length} deliberate-sabotage marker(s) left in the tree:`,
  );
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  ${f.text}`);
  }
  console.error(
    "\nA sabotage edit proves an assertion goes RED and must be reverted in the\n" +
      "same batch. Restore the real code, then re-run.",
  );
  process.exitCode = 1;
}

await main();
