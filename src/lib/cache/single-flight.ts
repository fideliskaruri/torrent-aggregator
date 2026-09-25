/**
 * Collapses concurrent identical async work onto one in-flight promise.
 *
 * A single `/api/search` page resolves metadata for the primary query plus six
 * release titles at once. Those titles overwhelmingly reduce to the *same*
 * catalog question ("Breaking Bad HD4U", "Breaking Bad ENG ITA" and four more
 * all ask AniList for "Breaking Bad"), and the only cache in front of them is
 * written *after* a lookup finishes — so six copies of the same request left
 * together, every one of them paying full latency and, worse, spending six
 * slots of a public catalog's per-minute budget. Under a 429 the retry ladder
 * then multiplied that again.
 *
 * Sharing the promise makes the duplicates free and cuts outbound requests by
 * the duplication factor. Entries are dropped the moment they settle, so this
 * is strictly a concurrency device and never a result cache: nothing is ever
 * served from it after the fact, and a failure is not remembered.
 */
export function createSingleFlight<T>(): {
  run(key: string, work: () => Promise<T>): Promise<T>;
  readonly size: number;
} {
  const inFlight = new Map<string, Promise<T>>();

  return {
    run(key, work) {
      const existing = inFlight.get(key);
      if (existing) return existing;

      // `work()` may throw synchronously; keep that on the returned promise
      // rather than letting it escape past the bookkeeping.
      const promise = (async () => work())().finally(() => {
        inFlight.delete(key);
      });
      inFlight.set(key, promise);
      return promise;
    },
    get size() {
      return inFlight.size;
    },
  };
}
