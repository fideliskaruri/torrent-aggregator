/**
 * Seeds a realistic library so screenshots and manual QA show populated
 * states, not just empty ones. Safe to re-run: watchlist upserts by
 * (mediaType, externalId) and rules are matched by name.
 *
 * Usage: node scripts/seed-demo.mjs [baseUrl]
 */
const BASE = process.argv[2] || "http://127.0.0.1:3000";

const SHOWS = [
  {
    mediaType: "anime",
    externalId: "seed-one-piece",
    title: "One Piece",
    fromSeason: 21,
    fromEpisode: 1085,
    monitorMode: "ongoing",
  },
  {
    mediaType: "tv",
    externalId: "seed-severance",
    title: "Severance",
    fromSeason: 2,
    fromEpisode: 1,
    monitorMode: "ongoing",
  },
  {
    mediaType: "tv",
    externalId: "seed-the-bear",
    title: "The Bear",
    fromSeason: 3,
    fromEpisode: 1,
    monitorMode: "ongoing",
  },
  {
    mediaType: "anime",
    externalId: "seed-frieren",
    title: "Frieren Beyond Journey's End",
    fromSeason: 1,
    fromEpisode: 1,
    monitorMode: "backfill",
  },
  {
    mediaType: "movie",
    externalId: "seed-dune-two",
    title: "Dune Part Two",
  },
];

const RULES = [
  {
    name: "4K movies, well seeded",
    query: "2160p",
    category: "movies",
    minSeeders: 20,
    resolution: "2160p",
    maxSizeBytes: 20_000_000_000,
    enabled: true,
  },
  {
    name: "Weekly anime, 1080p",
    query: "1080p",
    category: "anime",
    minSeeders: 10,
    resolution: "1080p",
    enabled: true,
  },
  {
    name: "Archived rule (disabled)",
    query: "720p",
    category: "tv",
    minSeeders: 5,
    enabled: false,
  },
];

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text };
}

async function main() {
  console.log(`Seeding ${BASE}\n`);

  for (const show of SHOWS) {
    const r = await post("/api/watchlist", show);
    console.log(`  ${r.status === 200 ? "ok " : "ERR"} watchlist: ${show.title}`);
  }

  const existing = await (await fetch(`${BASE}/api/rules`)).json();
  const names = new Set((existing.rules ?? []).map((r) => r.name));
  for (const rule of RULES) {
    if (names.has(rule.name)) {
      console.log(`  ok  rule exists: ${rule.name}`);
      continue;
    }
    const r = await post("/api/rules", rule);
    console.log(`  ${r.status === 200 ? "ok " : "ERR"} rule: ${rule.name}`);
  }

  const wl = await (await fetch(`${BASE}/api/watchlist`)).json();
  const rl = await (await fetch(`${BASE}/api/rules`)).json();
  console.log(
    `\nLibrary now has ${wl.items?.length ?? 0} items and ${rl.rules?.length ?? 0} rules.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
