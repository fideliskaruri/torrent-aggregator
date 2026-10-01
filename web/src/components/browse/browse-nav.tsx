import { Link } from "react-router";
import type { BrowseGenre } from "@/lib/browse";
import {
  BROWSE_VIEWS,
  browseHref,
  type BrowseQuery,
} from "@/lib/browse/views";
import { cn } from "@/lib/utils";

const focusRing =
  "outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";

/** A section tab: plain text, the current one underlined in the brand color. */
function tabClass(active: boolean) {
  return cn(
    "relative inline-flex min-h-11 items-center px-1 text-[15px] font-medium whitespace-nowrap transition-colors lg:min-h-10",
    "after:absolute after:inset-x-1 after:-bottom-px after:h-0.5 after:rounded-full after:transition-colors",
    focusRing,
    active
      ? "text-foreground after:bg-brand"
      : "text-muted-foreground after:bg-transparent hover:text-foreground",
  );
}

/** A genre filter: borderless text until chosen, then a quiet brand fill. */
function genreClass(active: boolean) {
  return cn(
    "inline-flex min-h-11 shrink-0 items-center rounded-md px-2.5 text-[13px] whitespace-nowrap transition-colors lg:min-h-8",
    focusRing,
    active
      ? "bg-brand-dim text-brand-foreground"
      : "text-muted-foreground hover:bg-muted hover:text-foreground",
  );
}

/**
 * The type switch (All, Films, Series, Anime) as tabs and, on a type, its
 * genre filters underneath.
 *
 * Links rather than buttons: each view is a URL, so middle-click, Back and a
 * shared link all work. On a genre page the type stays marked as the current
 * section (`aria-current="true"`) and the genre as the current page. The genre
 * row scrolls sideways on its own on narrow screens with a hidden scrollbar and
 * a faded right edge, never the page.
 */
export function BrowseNav({
  query,
  genres,
}: {
  query: BrowseQuery;
  genres: readonly BrowseGenre[];
}) {
  return (
    <div className="container-app min-w-0 pt-3 sm:pt-4" data-browse-nav>
      <nav aria-label="Browse by type" className="border-b border-border">
        <ul className="flex gap-5">
          {BROWSE_VIEWS.map((view) => {
            const active = query.view === view.id;
            return (
              <li key={view.id}>
                <Link
                  to={browseHref(view.id)}
                  aria-current={active ? (query.genre ? "true" : "page") : undefined}
                  className={tabClass(active)}
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
          className="-mx-1 mt-2 overflow-x-auto overscroll-x-contain px-1 [scrollbar-width:none] [mask-image:linear-gradient(to_right,black_calc(100%-32px),transparent)] lg:[mask-image:none] [&::-webkit-scrollbar]:hidden"
        >
          <ul className="flex gap-1 pr-8 lg:flex-wrap lg:pr-0">
            <li>
              <Link
                to={browseHref(query.view)}
                aria-current={!query.genre ? "page" : undefined}
                className={genreClass(!query.genre)}
              >
                All genres
              </Link>
            </li>
            {genres.map((genre) => (
              <li key={genre.id}>
                <Link
                  to={browseHref(query.view, genre.id)}
                  aria-current={query.genre === genre.id ? "page" : undefined}
                  className={genreClass(query.genre === genre.id)}
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
