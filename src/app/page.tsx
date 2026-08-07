import type { Metadata } from "next";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { BrowseBoard } from "@/components/browse/browse-board";
import { BrowseFirstRun } from "@/components/browse/browse-first-run";
import { BrowseSkeleton } from "@/components/browse/browse-skeleton";
import { loadBrowsePayload } from "@/components/browse/browse-source";
import { isFirstRun } from "@/components/browse/first-run";
import { SEARCH_HREF } from "@/lib/navigation";

export const metadata: Metadata = {
  title: "Browse",
  description: "Everything you can watch right now, and everything you can get.",
};

interface HomePageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * Browse — the catalog.
 *
 * This page used to be a search box on an empty canvas: a tool that asked
 * "what do you want?" before it would show you anything. It now answers the
 * question the app exists to answer — here is what you can play right now —
 * and search has a page of its own.
 *
 * The shell renders immediately and the payload streams in behind a Suspense
 * boundary whose fallback has the finished layout's exact geometry, so the
 * first paint is instant and nothing moves when the data lands. There is one
 * fetch: the rails are assembled together in a single pass, not per rail.
 */
export default async function HomePage({ searchParams }: HomePageProps) {
  const params = await searchParams;
  const q = firstValue(params.q)?.trim();

  // Search results lived on `/` for the app's whole life, and links to them
  // exist in bookmarks, history and the recent-searches list in localStorage.
  // Forward the entire query string rather than dropping them on a page that
  // no longer answers them.
  if (q) redirect(`${SEARCH_HREF}?${toQueryString(params)}`);

  return (
    <div className="min-w-0">
      {/* Ensures a11y tools always find an h1, even before the browse payload lands. */}
      <h1 className="sr-only">Browse</h1>
      <Suspense fallback={<BrowseSkeleton />}>
        <BrowseContent />
      </Suspense>
    </div>
  );
}

async function BrowseContent() {
  const { payload, error } = await loadBrowsePayload();

  // The happy path is entirely server-rendered: one query, no client fetch,
  // nothing to hydrate but the interaction handlers.
  //
  // The two paths that would otherwise put words in the user's mouth — "you
  // have nothing" and a failure disguised as the same sentence — are handed to
  // a client island instead, because both need something this server pass
  // cannot give them: a way to ask again.
  if (error || isFirstRun(payload.rails)) {
    return <BrowseFirstRun serverError={error} />;
  }

  return <BrowseBoard payload={payload} />;
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function toQueryString(
  params: Record<string, string | string[] | undefined>,
): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    if (Array.isArray(value)) for (const v of value) qs.append(key, v);
    else qs.set(key, value);
  }
  return qs.toString();
}
