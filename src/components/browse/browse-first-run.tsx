"use client";

/**
 * The browse page's honest answer when the server pass came back with nothing.
 *
 * Two very different situations produce the same server-side result — a clean
 * install where `/api/browse` correctly returns `{"rails":[]}`, and a payload
 * that could not be built at all — and for the app's whole life they rendered
 * identically: the empty state. That is the `/history` bug in a new dress. It
 * told the user their download log was empty when the truth was that it could
 * not be read, and it offered no retry, because as far as it knew nothing had
 * gone wrong.
 *
 * So the two paths that would otherwise put words in the user's mouth get an
 * authoritative second opinion from `/api/browse` through {@link useApiQuery},
 * which keeps `loading`, `error` and `data` mutually exclusive and hands back
 * a `refetch` a retry button can call. The populated path never reaches here
 * and never pays for it: the server already rendered the board.
 */

import { useMemo, useState } from "react";
import type { BrowsePayload } from "@/lib/browse";
import { TfErrorState } from "@/components/tf/error-state";
import { BrowseBoard } from "./browse-board";
import { BrowseEmptyState } from "./browse-empty-state";
import { BrowseSkeleton } from "./browse-skeleton";
import { isFirstRun } from "./first-run";
import { useApiQuery } from "@/hooks/use-api-query";

export function BrowseFirstRun({
  serverError,
}: {
  /** Why the server pass failed, or null when it simply had nothing. */
  serverError: string | null;
}) {
  // A failed server pass has already told us something is wrong, so the first
  // paint is the error state rather than a skeleton that resolves into one.
  // A clean install still asks, because "we found nothing" is a claim worth
  // being sure about — and asking is what gives the page a retry at all.
  const [dismissedServerError, setDismissedServerError] = useState(false);

  const { data, loading, error, refetch } = useApiQuery<BrowsePayload>(
    "/api/browse",
    { enabled: !serverError || dismissedServerError },
  );

  const rails = useMemo(() => data?.rails ?? [], [data]);

  const failure = data ? null : (error ?? (dismissedServerError ? null : serverError));

  if (failure) {
    return (
      <div className="container-app min-w-0 py-14">
        <TfErrorState
          title="Browse could not load"
          message={failure}
          retrying={loading}
          onRetry={() => {
            // The server pass is not repeatable from here, so the retry hands
            // the question to the API route — the same builder, reachable.
            setDismissedServerError(true);
            refetch();
          }}
        />
      </div>
    );
  }

  if (loading) return <BrowseSkeleton />;

  // Between the two honest outcomes, and only now that a request has actually
  // resolved: a real catalog, or a genuinely empty one.
  if (data && !isFirstRun(rails)) return <BrowseBoard payload={data} />;

  return (
    <div className="container-app min-w-0">
      <BrowseEmptyState />
    </div>
  );
}
