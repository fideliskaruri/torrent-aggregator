import { Check, ChevronDown } from "lucide-react";
import { Link } from "react-router";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { BrowseGenre } from "@/lib/browse";
import {
  BROWSE_VIEWS,
  browseHref,
  type BrowseQuery,
} from "@/lib/browse/views";
import { cn } from "@/lib/utils";

const focusRing =
  "outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";

/** A section link: plain text, the current one on a soft rounded fill. */
function sectionClass(active: boolean) {
  return cn(
    "inline-flex min-h-11 items-center rounded-full px-3 text-[14px] sm:px-3.5 sm:text-[15px] whitespace-nowrap transition-colors lg:min-h-9",
    focusRing,
    active
      ? "bg-foreground/15 font-semibold text-foreground"
      : "text-muted-foreground hover:text-foreground",
  );
}

/**
 * The section switch (All, Films, Series, Anime) and, on a section, a Genres
 * menu beside it. Shown right above the rows, under the hero.
 *
 * Links rather than buttons: each view is a URL, so middle-click, Back and a
 * shared link all work. On a genre page the section stays marked as current
 * (`aria-current="true"`) and the menu's button names the chosen genre.
 */
export function GenreFilters({
  query,
  genres,
}: {
  query: BrowseQuery;
  genres: readonly BrowseGenre[];
}) {
  const genre = genres.find((g) => g.id === query.genre) ?? null;
  const showGenres = query.view !== "all" && genres.length > 0;

  return (
    <div className="flex items-center justify-between gap-3 pt-4" data-browse-controls>
      <nav
        aria-label="Browse by type"
        className="-mx-1 min-w-0 overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
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

      {showGenres ? (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger
            className={cn(
              "inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-md border border-foreground/30 bg-background/40 px-3 sm:gap-2 sm:px-3.5 text-[14px] font-medium text-foreground transition-colors hover:border-foreground/60 data-[state=open]:border-foreground/60 lg:min-h-9",
              focusRing,
            )}
            data-browse-genre-menu
          >
            {genre?.label ?? "Genres"}
            <ChevronDown aria-hidden className="size-4 opacity-80" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-w-[min(30rem,calc(100vw-1rem))] p-2">
            <DropdownMenuItem asChild>
              <Link to={browseHref(query.view)} aria-current={!genre ? "page" : undefined}>
                All genres
                {!genre ? <Check aria-hidden className="ml-auto" /> : null}
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <div className="grid grid-cols-1 gap-x-2 sm:grid-cols-2">
              {genres.map((g) => (
                <DropdownMenuItem key={g.id} asChild>
                  <Link
                    to={browseHref(query.view, g.id)}
                    aria-current={g.id === genre?.id ? "page" : undefined}
                    data-browse-genre={g.id}
                  >
                    {g.label}
                    {g.id === genre?.id ? <Check aria-hidden className="ml-auto" /> : null}
                  </Link>
                </DropdownMenuItem>
              ))}
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}
