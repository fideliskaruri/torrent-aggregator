"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { openSearchOverlay } from "@/components/search/search-overlay";

/**
 * `/search` is no longer a page.
 *
 * Search is an overlay opened from anywhere — the header affordance and the `/`
 * shortcut both call `openSearchOverlay()`. This route used to render a second,
 * full-page search UI (its own input plus a raw release-row firehose), which
 * meant the app had two different search experiences and the "page" was the
 * worse one. It now survives only as a deep-link fallback: a bookmarked or
 * shared `/search?q=…` forwards to the browse board and opens the palette,
 * pre-filled from `q`, so the URL still works without resurrecting that UI.
 *
 * Reading `window.location.search` (rather than `useSearchParams`) keeps this a
 * plain client effect with no Suspense boundary requirement. The overlay is
 * mounted in the root layout, so its listener is always present by the time
 * this dispatches.
 */
export default function SearchRedirect() {
  const router = useRouter();

  useEffect(() => {
    const q =
      new URLSearchParams(window.location.search).get("q")?.trim() ?? "";
    router.replace("/");
    // Defer the open by one macrotask. On a cold `/search` load this page's
    // effect can run before the overlay's window-event listener (mounted in the
    // root layout) is attached, so a synchronous dispatch is lost. A 0ms timer
    // fires after the initial effect flush, once that listener exists. No
    // cleanup: this component unmounts the instant `replace` lands, and the
    // overlay — which lives in the persistent layout — must still open.
    window.setTimeout(() => openSearchOverlay(q), 0);
  }, [router]);

  return null;
}
