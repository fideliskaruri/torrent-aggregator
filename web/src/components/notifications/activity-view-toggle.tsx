import type { ReactNode } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { useCapabilities } from "@/lib/capabilities";
import { cn } from "@/lib/utils";

export type ActivityView = "inbox" | "log";

const VIEWS: readonly { view: ActivityView; href: string; label: string }[] = [
  { view: "inbox", href: "/notifications", label: "Inbox" },
  { view: "log", href: "/history", label: "Download log" },
];

/**
 * The column both views of Notifications share. The Inbox | Download log toggle
 * sits at its top, outside either view's header, loading and error states, so
 * it stays in the same place when switching views.
 */
export function ActivityColumn({ view, children }: { view: ActivityView; children: ReactNode }) {
  // Only people who may open the log are offered it.
  const { canSeeTransfers } = useCapabilities();
  return (
    <div className="container-app">
      <div className="mx-auto w-full max-w-3xl min-w-0 space-y-4 py-6 sm:py-8">
        {canSeeTransfers && <ActivityViewToggle current={view} />}
        {children}
      </div>
    </div>
  );
}

/**
 * Inbox | Download log: the two views of Notifications. The log has no nav
 * entry of its own, so this is the way in.
 */
export function ActivityViewToggle({ current }: { current: ActivityView }) {
  return (
    <nav
      aria-label="Activity view"
      className="inline-flex rounded-lg bg-muted p-[3px]"
      data-activity-view-toggle
    >
      {VIEWS.map(({ view, href, label }) => {
        const active = view === current;
        return (
          <Button
            key={view}
            asChild
            size="sm"
            variant="ghost"
            className={cn(
              "min-w-11 px-3 text-[13px] max-lg:min-h-11",
              active
                ? "bg-background text-foreground shadow-sm hover:bg-background"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Link to={href} aria-current={active ? "page" : undefined}>
              {label}
            </Link>
          </Button>
        );
      })}
    </nav>
  );
}
