"use client";

import { useRouter } from "next/navigation";
import {
  FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Clock, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";

const CATEGORIES = [
  { value: "all", label: "All" },
  { value: "anime", label: "Anime" },
  { value: "movies", label: "Movies" },
  { value: "tv", label: "TV" },
  { value: "music", label: "Music" },
  { value: "games", label: "Games" },
  { value: "apps", label: "Apps" },
] as const;

const RECENT_KEY = "tf-recent-searches";

interface SearchBarProps {
  initialQuery?: string;
  initialCategory?: string;
  size?: "hero" | "compact";
  className?: string;
}

interface Suggestion {
  title: string;
  mediaType: string;
  posterUrl?: string | null;
  year?: number | null;
}

export function SearchBar({
  initialQuery = "",
  initialCategory = "all",
  size = "hero",
  className,
}: SearchBarProps) {
  const router = useRouter();
  const [query, setQuery] = useState(initialQuery);
  const [category, setCategory] = useState(initialCategory);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [recent, setRecent] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const boxRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(RECENT_KEY);
      if (raw) setRecent(JSON.parse(raw) as string[]);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const fetchSuggestions = useCallback((q: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (q.trim().length < 2) {
      setSuggestions([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/suggest?q=${encodeURIComponent(q.trim())}`,
        );
        const data = await res.json();
        setSuggestions(data.suggestions ?? []);
      } catch {
        setSuggestions([]);
      }
    }, 220);
  }, []);

  function pushRecent(q: string) {
    const next = [q, ...recent.filter((r) => r !== q)].slice(0, 8);
    setRecent(next);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  }

  function clearRecent() {
    setRecent([]);
    localStorage.removeItem(RECENT_KEY);
    setActiveIdx(-1);
  }

  function removeRecent(item: string) {
    const next = recent.filter((r) => r !== item);
    setRecent(next);
    if (next.length) {
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } else {
      localStorage.removeItem(RECENT_KEY);
    }
    setActiveIdx(-1);
  }

  function go(q: string, cat = category) {
    const trimmed = q.trim();
    if (!trimmed) return;
    pushRecent(trimmed);
    setOpen(false);
    const params = new URLSearchParams({ q: trimmed });
    if (cat && cat !== "all") params.set("category", cat);
    // Results live on home — keep a single search surface
    router.push(`/?${params.toString()}`);
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (activeIdx >= 0 && suggestions[activeIdx]) {
      const s = suggestions[activeIdx];
      const cat =
        s.mediaType === "anime"
          ? "anime"
          : s.mediaType === "movie"
            ? "movies"
            : s.mediaType === "tv"
              ? "tv"
              : category;
      go(s.title, cat);
      return;
    }
    go(query);
  }

  const isHero = size === "hero";
  const showPanel =
    open && (suggestions.length > 0 || (recent.length > 0 && !query.trim()));

  return (
    <form onSubmit={onSubmit} className={cn("w-full", className)} role="search">
      <div ref={boxRef} className="relative">
        <div
          className={cn(
            "search-bar-shell flex items-stretch rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-elevated)] overflow-hidden focus-within:border-[var(--accent)] focus-within:shadow-[0_0_0_3px_var(--accent-dim)] transition-[border-color,box-shadow] w-full max-w-full",
            isHero ? "sm:h-12" : "sm:h-11",
          )}
        >
          <div className="relative flex-1 flex items-center min-w-0 w-full">
            <Search className="pointer-events-none absolute left-3 h-4 w-4 text-[var(--text-tertiary)]" />
            <input
              type="search"
              data-search-input="true"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActiveIdx(-1);
                fetchSuggestions(e.target.value);
                setOpen(true);
              }}
              onFocus={() => setOpen(true)}
              onKeyDown={(e) => {
                if (!showPanel) return;
                const max =
                  suggestions.length ||
                  (query.trim() ? 0 : recent.length) - 1;
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActiveIdx((i) => Math.min(i + 1, max));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActiveIdx((i) => Math.max(i - 1, -1));
                } else if (e.key === "Escape") {
                  setOpen(false);
                }
              }}
              placeholder="Search titles, releases…"
              className={cn(
                "w-full min-w-0 bg-transparent border-0 pl-10 pr-9 py-3 sm:py-0 text-[var(--text)] outline-none placeholder:text-[var(--text-tertiary)]",
                isHero ? "text-[15px]" : "text-sm",
              )}
              autoComplete="off"
              spellCheck={false}
            />
            {query && (
              <button
                type="button"
                className="absolute right-2.5 p-1 text-[var(--text-tertiary)] hover:text-[var(--text)]"
                onClick={() => {
                  setQuery("");
                  setSuggestions([]);
                }}
                aria-label="Clear"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          <div className="search-bar-actions flex items-stretch shrink-0 min-w-0">
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="min-w-0 flex-1 sm:flex-none bg-transparent border-0 px-3 py-2.5 sm:py-0 text-[12px] text-[var(--text-secondary)] outline-none cursor-pointer hover:text-[var(--text)]"
              aria-label="Category"
            >
              {CATEGORIES.map((c) => (
                <option key={c.value} value={c.value} className="bg-[var(--bg-elevated)]">
                  {c.label}
                </option>
              ))}
            </select>
            <button
              type="submit"
              className="px-4 py-2.5 sm:py-0 text-[13px] font-medium bg-[var(--accent)] text-[var(--primary-foreground)] hover:bg-[var(--accent-hover)] border-l border-[var(--border)] shrink-0"
            >
              Search
            </button>
          </div>
        </div>

        {showPanel && (
          <div className="absolute z-40 mt-1.5 left-0 right-0 w-full max-w-full surface shadow-[var(--shadow-md)] overflow-hidden max-h-[min(60vh,320px)] overflow-y-auto">
            {!query.trim() && recent.length > 0 && (
              <div className="py-1">
                <div className="flex items-center justify-between gap-2 px-3 py-1.5">
                  <p className="text-[10px] uppercase tracking-wider text-[var(--text-tertiary)]">
                    Recent
                  </p>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      clearRecent();
                    }}
                    className="text-[11px] text-[var(--text-tertiary)] hover:text-[var(--accent-text)] transition-colors"
                  >
                    Clear all
                  </button>
                </div>
                {recent.map((r, i) => (
                  <div
                    key={r}
                    className={cn(
                      "flex w-full items-center gap-1 pr-1 text-[13px] text-[var(--text-secondary)] hover:bg-[var(--bg-muted)]",
                      activeIdx === i && "bg-[var(--bg-muted)] text-[var(--text)]",
                    )}
                    onMouseEnter={() => setActiveIdx(i)}
                  >
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2 text-left"
                      onClick={() => go(r)}
                    >
                      <Clock className="h-3.5 w-3.5 shrink-0 text-[var(--text-tertiary)]" />
                      <span className="truncate">{r}</span>
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        removeRecent(r);
                      }}
                      className="shrink-0 rounded-md p-1.5 text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
                      aria-label={`Remove “${r}” from history`}
                      title="Remove"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {suggestions.length > 0 && (
              <div className="py-1 border-t border-[var(--border)]">
                <p className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-[var(--text-tertiary)]">
                  Suggestions
                </p>
                {suggestions.map((s, i) => (
                  <button
                    key={`${s.title}-${s.mediaType}`}
                    type="button"
                    className={cn(
                      "flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-[var(--bg-muted)]",
                      activeIdx === i && "bg-[var(--bg-muted)]",
                    )}
                    onMouseEnter={() => setActiveIdx(i)}
                    onClick={() => {
                      const cat =
                        s.mediaType === "anime"
                          ? "anime"
                          : s.mediaType === "movie"
                            ? "movies"
                            : s.mediaType === "tv"
                              ? "tv"
                              : category;
                      go(s.title, cat);
                    }}
                  >
                    {s.posterUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={s.posterUrl}
                        alt=""
                        className="h-9 w-6 rounded-[3px] object-cover bg-[var(--bg-muted)]"
                      />
                    ) : (
                      <div className="h-9 w-6 rounded-[3px] bg-[var(--bg-muted)]" />
                    )}
                    <div className="min-w-0">
                      <p className="text-[13px] text-[var(--text)] truncate">
                        {s.title}
                      </p>
                      <p className="text-[11px] text-[var(--text-tertiary)] capitalize">
                        {s.mediaType}
                        {s.year ? ` · ${s.year}` : ""}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </form>
  );
}
