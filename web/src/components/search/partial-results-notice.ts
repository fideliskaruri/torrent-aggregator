/**
 * What to tell someone when part of a search answered and part did not.
 *
 * A partial result is not an error: the categories that answered are real and
 * useful, so the surface keeps rendering them and adds one quiet line naming
 * what is missing. Saying nothing would be worse than an error screen — the
 * owner would read a short list as "that's all there is".
 *
 * Kept as data (no JSX) so both the full page and the overlay share the same
 * wording and it can be asserted without a DOM.
 */

/** Plain names for the fan-out keys the API reports back. */
const PROVIDER_LABELS: Record<string, string> = {
  movies: "films",
  series: "series",
  anime: "anime",
  tmdb: "films and series",
  anilist: "anime",
};

function partialProviderLabels(
  failedProviders: readonly string[] | undefined | null,
): string[] {
  const out: string[] = [];
  for (const raw of failedProviders ?? []) {
    const name = String(raw ?? "").trim();
    if (!name) continue;
    const label = PROVIDER_LABELS[name.toLowerCase()] ?? name;
    if (!out.includes(label)) out.push(label);
  }
  return out;
}

/** Join labels the way a person would read them aloud. */
function joinLabels(labels: readonly string[]): string {
  if (labels.length <= 1) return labels[0] ?? "";
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/**
 * The notice for a partial response, or null when there is nothing to say.
 *
 * Returns null unless the response actually reported a partial with named
 * providers: a notice with no names would be an unexplained warning.
 */
export function partialResultsNotice(input: {
  partial?: boolean | null;
  failedProviders?: readonly string[] | null;
}): string | null {
  if (!input.partial) return null;
  const labels = partialProviderLabels(input.failedProviders);
  if (!labels.length) return null;
  return `Some results are missing: ${joinLabels(labels)} did not respond. Everything else that answered is shown below.`;
}
