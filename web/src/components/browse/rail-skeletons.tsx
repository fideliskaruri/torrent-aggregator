import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { TitleCardSkeleton } from "./title-card";
import { GRID } from "./rail-layout";

export function RailSkeleton({ cards = 6 }: { cards?: number }) {
  return (
    <section className="py-4 sm:py-5" aria-hidden>
      <Skeleton className="mb-2.5 h-3.5 w-40 rounded" />
      <ul className="flex gap-2.5 overflow-hidden sm:gap-3">
        {Array.from({ length: cards }, (_, index) => (
          <TitleCardSkeleton key={index} />
        ))}
      </ul>
    </section>
  );
}

export function RailGridSkeleton({ cards = 12 }: { cards?: number }) {
  return (
    <section className="py-4 sm:py-5" aria-hidden>
      <Skeleton className="mb-3 h-3.5 w-40 rounded" />
      <ul className={cn(GRID, "overflow-hidden")}>
        {Array.from({ length: cards }, (_, index) => (
          <TitleCardSkeleton key={index} layout="grid" />
        ))}
      </ul>
    </section>
  );
}
