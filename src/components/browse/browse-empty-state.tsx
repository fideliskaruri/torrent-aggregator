"use client";

/**
 * The one state left after the home page stopped being empty.
 *
 * This file used to be the *first-run* page: a heading reading "What this page
 * becomes", the sentence "Five rows fill themselves in as you use it", and a
 * diagram of five rows of dashed rectangles standing in for rails that did not
 * exist yet. It was written for a real problem — every rail in the product was
 * personal, so a brand-new install genuinely had nothing to render — but the
 * answer was an essay about the page instead of a page. Nobody opens a catalog
 * to read about the catalog.
 *
 * `@/lib/browse/discovery` removed the problem rather than the symptom: a
 * fresh install now has Trending now, Popular series and — once there is
 * something to base it on — Because you're watching X, all built from a
 * background-refreshed cache and all full of real, current, clickable titles.
 *
 * Which leaves exactly one case for this component, and it is not "new": the
 * board renders nothing only when the local database holds no personal rows
 * *and* no catalog rows — nothing has ever been cached, and nothing can be
 * reached now. That is a failure, so it is drawn as one, with a retry. The
 * distinction is the same one `/history` got wrong and `TfErrorState` exists
 * to keep: an empty result and a failed request are different states, and
 * narrowing the second into the first tells the user a confident lie and
 * offers them no way out of it.
 *
 * What it deliberately does **not** do is explain what the page will one day
 * contain. If the sources are unreachable, the useful sentence is that they
 * are unreachable.
 */

import { useCallback, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { TfErrorState } from "@/components/tf/error-state";
import { SEARCH_HREF } from "@/lib/navigation";

export function BrowseEmptyState({
  onRetry,
}: {
  /**
   * Optional: the caller's own retry. Defaults to re-running the server
   * render, which is what actually re-reads the catalog — the rails are
   * assembled server-side, so a client-only refetch would ask the same failing
   * question through a longer pipe.
   */
  onRetry?: () => void;
} = {}) {
  const router = useRouter();
  const [retrying, startTransition] = useTransition();

  const retry = useCallback(() => {
    if (onRetry) {
      onRetry();
      return;
    }
    startTransition(() => router.refresh());
  }, [onRetry, router]);

  return (
    <div className="min-w-0 py-10" data-browse-empty>
      <TfErrorState
        title="Nothing could be loaded"
        message="TorrentFlow could not reach any source, and nothing is cached on this machine yet. Check the connection and try again."
        onRetry={retry}
        retrying={retrying}
      />

      <p className="mt-4 text-center text-[12px] text-[var(--text-tertiary)]">
        Search still works if you know what you are looking for —{" "}
        <Link
          href={SEARCH_HREF}
          data-dense-ui
          className="text-[var(--accent-text)] underline-offset-4 transition-colors hover:text-[var(--accent-hover)] hover:underline"
        >
          open search
        </Link>
        .
      </p>
    </div>
  );
}
