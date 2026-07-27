import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { SearchBar } from "@/components/search/search-bar";
import { SearchResults } from "@/components/search/search-results";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { SEARCH_HREF } from "@/lib/navigation";
import { browseWorkDisplay } from "@/lib/browse/collapse";

const CATEGORY_BY_MEDIA_TYPE: Record<string, string> = {
  anime: "anime",
  movie: "movies",
  tv: "tv",
};

type ShortcutSection = {
  id: string;
  title: string;
  items: SearchShortcut[];
};

type SearchShortcut = {
  id: string;
  label: string;
  category: string;
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
async function personalSearchShortcuts(): Promise<ShortcutSection[]> {
  try {
    const session = await auth();
    const [libraryRows, progressRows] = await Promise.all([
      prisma.watchListItem.findMany({
        where: {
          userId: session.user.id,
          status: { in: ["watching", "planned"] },
        },
        orderBy: { updatedAt: "desc" },
        take: 8,
        select: { id: true, title: true, mediaType: true },
      }),
      prisma.playbackProgress.findMany({
        where: { userId: session.user.id, completedAt: null },
        orderBy: { updatedAt: "desc" },
        take: 8,
        select: { id: true, title: true, infoHash: true },
      }),
    ]);

    const hashes = [
      ...new Set(progressRows.map((row) => row.infoHash.trim().toLowerCase())),
    ];
    const engineRows =
      hashes.length > 0
        ? await prisma.engineTorrent.findMany({
            where: { userId: session.user.id, hash: { in: hashes } },
            select: { hash: true, name: true },
          })
        : [];
    const torrentNameByHash = new Map(
      engineRows.map((row) => [row.hash.trim().toLowerCase(), row.name]),
    );

    const seen = new Set<string>();
    const fromLibrary = libraryRows
      .map((item) =>
        shortcut(item.id, item.title, CATEGORY_BY_MEDIA_TYPE[item.mediaType], seen),
      )
      .filter((item): item is SearchShortcut => item !== null)
      .slice(0, 6);

    const continueWatching = progressRows
      .map((row) => {
        const releaseName =
          torrentNameByHash.get(row.infoHash.trim().toLowerCase()) ?? row.title;
        return shortcut(
          row.id,
          browseWorkDisplay(releaseName).title,
          undefined,
          seen,
        );
      })
      .filter((item): item is SearchShortcut => item !== null)
      .slice(0, 6);

    return [
      { id: "continue-watching", title: "Continue watching", items: continueWatching },
      { id: "library", title: "From your library", items: fromLibrary },
    ].filter((section) => section.items.length > 0);
  } catch {
    // The search page must still render if the DB is unreachable.
    return [];
  }
}

function shortcut(
  id: string,
  title: string,
  category: string | undefined,
  seen: Set<string>,
): SearchShortcut | null {
  const label = title.trim();
  const key = label.toLowerCase().replace(/\s+/g, " ");
  if (!label || seen.has(key)) return null;
  seen.add(key);
  return { id, label, category: category ?? "all" };
}

function shortcutHref(item: SearchShortcut): string {
  const params = new URLSearchParams({ q: item.label });
  if (item.category !== "all") params.set("category", item.category);
  return `${SEARCH_HREF}?${params.toString()}`;
}

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
        description: "Search for a title to watch.",
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
  const shortcutSections = hasQuery ? [] : await personalSearchShortcuts();

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
        <section className="min-w-0 max-w-2xl pb-16 pt-8 sm:pt-10">
          <h1 className="mb-4 text-[18px] font-medium text-[var(--text)]">
            Search
          </h1>

          <SearchBar size="hero" autoFocus />

          {shortcutSections.length > 0 ? (
            <div className="mt-7 space-y-5">
              {shortcutSections.map((section) => (
                <div key={section.id}>
                  <p className="text-[12px] text-[var(--text-tertiary)]">
                    {section.title}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {section.items.map((item) => (
                      <Link
                        key={item.id}
                        href={shortcutHref(item)}
                        className="rounded-full border border-[var(--border)] bg-[var(--bg-muted)]/60 px-2.5 py-1 text-[12px] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent-text)]"
                      >
                        {item.label}
                      </Link>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-5 max-w-md text-[13px] leading-relaxed text-[var(--text-tertiary)]">
              No library or viewing history yet. Search for a title to get
              started.
            </p>
          )}
        </section>
      )}
    </div>
  );
}
