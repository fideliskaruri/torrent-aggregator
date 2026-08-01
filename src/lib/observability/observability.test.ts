import assert from "node:assert/strict";
import {
  ComponentHealthStore,
  HEALTH_COMPONENTS,
} from "./health";
import {
  CORRELATION_HEADER,
  correlationIdFromRequest,
  normalizeError,
  sanitizeLogFields,
} from "./logging";
import {
  buildDiagnosticsHealthResponse,
  buildPublicHealthResponse,
} from "./responses";
import { checkDatabaseReadiness } from "./readiness";

let failures = 0;

async function check(name: string, run: () => void | Promise<void>) {
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}`);
    console.error(error instanceof Error ? error.stack : error);
  }
}

async function redactionCases() {
  const secret = "do-not-log-this";
  const cases: Array<{
    name: string;
    fields: Record<string, unknown>;
    expected: Record<string, unknown>;
  }> = [
    {
      name: "credential, body, identity, and media keys are omitted",
      fields: {
        count: 4,
        password: secret,
        authorization: secret,
        requestBody: secret,
        userId: secret,
        title: secret,
        infoHash: secret,
        filePath: `C:\\media\\${secret}`,
      },
      expected: { count: 4 },
    },
    {
      name: "unsafe strings in allowed fields are redacted",
      fields: {
        action: `C:\\private\\${secret}`,
        clientType: "builtin",
        offline: false,
      },
      expected: {
        action: "[redacted]",
        clientType: "builtin",
        offline: false,
      },
    },
    {
      name: "non-finite numbers and nested values are omitted",
      fields: {
        count: Number.POSITIVE_INFINITY,
        status: { raw: secret },
        limit: 12,
      },
      expected: { limit: 12 },
    },
    {
      name: "hash-shaped values are redacted even under an allowed key",
      fields: {
        status: "0123456789abcdef0123456789abcdef01234567",
      },
      expected: { status: "[redacted]" },
    },
  ];

  for (const item of cases) {
    const actual = sanitizeLogFields(item.fields);
    assert.deepEqual(actual, item.expected, item.name);
    assert.doesNotMatch(JSON.stringify(actual), new RegExp(secret), item.name);
  }

  const normalized = normalizeError(
    new Error(`ECONNREFUSED https://user:${secret}@private.invalid/C:\\media`),
  );
  assert.equal(normalized.code, "UPSTREAM_UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify(normalized), new RegExp(secret));
  assert.equal("stack" in normalized, false);
}

async function correlationCases() {
  const cases = [
    {
      name: "accepts a bounded safe correlation ID",
      value: "request-ABC_1234",
      accepted: true,
    },
    {
      name: "rejects a path-shaped ID",
      value: "C:\\private\\movie.mkv",
      accepted: false,
    },
    {
      name: "rejects an ID containing spaces",
      value: "request secret",
      accepted: false,
    },
    {
      name: "rejects an oversized ID",
      value: "a".repeat(65),
      accepted: false,
    },
    {
      name: "rejects a torrent hash shaped ID",
      value: "0123456789abcdef0123456789abcdef01234567",
      accepted: false,
    },
    {
      name: "rejects a too-short ID",
      value: "short",
      accepted: false,
    },
  ] as const;

  for (const item of cases) {
    const request = new Request("http://127.0.0.1/api/test", {
      headers: { [CORRELATION_HEADER]: item.value },
    });
    const actual = correlationIdFromRequest(request);
    if (item.accepted) {
      assert.equal(actual, item.value, item.name);
    } else {
      assert.notEqual(actual, item.value, item.name);
      assert.match(
        actual,
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        item.name,
      );
    }
  }
}

