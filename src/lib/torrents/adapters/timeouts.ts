/** Shared outbound budgets for public indexers. */
export const INDEXER_TIMEOUT_MS = 12_000;

/**
 * Metadata lookups are optional decoration and should fail sooner than a
 * release search.
 */
export const INDEXER_METADATA_TIMEOUT_MS = 8_000;

/**
 * 1337x HTML/Cloudflare paths are intentionally different from JSON/RSS APIs:
 * search gets a little longer, detail a little shorter, and the opt-in browser
 * fallback includes browser startup.
 */
export const X1337_SEARCH_TIMEOUT_MS = 14_000;
export const X1337_DETAIL_TIMEOUT_MS = 10_000;
export const X1337_BROWSER_TIMEOUT_MS = 40_000;

export function indexerTimeoutSignal(
  timeoutMs = INDEXER_TIMEOUT_MS,
): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}
