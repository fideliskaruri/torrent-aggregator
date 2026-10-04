import { Skeleton } from "@/components/ui/skeleton";

export function TitleDetailSkeleton() {
  return (
    <div aria-hidden>
      <div className="border-b border-border bg-card">
        <div className="container-app">
          <div className="grid grid-cols-1 items-end gap-4 py-5 sm:py-8 md:grid-cols-[168px_minmax(0,1fr)] md:gap-6 md:py-10 lg:grid-cols-[196px_minmax(0,1fr)] lg:py-12">
            <div className="w-[104px] shrink-0 sm:w-[120px] md:w-[168px] lg:w-[196px]">
              <Skeleton className="aspect-[2/3] w-full rounded-lg" />
            </div>
            <div className="min-w-0 max-w-2xl flex-1">
              <Skeleton className="h-9 w-3/4 rounded" />
              <Skeleton className="mt-3 h-3 w-40 rounded" />
              <Skeleton className="mt-5 h-11 w-full rounded-lg md:w-44" />
            </div>
            <div className="space-y-2 md:col-start-2">
              <Skeleton className="h-3 w-full max-w-md rounded" />
              <Skeleton className="h-3 w-4/5 max-w-md rounded" />
            </div>
          </div>
        </div>
      </div>
      <div className="container-app py-6 md:py-8">
        <Skeleton className="h-5 w-32 rounded" />
        <div className="mt-3 space-y-2 sm:flex sm:gap-3 sm:space-y-0 sm:overflow-hidden">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton
              key={i}
              className="h-24 w-full rounded-lg sm:h-[215px] sm:w-[300px] sm:shrink-0"
            />
          ))}
        </div>
      </div>
    </div>
  );
}
