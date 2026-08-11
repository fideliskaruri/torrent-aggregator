import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import {
  canonicalWorkForHash,
  canonicalProgressTitle,
  claimCatalogEntriesForWork,
  ensureCanonicalWork,
} from "./store";

async function main() {
  const suffix = randomUUID();
  const providerId = `provider-${suffix}`;
  const catalogSource = `test-${suffix}`;
  const first = await ensureCanonicalWork({
    workKey: `dune-2021-${suffix}`,
    title: "Dune",
    year: 2021,
    mediaType: "movie",
    provider: "tmdb",
    providerId,
    posterUrl: "https://img.test/dune-2021.jpg",
  });
  const alias = await ensureCanonicalWork({
    workKey: `dune-${suffix}`,
    title: "Dune",
    mediaType: "movie",
    provider: "tmdb",
    providerId,
  });
  assert.equal(alias.id, first.id, "provider aliases must reuse one Work");

  const conflict = await ensureCanonicalWork({
    workKey: first.workKey,
    title: "Wrong Provider Title",
    mediaType: "movie",
    provider: "anilist",
    providerId: `other-${suffix}`,
  });
  assert.notEqual(conflict.id, first.id);
  assert.equal(conflict.provider, "anilist");
  assert.equal(conflict.providerId, `other-${suffix}`);
  assert.match(conflict.workKey, new RegExp(`^${first.workKey}--anilist-`));
  const unchangedFirst = await prisma.work.findUniqueOrThrow({
    where: { id: first.id },
  });
  assert.equal(unchangedFirst.provider, "tmdb");
  assert.equal(unchangedFirst.providerId, providerId);
  assert.equal(unchangedFirst.canonicalTitle, "Dune");
  const unclaimedBaseCatalog = await prisma.catalogEntry.create({
    data: {
      workKey: first.workKey,
      title: "Dune",
      year: 2021,
      mediaType: "movie",
      source: `unclaimed-${suffix}`,
    },
  });
  await claimCatalogEntriesForWork(first.workKey, conflict.id);
  assert.equal(
    (await prisma.catalogEntry.findUniqueOrThrow({
      where: { id: unclaimedBaseCatalog.id },
    })).workId,
    null,
    "a provider-scoped Work must not claim catalog rows from the base key",
  );
  const providerlessMediaMismatch = await ensureCanonicalWork({
    workKey: first.workKey,
    title: "Dune",
    mediaType: "tv",
    year: 1999,
    posterUrl: "https://img.test/unverified.jpg",
  });
  assert.notEqual(providerlessMediaMismatch.id, first.id);
  assert.equal(providerlessMediaMismatch.provider, null);
  assert.match(providerlessMediaMismatch.workKey, /--unverified$/);
  assert.equal(
    (await prisma.work.findUniqueOrThrow({ where: { id: first.id } })).mediaType,
    "movie",
    "provider-less metadata must not mutate a provider-owned identity tuple",
  );
  const verifiedAfterMismatch = await prisma.work.findUniqueOrThrow({
    where: { id: first.id },
  });
  assert.equal(verifiedAfterMismatch.year, first.year);
  assert.equal(verifiedAfterMismatch.posterUrl, first.posterUrl);
  const providerlessMatch = await ensureCanonicalWork({
    workKey: first.workKey,
    title: "Dune",
    year: 2021,
    mediaType: "movie",
  });
  assert.equal(
    providerlessMatch.id,
    first.id,
    "matching year evidence must reuse the verified keyed Work",
  );

  const raceProviderId = `race-${suffix}`;
  const [raceFirst, raceSecond] = await Promise.all([
    ensureCanonicalWork({
      workKey: `race-first-${suffix}`,
      title: "Race Work",
      mediaType: "movie",
      provider: "tmdb",
      providerId: raceProviderId,
    }),
    ensureCanonicalWork({
      workKey: `race-second-${suffix}`,
      title: "Race Work",
      mediaType: "movie",
      provider: "tmdb",
      providerId: raceProviderId,
    }),
  ]);
  assert.equal(raceFirst.id, raceSecond.id);

  const conflictingRaceBase = await ensureCanonicalWork({
    workKey: `conflicting-race-${suffix}`,
    title: "Conflicting Race Work",
    mediaType: "movie",
  });
  const [conflictingTmdb, conflictingAniList] = await Promise.all([
    ensureCanonicalWork({
      workKey: conflictingRaceBase.workKey,
      title: "Conflicting Race Work",
      mediaType: "movie",
      provider: "tmdb",
      providerId: `conflicting-tmdb-${suffix}`,
    }),
    ensureCanonicalWork({
      workKey: conflictingRaceBase.workKey,
      title: "Conflicting Race Work",
      mediaType: "movie",
      provider: "anilist",
      providerId: `conflicting-anilist-${suffix}`,
    }),
  ]);
  assert.notEqual(conflictingTmdb.id, conflictingAniList.id);
  assert.equal(conflictingTmdb.provider, "tmdb");
  assert.equal(conflictingAniList.provider, "anilist");
  assert.equal(
    (await prisma.work.findUniqueOrThrow({
      where: { id: conflictingRaceBase.id },
    })).provider,
    "tmdb",
    "serialized provider assignment must preserve the first claimed identity",
  );

  const distinctProviderOwner = await ensureCanonicalWork({
    workKey: `distinct-provider-${suffix}`,
    title: "Distinct Provider Work",
    mediaType: "movie",
    provider: "anilist",
    providerId: `distinct-${suffix}`,
  });
  const distinctCollision = await ensureCanonicalWork({
    workKey: first.workKey,
    title: "Distinct Provider Work",
    mediaType: "movie",
    provider: "anilist",
    providerId: `distinct-${suffix}`,
  });
  assert.equal(distinctCollision.id, distinctProviderOwner.id);
  assert.equal(
    (await prisma.work.findUnique({ where: { id: first.id } }))?.provider,
    "tmdb",
    "a provider-owned key collision must not delete or rewrite the keyed Work",
  );

  const orphan = await ensureCanonicalWork({
    workKey: `providerless-${suffix}`,
    title: "Providerless Alias",
    mediaType: "movie",
  });
  const catalog = await prisma.catalogEntry.create({
    data: {
      workId: orphan.id,
      workKey: orphan.workKey,
      title: orphan.canonicalTitle,
      mediaType: "movie",
      source: catalogSource,
    },
  });
  const providerOwner = await ensureCanonicalWork({
    workKey: `provider-owner-${suffix}`,
    title: "Provider Owner",
    mediaType: "movie",
    provider: "tmdb",
    providerId: `merge-${suffix}`,
  });
  const merged = await ensureCanonicalWork({
    workKey: orphan.workKey,
    title: "Provider Owner",
    mediaType: "movie",
    provider: "tmdb",
    providerId: `merge-${suffix}`,
  });
  assert.equal(merged.id, providerOwner.id);
  assert.equal(
    await prisma.work.findUnique({ where: { id: orphan.id } }),
    null,
    "the provider-less duplicate must be removed",
  );
  assert.equal(
    (await prisma.catalogEntry.findUnique({ where: { id: catalog.id } }))?.workId,
    providerOwner.id,
    "dependent rows must be relinked before the duplicate is removed",
  );

  const userId = `work-user-${suffix}`;
  const staleHash = suffix.replaceAll("-", "");
  await prisma.user.create({
    data: { id: userId, name: "Canonical Work Test" },
  });
  const staleWork = await ensureCanonicalWork({
    workKey: `stale-target-${suffix}`,
    title: "Stale Target",
    mediaType: "tv",
  });
  const authoritativeWork = await ensureCanonicalWork({
    workKey: `authoritative-target-${suffix}`,
    title: "Stale Target",
    mediaType: "tv",
    provider: "tmdb",
    providerId: `authoritative-${suffix}`,
  });
  const authoritativeCatalog = await prisma.catalogEntry.create({
    data: {
      workId: authoritativeWork.id,
      workKey: staleWork.workKey,
      title: "Stale Target",
      mediaType: "tv",
      source: `authoritative-${suffix}`,
    },
  });
  const staleTarget = await prisma.acquisitionTarget.create({
    data: {
      userId,
      workId: staleWork.id,
      targetKey: `target-${suffix}`,
      workKey: staleWork.workKey,
      scope: "episode",
      infoHash: staleHash,
    },
  });
  const staleTorrent = await prisma.engineTorrent.create({
    data: {
      userId,
      workId: staleWork.id,
      hash: staleHash,
      name: "Stale Target S01E01",
    },
  });
  const reconciled = await canonicalWorkForHash(userId, staleHash);
  assert.equal(reconciled?.id, authoritativeWork.id);
  assert.equal(
    (await prisma.acquisitionTarget.findUnique({ where: { id: staleTarget.id } }))
      ?.workId,
    authoritativeWork.id,
  );
  assert.equal(
    (await prisma.engineTorrent.findUnique({ where: { id: staleTorrent.id } }))
      ?.workId,
    authoritativeWork.id,
  );
  const engineAuthorityHash =
    `${staleHash.startsWith("c") ? "d" : "c"}${staleHash.slice(1)}`;
  const unlinkedTarget = await prisma.acquisitionTarget.create({
    data: {
      userId,
      targetKey: `unlinked-${suffix}`,
      workKey: staleWork.workKey,
      scope: "episode",
      infoHash: engineAuthorityHash,
    },
  });
  const authoritativeTorrent = await prisma.engineTorrent.create({
    data: {
      userId,
      workId: authoritativeWork.id,
      hash: engineAuthorityHash,
      name: "Stale Target S01E02",
    },
  });
  const engineReconciled = await canonicalWorkForHash(
    userId,
    engineAuthorityHash,
  );
  assert.equal(engineReconciled?.id, authoritativeWork.id);
  assert.equal(
    (await prisma.acquisitionTarget.findUnique({
      where: { id: unlinkedTarget.id },
    }))?.workId,
    authoritativeWork.id,
  );
  assert.equal(
    (await prisma.engineTorrent.findUnique({
      where: { id: authoritativeTorrent.id },
    }))?.workId,
    authoritativeWork.id,
  );

  assert.equal(
    canonicalProgressTitle(
      {
        workKey: "%E8%BB%A2%E7%94%9F",
        canonicalTitle: "Percent Encoded Fallback",
      },
      "Verified Native Title",
    ),
    "Verified Native Title",
  );

  await prisma.catalogEntry.delete({ where: { id: catalog.id } });
  await prisma.catalogEntry.delete({ where: { id: unclaimedBaseCatalog.id } });
  await prisma.work.delete({ where: { id: providerOwner.id } });
  await prisma.work.delete({ where: { id: distinctProviderOwner.id } });
  await prisma.work.delete({ where: { id: conflict.id } });
  await prisma.work.delete({ where: { id: raceFirst.id } });
  await prisma.work.delete({ where: { id: conflictingAniList.id } });
  await prisma.work.delete({ where: { id: conflictingRaceBase.id } });
  if (providerlessMediaMismatch.id !== first.id) {
    await prisma.work.delete({ where: { id: providerlessMediaMismatch.id } });
  }
  await prisma.work.delete({ where: { id: first.id } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.catalogEntry.delete({ where: { id: authoritativeCatalog.id } });
  await prisma.work.delete({ where: { id: staleWork.id } });
  await prisma.work.delete({ where: { id: authoritativeWork.id } });
  await prisma.$disconnect();
  console.log("PASS canonical Work provider and title safeguards");
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
