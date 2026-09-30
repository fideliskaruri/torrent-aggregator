import { Compass } from "lucide-react";
import { TfEmptyState } from "@/components/tf/empty-state";
import { useDocumentTitle } from "@/hooks/use-document-title";

/**
 * Unmatched routes and 404 route errors. It renders inside the app shell in
 * the app theme, so the header, footer and phone nav stay usable, and it
 * offers a way back instead of a dead end.
 */
export function NotFoundPage() {
  useDocumentTitle("Page not found");
  return (
    <div className="container-app py-8 sm:py-12 min-w-0" data-not-found>
      <TfEmptyState
        icon={Compass}
        title="Page not found"
        headingLevel={1}
        description="This address does not match a page. The link may be old or mistyped."
        actionLabel="Go to Browse"
        actionHref="/"
      />
    </div>
  );
}
