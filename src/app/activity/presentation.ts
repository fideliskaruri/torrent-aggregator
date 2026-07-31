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
