import { useCallback, useMemo, useState } from "react";
import { Check, Inbox, Loader2, RotateCw, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmDialog } from "@/components/tf/confirm-dialog";
import { ConfirmAction } from "@/components/tf/confirm-action";
import { DataList } from "@/components/tf/data-list";
import { FilterBar, type FilterField } from "@/components/tf/filter-bar";
import { BulkBar } from "@/components/tf/bulk-bar";
import { StatusChip } from "@/components/tf/status-chip";
import { TfEmptyState } from "@/components/tf/empty-state";
import { useSelection } from "@/components/tf/use-selection";
import { MediaPoster } from "@/components/browse/media-poster-card";
import { openReleasePicker, PICK_RELEASE_LABEL } from "@/components/releases/release-picker-store";
import { AIRING_NOTE, canRetryRequest, progressLabel, scopeLabel, statusTone } from "@/lib/requests";
import type { OwnerRequest, RequestStatus } from "@/lib/requests";

const REASON_MAX = 500;
const KEY = (request: OwnerRequest) => request.id;
const FILTER_FIELDS: readonly FilterField<OwnerRequest>[] = [
  { key: "title", label: "Search requests", kind: "search" },
  {
    key: "status",
    label: "Status",
    kind: "select",
    options: [
      { value: "pending", label: "Waiting" },
      { value: "approved", label: "Approved" },
      { value: "downloading", label: "Downloading" },
      { value: "available", label: "Available" },
      { value: "partial", label: "Partly done" },
      { value: "failed", label: "Couldn't get it" },
      { value: "declined", label: "Declined" },
      { value: "cancelled", label: "Cancelled" },
    ],
  },
];

function chipTone(status: RequestStatus): "active" | "done" | "error" | "neutral" {
  const tone = statusTone(status);
  return tone === "accent" ? "active" : tone === "success" ? "done" : tone === "danger" ? "error" : "neutral";
}

