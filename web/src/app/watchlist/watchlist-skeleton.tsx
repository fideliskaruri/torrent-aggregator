import { MediaPosterSkeleton } from "@/components/browse/media-poster-card";
import { PageSkeletonFrame, SkeletonBlock } from "@/components/ui/loading";
import { cn } from "@/lib/utils";

export function LibrarySkeleton({ visible = true }: { visible?: boolean }) {
  return (
    <PageSkeletonFrame
      aria-label="Loading library"
      className={cn("container-app min-w-0 space-y-6 py-6 transition-opacity duration-150 sm:py-8", !visible && "opacity-0")}
    >
      <h1 className="sr-only">Library</h1>
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-2"><SkeletonBlock className="h-8 w-28" /><SkeletonBlock className="h-4 w-52 max-w-full" /></div>
        <SkeletonBlock className="h-8 w-32" />
      </div>
      <SkeletonBlock className="h-10 w-full max-w-2xl" />
      <div className="grid gap-3 sm:grid-cols-2">
        {Array.from({ length: 4 }, (_, index) => <article key={index} className="surface flex min-w-0 gap-3 p-3.5">
          <MediaPosterSkeleton variant="library" />
          <div className="min-w-0 flex-1 space-y-3"><SkeletonBlock className="h-5 w-4/5" /><SkeletonBlock className="h-3 w-1/2" /><SkeletonBlock className="h-20 w-full" /><SkeletonBlock className="h-8 w-28" /></div>
        </article>)}
      </div>
    </PageSkeletonFrame>
  );
}