async function boundedHealthCases() {
  let second = 0;
  const store = new ComponentHealthStore(
    3,
    () => new Date(Date.UTC(2026, 0, 1, 0, 0, second++)),
  );
  const outcomes = [
    ["success", "TITLE_SEARCH_SUCCEEDED"],
    ["failure", "TITLE_SEARCH_FAILED"],
    ["degraded", "TITLE_SEARCH_FAILED"],
    ["success", "TITLE_SEARCH_SUCCEEDED"],
    ["failure", "TITLE_SEARCH_FAILED"],
  ] as const;
  for (const [outcome, code] of outcomes) {
    assert.equal(store.record("title-search", outcome, code), true);
  }

  assert.equal(
    store.record("arbitrary-component", "success", "TITLE_SEARCH_SUCCEEDED"),
    false,
    "unknown components must never allocate state",
  );
  assert.equal(
    store.record("title-search", "success", "TITLE_CONTAINS_MEDIA_DATA"),
    false,
    "unknown event codes must never enter the ring",
  );

  const snapshot = store.snapshot();
  assert.equal(snapshot.length, HEALTH_COMPONENTS.length);
  const search = snapshot.find((item) => item.component === "title-search");
  assert.ok(search);
  assert.deepEqual(
    {
      total: search.total,
      successes: search.successes,
      degraded: search.degraded,
      failures: search.failures,
      retained: search.events.length,
    },
    { total: 5, successes: 2, degraded: 1, failures: 2, retained: 3 },
  );
  assert.deepEqual(
    search.events.map((event) => event.code),
    ["TITLE_SEARCH_FAILED", "TITLE_SEARCH_SUCCEEDED", "TITLE_SEARCH_FAILED"],
    "the ring retains only the newest bounded events",
  );
}

async function healthResponseCases() {
  const now = new Date("2026-08-01T04:51:30.402Z");
  const database = { ready: true, latencyMs: 7 };
  const publicBody = buildPublicHealthResponse(database, {
    now,
    uptimeSeconds: 123.9,
    buildId: "release-2026.08",
  });
  assert.deepEqual(publicBody, {
    status: "ok",
    live: true,
    ready: true,
    timestamp: now.toISOString(),
    process: { status: "up", uptimeSeconds: 123 },
    build: { id: "release-2026.08" },
    database: { status: "up", latencyMs: 7 },
  });

  const store = new ComponentHealthStore(2, () => now);
  store.record("database", "success", "DATABASE_READY");
  store.record("playback", "failure", "PLAYBACK_PLAN_FAILED");
  const diagnostics = buildDiagnosticsHealthResponse(
    database,
    store.snapshot(),
    {
      now,
      uptimeSeconds: 123,
      buildId: "C:\\private\\media-library",
    },
  );
  assert.equal(diagnostics.build.id, "unknown");
  assert.equal(diagnostics.components.length, HEALTH_COMPONENTS.length);

  const serialized = JSON.stringify({ publicBody, diagnostics }).toLowerCase();
  for (const forbidden of [
    "hostname",
    "filepath",
    "credential",
    "password",
    "authorization",
    "infohash",
    "torrenttitle",
    "userid",
    "librarydata",
    "c:\\\\private",
  ]) {
    assert.equal(
      serialized.includes(forbidden),
      false,
      `health responses must not contain ${forbidden}`,
    );
  }

}

async function databaseReadinessCases() {
  const ready = await checkDatabaseReadiness(async () => ({ id: null }));
  assert.equal(ready.ready, true);
  assert.ok(ready.latencyMs >= 0);

  const unavailable = await checkDatabaseReadiness(async () => {
    throw new Error("no such table: AcquisitionTarget");
  });
  assert.equal(unavailable.ready, false);
  assert.ok(unavailable.latencyMs >= 0);
}

async function main() {
  await check("structured log redaction and safe errors", redactionCases);
  await check("correlation ID validation and generation", correlationCases);
  await check("bounded allowlisted component health state", boundedHealthCases);
  await check("health response privacy and shape", healthResponseCases);
  await check(
    "database readiness requires an application schema query",
    databaseReadinessCases,
  );

  if (failures > 0) {
    console.error(`FAIL observability.test.ts: ${failures} group(s) failed`);
    process.exit(1);
  }
  console.log("PASS observability.test.ts: all groups passed");
}

void main();
