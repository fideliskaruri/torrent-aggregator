import { useState } from "react";
import { Inbox } from "lucide-react";
import { TfEmptyState } from "@/components/tf/empty-state";
import { TfPageHeader } from "@/components/tf/page-header";
import { PageQueryBoundary } from "@/components/tf/page-query-boundary";
import { useCapabilities } from "@/lib/capabilities";
import { RequestsList } from "./requests-list";
import { useRequestsPage } from "./use-requests-page";

export default function RequestsPage() {
  const capabilities = useCapabilities();
  const reviewing = capabilities.canReviewRequests;
  const page = useRequestsPage(capabilities.ownerSession, reviewing, capabilities.previewing);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function decide(...args: Parameters<typeof page.decide>) {
    setBusyId(args[0].id);
    try {
      await page.decide(...args);
    } finally {
      setBusyId(null);
    }
  }

  async function cancel(request: Parameters<typeof page.cancel>[0]) {
    setBusyId(request.id);
    try {
      await page.cancel(request);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div
      className="container-app max-w-4xl min-w-0 space-y-6 py-6 pb-[calc(var(--mobile-nav-h)+var(--safe-bottom)+1.5rem)] sm:py-8 sm:pb-8"
      data-requests-page={reviewing ? "inbox" : "mine"}
      {...(reviewing ? { "data-owner-requests": "" } : {})}
    >
      <TfPageHeader
        title="Requests"
        description={reviewing
          ? "What friends asked for. Approving starts the download."
          : "What you asked for. The owner decides, and you can cancel while it's waiting."}
      />
      {capabilities.previewing ? (
        <p className="max-w-prose text-sm text-muted-foreground" data-requests-preview-note>
          Preview: this lists every friend&apos;s request and Cancel is off. A friend sees only their own.
        </p>
      ) : null}
      <PageQueryBoundary
        query={page.list}
        errorTitle="Couldn't load requests"
        isEmpty={() => page.rows.length === 0}
        skeleton={() => (
          <div className="space-y-2" role="status" aria-label="Loading requests">
            {Array.from({ length: 3 }, (_, index) => (
              <div key={index} className="surface flex gap-3 p-3" aria-hidden>
                <div className="skeleton aspect-[2/3] w-12 shrink-0 rounded-md" />
                <div className="flex flex-1 flex-col gap-2">
                  <div className="skeleton h-4 w-1/2 rounded" />
                  <div className="skeleton h-3 w-1/3 rounded" />
                </div>
              </div>
            ))}
          </div>
        )}
        empty={<TfEmptyState icon={Inbox} title={reviewing ? "No requests" : "No requests yet"} description={reviewing ? "When a friend asks for a title it shows up here." : "Browse or search for something, then press Request."} actionLabel={reviewing ? undefined : "Go to Browse"} actionHref={reviewing ? undefined : "/"} />}
      >
        {() => (
          <RequestsList
            rows={page.rows}
            reviewer={reviewing}
            previewing={capabilities.previewing}
            busyId={busyId}
            onDecide={decide}
            onCancel={cancel}
          />
        )}
      </PageQueryBoundary>
    </div>
  );
}
