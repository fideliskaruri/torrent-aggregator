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
import { Link } from "react-router";
import { MediaPoster, MediaPosterCaption, MediaPosterSkeleton } from "@/components/browse/media-poster-card";
import { Skeleton } from "@/components/ui/skeleton";
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
   * it changes height and the Download button shifts under the cursor — the exact
   * bug that caused accidental navigations to wrong films.
   */
  loading?: boolean;
  heading?: string;
}) {
  if (!loading && items.length === 0) return null;

  if (loading && items.length === 0) {
    return (
      <section aria-labelledby="title-similar-heading" data-title-similar aria-busy="true">
        <div className="text-title flex h-lh items-center" aria-hidden>
          <Skeleton className="h-5 w-28 rounded" />
        </div>
        {/* Skeleton grid: same grid-cols and aspect-ratio as the real grid so
            the section's height matches exactly once items arrive. */}
        <ul
          className="mt-3 grid grid-cols-3 gap-x-3 gap-y-4 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8"
          aria-hidden
        >
          {Array.from({ length: 8 }, (_, i) => (
            <li key={i}>
              <MediaPosterSkeleton variant="rail" />
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
              to={item.href}
              data-similar-card
              className="group block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            >
              <MediaPoster
                variant="rail"
                src={item.posterUrl}
                title={item.title}
                sizes="(min-width: 1024px) 12vw, (min-width: 640px) 22vw, 30vw"
                className="transition-colors group-hover:border-input"
              />
              <MediaPosterCaption
                title={item.title}
                subtitle={
                  [item.year, item.rating != null ? item.rating.toFixed(1) : null]
                    .filter((part) => part != null)
                    .join(" · ") || null
                }
              />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
