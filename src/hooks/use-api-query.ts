"use client";

/**
 * `useApiQuery` — one honest answer to "what is this panel doing right now?"
 *
 * Every client page had grown the same `useEffect` + `fetch` + `cancelled`
 * flag, and every copy lost the same piece of information: the difference
 * between *empty* and *broken*.
 *
 * `/history` was the clearest case. Its effect was `try { … } finally {
 * setLoading(false) }` with no `catch`. A rejected fetch — server restarting,
 * laptop asleep, DB unreachable — skipped the assignment, cleared the spinner,
 * and rendered the empty state: **"No downloads yet."** The user is told, with
 * confidence, that their download log is empty, when in fact it could not be
 * read. There is no retry, because as far as the UI is concerned nothing went
 * wrong. That is the worst failure a data panel can have: it does not look
 * like a failure.
 *
 * So this hook makes the four states explicit and mutually exclusive —
 * `loading`, `error`, `data`, and the caller's own notion of empty — and
 * refuses to let a failure be silently narrowed into an empty result. If a
 * request throws, `error` is set and `data` is left at whatever last
 * succeeded, so a refresh that fails does not blank out a screen the user was
 * already reading.
 *
 * Deliberately not a data-fetching library. This app has one user and no
 * cache-invalidation problem; adding React Query to get `isLoading` would be
 * paying for a graph we do not have. What it does add over a raw effect is
 * the part every hand-rolled copy got wrong: cancellation on unmount, a
 * cancellation that does *not* surface as an error, and a `refetch` that a
 * retry button can call.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export type ApiQueryState<T> = {
  data: T | null;
  /** True only for a load with nothing to show yet — never for a refetch. */
  loading: boolean;
  /** True while a refetch runs over data already on screen. */
  refreshing: boolean;
  /** Human-readable failure, or null. Never set for an aborted request. */
  error: string | null;
  /** Re-runs the request. Safe to wire straight to a retry button. */
  refetch: () => void;
};

export type UseApiQueryOptions<T> = {
  /** Re-runs the request whenever any value here changes (like deps). */
  deps?: readonly unknown[];
  /** Skip fetching entirely — for queries that depend on something not ready. */
  enabled?: boolean;
  /** Poll interval in ms. Omitted or <= 0 means no polling. */
  refreshMs?: number;
  /**
   * Turns a response into data. Defaults to `res.json()`.
   *
   * A 401 is *not* an error here by default: this app renders signed-out
   * states as empty panels rather than alarming the user, which is the one
   * piece of the old hand-rolled `if (res.status === 401)` branch worth
   * keeping.
   */
  select?: (json: unknown) => T;
  /** Treat 401 as an empty result rather than an error. Defaults to true. */
  emptyOnUnauthorized?: boolean;
};

function messageFor(err: unknown): string {
  if (err instanceof Error) {
    // A bare "Failed to fetch" tells the user nothing they can act on.
    if (/fetch/i.test(err.message) && /fail/i.test(err.message)) {
      return "Could not reach the server. Check that it is still running.";
    }
    return err.message;
  }
  return "Something went wrong loading this.";
}

export function useApiQuery<T = unknown>(
  url: string | null,
  options: UseApiQueryOptions<T> = {},
): ApiQueryState<T> {
  const {
    deps = [],
    enabled = true,
    refreshMs = 0,
    select,
    emptyOnUnauthorized = true,
  } = options;

  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState<boolean>(Boolean(url) && enabled);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Whether this query is currently supposed to be running at all. */
  const active = Boolean(url) && enabled;

  // A counter rather than a boolean: `refetch` must be able to re-run the
  // effect even when nothing else changed.
  const [attempt, setAttempt] = useState(0);

  // Held in a ref so the effect does not re-run when the caller passes a new
  // inline `select` on every render — the single most common way a fetch
  // effect turns into an infinite loop.
  //
  // Synced in an effect rather than assigned during render: a render can be
  // thrown away or replayed under concurrent rendering, and mutating a ref
  // there would leak that discarded render's closure into the next commit.
  // This effect is declared *before* the fetch effect so it always commits
  // first, which means `selectRef.current` is current by the time a fetch
  // triggered by the same render runs.
  const selectRef = useRef(select);
  useEffect(() => {
    selectRef.current = select;
  });

  // Whether anything has ever loaded, so a failing *refresh* is reported as a
  // refresh failure and does not blank the screen.
  const hasDataRef = useRef(false);

  const refetch = useCallback(() => {
    setAttempt((n) => n + 1);
  }, []);

  useEffect(() => {
    // No URL, or the caller says this query is not ready: nothing to do, and
    // nothing to unset. `loading` is derived from `active` on the way out, so
    // this path does not need to write state — writing it here would schedule
    // a cascading render on every disabled render pass.
    if (!active || !url) return;

    const controller = new AbortController();
    let cancelled = false;

    if (hasDataRef.current) setRefreshing(true);
    else setLoading(true);

    void (async () => {
      try {
        const res = await fetch(url, { signal: controller.signal });

        if (res.status === 401 && emptyOnUnauthorized) {
          if (!cancelled) {
            setData(null);
            setError(null);
            hasDataRef.current = true;
          }
          return;
        }

        if (!res.ok) {
          // Prefer the API's own message; a status code alone is not an
          // explanation a user can do anything with.
          let detail = "";
          try {
            const body = (await res.json()) as { error?: unknown };
            if (typeof body?.error === "string") detail = body.error;
          } catch {
            // Non-JSON error body. The status line is all we have.
          }
          throw new Error(detail || `Request failed (${res.status})`);
        }

        const json: unknown = await res.json();
        if (cancelled) return;

        const next = selectRef.current
          ? selectRef.current(json)
          : (json as T);

        setData(next);
        setError(null);
        hasDataRef.current = true;
      } catch (err) {
        // An abort is this component unmounting or re-querying. It is not a
        // failure and must never be shown as one.
        if (cancelled || (err as Error)?.name === "AbortError") return;
        setError(messageFor(err));
      } finally {
        if (!cancelled) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, active, attempt, emptyOnUnauthorized, ...deps]);

  // Polling is a separate effect so changing the interval does not cancel an
  // in-flight request.
  useEffect(() => {
    if (!url || !enabled || !refreshMs || refreshMs <= 0) return;
    const id = setInterval(() => setAttempt((n) => n + 1), refreshMs);
    return () => clearInterval(id);
  }, [url, enabled, refreshMs]);

  return {
    data,
    // Derived, not stored: a disabled query is not "loading", and deriving it
    // means flipping `enabled` cannot leave a stale spinner on screen.
    loading: active && loading,
    refreshing: active && refreshing,
    error,
    refetch,
  };
}
