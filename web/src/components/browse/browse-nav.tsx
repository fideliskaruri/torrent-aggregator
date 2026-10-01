import { Link } from "react-router";
import type { BrowseGenre } from "@/lib/browse";
import {
  BROWSE_VIEWS,
  browseHref,
  browseViewLabel,
  type BrowseQuery,
} from "@/lib/browse/views";
import { cn } from "@/lib/utils";

const focusRing =
  "outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";

/** A section link: plain text, the current one on a soft rounded fill. */
function sectionClass(active: boolean) {
  return cn(
    "inline-flex min-h-11 items-center rounded-full px-3.5 text-[15px] whitespace-nowrap transition-colors lg:min-h-9",
    focusRing,
    active
      ? "bg-foreground/15 font-semibold text-foreground"
      : "text-muted-foreground hover:text-foreground",
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
 * The section switch (All, Films, Series, Anime) and, on a section, its title.
 *
 * Links rather than buttons: each view is a URL, so middle-click, Back and a
 * shared link all work. On a genre page the section stays marked as current
 * (`aria-current="true"`).
 */
export function BrowseNav({ query }: { query: BrowseQuery }) {
  return (
    <div className="container-app min-w-0 pt-3 sm:pt-4" data-browse-nav>
      <nav
        aria-label="Browse by type"
        className="-mx-1 overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <ul className="flex gap-1">
          {BROWSE_VIEWS.map((view) => {
            const active = query.view === view.id;
            return (
              <li key={view.id}>
                <Link
                  to={browseHref(view.id)}
                  aria-current={active ? (query.genre ? "true" : "page") : undefined}
                  className={sectionClass(active)}
                  data-browse-type={view.id}
                >
                  {view.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {query.view !== "all" ? (
        <h2 className="mt-4 mb-2 text-[28px] leading-tight font-bold tracking-tight text-foreground sm:text-[34px]">
          {browseViewLabel(query.view)}
        </h2>
      ) : null}
    </div>
  );
}

/**
 * A section's genre filters, shown right above its rows (under the hero).
 * The row scrolls sideways on its own on narrow screens with a hidden
 * scrollbar and a faded right edge, never the page. Renders nothing on All.
 */
export function GenreFilters({
  query,
  genres,
}: {
  query: BrowseQuery;
  genres: readonly BrowseGenre[];
}) {
  if (query.view === "all" || genres.length === 0) return null;
  return (
    <nav
      aria-label="Genres"
      data-browse-genres
      className="-mx-1 overflow-x-auto overscroll-x-contain px-1 pt-4 [scrollbar-width:none] [mask-image:linear-gradient(to_right,black_calc(100%-32px),transparent)] lg:[mask-image:none] [&::-webkit-scrollbar]:hidden"
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
  );
}
