/**
 * A download may not be steered by what the client says the work is.
 *
 * `POST /api/title/[workKey]` re-verifies any claimed provider identity
 * against the provider itself before it may influence acquisition. Two
 * failures are guarded here: the honest case losing its verified aliases (an
 * anime searched under its English name only, which no indexer carries), and
 * the dishonest case — a forged or mismatched provider id — being obeyed.
 */
import assert from "node:assert/strict";

import type { AniListFormat, AniListWork } from "@/lib/metadata/anilist";
import { workKeyFor } from "@/components/title/work-key";
import {
  acquisitionIdentityParams,
  resolveAcquisitionIdentity,
} from "./acquisition-identity";
import { resolveTitleProviderIdentity } from "./provider-identity";

const SLIME_TITLE =
  "I've Been Killing Slimes for 300 Years and Maxed Out My Level";
const SLIME_ROMAJI =
  "Slime Taoshite 300-nen, Shiranai Uchi ni Level Max ni Nattemashita";
const SLIME_NATIVE =
  "スライム倒して300年、知らないうちにレベルMAXになってました";
const SLIME_KEY = workKeyFor(SLIME_TITLE); // a series key carries no year

function slimeWork(overrides: Partial<AniListWork> = {}): AniListWork {
  return {
    metadata: {
      source: "anilist",
      mediaType: "anime",
      externalId: "112608",
      title: SLIME_TITLE,
      aliases: [SLIME_TITLE, SLIME_ROMAJI, SLIME_NATIVE],
      year: 2021,
    },
    format: "TV" as AniListFormat,
    isSeries: true,
    episodeCount: 12,
    ...overrides,
  };
}

/** The real identity contract, with the network swapped for a fixture. */
function resolverFor(lookup: (id: string) => Promise<AniListWork | null>) {
  return (params: URLSearchParams, workKey: string) =>
    resolveTitleProviderIdentity(params, workKey, lookup);
}

const honestBody = {
  provider: "anilist",
  providerId: "112608",
  sourceType: "anime",
  format: "TV",
  title: SLIME_TITLE,
  year: 2021,
  season: 1,
  episode: 3,
};

async function main() {
  // --- shape hints are derived, never taken from the client ---------------
  const params = acquisitionIdentityParams(honestBody);
  assert.ok(params);
  assert.equal(params.get("type"), "anime");
  assert.equal(params.get("series"), "1");
  assert.deepEqual(
    params.getAll("alias"),
    [],
    "client-named aliases are never forwarded into verification",
  );
  assert.equal(
    acquisitionIdentityParams({
      ...honestBody,
      format: "MOVIE",
      // Extra shape hints a hand-written request might add are ignored
      // entirely: the shape is derived from the format and then checked
      // against what the provider reports.
      ...({ series: "1", type: "anime" } as Record<string, unknown>),
    })?.get("type"),
    "movie",
  );

  // --- the honest case keeps its verified aliases -------------------------
  let requestedId: string | null = null;
  const verified = await resolveAcquisitionIdentity(
    honestBody,
    SLIME_KEY,
    resolverFor(async (id) => {
      requestedId = id;
      return slimeWork();
    }),
  );
  assert.equal(requestedId, "112608", "the provider is actually re-queried");
  assert.equal(verified.kind, "verified");
  if (verified.kind !== "verified") return;
  assert.equal(verified.identity.provider, "anilist");
  assert.equal(verified.identity.externalId, "112608");
  assert.equal(verified.identity.episodeCount, 12);
  assert.deepEqual(
    verified.identity.metadata.aliases,
    [SLIME_TITLE, SLIME_ROMAJI, SLIME_NATIVE],
    "verified English/Romaji/native aliases survive to the episode search",
  );

  // --- forged and mismatched identities are refused ------------------------
  const forgeries: { name: string; body: Record<string, unknown>; work: AniListWork }[] = [
    {
      name: "a provider id that names a different show",
      body: honestBody,
      work: slimeWork({
        metadata: {
          source: "anilist",
          mediaType: "anime",
          externalId: "112608",
          title: "Solo Leveling",
          aliases: ["Ore dake Level Up na Ken"],
          year: 2024,
        },
      }),
    },
    {
      name: "a provider id that answers with a different id",
      body: honestBody,
      work: slimeWork({
        metadata: { ...slimeWork().metadata, externalId: "101280" },
      }),
    },
    {
      name: "a format the provider contradicts",
      body: { ...honestBody, format: "MOVIE" },
      work: slimeWork(),
    },
    {
      name: "a year the provider contradicts",
      body: { ...honestBody, year: 1999 },
      work: slimeWork(),
    },
  ];
  for (const forgery of forgeries) {
    const rejected = await resolveAcquisitionIdentity(
      forgery.body,
      SLIME_KEY,
      resolverFor(async () => forgery.work),
    );
    assert.equal(rejected.kind, "invalid", forgery.name);
  }

  // A work key pointing at another title is refused even with a real id.
  const wrongKey = await resolveAcquisitionIdentity(
    honestBody,
    workKeyFor("Solo Leveling"),
    resolverFor(async () => slimeWork()),
  );
  assert.equal(wrongKey.kind, "invalid", "the work key must name this work");

  // --- absent / unavailable both fall back to local resolution ------------
  assert.deepEqual(
    await resolveAcquisitionIdentity({ title: SLIME_TITLE }, SLIME_KEY),
    { kind: "absent" },
    "a body with no provider claim resolves ordinarily",
  );
  const outage = await resolveAcquisitionIdentity(
    honestBody,
    SLIME_KEY,
    resolverFor(async () => {
      throw new Error("provider timeout");
    }),
  );
  assert.deepEqual(
    outage,
    { kind: "absent" },
    "an unreachable provider verifies nothing, so the client's claim is dropped rather than trusted",
  );

  // --- Solo Leveling control: an ordinary honest identity still verifies ---
  const soloKey = workKeyFor("Solo Leveling");
  const solo = await resolveAcquisitionIdentity(
    {
      provider: "anilist",
      providerId: "151807",
      sourceType: "anime",
      format: "TV",
      title: "Solo Leveling",
      year: 2024,
    },
    soloKey,
    resolverFor(async () => ({
      metadata: {
        source: "anilist",
        mediaType: "anime",
        externalId: "151807",
        title: "Solo Leveling",
        aliases: ["Solo Leveling", "Ore dake Level Up na Ken", "俺だけレベルアップな件"],
        year: 2024,
      },
      format: "TV",
      isSeries: true,
      episodeCount: 12,
    })),
  );
  assert.equal(solo.kind, "verified");
  if (solo.kind !== "verified") return;
  assert.ok(
    solo.identity.metadata.aliases?.includes("Ore dake Level Up na Ken"),
    "the control show keeps its Romaji alias",
  );
  assert.equal(solo.identity.episodeCount, 12);
}

main()
  .then(() => console.log("PASS acquisition re-verifies provider identity"))
  .catch((error) => {
    console.error(error);
    console.log("FAIL acquisition re-verifies provider identity");
    process.exitCode = 1;
  });
