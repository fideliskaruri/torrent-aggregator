import { useState } from "react";
import { Link } from "react-router";
import { Inbox, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { PosterImage } from "@/components/browse/poster-image";
import { TfEmptyState } from "@/components/tf/empty-state";
import { TfErrorState } from "@/components/tf/error-state";
import { useApiQuery } from "@/hooks/use-api-query";
import { sessionAwareFetch } from "@/lib/session-expiry";
import {
  parseRequests,
  requestErrorMessage,
  scopeLabel,
  statusLabel,
  statusTone,
  type RequesterRequest,
} from "./requests";

/** The requester's own requests, newest first. Pending ones can be cancelled. */
export function MyRequests() {
  const list = useApiQuery("/api/requester/requests", {
    select: parseRequests,
    emptyOnUnauthorized: false,
    refreshMs: 60_000,
  });
  const [cancelling, setCancelling] = useState<RequesterRequest | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const requests = list.data ?? [];

  async function cancel(request: RequesterRequest) {
    setBusyId(request.id);
    try {
      const res = await sessionAwareFetch(
        `/api/requester/requests/${encodeURIComponent(request.id)}/cancel`,
        { method: "POST" },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { code?: string; error?: string } | null;
        toast.error(requestErrorMessage(body?.code, body?.error));
      } else {
        toast.success(`Cancelled ${request.title}`);
      }
    } catch (err) {
      toast.error(requestErrorMessage(null, (err as Error)?.message));
    } finally {
      setBusyId(null);
      list.refetch();
    }
  }

  return (
    <div className="space-y-5" data-requester-requests>
      <div className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight text-[var(--text)]">My requests</h1>
        <p className="text-sm text-[var(--text-secondary)]">What you asked for and where it stands.</p>
      </div>

      {list.loading ? (
        <ul className="space-y-2" aria-busy="true" aria-label="Loading requests">
          {Array.from({ length: 3 }, (_, i) => (
            <li key={i} className="surface flex gap-3 p-3" aria-hidden>
              <div className="skeleton aspect-[2/3] w-12 shrink-0 rounded-md" />
              <div className="flex flex-1 flex-col gap-2">
                <div className="skeleton h-4 w-1/2 rounded" />
                <div className="skeleton h-3 w-1/3 rounded" />
              </div>
            </li>
          ))}
        </ul>
      ) : list.error && requests.length === 0 ? (
        <TfErrorState
          title="Couldn't load your requests"
          message={list.error}
          onRetry={list.refetch}
          retrying={list.refreshing}
        />
      ) : requests.length === 0 ? (
        <TfEmptyState
          icon={Inbox}
          title="No requests yet"
          description="Search for a movie or show and tap Request."
          actionLabel="Search titles"
          actionHref="/"
        />
      ) : (
        <ul className="space-y-2" data-requester-request-list>
          {requests.map((request) => (
            <li
              key={request.id}
              className="surface flex gap-3 p-3 sm:gap-4"
              data-requester-request-row={request.status}
            >
              <div className="relative aspect-[2/3] w-12 shrink-0 self-start overflow-hidden rounded-md bg-[var(--bg-muted)] sm:w-14">
                <PosterImage src={request.posterUrl} title={request.title} sizes="56px" />
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-1.5 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 space-y-1">
                  <p className="line-clamp-2 text-sm font-medium text-[var(--text)]">
                    {request.title}
                    {request.year ? (
                      <span className="ml-1.5 font-normal tabular-nums text-[var(--text-tertiary)]">
                        {request.year}
                      </span>
                    ) : null}
                  </p>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant={statusTone(request.status)} data-requester-status={request.status}>
                      {statusLabel(request.status)}
                    </Badge>
                    <span className="text-xs text-[var(--text-tertiary)]">{scopeLabel(request)}</span>
                    {request.createdAt ? (
                      <span className="text-xs text-[var(--text-tertiary)]">· {formatDate(request.createdAt)}</span>
                    ) : null}
                  </div>
                  {request.decisionReason ? (
                    <p className="text-xs text-[var(--text-secondary)]">{request.decisionReason}</p>
                  ) : null}
                  {request.note ? (
                    <p className="line-clamp-2 text-xs text-[var(--text-tertiary)]">Your note: {request.note}</p>
                  ) : null}
                </div>
                {request.status === "pending" ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="self-start"
                    disabled={busyId === request.id}
                    onClick={() => setCancelling(request)}
                    aria-label={`Cancel request for ${request.title}`}
                    data-requester-cancel={request.id}
                  >
                    {busyId === request.id ? (
                      <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                    ) : (
                      <X aria-hidden="true" />
                    )}
                    Cancel
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      {requests.length > 0 ? (
        <p className="text-xs text-[var(--text-tertiary)]">
          Want something else? <Link to="/" className="text-[var(--accent-text)] underline-offset-4 hover:underline">Search titles</Link>
        </p>
      ) : null}

      <AlertDialog open={cancelling != null} onOpenChange={(open) => (!open ? setCancelling(null) : undefined)}>
        <AlertDialogContent data-requester-cancel-dialog>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this request?</AlertDialogTitle>
            <AlertDialogDescription>
              {cancelling ? `${cancelling.title} (${scopeLabel(cancelling)})` : ""} will be taken off the list. You can ask again later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (cancelling) void cancel(cancelling);
                setCancelling(null);
              }}
              data-requester-cancel-confirm
            >
              Cancel request
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
