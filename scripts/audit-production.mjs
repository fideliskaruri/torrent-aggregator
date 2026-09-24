import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const allowlistPath = path.join(root, ".github", "npm-audit-allowlist.json");
const allowlist = JSON.parse(fs.readFileSync(allowlistPath, "utf8")).advisories;
const usePnpm = fs.existsSync(path.join(root, "pnpm-lock.yaml"));
const packageManager = usePnpm
  ? process.platform === "win32"
    ? "pnpm.cmd"
    : "pnpm"
  : process.platform === "win32"
    ? "npm.cmd"
    : "npm";
const auditArgs = usePnpm
  ? ["audit", "--prod", "--json"]
  : ["audit", "--omit=dev", "--json"];
const result = spawnSync(packageManager, auditArgs, {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
  shell: process.platform === "win32",
});

let audit;
try {
  audit = JSON.parse(result.stdout);
} catch {
  console.error("Production audit failed before returning valid JSON.");
  console.error((result.stderr || result.stdout || "").trim());
  process.exit(1);
}

if (audit.error) {
  console.error(`Production audit failed: ${audit.error.summary || audit.error.code}`);
  process.exit(1);
}

const severe = new Set(["high", "critical"]);
const findings = new Map();

function collect(packageName, seen = new Set()) {
  if (seen.has(packageName)) return [];
  seen.add(packageName);
  const vulnerability = audit.vulnerabilities?.[packageName];
  if (!vulnerability) return [];

  const found = [];
  for (const via of vulnerability.via ?? []) {
    if (typeof via === "string") {
      found.push(...collect(via, seen));
      continue;
    }
    if (!severe.has(via.severity)) continue;
    const id = via.url?.match(/GHSA-[\w-]+/)?.[0] ?? String(via.source);
    found.push({ id, packageName, severity: via.severity, title: via.title, url: via.url });
  }
  return found;
}

const unresolved = [];
if (usePnpm) {
  for (const advisory of Object.values(audit.advisories ?? {})) {
    if (!severe.has(advisory.severity)) continue;
    const id = advisory.github_advisory_id ?? String(advisory.id);
    findings.set(id, {
      id,
      packageName: advisory.module_name,
      severity: advisory.severity,
      title: advisory.title,
      url: advisory.url,
    });
  }
} else {
  for (const [packageName, vulnerability] of Object.entries(audit.vulnerabilities ?? {})) {
    if (!severe.has(vulnerability.severity)) continue;
    const resolved = collect(packageName);
    if (resolved.length === 0) unresolved.push(packageName);
    for (const finding of resolved) findings.set(finding.id, finding);
  }
}

const today = Date.now();
const blocked = [];
for (const finding of findings.values()) {
  const exception = allowlist[finding.id];
  const expired =
    exception?.expires == null ||
    Number.isNaN(Date.parse(exception.expires)) ||
    Date.parse(`${exception.expires}T23:59:59Z`) < today;
  if (!exception || expired) {
    blocked.push({ ...finding, reason: exception ? "exception expired" : "not reviewed" });
    continue;
  }
  console.warn(
    `ALLOW ${finding.severity} ${finding.id} (${finding.packageName}) until ${exception.expires}: ` +
      exception.reason,
  );
}

if (unresolved.length > 0) {
  console.error(
    `High/critical findings could not be resolved to advisories: ${unresolved.join(", ")}`,
  );
}
for (const finding of blocked) {
  console.error(
    `BLOCK ${finding.severity} ${finding.id} (${finding.packageName}): ${finding.title} ` +
      `[${finding.reason}] ${finding.url ?? ""}`,
  );
}

if (unresolved.length > 0 || blocked.length > 0) process.exit(1);

console.log(
  findings.size === 0
    ? "Production audit: no high or critical vulnerabilities."
    : `Production audit: ${findings.size} reviewed high/critical advisories; no new findings.`,
);
