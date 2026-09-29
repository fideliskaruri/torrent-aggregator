import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useLocation } from "react-router";
import { AlertTriangle, Search, SearchX, X } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { documentTitleFor } from "@/hooks/use-document-title";
import { SEARCH_HREF } from "@/lib/navigation";
import { TitleResultsList } from "./title-results-list";
import { titlesFromSearchHits } from "./title-search";
import { partialResultsNotice } from "./partial-results-notice";
import type { TitleResult } from "./group-titles";
import {
  DEFAULT_SCOPE_ID,
  SEARCH_SCOPES,
} from "@/lib/torrents/search-scopes";
import {
  parseWorkSearchScope,
  type WorkSearchScope,
} from "@/lib/search/work-search";
import {
  placeholderFor,
  searchDisplayFor,
  searchErrorMessage,
  searchRequestFor,
  searchUrlFor,
} from "./search-overlay-state";

/** The window event that asks the overlay to open. */
const OPEN_EVENT = "tf:open-search";

/**
 * Open the search palette from anywhere — the `/` shortcut and the header's
 * Search affordance both call this. A window event keeps the trigger decoupled
 * from where the overlay is mounted, so nothing has to thread a callback down
 * the tree.
 */
export function openSearchOverlay(
  initialQuery?: string,
  options: {
    preserveUrl?: boolean;
    category?: WorkSearchScope;
  } = {},
) {
  window.dispatchEvent(
    new CustomEvent(OPEN_EVENT, {
      detail: {
        query: initialQuery ?? "",
        preserveUrl: options.preserveUrl ?? false,
        category: options.category ?? DEFAULT_SCOPE_ID,
      },
    }),
  );
}

/**
 * Search as an overlay, not a page.
 *
 * Every category returns canonical works. The only result interaction is the
 * title link; acquisition starts on the title page, never in discovery.
 */
