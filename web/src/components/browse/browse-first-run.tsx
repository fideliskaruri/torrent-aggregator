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

import { useCallback, useEffect, useMemo, useState } from "react";
import type { BrowseGenre, BrowsePayload } from "@/lib/browse";
import {
  browseApiUrl,
  browseHref,
  browseViewLabel,
  type BrowseQuery,
  type BrowseView,
} from "@/lib/browse/views";
import { TfErrorState } from "@/components/tf/error-state";
import { BrowseBoard } from "./browse-board";
import { BrowseEmptyState, type BrowseEmptyView } from "./browse-empty-state";
import { BrowseNav } from "./browse-nav";
import { BrowseSkeleton } from "./browse-skeleton";
import { isFirstRun } from "./first-run";
import { useApiQuery } from "@/hooks/use-api-query";
import { useStableLoading } from "@/components/ui/use-stable-loading";

interface BrowseFirstRunProps {
  /** Why the server pass failed, or null when it simply had nothing. */
  serverError: string | null;
  /** The view in the URL: All, a type, or a type's genre. */
  query: BrowseQuery;
}

/**
 * Each type's genres from its last payload. The genres are the server's
 * config, so they do not change while the app is open; remembering them keeps
 * the chip row in place while the next genre loads.
 */
const knownGenres = new Map<BrowseView, readonly BrowseGenre[]>();

/** The empty state's retry starts over: a fresh mount re-asks `/api/browse` from the skeleton. */
export function BrowseFirstRun(props: BrowseFirstRunProps) {
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => setGeneration((n) => n + 1), []);
  return <BrowseFirstRunView key={generation} {...props} onReload={reload} />;
}

function BrowseFirstRunView({
  serverError,
  query,
  onReload,
}: BrowseFirstRunProps & { onReload: () => void }) {
  // A failed server pass has already told us something is wrong, so the first
  // paint is the error state rather than a skeleton that resolves into one.
  // A clean install still asks, because "we found nothing" is a claim worth
  // being sure about — and asking is what gives the page a retry at all.
  const [dismissedServerError, setDismissedServerError] = useState(false);

  const { data, loading, error, refetch } = useApiQuery<BrowsePayload>(
    browseApiUrl(query),
    { enabled: !serverError || dismissedServerError },
  );

  useEffect(() => {
    if (data?.genres?.length && data.view && data.view !== "all") {
      knownGenres.set(data.view, data.genres);
    }
  }, [data]);

  const rails = useMemo(() => data?.rails ?? [], [data]);
  const showLoading = useStableLoading(loading && !data && !error);
  const genres = data?.genres ?? knownGenres.get(query.view) ?? [];
  const nav = <BrowseNav query={query} genres={genres} />;

  const failure = data ? null : (error ?? (dismissedServerError ? null : serverError));

  if (failure) {
    return (
      <>
        {nav}
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
      </>
    );
  }

  if (loading && !data && !error) {
    return (
      <>
        {nav}
        <BrowseSkeleton visible={showLoading} grid={Boolean(query.genre)} />
      </>
    );
  }

  // Between the two honest outcomes, and only now that a request has actually
  // resolved: a real catalog, or a genuinely empty one.
  if (data && !isFirstRun(rails)) {
    return (
      <>
        {nav}
        <BrowseBoard payload={data} />
      </>
    );
  }

  return (
    <>
      {nav}
      <div className="container-app min-w-0">
        <BrowseEmptyState onRetry={onReload} view={emptyView(query, genres)} />
      </div>
    </>
  );
}

/** What an empty narrowed view is called, and the wider view to offer instead. */
function emptyView(
  query: BrowseQuery,
  genres: readonly BrowseGenre[],
): BrowseEmptyView | undefined {
  if (query.view === "all") return undefined;
  const type = browseViewLabel(query.view);
  if (query.genre) {
    const genre = genres.find((g) => g.id === query.genre)?.label;
    return {
      name: genre ? `${genre} ${type.toLowerCase()}` : type,
      linkLabel: `See all ${type.toLowerCase()}`,
      linkHref: browseHref(query.view),
    };
  }
  return { name: type, linkLabel: "See everything", linkHref: browseHref("all") };
}
