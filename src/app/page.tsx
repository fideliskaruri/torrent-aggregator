import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Film, Gamepad2, Music2, Tv, Library } from "lucide-react";
import { SearchBar } from "@/components/search/search-bar";
import { SearchResults } from "@/components/search/search-results";
import { ActiveDownloadsTeaser } from "@/components/tf/active-downloads-teaser";
import { Button } from "@/components/ui/button";

const TRENDING = [
  { q: "One Piece", category: "anime", label: "One Piece" },
  { q: "Solo Leveling", category: "anime", label: "Solo Leveling" },
  { q: "Dune Part Two", category: "movies", label: "Dune: Part Two" },
  { q: "The Last of Us", category: "tv", label: "The Last of Us" },
  { q: "Frieren", category: "anime", label: "Frieren" },
  { q: "Severance", category: "tv", label: "Severance" },
];

const BROWSE = [
  {
    href: "/?q=anime&category=anime",
    icon: Tv,
    label: "Anime",
    hint: "Nyaa-first",
  },
  {
    href: "/?q=2024&category=movies",
    icon: Film,
    label: "Movies",
    hint: "YTS + TPB",
  },
  {
    href: "/?q=flac&category=music",
    icon: Music2,
    label: "Music",
    hint: "Lossless & more",
  },
  {
    href: "/?q=pc&category=games",
    icon: Gamepad2,
    label: "Games",
    hint: "PC releases",
  },
];

interface HomePageProps {
  searchParams: Promise<{ q?: string; category?: string }>;
}

export async function generateMetadata({
  searchParams,
}: HomePageProps): Promise<Metadata> {
  const params = await searchParams;
  const q = params.q?.trim();
  if (q) {
    return {
      title: q,
      description: `Results for ${q}`,
    };
  }
  return {
    title: "TorrentFlow",
    description: "Search multi-source indexers, monitor, grab, download.",
  };
}

export default async function HomePage({ searchParams }: HomePageProps) {
  const params = await searchParams;
  const q = params.q?.trim() ?? "";
  const category = params.category ?? "all";
  const hasQuery = Boolean(q);

  return (
    <div className="container-app min-w-0">
      {hasQuery ? (
        /* Results mode — compact bar + results on home */
        <section className="py-5 sm:py-8 space-y-5">
          <div className="flex flex-col sm:flex-row sm:items-end gap-3 sm:gap-6">
            <div className="sm:min-w-0 sm:flex-1">
              <h1 className="text-[15px] font-medium text-[var(--text)] mb-2.5">
                <span className="text-[var(--text-tertiary)] font-normal">
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
        /* Landing — hero search, library CTA, browse chips */
        <>
          <section className="pt-10 sm:pt-16 pb-10 sm:pb-14 max-w-2xl min-w-0">
            <p className="text-[12px] font-medium tracking-wide uppercase text-[var(--text-tertiary)] mb-4">
              Self-hosted torrent flow
            </p>
            <h1 className="text-display mb-4">
              Find it.
              <br />
              <span className="text-[var(--text-secondary)]">
                Monitor. Grab. Download.
              </span>
            </h1>
            <p className="text-body max-w-md mb-6">
              Search multi-source indexers, add titles to Library, run automation,
              and watch transfers on Client — one path.
            </p>

            <SearchBar size="hero" />

            <div className="mt-5 flex flex-wrap items-center gap-3">
              <Button asChild size="sm">
                <Link href="/watchlist">
                  <Library className="h-3.5 w-3.5" />
                  Open library
                </Link>
              </Button>
            </div>

            <div className="mt-5 flex flex-wrap items-center gap-x-1 gap-y-2">
              <span className="text-[12px] text-[var(--text-tertiary)] mr-2">
                Popular
              </span>
              {TRENDING.map((t) => (
                <Link
                  key={t.label}
                  href={`/?q=${encodeURIComponent(t.q)}&category=${t.category}`}
                  className="text-[12px] text-[var(--text-secondary)] hover:text-[var(--accent-text)] px-2 py-0.5 rounded-md hover:bg-[var(--bg-muted)] transition-colors"
                >
                  {t.label}
                </Link>
              ))}
            </div>
          </section>

          <ActiveDownloadsTeaser />

          <section className="pb-20 border-t border-[var(--border)] pt-10">
            <div className="flex items-baseline justify-between mb-4">
              <h2 className="text-[13px] font-medium text-[var(--text-secondary)]">
                Jump into search
              </h2>
            </div>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
              {BROWSE.map(({ href, icon: Icon, label, hint }) => (
                <Link
                  key={label}
                  href={href}
                  className="surface-interactive group flex items-center gap-3 p-3.5"
                >
                  <span className="flex h-9 w-9 items-center justify-center rounded-md bg-[var(--bg-muted)] text-[var(--text-secondary)] group-hover:text-[var(--accent-text)] transition-colors">
                    <Icon className="h-4 w-4" strokeWidth={1.75} />
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
          </section>
        </>
      )}
    </div>
  );
}
