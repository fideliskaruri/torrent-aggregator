/**
 * Heuristic dead-capability audit.
 *
 * Enumerates exported symbols and API route action strings, then reports entries
 * whose only references are definitions/tests or whose accepted action is never
 * posted by reachable app code. This is a triage probe: every reported finding
 * still needs hand verification before acting on it.
 *
 * Run:
 *   node node_modules\tsx\dist\cli.mjs scripts\probes\engine-dead-capabilities.mts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const srcRoot = path.join(repoRoot, "src");

const conventionExports = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
  "default",
  "generateMetadata",
  "generateStaticParams",
  "metadata",
  "viewport",
  "register",
  "middleware",
]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

function rel(file: string): string {
  return path.relative(repoRoot, file).replace(/\\/g, "/");
}

function isTest(file: string): boolean {
  return /(?:^|[\\/.])(test|tests|__tests__)(?:[\\/.])/.test(file) || /\.test\.(ts|tsx)$/.test(file);
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split(/\r?\n/).length;
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countWord(text: string, word: string): number {
  return [...text.matchAll(new RegExp(`\\b${escapeRe(word)}\\b`, "g"))].length;
}

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const files = walk(srcRoot);
const records = files.map((file) => ({ file, rel: rel(file), text: fs.readFileSync(file, "utf8") }));
const prod = records.filter((r) => !isTest(r.file));
const tests = records.filter((r) => isTest(r.file));

type ExportCandidate = {
  kind: "export";
  symbol: string;
  file: string;
  line: number;
  declaration: string;
  prodRefsOutsideFile: number;
  prodRefsInFileAfterDefinition: number;
  testRefs: number;
  confidence: "certain" | "suspicious";
  reason: string;
};

const exportCandidates: ExportCandidate[] = [];

for (const r of prod) {
  const source = stripComments(r.text);
  const exportRe = /(^|\n)\s*export\s+(?:(?:async\s+)?function|const|class|enum|type|interface)\s+([A-Za-z_$][\w$]*)\b/g;
  for (const m of source.matchAll(exportRe)) {
    const symbol = m[2];
    if (conventionExports.has(symbol)) continue;
    const absoluteIndex = m.index ?? 0;
    const line = lineOf(source, absoluteIndex + m[0].indexOf("export"));
    const declarationLine = r.text.split(/\r?\n/)[line - 1]?.trim() ?? "";
    const ownAfter = r.text
      .split(/\r?\n/)
      .slice(line)
      .join("\n");
    const prodRefsOutsideFile = prod
      .filter((other) => other.file !== r.file)
      .reduce((sum, other) => sum + countWord(other.text, symbol), 0);
    const prodRefsInFileAfterDefinition = Math.max(0, countWord(ownAfter, symbol));
    const testRefs = tests.reduce((sum, other) => sum + countWord(other.text, symbol), 0);
    if (prodRefsOutsideFile === 0 && prodRefsInFileAfterDefinition === 0) {
      exportCandidates.push({
        kind: "export",
        symbol,
        file: r.rel,
        line,
        declaration: declarationLine,
        prodRefsOutsideFile,
        prodRefsInFileAfterDefinition,
        testRefs,
        confidence: testRefs > 0 ? "certain" : "suspicious",
        reason: testRefs > 0
          ? "export is exercised only by tests (no production reference outside its declaration)"
          : "export has no production or test references; may be a deliberate public seam",
      });
    } else if (prodRefsOutsideFile === 0 && testRefs > 0) {
      exportCandidates.push({
        kind: "export",
        symbol,
        file: r.rel,
        line,
        declaration: declarationLine,
        prodRefsOutsideFile,
        prodRefsInFileAfterDefinition,
        testRefs,
        confidence: "suspicious",
        reason: "export is only referenced in its own production file plus tests",
      });
    }
  }
}

type ActionCandidate = {
  kind: "api-action";
  route: string;
  action: string;
  file: string;
  line: number;
  referencesOutsideRouteOrTests: string[];
  endpointPosters: string[];
  confidence: "certain" | "suspicious";
  reason: string;
};

type RouteCandidate = {
  kind: "api-route";
  route: string;
  file: string;
  methods: string[];
  referencesOutsideRouteOrTests: string[];
  confidence: "certain" | "suspicious";
  reason: string;
};

function routeUrl(routeRel: string): string {
  let p = routeRel.replace(/^src\/app\/api\//, "/api/").replace(/\/route\.ts$/, "");
  p = p.replace(/\/\([^)]*\)/g, "");
  return p;
}

const actionCandidates: ActionCandidate[] = [];
const routeCandidates: RouteCandidate[] = [];
const routeRecords = prod.filter((r) => /^src\/app\/api\/.*\/route\.ts$/.test(r.rel));
for (const r of routeRecords) {
  const source = stripComments(r.text);
  const endpoint = routeUrl(r.rel);
  const methods = [...source.matchAll(/export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)].map(
    (m) => m[1],
  );
  const routeRefs = prod
    .filter((other) => other.file !== r.file)
    .filter((other) => other.text.includes(endpoint))
    .map((other) => other.rel);
  if (routeRefs.length === 0) {
    routeCandidates.push({
      kind: "api-route",
      route: endpoint,
      file: r.rel,
      methods,
      referencesOutsideRouteOrTests: routeRefs,
      confidence: endpoint.includes("[") ? "suspicious" : "certain",
      reason: endpoint.includes("[")
        ? "dynamic API route URL is not mentioned literally outside its route; may be built by a helper"
        : "API route URL is not mentioned literally by any non-test source outside its route",
    });
  }

  const actionLiterals = new Map<string, number>();
  const patterns = [
    /body\.action\s*(?:===|==|!==|!=)\s*["'`]([^"'`]+)["'`]/g,
    /action\?\s*:\s*([^;\n]+)/g,
    /action\s*:\s*["'`]([^"'`]+)["'`]/g,
    /\{\s*action\s*:\s*["'`]([^"'`]+)["'`]/g,
  ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) {
      const raw = m[1];
      const literals = [...raw.matchAll(/["'`]([^"'`]+)["'`]/g)].map((x) => x[1]);
      for (const literal of literals.length ? literals : [raw]) {
        if (!/^[a-z][a-z0-9_-]*$/i.test(literal)) continue;
        if (!actionLiterals.has(literal)) actionLiterals.set(literal, lineOf(source, m.index ?? 0));
      }
    }
  }
  if (actionLiterals.size === 0) continue;
  for (const [action, line] of actionLiterals) {
    const refsOutside = prod
      .filter((other) => other.file !== r.file)
      .filter((other) => other.text.includes(action))
      .map((other) => other.rel);
    const endpointPosters = prod
      .filter((other) => other.file !== r.file)
      .filter((other) => other.text.includes(endpoint) && /fetch\s*\(/.test(other.text))
      .map((other) => other.rel);
    const sameFileEndpointAndAction = endpointPosters.filter((file) => {
      const other = prod.find((x) => x.rel === file);
      return other
        ? new RegExp(`\\baction\\s*:\\s*["'\`]${escapeRe(action)}["'\`]`).test(other.text)
        : false;
    });
    if (sameFileEndpointAndAction.length === 0) {
      actionCandidates.push({
        kind: "api-action",
        route: endpoint,
        action,
        file: r.rel,
        line,
        referencesOutsideRouteOrTests: refsOutside,
        endpointPosters,
        confidence: refsOutside.length === 0 ? "certain" : "suspicious",
        reason:
          refsOutside.length === 0
            ? "route accepts action but no non-test source mentions that action string"
            : "route accepts action, but no source file both posts to the endpoint and mentions this action",
      });
    }
  }
}

const result = {
  generatedAt: new Date().toISOString(),
  counts: {
    prodFiles: prod.length,
    testFiles: tests.length,
    exportCandidates: exportCandidates.length,
    actionCandidates: actionCandidates.length,
    routeCandidates: routeCandidates.length,
  },
  routeCandidates: routeCandidates.sort((a, b) => a.file.localeCompare(b.file)),
  exportCandidates: exportCandidates
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
    .slice(0, 200),
  actionCandidates: actionCandidates.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
};

console.log(JSON.stringify(result, null, 2));
