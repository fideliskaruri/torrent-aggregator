import { searchIntentQuery } from "@/lib/search/query-variants";

function normalizeForMatch(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function compactForMatch(value: string): string {
  return normalizeForMatch(value).replace(/ /g, "");
}

const LEADING_ARTICLE = /^(?:the|a|an) /;
const MIN_FUZZY_LENGTH = 5;
const MAX_FUZZY_QUERY_LENGTH = 64;
const MAX_FUZZY_CANDIDATE_LENGTH = 96;

function boundedDamerauLevenshtein(
  left: string,
  right: string,
  maxDistance: number,
): number | null {
  const a = Array.from(left);
  const b = Array.from(right);
  if (Math.abs(a.length - b.length) > maxDistance) return null;

  const rows = Array.from(
    { length: a.length + 1 },
    () => new Map<number, number>(),
  );
  rows[0].set(0, 0);
  for (let j = 1; j <= Math.min(b.length, maxDistance); j += 1) {
    rows[0].set(j, j);
  }

  for (let i = 1; i <= a.length; i += 1) {
    const row = rows[i];
    const start = Math.max(1, i - maxDistance);
    const end = Math.min(b.length, i + maxDistance);
    if (start === 1 && i <= maxDistance) row.set(0, i);

    for (let j = start; j <= end; j += 1) {
      const same = a[i - 1] === b[j - 1];
      let distance = Math.min(
        (rows[i - 1].get(j) ?? Infinity) + 1,
        (row.get(j - 1) ?? Infinity) + 1,
        (rows[i - 1].get(j - 1) ?? Infinity) + (same ? 0 : 1),
      );
      if (
        i > 1 &&
        j > 1 &&
        a[i - 1] === b[j - 2] &&
        a[i - 2] === b[j - 1]
      ) {
        distance = Math.min(
          distance,
          (rows[i - 2].get(j - 2) ?? Infinity) + 1,
        );
      }
      if (distance <= maxDistance) row.set(j, distance);
    }
  }

  return rows[a.length].get(b.length) ?? null;
}

function fuzzyDistance(query: string, name: string): number | null {
  const qCompact = compactForMatch(query);
  const nCompact = compactForMatch(name);
  const queryLength = Array.from(qCompact).length;
  const candidateLength = Array.from(nCompact).length;
  if (
    queryLength < MIN_FUZZY_LENGTH ||
    candidateLength < MIN_FUZZY_LENGTH ||
    queryLength > MAX_FUZZY_QUERY_LENGTH ||
    candidateLength > MAX_FUZZY_CANDIDATE_LENGTH
  ) {
    return null;
  }

  const maxDistance = Math.min(
    2,
    Math.max(1, Math.floor(queryLength / 6)),
  );
  return boundedDamerauLevenshtein(qCompact, nCompact, maxDistance);
}

/** Lower is a better match. Tier 6 means the candidate does not answer the query. */
export function queryRelevanceTier(query: string, name: string): number {
  const q = searchIntentQuery(query);
  if (!q) return 6;
  const n = normalizeForMatch(name);
  const qCompact = compactForMatch(q);
  const nCompact = compactForMatch(name);
  const qBare = q.replace(LEADING_ARTICLE, "");
  const nBare = n.replace(LEADING_ARTICLE, "");
  const nBareCompact = compactForMatch(nBare);
  const qBareCompact = compactForMatch(qBare);
  const nInitials = nBare
    .split(" ")
    .filter(Boolean)
    .map((token) => Array.from(token)[0] ?? "")
    .join("");
  if (n === q || nBare === qBare) return 0;
  if (
    n.startsWith(q) ||
    nBare.startsWith(qBare) ||
    nCompact === qCompact ||
    nBareCompact === qBareCompact ||
    nCompact.startsWith(qCompact) ||
    nBareCompact.startsWith(qBareCompact) ||
    (qBareCompact.length >= 2 && nInitials === qBareCompact)
  ) {
    return 1;
  }
  const phrase = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`(?:^| )${phrase}(?: |$)`).test(n)) return 2;
  if (n.includes(q)) return 3;
  const tokens = qBare.split(" ").filter(Boolean);
  if (tokens.length > 0 && tokens.every((token) => n.includes(token))) return 4;
  if (fuzzyDistance(q, name) != null) return 5;
  return 6;
}

export function bestQueryRelevanceTier(
  query: string,
  names: readonly string[],
): number {
  let best = 6;
  for (const name of names) {
    if (!name?.trim()) continue;
    best = Math.min(best, queryRelevanceTier(query, name));
    if (best === 0) break;
  }
  return best;
}

export function hasRelevantTitle(
  query: string,
  names: readonly string[],
): boolean {
  return bestQueryRelevanceTier(query, names) < 6;
}
