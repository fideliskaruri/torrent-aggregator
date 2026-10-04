import { useCallback, useEffect, useRef, useState } from "react";
import { useVisiblePoll } from "@/hooks/use-visible-poll";
import { ApiError, get } from "@/lib/api";
import { requestDeadlineMs } from "@/lib/observability/poll-schedule";

export type ApiQueryState<T> = {
  data: T | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  settled: boolean;
  refetch: () => void;
};

export type UseApiQueryOptions<T> = {
  deps?: readonly unknown[];
  enabled?: boolean;
  refreshMs?: number;
  select?: (json: unknown) => T;
  emptyOnUnauthorized?: boolean;
  dataIdentity?: string | null;
};

type RequestOwner = { generation: number; startedAt: number };

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
    dataIdentity = url,
  } = options;
  const active = Boolean(url) && enabled;
  const [data, setData] = useState<T | null>(null);
  const [storedIdentity, setStoredIdentity] = useState<string | null>(null);
  const [loading, setLoading] = useState(active);
  const [refreshing, setRefreshing] = useState(false);
  const [errorState, setErrorState] = useState<{ url: string; message: string } | null>(null);
  const [settledUrl, setSettledUrl] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const requestRef = useRef<RequestOwner | null>(null);
  const generationRef = useRef(0);
  const settledOnceRef = useRef(false);
  const selectRef = useRef(select);
  const settleTickRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    selectRef.current = select;
  });

  const refetch = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    if (!active || !url) return;
    const generation = ++generationRef.current;
    const controller = new AbortController();
    const request = { generation, startedAt: Date.now() };
    requestRef.current = request;
    if (storedIdentity === dataIdentity) {
      setRefreshing(true);
    } else {
      setLoading(true);
      setRefreshing(false);
    }

    void (async () => {
      try {
        const result = await get<unknown>(url, { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (result.status === 401 && emptyOnUnauthorized) {
          setData(null);
          setStoredIdentity(dataIdentity);
          setErrorState(null);
        } else if (!result.ok) {
          throw result.error ?? new ApiError(`Request failed (${result.status})`, result.status);
        } else {
          const next = selectRef.current
            ? selectRef.current(result.data)
            : (result.data as T);
          setData(next);
          setStoredIdentity(dataIdentity);
          setErrorState(null);
        }
      } catch (cause) {
        if (controller.signal.aborted || (cause as Error)?.name === "AbortError") return;
        const message = cause instanceof Error ? cause.message : "Something went wrong loading this.";
        setErrorState({ url, message });
      } finally {
        const ownsRequest = requestRef.current?.generation === generation;
        if (ownsRequest) requestRef.current = null;
        if (!controller.signal.aborted) settledOnceRef.current = true;
        if (ownsRequest) {
          settleTickRef.current?.();
          settleTickRef.current = null;
        }
        if (!controller.signal.aborted) {
          setLoading(false);
          setRefreshing(false);
          setSettledUrl(url);
        }
      }
    })();

    return () => {
      controller.abort();
      if (requestRef.current?.generation === generation) requestRef.current = null;
      settleTickRef.current?.();
      settleTickRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, active, attempt, emptyOnUnauthorized, dataIdentity, ...deps]);

  const pollOnce = useCallback(() => {
    const request = requestRef.current;
    const deadline = requestDeadlineMs(refreshMs, !settledOnceRef.current);
    if (request && Date.now() - request.startedAt < deadline) {
      return new Promise<void>((resolve) => {
        const timer = setTimeout(done, deadline - (Date.now() - request.startedAt));
        function done() {
          clearTimeout(timer);
          if (settleTickRef.current === done) settleTickRef.current = null;
          resolve();
        }
        settleTickRef.current = done;
      });
    }

    setAttempt((value) => value + 1);
    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, deadline);
      function done() {
        clearTimeout(timer);
        if (settleTickRef.current === done) settleTickRef.current = null;
        resolve();
      }
      settleTickRef.current = done;
    });
  }, [refreshMs]);

  useVisiblePoll(pollOnce, { intervalMs: refreshMs, enabled: active });

  const identityMatches = storedIdentity === dataIdentity;
  const visibleError = errorState?.url === url ? errorState.message : null;
  return {
    data: identityMatches ? data : null,
    loading: active && !identityMatches && visibleError == null && (loading || settledUrl !== url),
    refreshing: active && identityMatches && refreshing,
    error: visibleError,
    settled: active ? settledUrl === url : false,
    refetch,
  };
}
