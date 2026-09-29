import { useEffect } from "react";
import { openSearchOverlay } from "@/components/search/search-overlay";
import { searchUrlFor } from "@/components/search/search-overlay-state";
import { parseWorkSearchScope } from "@/lib/search/work-search";

/**
 * `/search` is the durable home of the search palette.
 *
 * Search is an overlay opened from anywhere — the header affordance and the `/`
 * shortcut both call `openSearchOverlay()`. This route used to render a second,
 * full-page search UI (its own input plus a raw release-row firehose), which
 * meant the app had two different search experiences. This route now keeps a
 * bookmarked or shared `/search?q=…` intact while opening the one palette. It
 * renders nothing itself, so closing the palette leaves the route: back to the
 * app page behind it, or home after a deep link.
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
    const category = parseWorkSearchScope(params.get("category"));
    // Keep the entry's state: its router index tells the palette where closing
    // should go.
    window.history.replaceState(
      window.history.state,
      "",
      searchUrlFor(q, category),
    );
    const timer = window.setTimeout(
      () => openSearchOverlay(q, { preserveUrl: true, category }),
      0,
    );
    return () => window.clearTimeout(timer);
  }, []);

  return null;
}
