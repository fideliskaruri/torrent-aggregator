/**
 * Mirror failover for public indexer APIs.
 *
 * Every adapter used to hardcode one hostname. When that host went away the
 * whole source went dark and the app reported "no results" — which is the same
 * sentence it uses when the indexer answered and genuinely had nothing. Two
 * very different facts, one message.
 *
 * This was not hypothetical: `yts.mx` stopped resolving while `yts.lt` and
 * `movies-api.accel.li` both answered normally, so YTS contributed nothing to
 * any search — quietly narrowing the pool that ranking picks from, which is
 * exactly how a 480p release ends up winning.
 *
 * The working host is remembered for the process lifetime, so the common case
 * is still one request; failover cost is paid once per outage, not per search.
 */

/** Remembered good host per adapter, so failover is not re-paid every search. */
const preferred = new Map<string, string>();

/** Statuses that mean "this host is not serving the API", not "bad request". */
function isHostFailure(status: number): boolean {
  // 403 is how Cloudflare-fronted mirrors answer; 404 means this mirror does
  // not host the API path at all; 5xx is the mirror being down.
  return status === 403 || status === 404 || status === 429 || status >= 500;
}

export interface MirrorFetchOptions {
  /** Stable key for remembering which host worked (usually the adapter id). */
  key: string;
  /** Candidate API roots, best first. */
  hosts: readonly string[];
  /** Builds the full URL from one host root. */
  path: (host: string) => string;
  init?: RequestInit;
}

/**
 * Fetches from the first host that actually serves the API.
 *
 * Throws the last failure when every mirror is exhausted, so the caller still
 * reports an honest source error rather than an empty result set.
 */
export async function fetchFromMirrors({
  key,
  hosts,
  path,
  init,
}: MirrorFetchOptions): Promise<Response> {
  const good = preferred.get(key);
  const ordered = good
    ? [good, ...hosts.filter((h) => h !== good)]
    : [...hosts];

  let lastError: Error | null = null;

  for (const host of ordered) {
    try {
      const res = await fetch(path(host), init);
      if (isHostFailure(res.status)) {
        lastError = new Error(`${host} HTTP ${res.status}`);
        // A previously-good host that started failing must not stay preferred.
        if (preferred.get(key) === host) preferred.delete(key);
        continue;
      }
      preferred.set(key, host);
      return res;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (preferred.get(key) === host) preferred.delete(key);
    }
  }

  throw lastError ?? new Error(`${key}: no mirrors configured`);
}

/**
 * Splits a comma-separated env override into hosts, falling back to defaults.
 * Lets a user point at their own mirror without a code change.
 */
export function mirrorList(
  envValue: string | undefined,
  defaults: readonly string[],
): readonly string[] {
  const custom = (envValue ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  return custom.length ? custom : defaults;
}
