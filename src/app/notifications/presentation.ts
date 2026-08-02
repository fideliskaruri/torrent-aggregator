function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Convert enum-style kind values into user-facing labels.
 *
 * The formatter handles separators, camelCase, shouting case, known compound
 * words, and unknown future values rather than patching one literal enum.
 */
export function formatActivityKind(
  value: string | null | undefined,
): string | null {
  const raw = clean(value);
  if (!raw) return null;

  const words = raw
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[._/-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\bondemand\b|\bon\s+demand\b/g, "on-demand")
    .replace(/\bautorule\b|\bauto\s+rule\b/g, "auto-rule")
    .replace(/\bprewarm\b|\bpre\s+warm\b/g, "pre-warm");

  return words ? words[0].toUpperCase() + words.slice(1) : null;
}

export function activityKindLabel(item: {
  kind?: string | null;
  context?: string | null;
}): string | null {
  return clean(item.context) ?? formatActivityKind(item.kind);
}

export const ACTIVITY_BATCH_SIZE = 20;

export function boundedActivityItems<T>(
  items: readonly T[],
  limit = ACTIVITY_BATCH_SIZE,
): T[] {
  return items.slice(0, Math.max(0, limit));
}

export type ActivityDayGroup<T> = {
  key: string;
  label: string;
  items: T[];
};

/** Group newest-first activity into scannable day sections. */
export function groupActivityByDay<T extends { createdAt: string }>(
  items: readonly T[],
  now = new Date(),
): ActivityDayGroup<T>[] {
  const todayKey = localDateKey(now);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayKey = localDateKey(yesterday);
  const groups = new Map<string, ActivityDayGroup<T>>();

  for (const item of items) {
    const date = new Date(item.createdAt);
    const valid = Number.isFinite(date.getTime());
    const key = valid ? localDateKey(date) : "unknown";
    const label =
      key === todayKey
        ? "Today"
        : key === yesterdayKey
          ? "Yesterday"
          : valid
            ? date.toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
                year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
              })
            : "Earlier";
    const group = groups.get(key) ?? { key, label, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }

  return [...groups.values()];
}

function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}
