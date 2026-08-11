import { prisma } from "@/lib/prisma";
import { displayTitleFromWorkKey } from "@/components/title/work-key";
import { isSlopTitle } from "@/lib/metadata/slop";
import { createHash, randomUUID } from "node:crypto";

export interface CanonicalWorkInput {
  workKey: string;
  title?: string | null;
  year?: number | null;
  mediaType?: string | null;
  aliases?: readonly string[];
  provider?: string | null;
  providerId?: string | null;
  posterUrl?: string | null;
}

function canonicalTitle(input: CanonicalWorkInput): string {
  const title = input.title?.trim();
  if (title && !isSlopTitle(title)) return title;
  return displayTitleFromWorkKey(input.workKey);
}

function aliasesJson(aliases: readonly string[] | undefined): string | null {
  const values = [...new Set((aliases ?? []).map((value) => value.trim()).filter(Boolean))];
  return values.length > 0 ? JSON.stringify(values) : null;
}

function providerScopedWorkKey(
  workKey: string,
  input: CanonicalWorkInput,
): string | null {
  const provider = input.provider?.trim().toLowerCase();
  const providerId = input.providerId?.trim().toLowerCase();
  const mediaType = input.mediaType?.trim().toLowerCase();
  if (!provider || !providerId || !mediaType) return null;
  const scopeHash = createHash("sha256")
    .update(`${provider}\0${providerId}\0${mediaType}`)
    .digest("hex")
    .slice(0, 16);
  return `${workKey}--${provider.replace(/[^a-z0-9]+/g, "-")}-${scopeHash}`;
}

function unverifiedScopedWorkKey(workKey: string): string {
  return `${workKey}--unverified`;
}

