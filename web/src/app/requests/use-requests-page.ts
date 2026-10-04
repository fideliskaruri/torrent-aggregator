import { useMemo } from "react";
import { useApiQuery } from "@/hooks/use-api-query";
import { useSessionInfo } from "@/lib/session";
import { send } from "@/lib/api";
import {
  cancelRequest,
  inboxRows,
  myRequestRows,
  ownerRequestErrorMessage,
  parseOwnerRequests,
  parseRequests,
} from "@/lib/requests";
import type { OwnerRequest } from "@/lib/requests";
import { toast } from "@/lib/toast";

export function useRequestsPage(ownerSession: boolean, reviewing: boolean) {
  const session = useSessionInfo();
  const ownerList = useApiQuery(ownerSession ? "/api/requests" : null, {
    select: parseOwnerRequests,
    refreshMs: 30_000,
  });
  const mineList = useApiQuery(ownerSession ? null : "/api/requester/requests", {
    select: (json: unknown) => ({
      requests: parseRequests(json).map((request): OwnerRequest => ({
        ...request,
        requestedBy: "",
        requesters: [],
        workKey: "",
        phase: null,
      })),
    }),
    refreshMs: 30_000,
    emptyOnUnauthorized: false,
  });
  const list = ownerSession ? ownerList : mineList;
  const rows = useMemo(
    () => reviewing
      ? inboxRows(list.data?.requests ?? [])
      : myRequestRows(list.data?.requests ?? []),
    [list.data?.requests, reviewing],
  );

  async function decide(request: OwnerRequest, action: "approve" | "decline" | "retry", reason?: string) {
    try {
      const response = await send(`/api/requests/${encodeURIComponent(request.id)}/${action}`, {
        method: "POST",
        ...(action === "decline" ? { body: { reason: reason?.trim() || null } } : {}),
      });
      if (!response.ok) {
        const body = response.data as { code?: unknown } | null;
        toast.error(ownerRequestErrorMessage(action, {
          code: typeof body?.code === "string" ? body.code : null,
          status: response.status,
        }));
      } else if (action === "approve") {
        toast.success(`Approved ${request.title}`, { description: "It's downloading on the request lane." });
      } else if (action === "retry") {
        toast.success(`Retrying ${request.title}`, { description: "Only the missing episodes are searched again." });
      } else {
        toast.success(`Declined ${request.title}`);
      }
    } catch {
      toast.error(ownerRequestErrorMessage(action, {}));
    } finally {
      list.refetch();
      session.retry();
    }
  }

  async function cancel(request: OwnerRequest) {
    const error = await cancelRequest(request.id);
    if (error) toast.error(error);
    else toast.success(`Cancelled ${request.title}`);
    list.refetch();
  }

  return { list, rows, decide, cancel };
}
