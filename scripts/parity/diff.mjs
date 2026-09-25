const kind = (v) => v === null ? "null" : Array.isArray(v) ? "array" : typeof v;

export function structuralDiff(expected, actual, pointer = "$", differences = []) {
  const left = kind(expected), right = kind(actual);
  if (left !== right) differences.push({ path: pointer, kind: "type", expected: left, actual: right });
  else if (left === "object") {
    for (const key of Object.keys(expected)) {
      if (!Object.hasOwn(actual, key)) differences.push({ path: `${pointer}.${key}`, kind: "missing", expected: expected[key] });
      else structuralDiff(expected[key], actual[key], `${pointer}.${key}`, differences);
    }
    for (const key of Object.keys(actual)) {
      if (!Object.hasOwn(expected, key)) differences.push({ path: `${pointer}.${key}`, kind: "extra", actual: actual[key] });
    }
  } else if (left === "array") {
    for (let i = 0; i < Math.max(expected.length, actual.length); i++) {
      if (i >= actual.length) differences.push({ path: `${pointer}[${i}]`, kind: "missing", expected: expected[i] });
      else if (i >= expected.length) differences.push({ path: `${pointer}[${i}]`, kind: "extra", actual: actual[i] });
      else structuralDiff(expected[i], actual[i], `${pointer}[${i}]`, differences);
    }
  } else if (!Object.is(expected, actual)) differences.push({ path: pointer, kind: "value", expected, actual });
  return differences;
}

export function compare(c, next, dotnet) {
  if (next.error || dotnet.error) return { outcome: "error", statusMatch: false, headers: {}, differences: [], next, dotnet };
  const headers = Object.fromEntries(["content-type", "cache-control"].map((key) => [
    key, { expected: next.headers[key], actual: dotnet.headers[key], match: next.headers[key] === dotnet.headers[key] },
  ]));
  const differences = structuralDiff(c.normalizer(next.body), c.normalizer(dotnet.body));
  const statusMatch = next.status === dotnet.status;
  // An application-level JSON 404 is implemented behaviour, not an absent route.
  const missing = dotnet.status === 404 && dotnet.body === "" && !dotnet.headers["content-type"];
  const outcome = missing ? "not ported"
    : statusMatch && Object.values(headers).every((h) => h.match) && !differences.length ? "pass" : "fail";
  return { outcome, statusMatch, headers, differences, next, dotnet };
}

export function markdown(report) {
  const counts = {};
  for (const r of report.results) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
  const lines = [
    "# API parity report", "", `Run: ${report.generatedAt}`, "",
    `Discovered GET routes: ${report.routes.length}; selected cases: ${report.results.length}.`,
    "", "| Outcome | Cases |", "| --- | ---: |",
    ...["pass", "fail", "not ported", "error"].map((k) => `| ${k} | ${counts[k] ?? 0} |`),
    "", "| Request | Case | Next | .NET | Status | Headers | JSON diffs | Outcome |",
    "| --- | --- | ---: | ---: | --- | --- | ---: | --- |",
    ...report.results.map((r) => `| ${r.method} ${r.route} | ${r.label} | ${r.next.status ?? "error"} | ${r.dotnet.status ?? "error"} | ${r.statusMatch ? "match" : "diff"} | ${Object.values(r.headers).every((h) => h.match) ? "match" : "diff"} | ${r.differences.length} | ${r.outcome} |`),
    "", "## Details", "",
  ];
  for (const r of report.results.filter((r) => r.outcome === "fail" || r.outcome === "error")) {
    lines.push(`### ${r.method} ${r.path}`, "", "```json",
      JSON.stringify({ headers: r.headers, errors: [r.next.error, r.dotnet.error].filter(Boolean), differences: r.differences.slice(0, 20) }, null, 2),
      "```", "");
  }
  lines.push("Full responses and all differences are in report.json. Reports contain local library data; do not commit them.", "");
  return lines.join("\n");
}
