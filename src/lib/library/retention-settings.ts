import prisma from "@/lib/prisma";
import {
  DEFAULT_STREAM_CACHE_BUDGET_BYTES,
  STREAM_CACHE_GRACE_MS,
  retentionStateForOrigin,
} from "@/lib/streaming/retention";

export const RETENTION_POLICY_EPHEMERAL = "EPHEMERAL" as const;
export const RETENTION_POLICY_KEPT = "KEPT" as const;

export type RetentionPolicy =
  | typeof RETENTION_POLICY_EPHEMERAL
  | typeof RETENTION_POLICY_KEPT;
export type SendRetentionChoice = "stream" | "keep";

export const DEFAULT_RETENTION_POLICY: RetentionPolicy =
  RETENTION_POLICY_EPHEMERAL;

export interface RetentionDecisionInput {
  defaultPolicy?: string | null;
  requestedPolicy?: string | null;
  watchListItemId?: string | null;
  tracked?: boolean | null;
  existingOrigin?: string | null;
}

export interface EvictionSafetyInput {
  retentionPolicy?: RetentionPolicy | null;
  hasProgressRow?: boolean | null;
  completedAt?: Date | null;
  referencedByWatchlist?: boolean | null;
  now?: Date;
  graceMs?: number;
}

export interface RetentionUsageItem {
  hash: string;
  name: string;
  retentionPolicy: RetentionPolicy | "INDETERMINATE";
  origin: string | null;
  sizeBytes: number;
  progress: number;
  status: string;
  lastUsedAt: string;
  savePath: string | null;
  category: string | null;
}

export interface RetentionStorageUsage {
  totalBytes: number;
  ephemeralBytes: number;
  keptBytes: number;
  indeterminateBytes: number;
  budgetBytes: number;
  graceMs: number;
  items: RetentionUsageItem[];
}

type Db = typeof prisma;
type RawDb = Pick<Db, "$queryRawUnsafe" | "$executeRawUnsafe">;

export function normalizeRetentionPolicy(
  value: string | null | undefined,
  fallback: RetentionPolicy = DEFAULT_RETENTION_POLICY,
): RetentionPolicy {
  const normalized = String(value ?? "").trim().toUpperCase();
  if (normalized === RETENTION_POLICY_KEPT || normalized === "KEEP") {
    return RETENTION_POLICY_KEPT;
  }
  if (normalized === RETENTION_POLICY_EPHEMERAL || normalized === "STREAM") {
    return RETENTION_POLICY_EPHEMERAL;
  }
  return fallback;
}

export function retentionPolicyForOrigin(
  origin: string | null | undefined,
): RetentionPolicy | null {
  const state = retentionStateForOrigin(origin);
  if (state === "kept") return RETENTION_POLICY_KEPT;
  if (state === "stream" || state === "prewarm") {
    return RETENTION_POLICY_EPHEMERAL;
  }
  return null;
}

export function shouldPromoteToKept(input: RetentionDecisionInput): boolean {
  if (normalizeRetentionPolicy(input.requestedPolicy, DEFAULT_RETENTION_POLICY) === RETENTION_POLICY_KEPT) {
    return true;
  }
  if (Boolean(input.watchListItemId)) return true;
  return input.tracked === true;
}

export function resolveRetentionPolicy(
  input: RetentionDecisionInput,
): RetentionPolicy {
  const existing = retentionPolicyForOrigin(input.existingOrigin);
  if (existing === RETENTION_POLICY_KEPT) return RETENTION_POLICY_KEPT;
  if (shouldPromoteToKept(input)) return RETENTION_POLICY_KEPT;
  return normalizeRetentionPolicy(input.defaultPolicy, DEFAULT_RETENTION_POLICY);
}

export function resolveSendRetentionChoice(
  input: RetentionDecisionInput & {
    explicitRetention?: SendRetentionChoice | null;
    defaultPolicyPersisted?: boolean | null;
  },
): SendRetentionChoice | null {
  if (input.explicitRetention === "stream" || input.explicitRetention === "keep") {
    return input.explicitRetention;
  }
  if (input.defaultPolicyPersisted !== true) return null;
  return resolveRetentionPolicy(input) === RETENTION_POLICY_KEPT
    ? "keep"
    : "stream";
}

