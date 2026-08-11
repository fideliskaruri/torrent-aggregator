import { searchAniList } from "@/lib/metadata/anilist";
import { searchTmdb } from "@/lib/metadata/tmdb";
import { rankTitleHitsByRelevance } from "@/components/search/title-search";
import {
  canonicalizeSearchQuery,
  displaySearchQuery,
} from "@/lib/search/query-variants";
import { AllProvidersFailedError } from "@/lib/search/work-search-fanout";
import { bestQueryRelevanceTier } from "@/lib/search/relevance";

export type SuggestProviderName = "anilist" | "tmdb";

export interface Suggestion {
  title: string;
  aliases?: string[];
  mediaType: string;
  posterUrl?: string | null;
  year?: number | null;
  source: string;
  externalId: string;
}

export type SuggestProviders = Record<
  SuggestProviderName,
  (query: string, limit: number) => Promise<Suggestion[]>
>;

export const defaultSuggestProviders: SuggestProviders = {
  anilist: async (query, limit) =>
    (await searchAniList(query, limit)).map(toSuggestion),
  tmdb: async (query, limit) =>
    (await searchTmdb(query, limit)).map(toSuggestion),
};

function toSuggestion(m: {
  title: string;
  mediaType: string;
  posterUrl?: string | null;
  year?: number | null;
  source: string;
  externalId: string;
  aliases?: string[];
}): Suggestion {
  return {
    title: m.title,
    aliases: m.aliases,
    mediaType: m.mediaType,
    posterUrl: m.posterUrl,
    year: m.year,
    source: m.source,
    externalId: m.externalId,
  };
}

export interface SuggestOutcome {
  suggestions: Suggestion[];
  query: string;
  displayQuery: string;
  failed: SuggestProviderName[];
  partial: boolean;
}

const PROVIDER_ORDER: SuggestProviderName[] = ["anilist", "tmdb"];

export interface SuggestFailureShape {
  status: 502 | 500;
  /** Named providers only when they genuinely failed — never a placeholder. */
  failedProviders: string[];
  providerOutage: boolean;
}

/**
 * Split "every provider rejected" from "our code threw".
 *
 * Only the first is an upstream outage worth a 502 and a provider list. An
 * unexpected internal error reported as a provider outage sends the owner
 * looking at TMDB's status page for a bug that is ours, so it becomes a 500
 * with no provider claim attached.
 */
export function suggestFailureShapeFor(error: unknown): SuggestFailureShape {
  if (error instanceof AllProvidersFailedError) {
    return {
      status: 502,
      failedProviders: [...error.failed],
      providerOutage: true,
    };
  }
  return { status: 500, failedProviders: [], providerOutage: false };
}

/**
 * Autocomplete fan-out on ONE canonical query.
 *
 * Same two guarantees as title search: casing/whitespace variants take the same
 * warm provider path (`MOONKN` must rank Moon Knight exactly like `moonkn`),
 * and one provider failing degrades to the other rather than emptying the list.
 * Both failing throws — an empty 200 would look like "no such title".
 */
export async function collectSuggestions(
  rawQuery: string,
  perProvider = 4,
  total = 8,
  providers: SuggestProviders = defaultSuggestProviders,
): Promise<SuggestOutcome> {
  const query = canonicalizeSearchQuery(rawQuery);
  const displayQuery = displaySearchQuery(rawQuery);

  const settled = await Promise.allSettled(
    PROVIDER_ORDER.map((name) => providers[name](query, perProvider)),
  );
  const failed = PROVIDER_ORDER.filter(
    (_, index) => settled[index].status === "rejected",
  );
  if (failed.length === PROVIDER_ORDER.length) {
    // The names must be the providers that actually rejected: the route turns
    // this list into what the user is told is unavailable.
    throw new AllProvidersFailedError(
      failed,
      (settled[0] as PromiseRejectedResult).reason,
    );
  }

  const collected: Suggestion[] = [];
  for (const entry of settled) {
    if (entry.status === "fulfilled") collected.push(...entry.value);
  }

  const seen = new Set<string>();
  const unique = collected.filter((s) => {
    const key = canonicalizeSearchQuery(s.title);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    suggestions: rankTitleHitsByRelevance(unique, query)
      .filter(
        (suggestion) =>
          bestQueryRelevanceTier(query, [
            suggestion.title,
            ...(suggestion.aliases ?? []),
          ]) < 6,
      )
      .slice(0, total),
    query,
    displayQuery,
    failed,
    partial: failed.length > 0,
  };
}
