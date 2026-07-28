"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle } from "lucide-react";
import type { SearchResponse } from "@/lib/torrents/types";
import { Button } from "@/components/ui/button";
import { groupTitles } from "./group-titles";
import { TitleResultsList } from "./title-results-list";
import { buildSearchQuery, DEFAULT_PAGE_SIZE } from "./pagination";

interface SearchResultsProps {
  query: string;
  category?: string;
}

/**
 * Search results — title-centric.
 *
 * A query yields one card per work (best match first, the rest in server rank
 * order), releases hidden behind each card's expander. There is deliberately
 * no toolbar: no result count, no source/quality filters, no density toggle,
 * no refresh, no season/pack tabs, no "cached" — that chrome narrated
 * mechanism the two-action product does not want on this surface.
 */
export function SearchResults({ query, category = "all" }: SearchResultsProps) {
  const [data, setData] = useState<SearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    if (!query) {
      setData(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const qs = buildSearchQuery({
        query,
        page: 1,
        pageSize: DEFAULT_PAGE_SIZE,
        category,
      });
      const res = await fetch(`/api/search?${qs}`);
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.message || json.error || "Search failed");
      }
      setData(json as SearchResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [query, category]);

  useEffect(() => {
    // Results are external API state keyed on the query; fetch them in an effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const titles = useMemo(
    () => (data?.results?.length ? groupTitles(data.results) : []),
    [data],
  );

  // Keyboard: arrow/j/k move focus through cards, Enter opens (the focused
  // card's body link handles Enter itself).
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
            onClick={() => void load()}
          >
            Retry
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div ref={listRef}>
      <TitleResultsList
        titles={titles}
        loading={loading}
        query={query}
        searchCategory={category}
      />
    </div>
  );
}
