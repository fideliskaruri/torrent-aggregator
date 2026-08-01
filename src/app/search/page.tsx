"use client";

import { useEffect } from "react";
import { openSearchOverlay } from "@/components/search/search-overlay";
import { searchUrlFor } from "@/components/search/search-overlay-state";
import { Search } from "lucide-react";
import { parseWorkSearchCategory } from "@/lib/search/work-search";

/**
 * `/search` is the durable home of the search palette.
 *
 * Search is an overlay opened from anywhere — the header affordance and the `/`
 * shortcut both call `openSearchOverlay()`. This route used to render a second,
 * full-page search UI (its own input plus a raw release-row firehose), which
 * meant the app had two different search experiences. This route now keeps a
 * bookmarked or shared `/search?q=…` intact while opening the one palette.
 *
 * Reading `window.location.search` (rather than `useSearchParams`) keeps this a
 * plain client effect with no Suspense boundary requirement. The overlay is
 * mounted in the root layout, so its listener is always present by the time
 * this dispatches.
 */
export default function SearchRedirect() {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const q = params.get("q")?.trim() ?? "";
    const category = parseWorkSearchCategory(params.get("category"));
    window.history.replaceState(null, "", searchUrlFor(q, category));
    const timer = window.setTimeout(
      () => openSearchOverlay(q, { preserveUrl: true, category }),
      0,
    );
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div className="container-app max-w-2xl py-10 sm:py-14">
      <div className="surface flex flex-col items-start gap-3 p-5 sm:p-6">
        <div>
          <h1 className="text-lg font-semibold text-[var(--text)]">Search</h1>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">
            Find movies, series, and anime by title.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-primary btn-lg"
          onClick={() => {
            const params = new URLSearchParams(window.location.search);
            openSearchOverlay(params.get("q")?.trim() ?? "", {
              preserveUrl: true,
              category: parseWorkSearchCategory(params.get("category")),
            });
          }}
        >
          <Search className="h-4 w-4" aria-hidden />
          Open search
        </button>
      </div>
    </div>
  );
}
