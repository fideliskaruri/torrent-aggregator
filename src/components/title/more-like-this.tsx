"use client";

/**
 * "More like this" — the answer to a film page being a hero and then nothing.
 *
 * A series fills the space under the hero with its episode list. A film had
 * no equivalent, so `/title/dune-part-two` was a hero, a quiet link, and then
 * several hundred pixels of black before the footer, which reads as an
 * unfinished page rather than a short one.
 *
 * The fix is content, not explanation: a rail of neighbouring works, each one
 * a link to its own title page, so the page ends in somewhere to go next. When
 * the provider returns nothing this component renders nothing at all — an
 * empty rail with a heading over it would be the same void with a label.
 *
 * The tiles carry no words. The title is printed underneath each one, and a
 * poster that repeats its own caption is the duplicate-title bug this repo has
 * already fixed once.
 */
import Link from "next/link";
import { PosterImage } from "@/components/browse/poster-image";
import { posterTint } from "@/components/browse/poster";
import type { TitleSimilar } from "./types";

export function MoreLikeThis({
  items,
  loading = false,
  heading = "More like this",
}: {
  items: TitleSimilar[];
  /**
   * True while the extras round trip is in flight.
   *
   * Space reservation mirrors the pattern from `hero-banner.tsx` (which uses
   * `min-h-[1.5rem]` on the pitch line): the section must occupy the same
   * vertical footprint before and after the items arrive, or the hero above
   * it changes height and the Play button shifts under the cursor — the exact
   * bug that caused accidental navigations to wrong films.
   */
  loading?: boolean;
  heading?: string;
}) {
  if (!loading && items.length === 0) return null;

  if (loading && items.length === 0) {
    return (
      <section aria-labelledby="title-similar-heading" data-title-similar aria-busy="true">
        <div className="skeleton h-5 w-28 rounded" aria-hidden />
        {/* Skeleton grid: same grid-cols and aspect-ratio as the real grid so
            the section's height matches exactly once items arrive. */}
        <ul
          className="mt-3 grid grid-cols-3 gap-x-3 gap-y-4 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8"
          aria-hidden
        >
          {Array.from({ length: 8 }, (_, i) => (
            <li key={i}>
              <div className="skeleton aspect-[2/3] w-full rounded-[var(--radius)]" />
              <div className="skeleton mt-1.5 h-3 w-4/5 rounded" />
              <div className="skeleton mt-1 h-2.5 w-1/2 rounded" />
            </li>
          ))}
        </ul>
      </section>
    );
  }

  return (
    <section aria-labelledby="title-similar-heading" data-title-similar>
      <h2 id="title-similar-heading" className="text-title">
        {heading}
      </h2>

      <ul className="mt-3 grid grid-cols-3 gap-x-3 gap-y-4 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
        {items.map((item) => (
          <li key={`${item.workKey}:${item.title}:${item.year ?? ""}`}>
            <Link
              href={item.href}
              data-similar-card
              className="group block rounded-[var(--radius)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            >
              <div
                className="relative aspect-[2/3] w-full overflow-hidden rounded-[var(--radius)] border border-[var(--border)] transition-colors group-hover:border-[var(--border-strong)]"
                style={{ background: posterTint(item.title) }}
              >
                <PosterImage
                  src={item.posterUrl}
                  title={item.title}
                  sizes="(min-width: 1024px) 12vw, (min-width: 640px) 22vw, 30vw"
                />
              </div>
              <p
                className="mt-1.5 line-clamp-2 text-[12px] leading-snug text-[var(--text-secondary)] transition-colors group-hover:text-[var(--text)]"
                title={item.title}
              >
                {item.title}
              </p>
              {/* Adjacent inline facts inside a flex row: the whitespace
                  between them is not rendered, because flex generates no
                  anonymous boxes for whitespace-only text. The separator is a
                  real element with real text so it survives — and so a screen
                  reader hears something between "2024" and "8.1". */}
              {item.year != null || item.rating != null ? (
                <span className="mt-0.5 flex items-center text-[12px] tabular-nums text-[var(--text-tertiary)]">
                  {item.year != null ? <span>{item.year}</span> : null}
                  {item.year != null && item.rating != null ? (
                    <span className="mx-1">·</span>
                  ) : null}
                  {item.rating != null ? (
                    <span>{item.rating.toFixed(1)}</span>
                  ) : null}
                </span>
              ) : null}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