export interface CanonicalWorkRecord {
  id: string;
  workKey: string;
  canonicalTitle: string;
  year: number | null;
  mediaType: string;
  aliasesJson: string | null;
  provider: string | null;
  providerId: string | null;
  posterUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AcquisitionWorkRow {
  infoHash: string | null;
  workId: string | null;
  workKey: string;
  canonicalTitle: string | null;
  year: number | null;
  mediaType: string | null;
  scope: string;
  season: number | null;
  episode: number | null;
}

let canonicalWorkMutationQueue: Promise<void> = Promise.resolve();

function serializeCanonicalWorkMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = canonicalWorkMutationQueue.then(operation, operation);
  canonicalWorkMutationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export function canonicalProgressTitle(
  work: Pick<CanonicalWorkRecord, "workKey" | "canonicalTitle">,
  fallbackTitle: string,
): string {
  const fallback = fallbackTitle.trim();
  if (
    work.workKey.includes("%")
    && fallback
    && !isSlopTitle(fallback)
  ) {
    return fallback;
  }
  return work.canonicalTitle;
}

async function workByKey(workKey: string): Promise<CanonicalWorkRecord | null> {
  const rows = await prisma.$queryRawUnsafe<CanonicalWorkRecord[]>(
    'SELECT * FROM "Work" WHERE "workKey" = ? LIMIT 1',
    workKey,
  );
  return rows[0] ?? null;
}

async function workById(id: string): Promise<CanonicalWorkRecord | null> {
  const rows = await prisma.$queryRawUnsafe<CanonicalWorkRecord[]>(
    'SELECT * FROM "Work" WHERE "id" = ? LIMIT 1',
    id,
  );
  return rows[0] ?? null;
}

async function workByProvider(
  input: CanonicalWorkInput,
): Promise<CanonicalWorkRecord | null> {
  const provider = input.provider?.trim();
  const providerId = input.providerId?.trim();
  const mediaType = input.mediaType?.trim();
  if (!provider || !providerId || !mediaType) return null;
  const rows = await prisma.$queryRawUnsafe<CanonicalWorkRecord[]>(
    `SELECT * FROM "Work"
     WHERE "provider" = ? AND "providerId" = ? AND "mediaType" = ?
     LIMIT 1`,
    provider,
    providerId,
    mediaType,
  );
  return rows[0] ?? null;
}

async function mergeCanonicalWorks(
  source: CanonicalWorkRecord,
  target: CanonicalWorkRecord,
): Promise<void> {
  if (source.id === target.id) return;
  await prisma.$transaction([
    prisma.watchListItem.updateMany({
      where: { workId: source.id },
      data: { workId: target.id },
    }),
    prisma.engineTorrent.updateMany({
      where: { workId: source.id },
      data: { workId: target.id },
    }),
    prisma.acquisitionTarget.updateMany({
      where: { workId: source.id },
      data: { workId: target.id },
    }),
    prisma.catalogEntry.updateMany({
      where: { workId: source.id },
      data: { workId: target.id },
    }),
    prisma.downloadHistory.updateMany({
      where: { workId: source.id },
      data: { workId: target.id },
    }),
    prisma.playbackProgress.updateMany({
      where: { workId: source.id },
      data: { workId: target.id },
    }),
    prisma.work.delete({ where: { id: source.id } }),
  ]);
}

async function relinkHashToWork(
  userId: string,
  hash: string,
  workId: string,
): Promise<void> {
  await prisma.$transaction([
    prisma.$executeRawUnsafe(
      `UPDATE "AcquisitionTarget" SET "workId" = ?
       WHERE "userId" = ? AND lower("infoHash") = ?`,
      workId,
      userId,
      hash,
    ),
    prisma.$executeRawUnsafe(
      `UPDATE "EngineTorrent" SET "workId" = ?
       WHERE "userId" = ? AND lower("hash") = ?`,
      workId,
      userId,
      hash,
    ),
  ]);
}

async function ensureCanonicalWorkUnlocked(input: CanonicalWorkInput) {
  let workKey = input.workKey.trim();
  const title = canonicalTitle(input);
  const suppliedTitle = input.title?.trim();
  const scopedWorkKey = providerScopedWorkKey(workKey, input);
  let [keyWork, providerWork] = await Promise.all([
    workByKey(workKey),
    workByProvider(input),
  ]);
  if (
    keyWork?.provider != null
    && providerWork == null
    && (
      keyWork.provider !== input.provider?.trim()
      || keyWork.providerId !== input.providerId?.trim()
      || keyWork.mediaType !== input.mediaType?.trim()
    )
    && (
      scopedWorkKey != null
      || !providerlessEvidenceMatches(keyWork, input)
    )
  ) {
    workKey = scopedWorkKey ?? unverifiedScopedWorkKey(workKey);
    keyWork = await workByKey(workKey);
    providerWork = await workByProvider(input);
  }

  function providerlessEvidenceMatches(
    work: CanonicalWorkRecord,
    input: CanonicalWorkInput,
  ): boolean {
    if (input.provider?.trim() || input.providerId?.trim()) return false;
    const mediaType = input.mediaType?.trim();
    if (!mediaType || mediaType !== work.mediaType) return false;

    const yearMatches =
      input.year != null
      && work.year != null
      && input.year === work.year;
    const posterUrl = input.posterUrl?.trim();
    const posterMatches =
      Boolean(posterUrl)
      && Boolean(work.posterUrl?.trim())
      && posterUrl === work.posterUrl?.trim();
    return yearMatches || posterMatches;
  }
  if (
    keyWork
    && providerWork
    && keyWork.id !== providerWork.id
    && keyWork.provider == null
    && keyWork.providerId == null
  ) {
    await mergeCanonicalWorks(keyWork, providerWork);
    keyWork = null;
    providerWork = await workById(providerWork.id);
  }
  const existing = providerWork ?? keyWork;
  const sameProvider =
    existing != null
    && existing.provider != null
    && existing.provider === input.provider
    && existing.providerId === input.providerId;
  const mayReplaceProviderTitle =
    existing?.provider == null || sameProvider || isSlopTitle(existing.canonicalTitle);
  const maySetProvider = existing?.provider == null || sameProvider;
  const titleUpdate =
    suppliedTitle && !isSlopTitle(suppliedTitle) && mayReplaceProviderTitle
      ? title
      : !suppliedTitle
        && existing != null
        && existing.provider == null
        && existing.canonicalTitle.localeCompare(title, undefined, {
          sensitivity: "accent",
        }) === 0
        ? title
        : undefined;
  const now = new Date();
  if (!existing) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Work"
        ("id", "workKey", "canonicalTitle", "year", "mediaType", "aliasesJson",
         "provider", "providerId", "posterUrl", "createdAt", "updatedAt")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
      randomUUID(),
      workKey,
      title,
      input.year ?? null,
      input.mediaType?.trim() || "unknown",
      aliasesJson(input.aliases),
      input.provider ?? null,
      input.providerId ?? null,
      input.posterUrl ?? null,
      now,
      now,
    );
  } else {
    await prisma.$executeRawUnsafe(
      `UPDATE "Work"
       SET "canonicalTitle" = ?, "year" = ?, "mediaType" = ?,
           "aliasesJson" = ?, "provider" = ?, "providerId" = ?,
           "posterUrl" = ?, "updatedAt" = ?
       WHERE "id" = ?`,
      titleUpdate ?? existing.canonicalTitle,
      maySetProvider ? input.year ?? existing.year : existing.year,
      maySetProvider
        ? input.mediaType?.trim() || existing.mediaType
        : existing.mediaType,
      aliasesJson(input.aliases) ?? existing.aliasesJson,
      maySetProvider ? input.provider ?? existing.provider : existing.provider,
      maySetProvider ? input.providerId ?? existing.providerId : existing.providerId,
      maySetProvider ? input.posterUrl ?? existing.posterUrl : existing.posterUrl,
      now,
      existing.id,
    );
  }
  const work = existing
    ? await workById(existing.id)
    : await workByKey(workKey) ?? await workByProvider(input);
  if (!work) throw new Error(`Failed to persist canonical work ${workKey}`);
  return work;
}

