import { useState } from "react";
import { Check, Inbox, Loader2, X } from "lucide-react";
import { toast } from "@/lib/toast";
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
import { useSessionInfo } from "@/lib/session";
import { sessionAwareFetch } from "@/lib/session-expiry";
import {
  inboxRows,
  parseOwnerRequests,
  scopeLabel,
  statusLabel,
  statusTone,
  type OwnerRequest,
} from "@/components/requester/requests";

const REASON_MAX = 500;

/** The owner's request inbox: pending requests to approve or decline, and what was decided. */
export default function RequestsPage() {
  const session = useSessionInfo();
  const list = useApiQuery("/api/requests", { select: parseOwnerRequests, refreshMs: 30_000 });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [declining, setDeclining] = useState<OwnerRequest | null>(null);
  const [reason, setReason] = useState("");
  const rows = inboxRows(list.data?.requests ?? []);

  async function decide(request: OwnerRequest, action: "approve" | "decline", declineReason?: string) {
    setBusyId(request.id);
    try {
      const res = await sessionAwareFetch(`/api/requests/${encodeURIComponent(request.id)}/${action}`, {
        method: "POST",
        ...(action === "decline"
          ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: declineReason?.trim() || null }) }
          : {}),
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) toast.error(body?.error ?? `Couldn't ${action} ${request.title}.`);
      else if (action === "approve") toast.success(`Approved ${request.title}`, { description: "It's downloading on the request lane." });
      else toast.success(`Declined ${request.title}`);
    } catch (err) {
      toast.error((err as Error)?.message || `Couldn't ${action} ${request.title}.`);
    } finally {
      setBusyId(null);
      list.refetch();
      session.retry();
    }
  }

  return (
    <div className="container-app max-w-4xl space-y-5 py-6" data-owner-requests>
      <div className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight text-[var(--text)]">Requests</h1>
        <p className="text-sm text-[var(--text-secondary)]">What friends asked for. Approving starts the download.</p>
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
      ) : list.error && rows.length === 0 ? (
        <TfErrorState title="Couldn't load requests" message={list.error} onRetry={list.refetch} retrying={list.refreshing} />
      ) : rows.length === 0 ? (
        <TfEmptyState icon={Inbox} title="No requests" description="When a friend asks for a title it shows up here." />
      ) : (
        <ul className="space-y-2" data-owner-request-list>
          {rows.map((request) => {
            const busy = busyId === request.id;
            return (
              <li key={request.id} className="surface flex gap-3 p-3 sm:gap-4" data-owner-request-row={request.status}>
                <div className="relative aspect-[2/3] w-12 shrink-0 self-start overflow-hidden rounded-md bg-[var(--bg-muted)] sm:w-14">
                  <PosterImage src={request.posterUrl} title={request.title} sizes="56px" />
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 space-y-1">
                    <p className="line-clamp-2 text-sm font-medium text-[var(--text)]">
                      {request.title}
                      {request.year ? (
                        <span className="ml-1.5 font-normal tabular-nums text-[var(--text-tertiary)]">{request.year}</span>
                      ) : null}
                    </p>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge variant={statusTone(request.status)} data-owner-request-status={request.status}>
                        {request.status === "pending" ? "Waiting for you" : statusLabel(request.status)}
                      </Badge>
                      <span className="text-xs text-[var(--text-tertiary)]">{scopeLabel(request)}</span>
                    </div>
                    <p className="truncate text-xs text-[var(--text-tertiary)]" title={request.requestedBy}>
                      From {request.requestedBy || "someone"}
                    </p>
                    {request.note ? <p className="line-clamp-3 text-xs text-[var(--text-secondary)]">“{request.note}”</p> : null}
                    {request.decisionReason ? (
                      <p className="text-xs text-[var(--text-secondary)]">Reason: {request.decisionReason}</p>
                    ) : null}
                  </div>
                  {request.status === "pending" ? (
                    <div className="flex shrink-0 gap-2">
                      <Button
                        type="button"
                        size="sm"
                        disabled={busy}
                        onClick={() => void decide(request, "approve")}
                        aria-label={`Approve ${request.title}`}
                        data-owner-request-approve={request.id}
                      >
                        {busy ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Check aria-hidden="true" />}
                        Approve
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => {
                          setReason("");
                          setDeclining(request);
                        }}
                        aria-label={`Decline ${request.title}`}
                        data-owner-request-decline={request.id}
                      >
                        <X aria-hidden="true" />
                        Decline
                      </Button>
                    </div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <AlertDialog open={declining != null} onOpenChange={(open) => (!open ? setDeclining(null) : undefined)}>
        <AlertDialogContent data-owner-decline-dialog>
          <AlertDialogHeader>
            <AlertDialogTitle>Decline {declining?.title}?</AlertDialogTitle>
            <AlertDialogDescription>They'll see it was declined, and your reason if you give one.</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1.5">
            <label htmlFor="decline-reason" className="text-xs font-medium text-[var(--text-secondary)]">
              Reason <span className="font-normal text-[var(--text-tertiary)]">(optional)</span>
            </label>
            <textarea
              id="decline-reason"
              value={reason}
              maxLength={REASON_MAX}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              className="w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-base text-[var(--text)] outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)] sm:text-sm"
              placeholder="Already on a streaming service, for example"
              data-owner-decline-reason
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (declining) void decide(declining, "decline", reason);
                setDeclining(null);
              }}
              data-owner-decline-confirm
            >
              Decline request
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