export function SearchOverlay() {
  const pathname = useLocation().pathname;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [scopeId, setScopeId] =
    useState<WorkSearchScope>(DEFAULT_SCOPE_ID);
  const [titles, setTitles] = useState<TitleResult[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  // Arrow keys on the scope tabs move focus along the tabs; a click hands it
  // back to the query box.
  const tabKeyNavRef = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reqIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const returnUrlRef = useRef<string | null>(null);
  const ownsSearchUrlRef = useRef(false);
  const openRef = useRef(false);
  const mountedRef = useRef(false);
  const activeRef = useRef(false);

  const close = useCallback(() => {
    activeRef.current = false;
    openRef.current = false;
    setOpen(false);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    abortRef.current?.abort();
    if (
      ownsSearchUrlRef.current &&
      window.location.pathname === "/search" &&
      returnUrlRef.current
    ) {
      window.history.back();
    }
    ownsSearchUrlRef.current = false;
    returnUrlRef.current = null;
  }, []);

  const canCommit = useCallback((reqId: number) => {
    return mountedRef.current && activeRef.current && reqId === reqIdRef.current;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      activeRef.current = false;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      abortRef.current?.abort();
    };
  }, []);

  // Open on the global event; set the query if one was passed. Focus is handled
  // by a dedicated effect below, once the input is actually mounted.
  useEffect(() => {
    function onOpen(e: Event) {
      const detail = (
        e as CustomEvent<{
          query?: string;
          preserveUrl?: boolean;
          category?: WorkSearchScope;
        }>
      ).detail;
      activeRef.current = true;
      const category = parseWorkSearchScope(detail?.category);
      if (!openRef.current) {
        openerRef.current =
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        if (!detail?.preserveUrl && window.location.pathname !== "/search") {
          returnUrlRef.current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
          ownsSearchUrlRef.current = true;
          window.history.pushState(
            null,
            "",
            searchUrlFor(detail?.query ?? "", category),
          );
        }
      }
      openRef.current = true;
      setOpen(true);
      setScopeId(category);
      setQuery(detail?.query ?? "");
      setTitles([]);
      setError(null);
      setNotice(null);
      if (detail?.query) {
        runSearch(detail.query, category);
      } else {
        setLoading(false);
      }
    }
    window.addEventListener(OPEN_EVENT, onOpen as EventListener);
    return () => window.removeEventListener(OPEN_EVENT, onOpen as EventListener);
  }, []);

  // Let the title link complete its own Next navigation. Closing from the
  // results click handler unmounted that link during the same event and raced
  // the router; the owned /search history entry won and sent users home.
  useEffect(() => {
    if (!open || window.location.pathname === "/search") return;
    openerRef.current = null;
    const frame = requestAnimationFrame(close);
    return () => cancelAnimationFrame(frame);
  }, [open, pathname, close]);

  // The overlay puts /search in the address bar without a router navigation,
  // so the route title never changes. Name the tab while it is open, and give
  // the page underneath its title back unless something renamed the tab since.
  useEffect(() => {
    if (!open) return;
    const previous = document.title;
    const applied = documentTitleFor(SEARCH_HREF);
    document.title = applied;
    return () => {
      if (document.title === applied) document.title = previous;
    };
  }, [open]);

  function runSearch(q: string, scope: WorkSearchScope) {
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
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    setError(null);
    setNotice(null);

    fetch(request.url, { signal: ac.signal })
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
        // Partial success is still success: keep the results and name what is
        // missing instead of replacing the panel with an error.
        setNotice(
          partialResultsNotice({
            partial: json?.partial,
            failedProviders: json?.failedProviders,
          }),
        );
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (!canCommit(reqId)) return;
        setTitles([]);
        setNotice(null);
        setError("Could not reach the server.");
        setLoading(false);
      });
  }

  function onQueryChange(value: string) {
    setQuery(value);
    if (window.location.pathname === "/search") {
      window.history.replaceState(null, "", searchUrlFor(value, scopeId));
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
  }

  /** Switching category re-runs immediately for the query already entered. */
  function onScopeChange(next: WorkSearchScope) {
    if (next === scopeId) return;
    setScopeId(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    abortRef.current?.abort();
    setTitles([]);
    setError(null);
    setNotice(null);
    if (window.location.pathname === "/search") {
      window.history.replaceState(null, "", searchUrlFor(query, next));
    }
    if (query.trim().length >= 2) runSearch(query, next);
    else setLoading(false);
    if (tabKeyNavRef.current) tabKeyNavRef.current = false;
    else requestAnimationFrame(() => inputRef.current?.focus());
  }

  /** Every keyboard-reachable result is one canonical title link. */
  function resultTargets(): HTMLElement[] {
    return Array.from(
      resultsRef.current?.querySelectorAll<HTMLElement>(
        '[data-card-target="title"]',
      ) ?? [],
    );
  }

  function focusCard(index: number) {
    const cards = resultTargets();
    if (!cards.length) return;
    const i = Math.max(0, Math.min(index, cards.length - 1));
    cards[i].focus();
    cards[i].scrollIntoView({ block: "nearest" });
  }

  function onInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusCard(0);
    } else if (e.key === "Enter") {
      const [first] = resultTargets();
      if (!first) return;
      e.preventDefault();
      first.click();
    }
  }

  function onResultsKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "j" && e.key !== "k")
      return;
    // `j`/`k` are text in a search box, but this handler only ever sees keys
    // that reached the results region, so they are safe as vim-style motions.
    const cards = resultTargets();
    if (!cards.length) return;
    const focused = document.activeElement as HTMLElement | null;
    const idx = cards.findIndex((c) => c === focused || c.contains(focused));
    const down = e.key === "ArrowDown" || e.key === "j";
    e.preventDefault();
    if (!down && idx <= 0) {
      inputRef.current?.focus();
      return;
    }
    focusCard(down ? idx + 1 : idx - 1);
  }

  const display = searchDisplayFor({
    scopeId,
    query,
    loading,
    error,
    resultCount: titles.length,
  });
  const statusMessage = loading
    ? `Searching ${display.scope.label.toLowerCase()}`
    : error
      ? `Search problem: ${error}`
      : query.trim().length >= 2
        ? `${titles.length} ${titles.length === 1 ? "result" : "results"} for ${query.trim()}`
        : `Search ${display.scope.label.toLowerCase()}`;

  function renderBody() {
    switch (display.state) {
      case "prompt":
      case "typing":
        // Never a blank panel: the active category supplies one concise
        // prompt and a real example.
        return (
          <SearchEmpty
            icon={Search}
            title={display.scope.blurb}
            description={`Try "${display.scope.placeholder.split(",")[0].trim()}"`}
          />
        );

      case "error":
        return (
          <SearchEmpty
            icon={AlertTriangle}
            title="Search did not finish"
            description={display.message}
            role="alert"
            data-search-error
          >
            <Button
              variant="secondary"
              onClick={() => runSearch(query, scopeId)}
            >
              Try search again
            </Button>
          </SearchEmpty>
        );

      case "empty":
        return (
          <SearchEmpty
            icon={SearchX}
            title={`Nothing in ${display.scope.label} matched "${display.query}"`}
            description="Try another spelling, or a different category above."
            data-results-empty
          />
        );

      case "loading":
        return (
          <TitleResultsList
            titles={[]}
            loading
            query={query}
            skeletonCount={4}
          />
        );

      case "results":
        return (
          <TitleResultsList
            titles={titles}
            loading={loading}
            query={query}
            skeletonCount={4}
          />
        );
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent
        mobileFullscreen
        showCloseButton={false}
        aria-label="Search"
        data-search-overlay
        className="sm:top-[10vh] sm:h-[min(80vh,46rem)] sm:max-w-3xl sm:translate-y-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          requestAnimationFrame(() => {
            inputRef.current?.focus();
            inputRef.current?.select();
          });
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const opener = openerRef.current;
          if (opener?.isConnected) opener.focus();
        }}
      >
        <DialogTitle className="sr-only">Search</DialogTitle>
        <DialogDescription className="sr-only">
          Find a film, series or anime and open its title page.
        </DialogDescription>
        <p className="sr-only" role="status" aria-live="polite">
          {statusMessage}
        </p>
        <Tabs
          value={scopeId}
          onValueChange={(value) => onScopeChange(value as WorkSearchScope)}
          className="min-h-0 flex-1 gap-0"
        >
          <div className="shrink-0 space-y-2.5 border-b border-border p-3">
            <InputGroup role="search" className="h-11 bg-background">
              <InputGroupAddon>
                <Search className="text-subtle-foreground" aria-hidden />
              </InputGroupAddon>
              <InputGroupInput
                ref={inputRef}
                type="search"
                data-search-input="true"
                data-search-overlay-input="true"
                value={query}
                onChange={(e) => onQueryChange(e.target.value)}
                onKeyDown={onInputKeyDown}
                placeholder={placeholderFor(scopeId)}
                aria-label="Search"
                autoComplete="off"
                spellCheck={false}
                className="h-full text-base [&::-webkit-search-cancel-button]:appearance-none"
              />
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  size="icon-sm"
                  onClick={close}
                  aria-label="Close search"
                  className="size-9 text-subtle-foreground hover:text-foreground max-md:size-11 pointer-coarse:size-11"
                >
                  <X aria-hidden />
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>

            <ScrollArea className="-mx-3 sm:mx-0">
              <TabsList
                aria-label="Search category"
                className="mx-3 group-data-horizontal/tabs:h-auto sm:mx-0"
              >
                {SEARCH_SCOPES.map((s) => (
                  <TabsTrigger
                    key={s.id}
                    value={s.id}
                    title={s.blurb}
                    data-search-scope={s.id}
                    onKeyDown={(event) => {
                      if (
                        ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)
                      ) {
                        tabKeyNavRef.current = true;
                      }
                    }}
                    className="h-8 flex-none px-3 text-[13px] max-md:h-11 pointer-coarse:h-11"
                  >
                    {s.label}
                  </TabsTrigger>
                ))}
              </TabsList>
              <ScrollBar orientation="horizontal" />
            </ScrollArea>
          </div>

          <TabsContent
            value={scopeId}
            aria-label={`${display.scope.label} search results`}
            className="relative min-h-0 flex-1"
          >
            <ScrollArea className="absolute inset-0">
              <div
                ref={resultsRef}
                onKeyDown={onResultsKeyDown}
                className="p-3 sm:p-4"
                data-search-results
              >
                {notice && display.state === "results" ? (
                  <Alert
                    role="status"
                    aria-live="polite"
                    className="mb-3 bg-muted"
                    data-partial-notice
                  >
                    <AlertTriangle className="text-brand" aria-hidden />
                    <AlertDescription className="text-[12px] text-muted-foreground">
                      {notice}
                    </AlertDescription>
                  </Alert>
                ) : null}
                {renderBody()}
              </div>
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function SearchEmpty({
  icon: Icon,
  title,
  description,
  children,
  ...rest
}: {
  icon: typeof Search;
  title: string;
  description?: string;
  children?: React.ReactNode;
} & Omit<React.ComponentProps<typeof Empty>, "title">) {
  return (
    <Empty className="px-4 py-12" {...rest}>
      <EmptyHeader>
        <EmptyMedia variant="icon" className="size-11 text-subtle-foreground">
          <Icon className="size-5" strokeWidth={1.75} aria-hidden />
        </EmptyMedia>
        <EmptyTitle className="text-foreground">{title}</EmptyTitle>
        {description ? (
          <EmptyDescription className="text-[13px] text-subtle-foreground">
            {description}
          </EmptyDescription>
        ) : null}
      </EmptyHeader>
      {children ? <EmptyContent>{children}</EmptyContent> : null}
    </Empty>
  );
}
