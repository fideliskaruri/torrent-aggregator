import assert from "node:assert/strict";
import { ApiBayAdapter } from "./apibay";

const originalFetch = globalThis.fetch;
let failures = 0;

function row(category: string, index: number) {
  return {
    id: String(index + 1),
    name: `Fixture ${category} ${index}`,
    info_hash: String(index + 1).padStart(40, "0"),
    seeders: "30",
    leechers: "2",
    size: "1000000000",
    category,
  };
}

const categories = [
  "101", "201", "202", "203", "204", "205", "206", "207", "208",
  "209", "210", "211", "212", "299", "501", "507", "",
];
const rows = categories.map(row);

function stubRows() {
  const requests: URL[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    requests.push(url);
    const category = url.searchParams.get("cat");
    return Response.json(
      category === "0" ? rows : rows.filter((r) => r.category === category),
    );
  };
  return requests;
}

async function check(name: string, test: () => Promise<void>) {
  try {
    await test();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures++;
    console.error(`  FAIL ${name}: ${error instanceof Error ? error.message : error}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function main() {
  await check("TV includes SD, HD and UHD without unrelated video categories", async () => {
    const requests = stubRows();
    const results = await new ApiBayAdapter().search({ query: "Fixture", category: "tv" });
    assert.deepEqual(results.map((r) => r.category), ["205", "208", "212"]);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].searchParams.get("cat"), "0");
  });

  await check("movies include HD and UHD without TV, clips or adult categories", async () => {
    stubRows();
    const results = await new ApiBayAdapter().search({ query: "Fixture", category: "movies" });
    assert.deepEqual(results.map((r) => r.category), ["201", "202", "207", "209", "210", "211"]);
  });

  await check("scope filtering runs before the adapter result limit", async () => {
    stubRows();
    const results = await new ApiBayAdapter().search({ query: "Fixture", category: "tv", limit: 2 });
    assert.deepEqual(results.map((r) => r.category), ["205", "208"]);
    assert.ok(results.every((r) => r.magnet?.includes(r.infoHash ?? "missing")));
  });

  await check("non-video category routing is unchanged", async () => {
    const requests = stubRows();
    const results = await new ApiBayAdapter().search({ query: "Fixture", category: "music" });
    assert.equal(requests[0].searchParams.get("cat"), "101");
    assert.deepEqual(results.map((r) => r.category), ["101"]);
  });

  await check("all-category and anime searches retain their broad scope", async () => {
    stubRows();
    for (const category of ["all", "anime"] as const) {
      const results = await new ApiBayAdapter().search({ query: "Fixture", category });
      assert.equal(results.length, rows.length);
    }
  });

  await check("empty queries do not contact the indexer", async () => {
    const requests = stubRows();
    assert.deepEqual(await new ApiBayAdapter().search({ query: "  ", category: "tv" }), []);
    assert.equal(requests.length, 0);
  });

  await check("provider failures are not reported as empty results", async () => {
    globalThis.fetch = async () => new Response("Unavailable", { status: 503 });
    await assert.rejects(
      () => new ApiBayAdapter().search({ query: "Fixture", category: "tv" }),
      /apibay HTTP 503/,
    );
  });

  if (failures) process.exitCode = 1;
}

void main();