export function ensureCanonicalWork(input: CanonicalWorkInput) {
  return serializeCanonicalWorkMutation(() => ensureCanonicalWorkUnlocked(input));
}

export async function claimCatalogEntriesForWork(
  workKey: string,
  workId: string,
): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE "CatalogEntry"
     SET "workId" = ?
     WHERE "workKey" = ?
       AND EXISTS (
         SELECT 1 FROM "Work" incoming
         WHERE incoming."id" = ? AND incoming."workKey" = ?
       )
       AND (
         "workId" IS NULL
         OR "workId" = ?
         OR "workId" IN (
           SELECT "id" FROM "Work"
           WHERE "provider" IS NULL AND "providerId" IS NULL
         )
       )`,
    workId,
    workKey,
    workId,
    workKey,
    workId,
  );
}

export async function acquisitionWorksForUser(
  userId: string,
  hashes: readonly string[],
): Promise<AcquisitionWorkRow[]> {
  if (hashes.length === 0) return [];
  const placeholders = hashes.map(() => "?").join(", ");
  return prisma.$queryRawUnsafe<AcquisitionWorkRow[]>(
    `SELECT a."infoHash", a."workId", a."workKey", a."scope",
            a."season", a."episode", w."canonicalTitle",
            w."year", w."mediaType"
     FROM "AcquisitionTarget" a
     LEFT JOIN "Work" w ON w."id" = a."workId"
     WHERE a."userId" = ? AND lower(a."infoHash") IN (${placeholders})
     ORDER BY a."updatedAt" DESC`,
    userId,
    ...hashes.map((hash) => hash.toLowerCase()),
  );
}

export async function canonicalWorkForHash(userId: string, infoHash: string) {
  const hash = infoHash.toLowerCase();
  const targetRows = await prisma.$queryRawUnsafe<
    Array<{
      workId: string | null;
      workKey: string;
      canonicalTitle: string | null;
    }>
  >(
    `SELECT a."workId", a."workKey", w."canonicalTitle"
     FROM "AcquisitionTarget" a
     LEFT JOIN "Work" w ON w."id" = a."workId"
     WHERE a."userId" = ? AND lower(a."infoHash") = ?
     ORDER BY a."updatedAt" DESC LIMIT 1`,
    userId,
    hash,
  );
  const target = targetRows[0] ?? null;
  const engineRows = await prisma.$queryRawUnsafe<CanonicalWorkRecord[]>(
    `SELECT w.*
     FROM "EngineTorrent" e
     JOIN "Work" w ON w."id" = e."workId"
     WHERE e."userId" = ? AND lower(e."hash") = ?
     ORDER BY e."updatedAt" DESC LIMIT 1`,
    userId,
    hash,
  );
  const engineWork = engineRows[0] ?? null;
  if (!target) {
    return engineWork;
  }
  const catalog = await prisma.catalogEntry.findFirst({
    where: { workKey: target.workKey },
    orderBy: { refreshedAt: "desc" },
  });
  const catalogWork = catalog?.workId
    ? await workById(catalog.workId)
    : null;
  if (target.workId) {
    const work = await workById(target.workId);
    if (work) {
      const authoritativeWork =
        engineWork?.provider != null
          ? engineWork
          : catalogWork?.provider != null
            ? catalogWork
            : null;
      if (
        work.provider == null
        && authoritativeWork
        && authoritativeWork.id !== work.id
      ) {
        await relinkHashToWork(
          userId,
          hash,
          authoritativeWork.id,
        );
        return authoritativeWork;
      }
      return work;
    }
  }
  const existingLinkedWork = engineWork ?? catalogWork;
  if (existingLinkedWork) {
    await relinkHashToWork(
      userId,
      hash,
      existingLinkedWork.id,
    );
    return existingLinkedWork;
  }

  const work = await ensureCanonicalWork({
    workKey: target.workKey,
    title: catalog?.title ?? null,
    year: catalog?.year ?? null,
    mediaType: catalog?.mediaType ?? null,
    posterUrl: catalog?.posterUrl ?? null,
  });
  await relinkHashToWork(userId, hash, work.id);
  return work;
}
