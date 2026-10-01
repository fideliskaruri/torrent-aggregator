import type { ReactNode } from "react";
import { HeroSkeleton } from "./hero-banner";
import { RailGridSkeleton, RailSkeleton } from "./rail";
import { PageSkeletonFrame } from "@/components/ui/loading";
import { cn } from "@/lib/utils";

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
 * lie. A genre page is a grid, so it gets a grid, under the same hero.
 *
 * `filters` sits exactly where the board puts it (under the hero), so the
 * section pills do not jump when the payload lands.
 */
export function BrowseSkeleton({
  visible = true,
  grid = false,
  filters,
}: {
  visible?: boolean;
  grid?: boolean;
  filters?: ReactNode;
}) {
  return (
    <PageSkeletonFrame
      aria-label="Loading browse"
      className={cn(
        "transition-opacity duration-150",
        !visible && "opacity-0",
      )}
    >
      <HeroSkeleton />
      <div className="container-app min-w-0 pb-14">
        {filters}
        {grid ? (
          <RailGridSkeleton />
        ) : (
          <>
            <RailSkeleton />
            <RailSkeleton />
          </>
        )}
      </div>
    </PageSkeletonFrame>
  );
}
