import { useMemo, useState } from "react";
import { Ban, Check, Inbox, Loader2, Plus, RotateCw, Search, X } from "lucide-react";
import { openReleasePicker, PICK_RELEASE_LABEL } from "@/components/releases/release-picker-store";
import { toast } from "@/lib/toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmDialog } from "@/components/tf/confirm-dialog";
import { MediaPoster } from "@/components/browse/media-poster-card";
import { useWorkArtwork } from "@/hooks/use-work-artwork";
import { TfEmptyState } from "@/components/tf/empty-state";
import { TfErrorState } from "@/components/tf/error-state";
import { PageQueryBoundary } from "@/components/tf/page-query-boundary";
import { cn } from "@/lib/utils";
import { useApiQuery } from "@/hooks/use-api-query";
import { useSessionInfo } from "@/lib/session";
import { useCapabilities } from "@/lib/capabilities";
import { sessionAwareFetch } from "@/lib/session-expiry";
import {
  autoApproveModeLabel,
  autoApproveRows,
  inboxRows,
  parseAutoApprove,
  cancelRequest,
  myRequestRows,
  parseOwnerRequests,
  parseRequests,
  ownerRequestErrorMessage,
  scopeLabel,
  statusLabel,
  canRetryRequest,
  statusTone,
  type AutoApproveMode,
  type AutoApproveRule,
  type OwnerRequest,
} from "@/lib/requests";

const REASON_MAX = 500;
const AUTO_MODES: AutoApproveMode[] = ["none", "moviesOnly", "everything"];

/**
 * One page for everyone. The owner sees the inbox of every request, with
 * approve, decline and auto-approve; a requester sees their own requests, with
 * Cancel while one is still waiting.
 */
