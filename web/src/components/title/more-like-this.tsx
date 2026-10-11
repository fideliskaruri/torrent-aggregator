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
import { MediaPoster, MediaPosterCaption, MediaPosterSkeleton, RAIL_CARD_WIDTH } from "@/components/browse/media-poster-card";
import { RailStrip } from "@/components/browse/rail";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { TitleSimilar } from "./types";

const CARD = cn("group flex shrink-0 snap-start flex-col", RAIL_CARD_WIDTH);
/** Room for a two-line title and the facts line, so every rail row is the same height. */
const CAPTION = "block h-[3.75rem] overflow-hidden";

export function MoreLikeThis({
  items,
  loading = false,
  heading = "More like this",
}: {
  items: TitleSimilar[];
  /**
   * True while the extras round trip is in flight. The skeleton is one rail
   * row, the same height as the loaded rail whatever the item count, so the
   * sections below never move when the items arrive.
   */
  loading?: boolean;
  heading?: string;
}) {
  if (!loading && items.length === 0) return null;

  if (loading && items.length === 0) {
    return (
      <div aria-busy="true" aria-hidden className="[&_[data-rail-arrow]]:hidden">
        <RailStrip id="title-similar-pending" title={<span className="flex h-lh items-center"><Skeleton className="h-3.5 w-28 rounded" /></span>} itemCount={10} className="py-0 sm:py-0">
          {Array.from({ length: 10 }, (_, i) => (
            <li key={i} className={CARD}>
              <MediaPosterSkeleton variant="rail" caption={false} />
              <span className={CAPTION}>
                <span className="mt-2 block">
                  <Skeleton className="h-3 w-4/5 rounded" />
                  <Skeleton className="mt-1.5 h-2.5 w-2/5 rounded" />
                </span>
              </span>
            </li>
          ))}
        </RailStrip>
      </div>
    );
  }

  return (
    <RailStrip id="title-similar" title={heading} itemCount={items.length} className="py-0 sm:py-0">
      {items.map((item) => (
        <li key={`${item.workKey}:${item.title}:${item.year ?? ""}`} className={CARD}>
          <Link
            to={item.href}
            data-similar-card
            data-rail-card
            className="block rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
            <MediaPoster
              variant="rail"
              src={item.posterUrl}
              title={item.title}
              sizes="(min-width: 1024px) 168px, (min-width: 640px) 148px, 124px"
              className="transition-colors group-hover:border-input"
            />
            <span className={CAPTION}><MediaPosterCaption
              title={item.title}
              subtitle={
                [item.year, item.rating != null ? item.rating.toFixed(1) : null]
                  .filter((part) => part != null)
                  .join(" · ") || null
              }
            /></span>
          </Link>
        </li>
      ))}
    </RailStrip>
  );
}