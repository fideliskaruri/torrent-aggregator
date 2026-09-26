import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router";
import { Check, Clock, Plus, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TfEmptyState } from "@/components/tf/empty-state";
import { TfErrorState } from "@/components/tf/error-state";
import {
  TitleResultCard,
  TitleResultCardSkeleton,
} from "@/components/search/title-result-card";
import { useApiQuery } from "@/hooks/use-api-query";
import { RequestDialog } from "./request-dialog";
import {
  canRequest,
  parseTitles,
  statusLabel,
  toTitleResult,
  type RequesterTitle,
} from "./requests";

const QUERY_MAX = 200;

/** Title search for requesters: catalog results with Request buttons, nothing else. */
export function RequestSearch() {
  const [params, setParams] = useSearchParams();
  const query = (params.get("q") ?? "").trim().slice(0, QUERY_MAX);
  const [draft, setDraft] = useState(query);
  const [selected, setSelected] = useState<RequesterTitle | null>(null);

  const url = query ? `/api/requester/titles?${new URLSearchParams({ q: query })}` : null;
  const search = useApiQuery(url, { select: parseTitles, emptyOnUnauthorized: false });
  const results = search.data?.results ?? [];

  function submit(event: FormEvent) {
    event.preventDefault();
    const next = draft.trim().slice(0, QUERY_MAX);
    setParams(next ? { q: next } : {});
  }

  return (
    <div className="space-y-5" data-requester-search>
      <div className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight text-[var(--text)]">Find something to watch</h1>
        <p className="text-sm text-[var(--text-secondary)]">
          Search movies and shows, then ask for the ones you want.
        </p>
      </div>

      <form role="search" onSubmit={submit} className="flex gap-2">
        <label htmlFor="requester-query" className="sr-only">
          Title
        </label>
        <Input
          id="requester-query"
          type="search"
          value={draft}
          maxLength={QUERY_MAX}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Movie or show title"
          autoComplete="off"
          enterKeyHint="search"
          className="h-11 min-w-0 flex-1 text-base sm:text-sm"
          data-requester-query
        />
        <Button type="submit" size="lg" disabled={!draft.trim()} data-requester-submit>
          <Search aria-hidden="true" />
          <span className="max-sm:sr-only">Search</span>
        </Button>
      </form>

      {!query ? (
        <TfEmptyState
          icon={Search}
          title="Search for a title"
          description="Type a movie or show name to see what you can ask for."
        />
      ) : search.loading ? (
        <div className="grid gap-3 md:grid-cols-2" aria-busy="true" aria-label="Searching">
          {Array.from({ length: 4 }, (_, i) => (
            <TitleResultCardSkeleton key={i} />
          ))}
        </div>
      ) : search.error && results.length === 0 ? (
        <TfErrorState
          title="Search didn't work"
          message={search.error}
          onRetry={search.refetch}
          retrying={search.refreshing}
        />
      ) : results.length === 0 ? (
        <TfEmptyState
          icon={Search}
          title="Nothing found"
          description="Check the spelling or try a shorter title."
        />
      ) : (
        <div className="space-y-2">
          {search.data?.partial ? (
            <p className="text-xs text-[var(--text-tertiary)]">
              Some catalogs didn't answer, so this list may be incomplete.
            </p>
          ) : null}
          <ul className="grid gap-3 md:grid-cols-2" data-requester-results>
            {results.map((title) => (
              <li key={`${title.provider}:${title.providerId ?? title.key}`} className="min-w-0">
                <TitleResultCard
                  title={toTitleResult(title)}
                  actions={<TitleActions title={title} onRequest={() => setSelected(title)} />}
                />
              </li>
            ))}
          </ul>
        </div>
      )}

      <RequestDialog
        title={selected}
        onClose={() => setSelected(null)}
        onCreated={search.refetch}
      />
    </div>
  );
}

function TitleActions({ title, onRequest }: { title: RequesterTitle; onRequest: () => void }) {
  return (
    <>
      {title.inLibrary ? (
        <Badge variant="success" data-requester-in-library>
          <Check className="h-3 w-3" aria-hidden="true" />
          In the library
        </Badge>
      ) : null}
      {!title.inLibrary && title.requestStatus ? (
        <Badge variant="accent" data-requester-requested={title.requestStatus}>
          <Clock className="h-3 w-3" aria-hidden="true" />
          {statusLabel(title.requestStatus)}
        </Badge>
      ) : null}
      {canRequest(title) ? (
        <Button
          type="button"
          size="sm"
          variant={title.requestStatus ? "outline" : "default"}
          onClick={onRequest}
          aria-label={`${title.requestStatus ? "Request more of" : "Request"} ${title.title}`}
          data-requester-request={title.key}
        >
          <Plus aria-hidden="true" />
          {title.requestStatus ? "More seasons" : "Request"}
        </Button>
      ) : null}
    </>
  );
}
