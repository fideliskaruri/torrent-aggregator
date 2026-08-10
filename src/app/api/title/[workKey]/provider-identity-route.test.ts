import assert from "node:assert/strict";
import type { AniListFormat, AniListWork } from "@/lib/metadata/anilist";
import { resolveTitleProviderIdentity } from "./provider-identity";

const cases = [
  { format: "MOVIE", isSeries: false, routeType: "movie" },
  { format: "TV", isSeries: true, routeType: "anime" },
  { format: "ONA", isSeries: true, routeType: "anime" },
  { format: "OVA", isSeries: true, routeType: "anime" },
] as const;

async function run() {
for (const row of cases) {
  const title = row.format === "MOVIE" ? "Your Name." : `Anime ${row.format}`;
  const year = row.format === "MOVIE" ? 2016 : 2020;
  const providerId = row.format === "MOVIE" ? "21519" : `10${year}`;
  const aliases = [`${title} Romaji`, `${title} Native`];
  const params = new URLSearchParams({
    t: title,
    y: String(year),
    type: row.routeType,
    provider: "anilist",
    providerId,
    sourceType: "anime",
    format: row.format,
    series: row.isSeries ? "1" : "0",
  });
  for (const alias of aliases) params.append("alias", alias);

  let requestedId: string | null = null;
  const answer = await resolveTitleProviderIdentity(
    params,
    row.format === "MOVIE" ? "your-name-2016" : `anime-${row.format.toLowerCase()}`,
    async (id): Promise<AniListWork | null> => {
      requestedId = id;
      return {
        metadata: {
          source: "anilist",
          mediaType: "anime",
          externalId: providerId,
          title,
          aliases,
          year,
        },
        format: row.format as AniListFormat,
        isSeries: row.isSeries,
        episodeCount: row.isSeries ? 12 : null,
      };
    },
  );

  assert.equal(requestedId, providerId);
  assert.equal(answer.kind, "verified");
  if (answer.kind !== "verified") continue;
  assert.equal(answer.identity.provider, "anilist");
  assert.equal(answer.identity.externalId, providerId);
  assert.equal(answer.identity.mediaType, "anime");
  assert.equal(answer.identity.format, row.format);
  assert.equal(answer.identity.isSeries, row.isSeries);
  assert.equal(answer.identity.verified, true);
  assert.deepEqual(answer.identity.metadata.aliases, aliases);
}
console.log("PASS AniList MOVIE/TV/ONA/OVA route identity table");

const mismatched = new URLSearchParams({
  t: "Your Name.",
  y: "2016",
  type: "movie",
  provider: "anilist",
  providerId: "21519",
  sourceType: "anime",
  format: "TV",
  series: "1",
});
const rejected = await resolveTitleProviderIdentity(
  mismatched,
  "your-name-2016",
  async () => ({
    metadata: {
      source: "anilist",
      mediaType: "anime",
      externalId: "21519",
      title: "Your Name.",
      aliases: ["Kimi no Na wa."],
      year: 2016,
    },
    format: "MOVIE",
    isSeries: false,
    episodeCount: 1,
  }),
);
assert.equal(rejected.kind, "invalid");
console.log("PASS client format/series hints cannot override provider identity");

const unavailableParams = new URLSearchParams({
  t: "Your Name.",
  y: "2016",
  type: "movie",
  provider: "anilist",
  providerId: "21519",
  sourceType: "anime",
  format: "MOVIE",
  series: "0",
});
unavailableParams.append("alias", "Kimi no Na wa.");

for (const lookup of [
  async (): Promise<AniListWork | null> => {
    throw new Error("provider timeout");
  },
  async (): Promise<AniListWork | null> => null,
]) {
  const degraded = await resolveTitleProviderIdentity(
    unavailableParams,
    "your-name-2016",
    lookup,
  );
  assert.equal(degraded.kind, "carried");
  if (degraded.kind !== "carried") continue;
  assert.equal(degraded.identity.verified, false);
  assert.equal(degraded.identity.isSeries, false);
  assert.equal(degraded.identity.metadata.title, "Your Name.");
  assert.equal(degraded.identity.externalId, "21519");
}
console.log("PASS AniList outage degrades to validated carried identity");
}

run().catch((error) => {
  console.error("FAIL provider identity route", error);
  process.exit(1);
});