export function shouldDemoteToEphemeral(input: {
  existingPolicy?: RetentionPolicy | null;
  explicitDemotion?: boolean | null;
}): boolean {
  return input.existingPolicy === RETENTION_POLICY_EPHEMERAL && input.explicitDemotion === true;
}

export function isSafeToEvictEphemeral(input: EvictionSafetyInput): boolean {
  if (input.retentionPolicy !== RETENTION_POLICY_EPHEMERAL) return false;
  if (input.hasProgressRow !== true) return false;
  if (!(input.completedAt instanceof Date)) return false;
  if (input.referencedByWatchlist !== false) return false;

  const now = input.now ?? new Date();
  const graceMs = input.graceMs ?? STREAM_CACHE_GRACE_MS;
  return now.getTime() - input.completedAt.getTime() >= graceMs;
}

export async function readDefaultRetentionPolicy(
  userId: string,
  db: RawDb = prisma,
): Promise<{ policy: RetentionPolicy; persisted: boolean }> {
  try {
    const rows = await db.$queryRawUnsafe<Array<{ defaultRetentionPolicy?: string | null }>>(
      'SELECT defaultRetentionPolicy FROM ClientSettings WHERE userId = ? LIMIT 1',
      userId,
    );
    return {
      policy: normalizeRetentionPolicy(rows[0]?.defaultRetentionPolicy),
      persisted: true,
    };
  } catch {
    return { policy: DEFAULT_RETENTION_POLICY, persisted: false };
  }
}

export async function writeDefaultRetentionPolicy(
  userId: string,
  policy: RetentionPolicy,
  db: RawDb = prisma,
): Promise<{ persisted: boolean }> {
  try {
    await db.$executeRawUnsafe(
      'UPDATE ClientSettings SET defaultRetentionPolicy = ? WHERE userId = ?',
      policy,
      userId,
    );
    return { persisted: true };
  } catch {
    return { persisted: false };
  }
}

export async function getRetentionStorageUsage(
  userId: string,
  db: Db = prisma,
): Promise<RetentionStorageUsage> {
  const rows = await db.engineTorrent.findMany({
    where: { userId, status: { not: "removed" } },
    orderBy: { lastUsedAt: "desc" },
    take: 200,
    select: {
      hash: true,
      name: true,
      origin: true,
      sizeBytes: true,
      progress: true,
      status: true,
      lastUsedAt: true,
      savePath: true,
      category: true,
    },
  });

  let totalBytes = 0;
  let ephemeralBytes = 0;
  let keptBytes = 0;
  let indeterminateBytes = 0;
  const items = rows.map((row) => {
    const sizeBytes = Number(row.sizeBytes);
    const safeBytes = Number.isFinite(sizeBytes) && sizeBytes > 0 ? sizeBytes : 0;
    const policy: RetentionUsageItem["retentionPolicy"] =
      retentionPolicyForOrigin(row.origin) ?? "INDETERMINATE";
    totalBytes += safeBytes;
    if (policy === RETENTION_POLICY_EPHEMERAL) ephemeralBytes += safeBytes;
    else if (policy === RETENTION_POLICY_KEPT) keptBytes += safeBytes;
    else indeterminateBytes += safeBytes;
    return {
      hash: row.hash,
      name: row.name,
      retentionPolicy: policy,
      origin: row.origin,
      sizeBytes: safeBytes,
      progress: row.progress,
      status: row.status,
      lastUsedAt: row.lastUsedAt.toISOString(),
      savePath: row.savePath,
      category: row.category,
    };
  });

  return {
    totalBytes,
    ephemeralBytes,
    keptBytes,
    indeterminateBytes,
    budgetBytes: DEFAULT_STREAM_CACHE_BUDGET_BYTES,
    graceMs: STREAM_CACHE_GRACE_MS,
    items,
  };
}

export async function getRetentionSettingsSnapshot(
  userId: string,
  db: Db = prisma,
): Promise<{
  defaultRetentionPolicy: RetentionPolicy;
  defaultRetentionPolicyPersisted: boolean;
  storageUsage: RetentionStorageUsage;
}> {
  const [defaultPolicy, storageUsage] = await Promise.all([
    readDefaultRetentionPolicy(userId, db),
    getRetentionStorageUsage(userId, db),
  ]);
  return {
    defaultRetentionPolicy: defaultPolicy.policy,
    defaultRetentionPolicyPersisted: defaultPolicy.persisted,
    storageUsage,
  };
}