export function RequestsList({
  rows,
  reviewer,
  previewing,
  busyId,
  artFor,
  onDecide,
  onCancel,
}: {
  rows: OwnerRequest[];
  reviewer: boolean;
  previewing: boolean;
  busyId: string | null;
  artFor: (request: OwnerRequest) => string | null;
  onDecide: (request: OwnerRequest, action: "approve" | "decline" | "retry", reason?: string) => Promise<void>;
  onCancel: (request: OwnerRequest) => Promise<void>;
}) {
  const [predicate, setPredicate] = useState<(request: OwnerRequest) => boolean>(() => () => true);
  const [declining, setDeclining] = useState<OwnerRequest | null>(null);
  const [reason, setReason] = useState("");
  const filtered = useMemo(() => rows.filter(predicate), [rows, predicate]);
  const selection = useSelection(filtered, KEY);
  const filterChange = useCallback((next: (request: OwnerRequest) => boolean) => setPredicate(() => next), []);
  const clearFilters = useCallback(() => setPredicate(() => () => true), []);

  const empty = rows.length ? (
    <TfEmptyState icon={Search} title="No requests match" description="Clear the filters to see other requests." />
  ) : reviewer ? (
    <TfEmptyState icon={Inbox} title="No requests" description="When a friend asks for a title it shows up here." />
  ) : (
    <TfEmptyState
      icon={Inbox}
      title="No requests yet"
      description="Browse or search for something, then press Request."
      actionLabel="Go to Browse"
      actionHref="/"
    />
  );

  async function approveSelected() {
    const selected = selection.selected.filter((request) => request.status === "pending");
    selection.clear();
    for (const request of selected) await onDecide(request, "approve");
  }

  return (
    <FilterBar fields={FILTER_FIELDS} onPredicateChange={filterChange}>
      {({ activeCount }) => (
        <div className="space-y-4">
          <DataList
            items={filtered}
            getKey={KEY}
            selection={reviewer ? selection : undefined}
            empty={empty}
            noResults={Boolean(rows.length && activeCount)}
            onClearFilters={clearFilters}
            className="space-y-2"
            renderRow={(request) => {
              const busy = busyId === request.id;
              const shown = request.status === "pending" ? request.status : (request.phase ?? request.status);
              const from = (request.requesters.length ? request.requesters : [request.requestedBy]).filter(Boolean).join(", ");
              return (
                <div className="surface flex min-w-0 flex-wrap items-start gap-3 p-3 sm:gap-4" data-owner-request-row={request.status}>
                  <MediaPoster variant="row" src={artFor(request)} title={request.title} />
                  <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0 space-y-1">
                      <p className="line-clamp-2 text-sm font-medium text-foreground">
                        {request.title}
                        {request.year ? <span className="ml-1.5 font-normal text-subtle-foreground">{request.year}</span> : null}
                      </p>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <StatusChip
                          label={request.status === "pending" && reviewer ? "Waiting for you" : progressLabel(shown, request.done, request.total)}
                          tone={chipTone(shown)}
                          className="text-xs"
                        />
                        <span className="text-xs text-subtle-foreground">{scopeLabel(request)}</span>
                      </div>
                      {reviewer ? <p className="truncate text-xs text-subtle-foreground" title={from}>From {from || "someone"}</p> : null}
                      {shown === "available" && request.airing ? <p className="text-xs text-subtle-foreground">{AIRING_NOTE}</p> : null}
                      {request.note ? <p className="line-clamp-3 text-xs text-muted-foreground">“{request.note}”</p> : null}
                      {request.decisionReason ? <p className="text-xs text-muted-foreground">Reason: {request.decisionReason}</p> : null}
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-2">
                      {request.status === "pending" && !reviewer ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={busy || previewing}
                          onClick={() => void onCancel(request)}
                          aria-label={`Cancel request for ${request.title}`}
                          data-request-cancel={request.id}
                          className="min-h-11"
                        >
                          {busy ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
                          Cancel request
                        </Button>
                      ) : null}
                      {request.status === "pending" && reviewer ? (
                        <>
                          <Button type="button" size="sm" disabled={busy} onClick={() => void onDecide(request, "approve")} aria-label={`Approve ${request.title}`} data-owner-request-approve={request.id} className="min-h-11">
                            {busy ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Check aria-hidden="true" />}
                            Approve
                          </Button>
                          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => { setReason(""); setDeclining(request); }} aria-label={`Decline ${request.title}`} data-owner-request-decline={request.id} className="min-h-11">
                            <X aria-hidden="true" />Decline
                          </Button>
                        </>
                      ) : null}
                      {reviewer && canRetryRequest(request.status) ? (
                        <>
                          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void onDecide(request, "retry")} aria-label={`Retry missing episodes for ${request.title}`} data-owner-request-retry={request.id} className="min-h-11">
                            <RotateCw aria-hidden="true" />{request.scope === "movie" ? "Retry" : "Retry missing episodes"}
                          </Button>
                          {request.workKey ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              disabled={busy}
                              onClick={() => openReleasePicker({
                                workKey: request.workKey,
                                title: request.title,
                                season: request.seasons.length === 1 ? request.seasons[0] : null,
                                requestId: request.id,
                              })}
                              data-owner-request-pick={request.id}
                              className="min-h-11"
                            >
                              <Search aria-hidden="true" />{PICK_RELEASE_LABEL}
                            </Button>
                          ) : null}
                        </>
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            }}
          />
          {reviewer ? (
            <BulkBar
              count={selection.selected.length}
              onClear={selection.clear}
              actions={<ConfirmAction
                label={<><Check aria-hidden="true" />Approve selected</>}
                title={`Approve ${selection.selected.length} requests?`}
                description="These requests will start downloading."
                confirmLabel="Approve requests"
                onConfirm={approveSelected}
                variant="default"
                buttonProps={{
                  size: "sm",
                  disabled: selection.selected.some((request) => request.status !== "pending"),
                }}
              />}
            />
          ) : null}
          <ConfirmDialog
            open={declining != null}
            onOpenChange={(open) => { if (!open) setDeclining(null); }}
            contentData={{ "data-owner-decline-dialog": true }}
            confirmData={{ "data-owner-decline-confirm": true }}
            title={`Decline ${declining?.title ?? "this request"}?`}
            description="They'll see it was declined, and your reason if you give one."
            cancelLabel="Keep it"
            variant="destructive"
            confirmLabel="Decline request"
            onConfirm={() => {
              if (declining) void onDecide(declining, "decline", reason).finally(() => setDeclining(null));
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
                onChange={(event) => setReason(event.target.value)}
                rows={3}
                className="min-h-20"
                placeholder="Already on a streaming service, for example"
                data-owner-decline-reason
              />
            </div>
          </ConfirmDialog>
        </div>
      )}
    </FilterBar>
  );
}
