import { useMemo, useState } from "react";
import { Check, Inbox, Loader2, Plus, X } from "lucide-react";
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
  autoApproveModeLabel,
  autoApproveRows,
  inboxRows,
  parseAutoApprove,
  parseOwnerRequests,
  scopeLabel,
  statusLabel,
  statusTone,
  type AutoApproveMode,
  type AutoApproveRule,
  type OwnerRequest,
} from "@/components/requester/requests";

const REASON_MAX = 500;
const AUTO_MODES: AutoApproveMode[] = ["none", "moviesOnly", "everything"];

/** The owner's request inbox: pending requests to approve or decline, and what was decided. */
export default function RequestsPage() {
  const session = useSessionInfo();
  const list = useApiQuery("/api/requests", { select: parseOwnerRequests, refreshMs: 30_000 });
  const auto = useApiQuery("/api/requests/auto-approve", { select: parseAutoApprove, refreshMs: 60_000 });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [declining, setDeclining] = useState<OwnerRequest | null>(null);
  const [reason, setReason] = useState("");
  const [autoBusy, setAutoBusy] = useState(false);
  const [draftEmail, setDraftEmail] = useState("");
  const [extraEmails, setExtraEmails] = useState<string[]>([]);
  const rows = inboxRows(list.data?.requests ?? []);
  const autoRows = useMemo(
    () => autoApproveRows(auto.data ?? { rules: [], knownEmails: [] }, extraEmails),
    [auto.data, extraEmails],
  );

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

  async function saveAutoRules(next: AutoApproveRule[]) {
    setAutoBusy(true);
    try {
      const res = await sessionAwareFetch("/api/requests/auto-approve", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rules: next }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        toast.error(body?.error ?? "Couldn't save auto-approve rules.");
        return;
      }
      toast.success("Auto-approve updated");
      auto.refetch();
    } catch (err) {
      toast.error((err as Error)?.message || "Couldn't save auto-approve rules.");
    } finally {
      setAutoBusy(false);
    }
  }

  async function setMode(email: string, mode: AutoApproveMode) {
    const others = autoRows.filter((r) => r.email !== email && r.mode !== "none").map((r) => ({ email: r.email, mode: r.mode }));
    const next = mode === "none" ? others : [...others, { email, mode }];
    await saveAutoRules(next);
  }

  function addEmail() {
    const email = draftEmail.trim().toLowerCase();
    if (!email || !email.includes("@")) {
      toast.error("Enter a valid email.");
      return;
    }
    if (!extraEmails.includes(email) && !autoRows.some((r) => r.email === email)) {
      setExtraEmails((prev) => [...prev, email]);
    }
    setDraftEmail("");
  }

  return (
    <div className="container-app max-w-4xl space-y-5 py-6" data-owner-requests>
      <div className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight text-[var(--text)]">Requests</h1>
        <p className="text-sm text-[var(--text-secondary)]">What friends asked for. Approving starts the download.</p>
      </div>

      <section className="surface space-y-3 p-3 sm:p-4" data-auto-approve>
        <div className="space-y-0.5">
          <h2 className="text-sm font-semibold text-[var(--text)]">Auto-approve</h2>
          <p className="text-xs text-[var(--text-secondary)]">
            Skip the inbox for trusted friends. Movies only still asks you about series.
          </p>
        </div>
        {auto.loading && autoRows.length === 0 ? (
          <div className="skeleton h-12 w-full rounded-md" aria-hidden />
        ) : auto.error && autoRows.length === 0 ? (
          <TfErrorState title="Couldn't load auto-approve" message={auto.error} onRetry={auto.refetch} retrying={auto.refreshing} />
        ) : (
          <ul className="space-y-2" data-auto-approve-list>
            {autoRows.length === 0 ? (
              <li className="text-xs text-[var(--text-tertiary)]">No requesters yet. Add an email below.</li>
            ) : (
              autoRows.map((row) => (
                <li
                  key={row.email}
                  className="flex flex-col gap-2 rounded-md border border-[var(--border)] bg-[var(--bg)] p-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3"
                  data-auto-approve-row={row.email}
                >
                  <span className="min-w-0 truncate text-sm text-[var(--text)]" title={row.email}>
                    {row.email}
                  </span>
                  <label className="sr-only" htmlFor={`auto-mode-${row.email}`}>
                    Auto-approve for {row.email}
                  </label>
                  <select
                    id={`auto-mode-${row.email}`}
                    value={row.mode}
                    disabled={autoBusy}
                    onChange={(e) => void setMode(row.email, e.target.value as AutoApproveMode)}
                    className="min-h-[44px] w-full shrink-0 rounded-md border border-[var(--border)] bg-[var(--bg-muted)] px-3 text-base text-[var(--text)] outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)] sm:w-44 sm:text-sm"
                    data-auto-approve-mode={row.email}
                    aria-label={`Auto-approve mode for ${row.email}`}
                  >
                    {AUTO_MODES.map((mode) => (
                      <option key={mode} value={mode}>
                        {autoApproveModeLabel(mode)}
                      </option>
                    ))}
                  </select>
                </li>
              ))
            )}
          </ul>
        )}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <label htmlFor="auto-approve-add" className="sr-only">
            Add requester email
          </label>
          <input
            id="auto-approve-add"
            type="email"
            value={draftEmail}
            onChange={(e) => setDraftEmail(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addEmail();
              }
            }}
            placeholder="friend@example.com"
            className="min-h-[44px] min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 text-base text-[var(--text)] outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)] sm:text-sm"
            data-auto-approve-add-email
          />
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="min-h-[44px]"
            disabled={autoBusy}
            onClick={addEmail}
            aria-label="Add email to auto-approve list"
            data-auto-approve-add
          >
            <Plus aria-hidden="true" />
            Add email
          </Button>
        </div>
      </section>

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
