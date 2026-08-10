"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TitleResultsList } from "./title-results-list";
import { titlesFromSearchHits } from "./title-search";
import { partialResultsNotice } from "./partial-results-notice";
import type { TitleResult } from "./group-titles";
import {
  parseWorkSearchScope,
  type WorkSearchScope,
} from "@/lib/search/work-search";

interface SearchResultsProps {
  query: string;
  category?: string;
}

/**
 * Full-page title results (legacy surface). Same TMDB discovery path as the
 * overlay — never hits torrent indexers.
 */
export function SearchResults({ query, category }: SearchResultsProps) {
  const [titles, setTitles] = useState<TitleResult[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [retryNonce, setRetryNonce] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async (signal: AbortSignal) => {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      setTitles([]);
      setNotice(null);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const normalizedCategory: WorkSearchScope =
        parseWorkSearchScope(category);
      const qs = new URLSearchParams({
        q: trimmedQuery,
        category: normalizedCategory,
        limit: "20",
      });
      const res = await fetch(`/api/search/titles?${qs}`, { signal });
      const json = (await res.json()) as {
        results?: Parameters<typeof titlesFromSearchHits>[0];
        message?: string;
        error?: string;
        partial?: boolean;
        failedProviders?: string[];
      };
      if (signal.aborted) return;
      if (!res.ok) {
        throw new Error(json.message || json.error || "Search failed");
      }
      setTitles(titlesFromSearchHits(json.results ?? []));
      // A partial answer stays a success: the categories that responded are
      // rendered, with one line naming the ones that did not.
      setNotice(
        partialResultsNotice({
          partial: json.partial,
          failedProviders: json.failedProviders,
        }),
      );
    } catch (err) {
      if ((err as Error)?.name === "AbortError" || signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
      setTitles([]);
      setNotice(null);
    } finally {
      if (signal.aborted) return;
      setLoading(false);
    }
  }, [category, query]);

  useEffect(() => {
    const controller = new AbortController();
    // Results are external API state keyed on the query; fetch them in an effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(controller.signal);
    return () => controller.abort();
  }, [load, retryNonce]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (
        e.key !== "j" &&
        e.key !== "k" &&
        e.key !== "ArrowDown" &&
        e.key !== "ArrowUp"
      )
        return;
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;

      const cards = Array.from(
        listRef.current?.querySelectorAll<HTMLElement>(
          '[data-card-target="title"]',
        ) ?? [],
      );
      if (!cards.length) return;

      const focused = document.activeElement as HTMLElement | null;
      let idx = cards.findIndex((c) => c === focused || c.contains(focused));
      const down = e.key === "j" || e.key === "ArrowDown";
      e.preventDefault();
      idx = down ? Math.min(idx + 1, cards.length - 1) : Math.max(idx - 1, 0);
      if (idx < 0) idx = 0;
      cards[idx].focus();
      cards[idx].scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (error) {
    return (
      <div className="surface flex items-start gap-3 p-5">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--danger)]" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-[var(--text)]">
            Search failed
          </p>
          <p className="mt-1 text-[13px] text-[var(--text-tertiary)]">
            {error}
          </p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="mt-3"
            onClick={() => setRetryNonce((n) => n + 1)}
          >
            Retry
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div ref={listRef}>
      {notice ? (
        <div
          className="surface mb-3 flex items-start gap-3 p-3"
          role="status"
          aria-live="polite"
          data-partial-notice
        >
          <AlertTriangle
            className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent)]"
            aria-hidden
          />
          <p className="min-w-0 text-[13px] text-[var(--text-secondary)]">
            {notice}
          </p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="ml-auto shrink-0"
            onClick={() => setRetryNonce((n) => n + 1)}
          >
            Try again
          </Button>
        </div>
      ) : null}
      <TitleResultsList titles={titles} loading={loading} query={query} />
    </div>
  );
}
