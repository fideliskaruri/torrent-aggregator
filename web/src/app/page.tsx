import { Navigate, useSearchParams } from "react-router";
import { BrowseFirstRun } from "@/components/browse/browse-first-run";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { browseViewLabel, parseBrowseQuery } from "@/lib/browse/views";
import { SEARCH_HREF } from "@/lib/navigation";

/**
 * Browse — the catalog.
 *
 * The Next.js page assembled the browse payload on the server and handed empty
 * or failed payloads to `BrowseFirstRun`. In the SPA the payload comes from
 * `GET /api/browse` (the same `buildBrowsePayload` the server pass called), and
 * `BrowseFirstRun` already owns that fetch: skeleton while loading, the board
 * when there are rails, the first-run / error states otherwise.
 *
 * `?type=films&genre=comedy` narrows it: the view lives in the URL so Back,
 * reload and a shared link all keep it.
 */
export default function HomePage() {
  const [params] = useSearchParams();
  const query = parseBrowseQuery(params);
  useDocumentTitle(
    query.view === "all" ? "Browse" : browseViewLabel(query.view),
    "Everything you have, and everything you can get.",
    { absolute: true },
  );
  const q = params.get("q")?.trim();

  // Search results lived on `/` for the app's whole life, and links to them
  // exist in bookmarks, history and the recent-searches list in localStorage.
  // Forward the entire query string rather than dropping them on a page that
  // no longer answers them.
  if (q) return <Navigate replace to={`${SEARCH_HREF}?${params.toString()}`} />;

  return (
    <div className="min-w-0">
      {/* Ensures a11y tools always find an h1, even before the browse payload lands. */}
      <h1 className="sr-only">Browse</h1>
      <BrowseFirstRun serverError={null} query={query} />
    </div>
  );
}
