import { AlertTriangle, Search, SearchX } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { TfEmptyState } from "@/components/tf/empty-state";
import { TfErrorState } from "@/components/tf/error-state";
import { TitleResultsList } from "./title-results-list";
import { placeholderFor, type SearchDisplay } from "./search-overlay-state";
import type { TitleSearchState } from "./use-title-search";

export function SearchOverlayResults({
  search,
  display,
}: {
  search: TitleSearchState;
  display: SearchDisplay;
}) {
  return (
    <>
      {search.notice && display.state === "results" ? (
        <Alert
          role="status"
          aria-live="polite"
          className="mb-3 bg-muted"
          data-partial-notice
        >
          <AlertTriangle className="text-brand" aria-hidden />
          <AlertDescription className="text-[12px] text-muted-foreground">
            {search.notice}
          </AlertDescription>
        </Alert>
      ) : null}
      {display.state === "error" ? (
          <div data-search-error>
            <TfErrorState
              title="Search did not finish"
              message={display.message}
              onRetry={() => search.runSearch(search.query, search.scopeId)}
              retrying={search.loading}
              className="border-0 bg-transparent px-4 py-12"
            />
          </div>
        ) : null}
        {display.state === "empty" ? (
          <div data-results-empty>
            <TfEmptyState
              icon={SearchX}
              title={`Nothing in ${display.scope.label} matched "${display.query}"`}
              description="Try another spelling, or a different category above."
              className="border-0 bg-transparent px-4 py-12"
            />
          </div>
      ) : null}
      {display.state === "prompt" || display.state === "typing" ? (
        <TfEmptyState
          icon={Search}
          title={display.scope.blurb}
          description={`Try "${placeholderFor(search.scopeId).split(",")[0].trim()}"`}
          className="border-0 bg-transparent px-4 py-12"
        />
      ) : null}
      {display.state === "loading" ? (
        <TitleResultsList titles={[]} loading query={search.query} skeletonCount={4} />
      ) : null}
      {display.state === "results" ? (
        <TitleResultsList
          titles={search.titles}
          loading={search.loading}
          query={search.query}
          skeletonCount={4}
        />
      ) : null}
    </>
  );
}
