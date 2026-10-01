import { Link } from "react-router";
import type { BrowseGenre } from "@/lib/browse";
import {
  BROWSE_VIEWS,
  browseHref,
  type BrowseQuery,
} from "@/lib/browse/views";
import { cn } from "@/lib/utils";

/** The rules page's filter chip, as a link. */
function chipClass(active: boolean) {
  return cn(
    "inline-flex min-h-11 shrink-0 items-center rounded-full border px-3.5 text-[13px] leading-none whitespace-nowrap transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 lg:min-h-8",
    active
      ? "border-brand/50 bg-brand-dim text-brand-foreground"
      : "border-border bg-muted text-muted-foreground hover:text-foreground",
  );
}

/**
 * The type switch (All, Films, Series, Anime) and, on a type, its genre chips.
 *
 * Links rather than buttons: each view is a URL, so middle-click, Back and a
 * shared link all work. On a genre page the type stays marked as the current
 * section (`aria-current="true"`) and the genre as the current page. The genre
 * row scrolls sideways on its own at 390 px, like a rail, never the page.
 */
export function BrowseNav({
  query,
  genres,
}: {
  query: BrowseQuery;
  genres: readonly BrowseGenre[];
}) {
  return (
    <div className="container-app min-w-0 pt-4 sm:pt-5" data-browse-nav>
      <nav aria-label="Browse by type">
        <ul className="flex flex-wrap gap-2">
          {BROWSE_VIEWS.map((view) => {
            const active = query.view === view.id;
            return (
              <li key={view.id}>
                <Link
                  to={browseHref(view.id)}
                  aria-current={active ? (query.genre ? "true" : "page") : undefined}
                  className={chipClass(active)}
                  data-browse-type={view.id}
                >
                  {view.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {query.view !== "all" && genres.length > 0 ? (
        <nav
          aria-label="Genres"
          className="-mx-1 mt-1 overflow-x-auto overscroll-x-contain px-1 py-1.5"
        >
          <ul className="flex gap-2">
            <li>
              <Link
                to={browseHref(query.view)}
                aria-current={!query.genre ? "page" : undefined}
                className={chipClass(!query.genre)}
              >
                All genres
              </Link>
            </li>
            {genres.map((genre) => (
              <li key={genre.id}>
                <Link
                  to={browseHref(query.view, genre.id)}
                  aria-current={query.genre === genre.id ? "page" : undefined}
                  className={chipClass(query.genre === genre.id)}
                  data-browse-genre={genre.id}
                >
                  {genre.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
    </div>
  );
}
