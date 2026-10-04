import type {
  OwnerRequest,
  RequestState,
  RequestStatus,
  RequestView,
  RequesterRequest,
  StatusTone,
} from "./types";

export const AIRING_NOTE = "New episodes download as they air";
const INBOX_STATUSES: readonly RequestStatus[] = ["pending", "partial", "failed", "approved", "declined"];

export function canRetryRequest(status: RequestStatus): boolean {
  return status === "partial" || status === "failed";
}

export function inboxRows(requests: readonly OwnerRequest[]): OwnerRequest[] {
  const rank = (status: RequestStatus) => INBOX_STATUSES.indexOf(status);
  return requests
    .filter((request) => rank(request.status) >= 0)
    .sort((a, b) => rank(a.status) - rank(b.status) || b.createdAt.localeCompare(a.createdAt));
}

export function pendingBadge(count: number | null | undefined): string | null {
  if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) return null;
  return count > 99 ? "99+" : String(Math.floor(count));
}

export function statusLabel(status: RequestStatus): string {
  switch (status) {
    case "pending": return "Waiting for approval";
    case "approved": return "Approved";
    case "downloading": return "Downloading";
    case "available":
    case "fulfilled": return "Available";
    case "declined": return "Declined";
    case "partial": return "Partly done";
    case "failed": return "Couldn't get it";
    case "cancelled": return "Cancelled";
  }
}

export function statusTone(status: RequestStatus): StatusTone {
  if (status === "pending" || status === "approved" || status === "downloading" || status === "partial") return "accent";
  if (status === "fulfilled" || status === "available") return "success";
  if (status === "declined" || status === "failed") return "danger";
  return "outline";
}

export function progressLabel(status: RequestStatus, done: number, total: number): string {
  if (status === "downloading" && total > 1) return `${statusLabel(status)}, ${done} of ${total}`;
  return statusLabel(status);
}

export function scopeLabel(request: Pick<RequesterRequest, "scope" | "seasons">): string {
  if (request.scope === "movie") return "Movie";
  if (request.scope === "series") return "Whole series";
  return formatSeasons(request.seasons);
}

export function formatSeasons(seasons: readonly number[]): string {
  const sorted = [...new Set(seasons)].sort((a, b) => a - b);
  if (sorted.length === 0) return "Seasons";
  if (sorted.length === 1) return `Season ${sorted[0]}`;
  const parts: string[] = [];
  let start = sorted[0];
  let previous = sorted[0];
  for (const number of [...sorted.slice(1), Number.NaN]) {
    if (number === previous + 1) {
      previous = number;
      continue;
    }
    parts.push(start === previous ? String(start) : `${start}–${previous}`);
    start = number;
    previous = number;
  }
  return `Seasons ${parts.join(", ")}`;
}

export function requestViewFor(state: RequestState, isSeries: boolean): RequestView {
  const seasons = state.availableSeasons ?? [];
  if (!isSeries && (state.inLibrary || state.requestStatus === "available" || state.requestStatus === "fulfilled")) {
    return { label: "Available", tone: "success", action: null };
  }
  if (isSeries && (state.requestStatus === "available" || state.requestStatus === "fulfilled" || (!state.requestStatus && seasons.length > 0))) {
    return {
      label: seasons.length > 0 ? `${formatSeasons(seasons)} available` : "Available",
      tone: "success",
      action: "Request more seasons",
      note: state.requestAiring ? AIRING_NOTE : null,
    };
  }
  switch (state.requestStatus) {
    case "pending":
      return { label: "Requested", tone: "accent", action: isSeries ? "Request more seasons" : null };
    case "approved":
      return { label: "Approved", tone: "accent", action: isSeries ? "Request more seasons" : null };
    case "downloading":
      return {
        label: progressLabel("downloading", state.requestDone ?? 0, state.requestTotal ?? 0),
        tone: "accent",
        action: isSeries ? "Request more seasons" : null,
      };
    case "declined":
      return { label: "Declined", tone: "danger", action: "Request again" };
    case "partial":
      return { label: statusLabel("partial"), tone: "accent", action: isSeries ? "Request more seasons" : null };
    case "failed":
      return { label: statusLabel("failed"), tone: "danger", action: "Request again" };
    default:
      return { label: null, tone: "outline", action: "Request" };
  }
}

export function myRequestRows<T extends Pick<RequesterRequest, "status" | "createdAt">>(requests: readonly T[]): T[] {
  return [...requests].sort(
    (a, b) => Number(b.status === "pending") - Number(a.status === "pending") || b.createdAt.localeCompare(a.createdAt),
  );
}
