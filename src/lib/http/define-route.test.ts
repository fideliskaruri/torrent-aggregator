/**
 * `defineRoute` owns the cross-cutting preamble, so these assertions pin the
 * exact contract routes now depend on: the canonical superset error envelope,
 * status codes preserved, the browser mutation guard enforced for bodies, typed
 * body/query reaching the handler, and thrown ApiErrors mapped to their status.
 *
 * Run: npx tsx src/lib/http/define-route.test.ts
 */
import assert from "node:assert/strict";
import { ApiError, defineRoute } from "./define-route";
import { f, q } from "./schema";

let failures = 0;

async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err instanceof Error ? err.message : String(err)}`);
  }
}

function jsonRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://127.0.0.1:3000/api/test", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function main() {
  console.log("define-route.test.ts");

  await check("valid body reaches the handler typed; object result is 200 JSON", async () => {
    const route = defineRoute({
      body: {
        season: f.number({ required: true, integer: true, min: 1 }),
        retention: f.enum(["stream", "keep"] as const),
      },
    })(({ body }) => ({ ok: true, season: body.season, retention: body.retention }));
    const res = await route(jsonRequest({ season: 3, retention: "keep" }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, season: 3, retention: "keep" });
  });

  await check("validation failure returns the superset envelope with field + 400", async () => {
    const route = defineRoute({
      body: { season: f.number({ required: true, min: 1 }) },
    })(() => ({ ok: true }));
    const res = await route(jsonRequest({ season: 0 }));
    assert.equal(res.status, 400);
    const body = (await res.json()) as Record<string, unknown>;
    // Superset of both historical shapes: ok:false AND error AND message AND field.
    assert.equal(body.ok, false);
    assert.equal(typeof body.error, "string");
    assert.equal(typeof body.message, "string");
    assert.equal(body.field, "season");
  });

  await check("a thrown ApiError maps to its status and envelope", async () => {
    const route = defineRoute({
      body: { season: f.number({ required: true }) },
    })(() => {
      throw new ApiError(404, "Not found", "Library item not found");
    });
    const res = await route(jsonRequest({ season: 1 }));
    assert.equal(res.status, 404);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.ok, false);
    assert.equal(body.error, "Not found");
    assert.equal(body.message, "Library item not found");
  });

  await check("an unexpected throw becomes a 500 envelope", async () => {
    const route = defineRoute({})(() => {
      throw new Error("boom");
    });
    const res = await route(new Request("http://127.0.0.1:3000/api/test", { method: "POST" }));
    assert.equal(res.status, 500);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.ok, false);
    assert.equal(body.message, "boom");
  });

  await check("a handler-returned Response passes through with its own status", async () => {
    const route = defineRoute({
      body: { season: f.number({ required: true }) },
    })(() => Response.json({ ok: false, storage: true }, { status: 507 }));
    const res = await route(jsonRequest({ season: 1 }));
    assert.equal(res.status, 507);
    assert.deepEqual(await res.json(), { ok: false, storage: true });
  });

  await check("cross-site browser mutation is refused with 403", async () => {
    const route = defineRoute({
      body: { season: f.number({ required: true }) },
    })(() => ({ ok: true }));
    const res = await route(jsonRequest({ season: 1 }, { "sec-fetch-site": "cross-site" }));
    assert.equal(res.status, 403);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.ok, false);
  });

  await check("same-origin browser mutation is allowed", async () => {
    const route = defineRoute({
      body: { season: f.number({ required: true }) },
    })(({ body }) => ({ ok: true, season: body.season }));
    const res = await route(jsonRequest({ season: 9 }, { "sec-fetch-site": "same-origin" }));
    assert.equal(res.status, 200);
  });

  await check("query schema parses into the handler", async () => {
    const route = defineRoute({
      query: { q: q.string({ required: true }), limit: q.number({ min: 1, max: 50 }) },
    })(({ query }) => ({ ok: true, q: query.q, limit: query.limit }));
    const res = await route(new Request("http://127.0.0.1:3000/api/test?q=dune&limit=5"));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, q: "dune", limit: 5 });
  });

  await check("route params are awaited and passed through", async () => {
    const route = defineRoute({})<{ workKey: string }>(({ params }) => ({
      ok: true,
      workKey: params.workKey,
    }));
    const res = await route(new Request("http://127.0.0.1:3000/api/test"), {
      params: Promise.resolve({ workKey: "dune-2021" }),
    });
    assert.deepEqual(await res.json(), { ok: true, workKey: "dune-2021" });
  });

  await check("body-less mutation:true refuses a cross-site browser request", async () => {
    const route = defineRoute({ mutation: true })(() => ({ ok: true }));
    const res = await route(
      new Request("http://127.0.0.1:3000/api/test", {
        method: "DELETE",
        headers: { "sec-fetch-site": "cross-site" },
      }),
    );
    assert.equal(res.status, 403);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.ok, false);
  });

  await check("body-less mutation:true allows a same-origin request", async () => {
    const route = defineRoute({ mutation: true })(() => ({ ok: true, done: 1 }));
    const res = await route(
      new Request("http://127.0.0.1:3000/api/test", {
        method: "DELETE",
        headers: { "sec-fetch-site": "same-origin" },
      }),
    );
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, done: 1 });
  });

  await check("a null/undefined handler result becomes a 204, not a 500", async () => {
    const route = defineRoute({})(() => undefined as unknown as object);
    const res = await route(new Request("http://127.0.0.1:3000/api/test"));
    assert.equal(res.status, 204);
    assert.equal(await res.text(), "");
  });

  await check("extra fields on an error can never clobber the envelope contract", async () => {
    const route = defineRoute({})(() => {
      // A handler that (wrongly) tries to smuggle ok:true / a different error
      // into the envelope must not win over the canonical keys.
      throw new ApiError(409, "Conflict", "Conflict", {
        ok: true,
        error: "spoofed",
        field: "name",
      });
    });
    const res = await route(new Request("http://127.0.0.1:3000/api/test"));
    assert.equal(res.status, 409);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.ok, false);
    assert.equal(body.error, "Conflict");
    assert.equal(body.field, "name");
  });

  if (failures > 0) {
    console.error(`define-route.test.ts: ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("define-route.test.ts: all assertions passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


