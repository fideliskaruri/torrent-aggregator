import type { TorrentSourceId } from "@/lib/torrents/types";

export const RULE_SOURCE_OPTIONS: ReadonlyArray<{
  value: TorrentSourceId;
  label: string;
}> = [
  { value: "nyaa", label: "Nyaa" },
  { value: "1337x", label: "1337x" },
  { value: "apibay", label: "The Pirate Bay" },
  { value: "torrentscsv", label: "Torrents.csv" },
  { value: "yts", label: "YTS" },
];

const RULE_SOURCE_VALUES = new Set<string>(
  RULE_SOURCE_OPTIONS.map((source) => source.value),
);

export interface RuleFormState {
  name: string;
  query: string;
  category: string;
  minSeeders: string;
  resolution: string;
  sources: string[];
  maxSizeGb: string;
}

export interface RuleFilterFormState {
  sources: string[];
  maxSizeGb: string;
}

export function parseRuleSources(
  stored: string | null | undefined,
): TorrentSourceId[] {
  if (!stored) return [];
  const out: TorrentSourceId[] = [];
  for (const raw of stored.split(",")) {
    const value = raw.trim();
    if (!RULE_SOURCE_VALUES.has(value) || out.includes(value as TorrentSourceId)) {
      continue;
    }
    out.push(value as TorrentSourceId);
  }
  return out;
}

export function serializeRuleSources(
  sources: readonly string[] | null | undefined,
): string | null {
  if (!sources?.length) return null;
  const selected = parseRuleSources(sources.join(","));
  return selected.length ? selected.join(",") : null;
}

export function maxSizeGbToBytes(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const gb = Number(trimmed);
  if (!Number.isFinite(gb) || gb <= 0) return null;
  return Math.round(gb * 1024 ** 3);
}

export function bytesToMaxSizeGbInput(
  bytes: number | bigint | null | undefined,
): string {
  if (bytes == null) return "";
  const numeric = typeof bytes === "bigint" ? Number(bytes) : Number(bytes);
  if (!Number.isFinite(numeric) || numeric <= 0) return "";
  const gb = numeric / 1024 ** 3;
  return Number.isInteger(gb)
    ? String(gb)
    : gb.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

export function buildRuleCreatePayload(form: RuleFormState) {
  return {
    name: form.name,
    query: form.query,
    category: form.category,
    minSeeders: parseInt(form.minSeeders, 10) || 10,
    resolution: form.resolution || null,
    sources: serializeRuleSources(form.sources),
    maxSizeBytes: maxSizeGbToBytes(form.maxSizeGb),
  };
}

export function buildRuleTogglePayload(id: string, enabled: boolean) {
  return { id, enabled };
}

export function buildRuleRetargetPayload(
  id: string,
  category: string | null | undefined,
) {
  return { id, category: category ?? "all" };
}

export function buildRuleFilterPayload(
  id: string,
  filters: RuleFilterFormState,
) {
  return {
    id,
    sources: serializeRuleSources(filters.sources),
    maxSizeBytes: maxSizeGbToBytes(filters.maxSizeGb),
  };
}
