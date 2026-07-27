import { HeroSkeleton } from "./hero-banner";
import { RailSkeleton } from "./rail";

/**
 * The browse page while its one round trip is in flight.
 *
 * Skeleton rails rather than a spinner, and the choice is about layout rather
 * than taste: the rails arrive together from a single request, so there is one
 * visible gap on a cold load and then the whole page appears at once. A
 * spinner would reserve none of that space and the finished page would shove
 * everything down as it landed. These placeholders carry `TitleCard`'s exact
 * width and 2:3 ratio and the hero's exact height, so the real content lands
 * where the skeleton already was and nothing moves.
 *
 * Two rails, not five: it fills the fold at both 390px and 1440px, and
 * promising five rows to a user who is about to be shown one is its own small
 * lie.
 */
export function BrowseSkeleton() {
  return (
    <>
      <HeroSkeleton />
      <div className="container-app min-w-0 pb-14">
        <RailSkeleton />
        <RailSkeleton />
      </div>
    </>
  );
}
