"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TitleResultsList } from "./title-results-list";
import { titlesFromSearchHits } from "./title-search";
import type { TitleResult } from "./group-titles";
import {
  parseWorkSearchCategory,
  type WorkSearchCategory,
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
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    if (!query) {
      setTitles([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const normalizedCategory: WorkSearchCategory =
        parseWorkSearchCategory(category);
      const qs = new URLSearchParams({
        q: query,
        category: normalizedCategory,
        limit: "20",
      });
      const res = await fetch(`/api/search/titles?${qs}`);
      const json = (await res.json()) as {
        results?: Parameters<typeof titlesFromSearchHits>[0];
        message?: string;
        error?: string;
      };
      if (!res.ok) {
        throw new Error(json.message || json.error || "Search failed");
      }
      setTitles(titlesFromSearchHits(json.results ?? []));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setTitles([]);
    } finally {
      setLoading(false);
    }
  }, [category, query]);

  useEffect(() => {
    // Results are external API state keyed on the query; fetch them in an effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

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
      <TitleResultsList titles={titles} loading={loading} query={query} />
    </div>
  );
}
