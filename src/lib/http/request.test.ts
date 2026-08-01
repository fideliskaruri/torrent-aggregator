import assert from "node:assert/strict";
import {
  booleanField,
  enumField,
  guardBrowserMutation,
  numberField,
  queryNumber,
  readJson,
  readMutationObject,
  stringArrayField,
  stringField,
} from "./request";

async function main() {
  const bodyCases: Array<{
    name: string;
    request: Request;
    status?: number;
  }> = [
    {
      name: "valid JSON object",
      request: new Request("http://127.0.0.1/api/x", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"name":"ok"}',
      }),
    },
    {
      name: "wrong media type",
      request: new Request("http://127.0.0.1/api/x", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "{}",
      }),
      status: 415,
    },
    {
      name: "malformed JSON",
      request: new Request("http://127.0.0.1/api/x", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
      status: 400,
    },
    {
      name: "oversized body",
      request: new Request("http://127.0.0.1/api/x", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: "x".repeat(200) }),
      }),
      status: 413,
    },
  ];

  for (const item of bodyCases) {
    const result = await readJson(item.request, 100);
    assert.equal(
      result.ok ? undefined : result.status,
      item.status,
      item.name,
    );
  }

  const origins = [
    { site: null, origin: null, ok: true, name: "curl without Fetch Metadata" },
    { site: "same-origin", origin: "http://proxy.invalid", ok: true, name: "reverse proxy same-origin" },
    { site: "cross-site", origin: "https://evil.invalid", ok: false, name: "cross-site browser" },
    { site: "same-site", origin: "http://127.0.0.1", ok: true, name: "same-site exact origin" },
    { site: "same-site", origin: "http://localhost", ok: false, name: "same-site different origin" },
  ] as const;
  for (const item of origins) {
    const headers = new Headers({ "content-type": "application/json" });
    if (item.site) headers.set("sec-fetch-site", item.site);
    if (item.origin) headers.set("origin", item.origin);
    const request = new Request("http://127.0.0.1/api/x", {
      method: "POST",
      headers,
      body: "{}",
    });
    assert.equal(guardBrowserMutation(request).ok, item.ok, item.name);
  }

  const parsed = await readMutationObject(
    new Request("http://127.0.0.1/api/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "  Dune  ",
        count: 3,
        enabled: false,
        mode: "keep",
        tags: [" movie ", "1080p"],
      }),
    }),
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("unreachable");
  const fields = parsed.value;
  assert.deepEqual(stringField(fields, "title", { required: true, maxLength: 20 }), {
    ok: true,
    value: "Dune",
  });
  assert.deepEqual(numberField(fields, "count", { integer: true, min: 1, max: 5 }), {
    ok: true,
    value: 3,
  });
  assert.deepEqual(booleanField(fields, "enabled"), { ok: true, value: false });
  assert.deepEqual(enumField(fields, "mode", ["stream", "keep"] as const), {
    ok: true,
    value: "keep",
  });
  assert.deepEqual(stringArrayField(fields, "tags", { maxItems: 3 }), {
    ok: true,
    value: ["movie", "1080p"],
  });

  const queryCases = [
    ["1", true],
    ["1.5", false],
    ["1oops", false],
    ["0", false],
    ["201", false],
  ] as const;
  for (const [raw, ok] of queryCases) {
    const params = new URLSearchParams({ page: raw });
    assert.equal(
      queryNumber(params, "page", { integer: true, min: 1, max: 200 }).ok,
      ok,
      `page=${raw}`,
    );
  }

  console.log("request.test.ts: all assertions passed");
}

void main();