export default function RequestsPage() {
  const session = useSessionInfo();
  const caps = useCapabilities();
  const reviewing = caps.canReviewRequests;
  // Only a real requester may call /api/requester/*; the owner's preview maps the owner's list instead.
  const ownerList = useApiQuery(caps.ownerSession ? "/api/requests" : null, {
    select: parseOwnerRequests,
    refreshMs: 30_000,
  });
  const mineList = useApiQuery(caps.ownerSession ? null : "/api/requester/requests", {
    select: (json: unknown) => ({ requests: parseRequests(json).map((r): OwnerRequest => ({ ...r, requestedBy: "", workKey: "" })) }),
    refreshMs: 30_000,
    emptyOnUnauthorized: false,
  });
  const list = caps.ownerSession ? ownerList : mineList;
  const auto = useApiQuery(reviewing ? "/api/requests/auto-approve" : null, { select: parseAutoApprove, refreshMs: 60_000 });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [declining, setDeclining] = useState<OwnerRequest | null>(null);
  const [reason, setReason] = useState("");
  const [autoBusy, setAutoBusy] = useState(false);
  const [draftEmail, setDraftEmail] = useState("");
  const [extraEmails, setExtraEmails] = useState<string[]>([]);
  const rows = reviewing ? inboxRows(list.data?.requests ?? []) : myRequestRows(list.data?.requests ?? []);
  // Requests saved without a poster ask the shared artwork lookup by title and year.
  const missingArt = useMemo(
    () =>
      rows
        .filter((r) => !r.posterUrl)
        .map((r) => ({ name: r.title, workTitle: r.title, workYear: r.year ?? null })),
    [rows],
  );
  const artwork = useWorkArtwork(missingArt);
  const autoRows = useMemo(
    () => autoApproveRows(auto.data ?? { rules: [], knownEmails: [] }, extraEmails),
    [auto.data, extraEmails],
  );

  async function decide(request: OwnerRequest, action: "approve" | "decline" | "retry", declineReason?: string) {
    setBusyId(request.id);
    try {
      const res = await sessionAwareFetch(`/api/requests/${encodeURIComponent(request.id)}/${action}`, {
        method: "POST",
        ...(action === "decline"
          ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: declineReason?.trim() || null }) }
          : {}),
      });
      const body = (await res.json().catch(() => null)) as { code?: unknown } | null;
      if (!res.ok) toast.error(ownerRequestErrorMessage(action, { code: typeof body?.code === "string" ? body.code : null, status: res.status }));
      else if (action === "approve") toast.success(`Approved ${request.title}`, { description: "It's downloading on the request lane." });
      else if (action === "retry") toast.success(`Retrying ${request.title}`, { description: "Only the missing episodes are searched again." });
      else toast.success(`Declined ${request.title}`);
    } catch {
      toast.error(ownerRequestErrorMessage(action, {}));
    } finally {
      setBusyId(null);
      list.refetch();
      session.retry();
    }
  }

  async function cancel(request: OwnerRequest) {
    if (caps.previewing) {
      toast.error("Requests aren't cancelled while previewing.", { description: "Exit preview to go back to your own view." });
      return;
    }
    setBusyId(request.id);
    const error = await cancelRequest(request.id);
    if (error) toast.error(error);
    else toast.success(`Cancelled ${request.title}`);
    setBusyId(null);
    list.refetch();
  }

  async function saveAutoRules(next: AutoApproveRule[]) {
    setAutoBusy(true);
    try {
      const res = await sessionAwareFetch("/api/requests/auto-approve", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rules: next }),
      });
      const body = (await res.json().catch(() => null)) as { code?: unknown } | null;
      if (!res.ok) {
        toast.error(ownerRequestErrorMessage("auto-approve", { code: typeof body?.code === "string" ? body.code : null, status: res.status }));
        return;
      }
      toast.success("Auto-approve updated");
      auto.refetch();
    } catch {
      toast.error(ownerRequestErrorMessage("auto-approve", {}));
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
    <div className="container-app max-w-4xl space-y-6 py-6" data-requests-page={reviewing ? "inbox" : "mine"} {...(reviewing ? { "data-owner-requests": "" } : {})}>
      <div className="space-y-2">
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-foreground">Requests</h1>
        <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
          {reviewing
            ? "What friends asked for. Approving starts the download."
            : "What you asked for. The owner decides, and you can cancel while it's waiting."}
        </p>
        {caps.previewing ? (
          <p className="max-w-prose text-sm text-muted-foreground" data-requests-preview-note>
            Preview: this lists every friend&apos;s request and Cancel is off. A friend sees only their own.
          </p>
        ) : null}
      </div>

      {reviewing ? (
      <section className="surface space-y-3 p-3 sm:p-4" data-auto-approve>
        <div className="space-y-0.5">
          <h2 className="text-sm font-semibold text-foreground">Auto-approve</h2>
          <p className="text-xs text-muted-foreground">
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
              <li className="text-xs text-subtle-foreground">No requesters yet. Add an email below.</li>
            ) : (
              autoRows.map((row) => (
                <li
                  key={row.email}
                  className="flex flex-col gap-2 rounded-md border border-border bg-background p-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3"
                  data-auto-approve-row={row.email}
                >
                  <span className="min-w-0 truncate text-sm text-foreground" title={row.email}>
                    {row.email}
                  </span>
                  <Select
                    value={row.mode}
                    disabled={autoBusy}
                    onValueChange={(value) => void setMode(row.email, value as AutoApproveMode)}
                  >
                    <SelectTrigger
                      id={`auto-mode-${row.email}`}
                      className="w-full shrink-0 sm:w-44"
                      data-auto-approve-mode={row.email}
                      aria-label={`Auto-approve mode for ${row.email}`}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {AUTO_MODES.map((mode) => (
                        <SelectItem key={mode} value={mode}>
                          {autoApproveModeLabel(mode)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </li>
              ))
            )}
          </ul>
        )}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Label htmlFor="auto-approve-add" className="sr-only">
            Add requester email
          </Label>
          <Input
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
            className="min-w-0 flex-1"
            data-auto-approve-add-email
          />
          <Button
            type="button"
            size="sm"
            variant="secondary"
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
      ) : null}

      <PageQueryBoundary
        query={list}
        errorTitle="Couldn't load requests"
        isEmpty={() => rows.length === 0}
        skeleton={(visible) => (
        <ul className={cn("space-y-2", !visible && "invisible")} aria-busy="true" aria-label="Loading requests">
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
        )}
        empty={
        reviewing ? (
          <TfEmptyState icon={Inbox} title="No requests" description="When a friend asks for a title it shows up here." />
        ) : (
          <TfEmptyState
            icon={Inbox}
            title="No requests yet"
            description="Browse or search for something, then press Request."
            actionLabel="Go to Browse"
            actionHref="/"
          />
        )
        }
      >
        {() => (
        <ul className="space-y-2" data-owner-request-list>
          {rows.map((request) => {
            const busy = busyId === request.id;
            return (
              <li key={request.id} className="surface flex gap-3 p-3 sm:gap-4" data-owner-request-row={request.status}>
                <MediaPoster variant="row" src={request.posterUrl ?? artwork.artFor({ name: request.title, workTitle: request.title, workYear: request.year ?? null })?.posterUrl} title={request.title} />
                <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 space-y-1">
                    <p className="line-clamp-2 text-sm font-medium text-foreground">
                      {request.title}
                      {request.year ? (
                        <span className="ml-1.5 font-normal tabular-nums text-subtle-foreground">{request.year}</span>
                      ) : null}
                    </p>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge variant={statusTone(request.status)} data-owner-request-status={request.status}>
                        {request.status === "pending" && reviewing ? "Waiting for you" : statusLabel(request.status)}
                      </Badge>
                      <span className="text-xs text-subtle-foreground">{scopeLabel(request)}</span>
                    </div>
                    {reviewing ? (
                      <p className="truncate text-xs text-subtle-foreground" title={request.requestedBy}>
                        From {request.requestedBy || "someone"}
                      </p>
                    ) : null}
                    {request.note ? <p className="line-clamp-3 text-xs text-muted-foreground">“{request.note}”</p> : null}
                    {request.decisionReason ? (
                      <p className="text-xs text-muted-foreground">Reason: {request.decisionReason}</p>
                    ) : null}
                  </div>
                  {request.status === "pending" && !reviewing ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="shrink-0 self-start"
                      disabled={busy || caps.previewing}
                      onClick={() => void cancel(request)}
                      aria-label={`Cancel request for ${request.title}`}
                      data-request-cancel={request.id}
                    >
                      {busy ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Ban aria-hidden="true" />}
                      Cancel request
                    </Button>
                  ) : null}
                  {request.status === "pending" && reviewing ? (
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
                  {reviewing && canRetryRequest(request.status) ? (
                    <div className="flex shrink-0 flex-wrap gap-2 self-start">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void decide(request, "retry")}
                      aria-label={`Retry missing episodes for ${request.title}`}
                      data-owner-request-retry={request.id}
                    >
                      {busy ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <RotateCw aria-hidden="true" />}
                      {request.scope === "movie" ? "Retry" : "Retry missing episodes"}
                    </Button>
                    {request.workKey ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          openReleasePicker({
                            workKey: request.workKey,
                            title: request.title,
                            season: request.seasons.length === 1 ? request.seasons[0] : null,
                            requestId: request.id,
                            onPicked: list.refetch,
                          })
                        }
                        data-owner-request-pick={request.id}
                      >
                        <Search aria-hidden="true" />
                        {PICK_RELEASE_LABEL}
                      </Button>
                    ) : null}
                    </div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
        )}
      </PageQueryBoundary>

      <ConfirmDialog
        open={declining != null}
        onOpenChange={(open) => (!open ? setDeclining(null) : undefined)}
        contentData={{ "data-owner-decline-dialog": true }}
        confirmData={{ "data-owner-decline-confirm": true }}
        title={`Decline ${declining?.title ?? "this request"}?`}
        description="They'll see it was declined, and your reason if you give one."
        cancelLabel="Keep it"
        confirmLabel="Decline request"
        onConfirm={() => {
          if (declining) void decide(declining, "decline", reason);
          setDeclining(null);
        }}
      >
          <div className="space-y-1.5">
            <Label htmlFor="decline-reason" className="text-xs text-muted-foreground">
              Reason <span className="font-normal text-subtle-foreground">(optional)</span>
            </Label>
            <Textarea
              id="decline-reason"
              value={reason}
              maxLength={REASON_MAX}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              className="min-h-20"
              placeholder="Already on a streaming service, for example"
              data-owner-decline-reason
            />
          </div>
      </ConfirmDialog>
    </div>
  );
}
