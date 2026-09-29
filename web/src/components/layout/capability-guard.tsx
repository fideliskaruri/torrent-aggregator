import { Outlet, useLocation } from "react-router";
import { Lock } from "lucide-react";
import { TfEmptyState } from "@/components/tf/empty-state";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useCapabilities } from "@/lib/capabilities";
import { routeRequirement } from "@/lib/navigation";

/**
 * The one place a route is refused. Pages never check roles; the router nests
 * every page under this, and a page someone can't use is replaced before it
 * mounts, so it never calls an API that would answer 403.
 */
export function CapabilityGuard() {
  const pathname = useLocation().pathname;
  const caps = useCapabilities();
  const needs = routeRequirement(pathname);
  if (needs && !caps[needs]) return <NotAvailable />;
  return <Outlet />;
}

export function NotAvailable() {
  useDocumentTitle("Not available");
  return (
    <div className="container-app max-w-xl py-8 sm:py-12 min-w-0" data-not-available>
      <TfEmptyState
        icon={Lock}
        title="Not available"
        description="This page is only for the owner. Browse or search to request something."
        actionLabel="Go to Browse"
        actionHref="/"
      />
    </div>
  );
}
