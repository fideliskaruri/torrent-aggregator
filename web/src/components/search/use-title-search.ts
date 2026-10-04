import { useCallback, useEffect, useRef, useState } from "react";
import { get } from "@/lib/api";
import {
  DEFAULT_SCOPE_ID,
} from "@/lib/torrents/search-scopes";
import {
  parseWorkSearchScope,
  type WorkSearchScope,
} from "@/lib/search/work-search";
import { partialResultsNotice } from "./partial-results-notice";
import { titlesFromSearchHits } from "./title-search";
import type { TitleResult } from "./group-titles";
import {
  searchErrorMessage,
  searchRequestFor,
  searchUrlFor,
} from "./search-overlay-state";

export function useTitleSearch() {
  const [query, setQuery] = useState("");
  const [scopeId, setScopeId] = useState<WorkSearchScope>(DEFAULT_SCOPE_ID);
  const [titles, setTitles] = useState<TitleResult[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reqIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(false);
  const activeRef = useRef(false);

  const canCommit = useCallback((reqId: number) => {
    return mountedRef.current && activeRef.current && reqId === reqIdRef.current;
  }, []);

  const runSearch = useCallback((q: string, scope: WorkSearchScope) => {
    if (!mountedRef.current || !activeRef.current) return;
    const request = searchRequestFor(scope, q);
    if (!request) {
      setTitles([]);
      setError(null);
      setNotice(null);
      setLoading(false);
      return;
    }
    const reqId = ++reqIdRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    setNotice(null);

    get(request.url, { signal: controller.signal })
      .then(async (res) => {
        const json = (await res.json().catch(() => null)) as {
          results?: unknown;
          error?: string | null;
          partial?: boolean;
          failedProviders?: string[];
        } | null;
        if (!canCommit(reqId)) return;
        if (!res.ok) {
          setTitles([]);
          setNotice(null);
          setError(searchErrorMessage(res.status, json));
          setLoading(false);
          return;
        }
        setTitles(
          titlesFromSearchHits(
            (json?.results ?? []) as Parameters<typeof titlesFromSearchHits>[0],
          ),
        );
        setNotice(
          partialResultsNotice({
            partial: json?.partial,
            failedProviders: json?.failedProviders,
          }),
        );
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        if (!canCommit(reqId)) return;
        setTitles([]);
        setNotice(null);
        setError("Could not reach the server.");
        setLoading(false);
      });
  }, [canCommit]);

  const cancelPending = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = null;
    abortRef.current?.abort();
  }, []);

  const openSearch = useCallback((initialQuery: string, initialScope: unknown) => {
    activeRef.current = true;
    const category = parseWorkSearchScope(initialScope);
    setScopeId(category);
    setQuery(initialQuery);
    setTitles([]);
    setError(null);
    setNotice(null);
    if (initialQuery) runSearch(initialQuery, category);
    else setLoading(false);
  }, [runSearch]);

  const deactivate = useCallback(() => {
    activeRef.current = false;
    cancelPending();
  }, [cancelPending]);

  const onQueryChange = useCallback((value: string) => {
    setQuery(value);
    if (window.location.pathname === "/search") {
      window.history.replaceState(
        window.history.state,
        "",
        searchUrlFor(value, scopeId),
      );
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (value.trim().length < 2) {
      abortRef.current?.abort();
      setTitles([]);
      setError(null);
      setNotice(null);
      setLoading(false);
      return;
    }
    debounceRef.current = setTimeout(() => runSearch(value, scopeId), 220);
  }, [runSearch, scopeId]);

  const onScopeChange = useCallback((next: WorkSearchScope) => {
    if (next === scopeId) return;
    setScopeId(next);
    cancelPending();
    setTitles([]);
    setError(null);
    setNotice(null);
    if (window.location.pathname === "/search") {
      window.history.replaceState(
        window.history.state,
        "",
        searchUrlFor(query, next),
      );
    }
    if (query.trim().length >= 2) runSearch(query, next);
    else setLoading(false);
  }, [cancelPending, query, runSearch, scopeId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      activeRef.current = false;
      cancelPending();
    };
  }, [cancelPending]);

  return {
    query,
    scopeId,
    titles,
    notice,
    error,
    loading,
    openSearch,
    deactivate,
    runSearch,
    onQueryChange,
    onScopeChange,
  };
}

export type TitleSearchState = ReturnType<typeof useTitleSearch>;
