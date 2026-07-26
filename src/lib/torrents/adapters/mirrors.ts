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

/** Remembered good host per adapter, so failover is not re-paid every search.
 *
 * Module-level, therefore per-runtime: under Next.js each worker learns its own
 * winner, and a restart re-probes. That is accepted rather than persisted — the
 * cost is one extra request per worker per outage, and a stored "good host"
 * that has since died is worse than re-learning. */
const preferred = new Map<string, string>();

/**
 * Statuses that mean "this host is not serving the API", not "bad request".
 *
 * 404 is deliberately conditional. A host we have never had a good response
 * from probably does not host the API at this path, so 404 means "wrong
 * mirror". But a host that has already answered correctly returning 404 almost
 * certainly means "nothing for this query" — several torrent APIs answer that
 * way — and demoting it would turn an empty result into a reported outage,
 * which is the exact conflation this module exists to prevent.
 */
function isHostFailure(status: number, hostIsProven: boolean): boolean {
  if (status === 404) return !hostIsProven;
  // 403 is how Cloudflare-fronted mirrors answer; 5xx is the mirror being down.
  return status === 403 || status === 429 || status >= 500;
}

/**
 * A challenge page is served as HTTP 200 with an HTML body.
 *
 * Status alone is not enough: apibay's Cloudflare interstitial answers 200
 * "Just a moment…", which would pass every status check, get pinned as the
 * preferred host, and then throw in the adapter's `res.json()` on every future
 * search — no failover would ever happen. That is precisely the failure this
 * module was written for, so the body type is checked before a host is trusted.
 */
function looksLikeApi(res: Response): boolean {
  const type = res.headers.get("content-type") ?? "";
  return /json|text\/plain/i.test(type);
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
    const hostIsProven = good === host;
    try {
      const res = await fetch(path(host), init);
      if (isHostFailure(res.status, hostIsProven)) {
        lastError = new Error(`${host} HTTP ${res.status}`);
        // A previously-good host that started failing must not stay preferred.
        if (preferred.get(key) === host) preferred.delete(key);
        continue;
      }
      if (res.ok && !looksLikeApi(res)) {
        lastError = new Error(`${host} returned a non-API response`);
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
 * Merges a comma-separated env override with the built-in mirrors.
 *
 * The override leads but does not replace: a user setting YTS_BASE_URL to add
 * their own mirror would otherwise *remove* the two working fallbacks and
 * recreate the single-point-of-failure this module exists to fix.
 */
export function mirrorList(
  envValue: string | undefined,
  defaults: readonly string[],
): readonly string[] {
  const custom = (envValue ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  if (!custom.length) return defaults;
  return [...custom, ...defaults.filter((d) => !custom.includes(d))];
}
