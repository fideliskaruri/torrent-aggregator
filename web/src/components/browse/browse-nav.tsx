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

/**
 * The section switch (All, Films, Series, Anime) and, on a section, its title
 * with a Genres menu beside it.
 *
 * Links rather than buttons: each view is a URL, so middle-click, Back and a
 * shared link all work. On a genre page the section stays marked as current
 * (`aria-current="true"`) and the menu's button names the chosen genre.
 */
export function BrowseNav({
  query,
  genres,
}: {
  query: BrowseQuery;
  genres: readonly BrowseGenre[];
}) {
  const genre = genres.find((g) => g.id === query.genre) ?? null;

  return (
    <div className="container-app min-w-0 pt-3 sm:pt-4" data-browse-nav>
      <nav aria-label="Browse by type" className="-mx-1 overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
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
        <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2">
          <h2 className="text-[28px] leading-tight font-bold tracking-tight text-foreground sm:text-[34px]">
            {browseViewLabel(query.view)}
          </h2>
          {genres.length > 0 ? (
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger
                className={cn(
                  "inline-flex min-h-11 items-center gap-2 rounded-md border border-foreground/30 bg-background/40 px-3.5 text-[14px] font-medium text-foreground transition-colors hover:border-foreground/60 data-[state=open]:border-foreground/60 lg:min-h-9",
                  focusRing,
                )}
                data-browse-genre-menu
              >
                {genre?.label ?? "Genres"}
                <ChevronDown aria-hidden className="size-4 opacity-80" />
              </DropdownMenuTrigger>
              <DropdownMenuContent className="max-w-[min(30rem,calc(100vw-1rem))] p-2">
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
      ) : null}
    </div>
  );
}
