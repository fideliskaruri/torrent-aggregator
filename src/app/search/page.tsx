import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Film, Gamepad2, Music2, Tv } from "lucide-react";
import { SearchBar } from "@/components/search/search-bar";
import { SearchResults } from "@/components/search/search-results";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { SEARCH_HREF } from "@/lib/navigation";

const CATEGORY_BY_MEDIA_TYPE: Record<string, string> = {
  anime: "anime",
  movie: "movies",
  tv: "tv",
};

/**
 * Shortcuts back into the titles you are actually tracking.
 *
 * This row used to be a hardcoded "Popular" list — six frozen strings dressed
 * up as a live trending feed, identical for every install and stale the day it
 * was written. On a single-user tool the only honest source of "what matters
 * right now" is your own library, so that is what it reads. Empty library means
 * the row is not rendered at all.
 */
async function recentLibraryShortcuts() {
  try {
    const session = await auth();
    const items = await prisma.watchListItem.findMany({
      where: { userId: session.user.id, status: { in: ["watching", "planned"] } },
      orderBy: { updatedAt: "desc" },
      take: 6,
      select: { id: true, title: true, mediaType: true },
    });
    return items.map((item) => ({
      id: item.id,
      label: item.title,
      category: CATEGORY_BY_MEDIA_TYPE[item.mediaType] ?? "all",
    }));
  } catch {
    // The search page must still render if the DB is unreachable.
    return [];
  }
}

const STARTERS = [
  { href: `${SEARCH_HREF}?q=anime&category=anime`, icon: Tv, label: "Anime", hint: "Nyaa-first" },
  { href: `${SEARCH_HREF}?q=2024&category=movies`, icon: Film, label: "Movies", hint: "YTS + TPB" },
  { href: `${SEARCH_HREF}?q=flac&category=music`, icon: Music2, label: "Music", hint: "Lossless & more" },
  { href: `${SEARCH_HREF}?q=pc&category=games`, icon: Gamepad2, label: "Games", hint: "PC releases" },
] as const;

interface SearchPageProps {
  searchParams: Promise<{ q?: string; category?: string }>;
}

export async function generateMetadata({
  searchParams,
}: SearchPageProps): Promise<Metadata> {
  const params = await searchParams;
  const q = params.q?.trim();
  return q
    ? { title: q, description: `Results for ${q}` }
    : {
        title: "Search",
        description: "Search multi-source indexers, monitor, grab, download.",
      };
}

/**
 * Search — every indexer at once.
 *
 * Results used to render on `/`, which meant the home page was a search box and
 * a new install landed on a blank tool. Search now owns its own route with the
 * same capabilities it always had (suggestions, category, source filters,
 * paging, quality filters — all still driven by the query string), and `/` is
 * the catalog.
 */
export default async function SearchPage({ searchParams }: SearchPageProps) {
  const params = await searchParams;
  const q = params.q?.trim() ?? "";
  const category = params.category ?? "all";
  const hasQuery = Boolean(q);
  const shortcuts = hasQuery ? [] : await recentLibraryShortcuts();

  return (
    <div className="container-app min-w-0">
      {hasQuery ? (
        <section className="space-y-5 py-5 sm:py-8">
          <div className="min-w-0">
            <h1 className="mb-2.5 text-[15px] font-medium text-[var(--text)]">
              <span className="font-normal text-[var(--text-tertiary)]">
                Results for{" "}
              </span>
              {q}
            </h1>
            <SearchBar
              key={`${q}|${category}`}
              initialQuery={q}
              initialCategory={category}
              size="compact"
            />
          </div>

          <Suspense
            fallback={
              <div className="surface p-8 text-[13px] text-[var(--text-tertiary)]">
                Loading…
              </div>
            }
          >
            <SearchResults query={q} category={category} />
          </Suspense>
        </section>
      ) : (
        <section className="min-w-0 max-w-2xl pb-16 pt-10 sm:pt-14">
          <p className="mb-4 text-[12px] font-medium uppercase tracking-wide text-[var(--text-tertiary)]">
            Every indexer, one query
          </p>
          <h1 className="text-display mb-4">
            Search.
            <br />
            <span className="text-[var(--text-secondary)]">
              Monitor. Grab. Download.
            </span>
          </h1>
          <p className="text-body mb-6 max-w-md">
            Results are ranked by how close each release is to what you asked
            for — nothing is dropped for being 720p or new to the swarm.
          </p>

          <SearchBar size="hero" />

          {shortcuts.length > 0 ? (
            <div className="mt-6">
              <p className="text-[12px] text-[var(--text-tertiary)]">
                From your library
              </p>
              {/* A label inline with padded chips left a ragged edge on every
                  wrapped line, and unbordered text gave no hint these are
                  links. Label above, real chips below. */}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {shortcuts.map((t) => (
                  <Link
                    key={t.id}
                    href={`${SEARCH_HREF}?q=${encodeURIComponent(t.label)}&category=${t.category}`}
                    className="rounded-full border border-[var(--border)] bg-[var(--bg-muted)]/60 px-2.5 py-1 text-[12px] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent-text)]"
                  >
                    {t.label}
                  </Link>
                ))}
              </div>
            </div>
          ) : null}

          <div className="mt-10 border-t border-[var(--border)] pt-8">
            <h2 className="mb-4 text-[13px] font-medium text-[var(--text-secondary)]">
              Start somewhere
            </h2>
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
              {STARTERS.map(({ href, icon: Icon, label, hint }) => (
                <Link
                  key={label}
                  href={href}
                  className="surface-interactive group flex items-center gap-3 p-3.5"
                >
                  <span className="flex h-9 w-9 items-center justify-center rounded-md bg-[var(--bg-muted)] text-[var(--text-secondary)] transition-colors group-hover:text-[var(--accent-text)]">
                    <Icon className="h-4 w-4" strokeWidth={1.75} aria-hidden />
                  </span>
                  <span>
                    <span className="block text-[13px] font-medium text-[var(--text)]">
                      {label}
                    </span>
                    <span className="block text-[11px] text-[var(--text-tertiary)]">
                      {hint}
                    </span>
                  </span>
                </Link>
              ))}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
