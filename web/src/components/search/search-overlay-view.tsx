import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { SearchOverlayControls } from "./search-overlay-controls";
import { SearchOverlayResults } from "./search-overlay-results";
import { searchDisplayFor } from "./search-overlay-state";
import type { SearchOverlayController } from "./use-search-overlay-controller";
import type { TitleSearchState } from "./use-title-search";

export function SearchOverlayView({
  controller,
  search,
}: {
  controller: SearchOverlayController;
  search: TitleSearchState;
}) {
  const display = searchDisplayFor({
    scopeId: search.scopeId,
    query: search.query,
    loading: search.loading,
    error: search.error,
    resultCount: search.titles.length,
  });
  const statusMessage = search.loading
    ? `Searching ${display.scope.label.toLowerCase()}`
    : search.error
      ? `Search problem: ${search.error}`
      : search.query.trim().length >= 2
        ? `${search.titles.length} ${search.titles.length === 1 ? "result" : "results"} for ${search.query.trim()}`
        : `Search ${display.scope.label.toLowerCase()}`;

  return (
    <Dialog
      open={controller.open}
      onOpenChange={(next) => {
        if (!next) controller.close();
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
            controller.inputRef.current?.focus();
            controller.inputRef.current?.select();
          });
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const opener = controller.openerRef.current;
          if (opener?.isConnected) opener.focus();
        }}
      >
        <DialogTitle className="sr-only">Search</DialogTitle>
        <DialogDescription className="sr-only">
          Find a film, series or anime and open its title page.
        </DialogDescription>
        <p className="sr-only" role="status" aria-live="polite">{statusMessage}</p>
        <Tabs
          value={search.scopeId}
          onValueChange={controller.onScopeChange}
          className="min-h-0 flex-1 gap-0"
        >
          <SearchOverlayControls controller={controller} search={search} />
          <TabsContent
            value={search.scopeId}
            aria-label={`${display.scope.label} search results`}
            className="relative min-h-0 flex-1"
          >
            <ScrollArea className="absolute inset-0">
              <div
                ref={controller.resultsRef}
                onKeyDown={controller.onResultsKeyDown}
                className="p-3 sm:p-4"
                data-search-results
              >
                <SearchOverlayResults search={search} />
              </div>
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
