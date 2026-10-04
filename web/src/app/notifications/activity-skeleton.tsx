import { PageSkeletonFrame } from "@/components/ui/loading";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export function ActivitySkeleton({ visible = true }: { visible?: boolean }) {
  return (
    <PageSkeletonFrame aria-label="Loading activity" className={cn("min-w-0 space-y-5 transition-opacity duration-150", !visible && "opacity-0")}>
      <div className="space-y-2">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-4 w-64 max-w-full" />
      </div>
      <Skeleton className="h-3 w-20" />
      <Card className="gap-0 py-0">
        <ul className="divide-y divide-border">
          {Array.from({ length: 6 }, (_, index) => (
            <li key={index} className="flex items-start gap-2.5 px-3 py-2.5" aria-hidden>
              <Skeleton className="h-5 w-14 shrink-0 rounded-full" />
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-4 w-4/5" />
                <Skeleton className="h-3 w-2/3" />
              </div>
              <Skeleton className="hidden h-3 w-12 shrink-0 sm:block" />
            </li>
          ))}
        </ul>
      </Card>
    </PageSkeletonFrame>
  );
}
