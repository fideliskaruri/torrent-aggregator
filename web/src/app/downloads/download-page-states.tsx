import type { ComponentProps, ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { PageSkeletonFrame, SkeletonBlock } from "@/components/ui/loading";

export function DetailsDisclosure({
  className,
  contentClassName,
  children,
  ...props
}: ComponentProps<typeof Collapsible> & { contentClassName?: string }) {
  return (
    <Collapsible className={cn("group/details", className)} {...props}>
      <CollapsibleTrigger className="inline-flex min-h-11 cursor-pointer items-center gap-1 rounded-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        Details<ChevronDown aria-hidden className="h-3.5 w-3.5 transition-transform group-data-[state=open]/details:rotate-180"/>
      </CollapsibleTrigger>
      <CollapsibleContent className={contentClassName}>{children}</CollapsibleContent>
    </Collapsible>
  );
}

export function ClientSkeleton({ visible = true }: { visible?: boolean }) {
  return (
    <PageSkeletonFrame aria-label="Loading downloads"
      className={cn("container-app max-w-5xl space-y-4 py-6 transition-opacity duration-150 sm:py-8", !visible && "opacity-0")}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-2"><SkeletonBlock className="h-8 w-24"/><SkeletonBlock className="h-4 w-80 max-w-full"/></div>
        <div className="flex flex-wrap gap-2"><SkeletonBlock className="h-8 w-20"/><SkeletonBlock className="h-8 w-24"/></div>
      </div>
      <div className="grid gap-2 sm:grid-cols-5">{Array.from({ length: 5 }, (_, i) => <SkeletonBlock key={i} className="h-16 w-full"/>)}</div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <SkeletonBlock className="h-8 w-full max-w-sm"/><div className="flex gap-1">{Array.from({ length: 5 }, (_, i) => <SkeletonBlock key={i} className="h-7 w-20"/>)}</div>
      </div>
      <div className="surface overflow-hidden">{Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="grid grid-cols-1 gap-2 px-3 py-2.5 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:gap-3">
          <SkeletonBlock className="h-4 w-4"/><div className="flex gap-2.5">
            <SkeletonBlock className="h-10 w-10 shrink-0 rounded-md"/>
            <div className="min-w-0 flex-1 space-y-2"><SkeletonBlock className="h-4 w-4/5"/><SkeletonBlock className="h-3 w-2/3"/><SkeletonBlock className="h-3 w-1/2"/></div>
          </div><SkeletonBlock className="h-8 w-24 justify-self-end"/>
        </div>
      ))}</div>
    </PageSkeletonFrame>
  );
}

export function DownloadsErrorDetails({ children }: { children: ReactNode }) {
  return <DetailsDisclosure><p className="mt-1 break-words font-mono text-[12px]">{children}</p></DetailsDisclosure>;
}
