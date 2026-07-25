/**
 * API smoke suite — exercises every route against a running dev server.
 *
 * Run: node scripts/api-smoke.mjs [baseUrl]
 *
 * These are contract checks, not mocks: each route must answer with a sane
 * status and a body of the documented shape. Network-dependent routes (search,
 * suggest) accept degraded-but-valid responses so a blocked indexer does not
 * fail the suite, but they must still return well-formed JSON.
 */
const BASE = process.argv[2] || process.env.TF_BASE_URL || "http://localhost:3000";

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function req(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, json, text };
}

function isJson(r) {
  return r.json !== null && typeof r.json === "object";
}

async function main() {
  console.log(`API smoke against ${BASE}\n`);

  // --- Pages must render (no auth wall) -----------------------------------
  console.log("pages:");
  for (const p of [
    "/",
    "/search?q=test",
    "/watchlist",
    "/activity",
    "/client",
    "/history",
    "/rules",
    "/settings",
    "/about",
  ]) {
    const res = await fetch(`${BASE}${p}`);
    check(`GET ${p} renders`, res.status === 200, `status ${res.status}`);
  }

  // --- Auth is gone: the login page and nextauth route must be 404 --------
  console.log("\nauth removed:");
  const login = await fetch(`${BASE}/login`);
  check("GET /login is gone", login.status === 404, `status ${login.status}`);
  const nextauth = await fetch(`${BASE}/api/auth/session`);
  check(
    "GET /api/auth/session is gone",
    nextauth.status === 404,
    `status ${nextauth.status}`,
  );

  // --- Read routes reachable without signing in ---------------------------
  console.log("\nread routes:");
  const activity = await req("GET", "/api/activity");
  check("GET /api/activity 200", activity.status === 200, `status ${activity.status}`);
  check("  returns items[]", Array.isArray(activity.json?.items));

  const history = await req("GET", "/api/history");
  check("GET /api/history 200", history.status === 200, `status ${history.status}`);
  check("  returns items[]", Array.isArray(history.json?.items));

  const watchlist = await req("GET", "/api/watchlist");
  check("GET /api/watchlist 200", watchlist.status === 200, `status ${watchlist.status}`);
  check("  returns items[]", Array.isArray(watchlist.json?.items));

  const rules = await req("GET", "/api/rules");
  check("GET /api/rules 200", rules.status === 200, `status ${rules.status}`);
  check("  returns rules[]", Array.isArray(rules.json?.rules));

  const settings = await req("GET", "/api/settings/client");
  check(
    "GET /api/settings/client 200",
    settings.status === 200,
    `status ${settings.status}`,
  );
  check("  returns settings", Boolean(settings.json?.settings));
  check(
    "  password never leaves the server",
    settings.json?.settings != null &&
      !("password" in settings.json.settings) &&
      typeof settings.json.settings.hasPassword === "boolean",
  );
  check(
    "  returns defaults for first-run",
    Boolean(settings.json?.defaults?.baseDownloadPath),
  );

  const torrents = await req("GET", "/api/client/torrents");
  check(
    "GET /api/client/torrents answers",
    [200, 503].includes(torrents.status),
    `status ${torrents.status}`,
  );
  check("  json body", isJson(torrents));

  const estimate = await req("GET", "/api/library/backfill-estimate?id=none");
  check(
    "GET /api/library/backfill-estimate answers",
    estimate.status < 500,
    `status ${estimate.status}`,
  );

  // --- Search / suggest: must be well-formed even when indexers are blocked
  console.log("\nsearch:");
  const search = await req("GET", "/api/search?q=big+buck+bunny&pageSize=5");
  check("GET /api/search 200", search.status === 200, `status ${search.status}`);
  check("  results[]", Array.isArray(search.json?.results));
  check("  per-source status[]", Array.isArray(search.json?.sources));
  check("  paginated", typeof search.json?.totalPages === "number");
  if (Array.isArray(search.json?.sources)) {
    const shaped = search.json.sources.every(
      (s) => typeof s.id === "string" && typeof s.count === "number",
    );
    check("  each source reports id+count", shaped);
    const up = search.json.sources.filter((s) => !s.error).map((s) => s.id);
    const down = search.json.sources.filter((s) => s.error).map((s) => s.id);
    check("  a failing source degrades, never 500s", search.status === 200);
    console.log(`        up: ${up.join(", ") || "(none)"}`);
    console.log(`        down: ${down.join(", ") || "(none)"}`);
  }
  check(
    "  advertises available sources",
    Array.isArray(search.json?.availableSources),
  );

  const suggest = await req("GET", "/api/suggest?q=one+piece");
  check("GET /api/suggest answers", suggest.status < 500, `status ${suggest.status}`);

  // --- Empty/invalid input must be rejected cleanly, never 500 ------------
  console.log("\ninput validation (never 500):");
  const badSearch = await req("GET", "/api/search?q=");
  check(
    "GET /api/search with empty q",
    badSearch.status < 500,
    `status ${badSearch.status}`,
  );

  const badSend = await req("POST", "/api/torrent/send", {});
  check(
    "POST /api/torrent/send with empty body",
    badSend.status >= 400 && badSend.status < 500,
    `status ${badSend.status}`,
  );
  check("  explains the problem", typeof badSend.json?.error === "string");

  const badWatch = await req("POST", "/api/watchlist", {});
  check(
    "POST /api/watchlist with empty body",
    badWatch.status >= 400 && badWatch.status < 500,
    `status ${badWatch.status}`,
  );

  const badRule = await req("POST", "/api/rules", {});
  check(
    "POST /api/rules with empty body",
    badRule.status >= 400 && badRule.status < 500,
    `status ${badRule.status}`,
  );

  // --- Watchlist write path: add, read back, delete -----------------------
  console.log("\nwatchlist round-trip:");
  const created = await req("POST", "/api/watchlist", {
    mediaType: "tv",
    externalId: `smoke-${Date.now()}`,
    title: "Smoke Test Show",
    fromSeason: 2,
    fromEpisode: 4,
  });
  check(
    "POST /api/watchlist creates",
    created.status === 200,
    `status ${created.status} ${created.text.slice(0, 160)}`,
  );
  const item = created.json?.item;
  check("  returns the item", Boolean(item?.id));
  check(
    "  seeds cursor from fromSeason/fromEpisode",
    item?.cursorSeason === 2 && item?.cursorEpisode === 4,
    `cursor=S${item?.cursorSeason}E${item?.cursorEpisode}`,
  );
  check(
    "  derives a search hint for the next episode",
    typeof item?.nextEpisodeHint === "string" &&
      /S02E04/i.test(item.nextEpisodeHint),
    `hint=${item?.nextEpisodeHint}`,
  );
  check(
    "  starts with zero recorded misses",
    item?.cursorMisses === 0,
    `cursorMisses=${item?.cursorMisses}`,
  );

  if (item?.id) {
    const after = await req("GET", "/api/watchlist");
    const found = (after.json?.items ?? []).find((i) => i.id === item.id);
    check("  readable back", Boolean(found));

    const patched = await req("PATCH", "/api/watchlist", {
      id: item.id,
      cursorSeason: 3,
      cursorEpisode: 1,
    });
    check(
      "PATCH /api/watchlist moves the cursor",
      patched.status === 200 && patched.json?.item?.cursorSeason === 3,
      `status ${patched.status} cursorSeason=${patched.json?.item?.cursorSeason}`,
    );

    const checkRes = await req("POST", "/api/watchlist/check", { id: item.id });
    check(
      "POST /api/watchlist/check answers",
      checkRes.status < 500,
      `status ${checkRes.status}`,
    );

    const del = await req("DELETE", `/api/watchlist?id=${item.id}`);
    check("DELETE /api/watchlist removes", del.status === 200, `status ${del.status}`);
    const gone = await req("GET", "/api/watchlist");
    check(
      "  really gone",
      !(gone.json?.items ?? []).some((i) => i.id === item.id),
    );
  }

  // --- Rules write path ---------------------------------------------------
  console.log("\nrules round-trip:");
  const rule = await req("POST", "/api/rules", {
    name: `smoke-${Date.now()}`,
    query: "big buck bunny",
    minSeeders: 5,
  });
  check("POST /api/rules creates", rule.status === 200, `status ${rule.status}`);
  const ruleId = rule.json?.rule?.id;
  check("  returns the rule", Boolean(ruleId));
  check(
    "  maxSizeBytes is JSON-safe (not BigInt)",
    rule.status !== 500,
    "BigInt serialisation would 500 here",
  );
  if (ruleId) {
    const toggled = await req("PATCH", "/api/rules", { id: ruleId, enabled: false });
    check(
      "PATCH /api/rules disables",
      toggled.status === 200 && toggled.json?.rule?.enabled === false,
      `status ${toggled.status}`,
    );
    const delRule = await req("DELETE", `/api/rules?id=${ruleId}`);
    check("DELETE /api/rules removes", delRule.status === 200, `status ${delRule.status}`);
  }
  const missingRule = await req("PATCH", "/api/rules", { id: "does-not-exist" });
  check(
    "PATCH unknown rule is 404 not 500",
    missingRule.status === 404,
    `status ${missingRule.status}`,
  );

  // --- Automation run: must answer, and must be concurrency-safe ----------
  console.log("\nautomation:");
  const run = await req("POST", "/api/automation/run", {});
  check(
    "POST /api/automation/run answers",
    run.status < 500,
    `status ${run.status} ${run.text.slice(0, 160)}`,
  );
  check("  json body", isJson(run));

  const [a, b] = await Promise.all([
    req("POST", "/api/automation/run", {}),
    req("POST", "/api/automation/run", {}),
  ]);
  check(
    "  two concurrent runs both answer without 500",
    a.status < 500 && b.status < 500,
    `${a.status}/${b.status}`,
  );
  const locked = [a, b].filter(
    (r) => r.status === 409 || r.json?.skipped || r.json?.alreadyRunning,
  );
  console.log(
    `        run-lock rejected ${locked.length} of 2 concurrent runs`,
  );

  const rulesRun = await req("POST", "/api/rules/run", {});
  check(
    "POST /api/rules/run answers",
    rulesRun.status < 500,
    `status ${rulesRun.status}`,
  );

  const ondemand = await req("POST", "/api/library/ondemand", {});
  check(
    "POST /api/library/ondemand rejects empty body cleanly",
    ondemand.status >= 400 && ondemand.status < 500,
    `status ${ondemand.status}`,
  );

  // --- Folder browsing ----------------------------------------------------
  console.log("\nsettings folders:");
  const browse = await req("POST", "/api/settings/browse-folders", { path: "" });
  check(
    "POST /api/settings/browse-folders answers",
    browse.status < 500,
    `status ${browse.status}`,
  );
  const openDefault = await req("POST", "/api/settings/open-folder", {
    reveal: false,
  });
  check(
    "POST /api/settings/open-folder resolves the default folder",
    openDefault.status < 500,
    `status ${openDefault.status}`,
  );
  const escape = await req("POST", "/api/settings/open-folder", {
    path: process.platform === "win32" ? "C:\\Windows" : "/etc",
    reveal: false,
  });
  check(
    "  refuses a path outside the library",
    escape.status === 403,
    `status ${escape.status} ${escape.text.slice(0, 120)}`,
  );
  const traversal = await req("POST", "/api/settings/open-folder", {
    path:
      process.platform === "win32"
        ? "C:\\Users\\Public\\..\\..\\Windows"
        : "/tmp/../etc",
    reveal: false,
  });
  check(
    "  refuses traversal out of the library",
    traversal.status === 403,
    `status ${traversal.status}`,
  );

  console.log(
    `\n${failed === 0 ? "OK" : "FAILURES"} — ${passed} passed, ${failed} failed`,
  );
  if (failures.length) {
    console.log("\nFailed checks:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("smoke suite crashed:", err);
  process.exit(1);
});
