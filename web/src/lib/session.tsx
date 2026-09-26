import {
  createContext,
  useContext,
  useEffect,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useApiQuery } from "@/hooks/use-api-query";
import {
  clearSessionExpired,
  isSessionExpired,
  setSessionVia,
  subscribeSessionExpired,
  type SessionVia,
} from "@/lib/session-expiry";

export type SessionRole = "owner" | "requester";

export interface SessionInfo {
  /** Owner until `/api/me` says otherwise; the server enforces the real boundary. */
  role: SessionRole;
  /** "tunnel" when this page came through Cloudflare Access; null until known. */
  via: SessionVia | null;
  email: string | null;
  /** Owner only: requests waiting for a decision. Null for requesters or until known. */
  pendingRequests: number | null;
  /** True once `/api/me` has answered successfully. */
  known: boolean;
  /** `/api/me` failed before it ever answered, so the role is unknown. */
  failed: boolean;
  /** Asks `/api/me` again. */
  retry: () => void;
}

export type MeInfo = Pick<SessionInfo, "role" | "via" | "email" | "pendingRequests">;

const SessionContext = createContext<SessionInfo>({
  role: "owner",
  via: null,
  email: null,
  pendingRequests: null,
  known: false,
  failed: false,
  retry: () => {},
});

export function parseMe(json: unknown): MeInfo {
  const body = (json ?? {}) as {
    via?: unknown;
    email?: unknown;
    role?: unknown;
    pendingRequests?: unknown;
  };
  const role: SessionRole = body.role === "requester" ? "requester" : "owner";
  return {
    role,
    via: body.via === "tunnel" ? "tunnel" : body.via === "local" ? "local" : null,
    email: typeof body.email === "string" ? body.email : null,
    pendingRequests:
      role === "owner" && typeof body.pendingRequests === "number" && body.pendingRequests >= 0
        ? body.pendingRequests
        : null,
  };
}

/**
 * `/api/me` for the whole app. The minute poll also notices an expired
 * Cloudflare Access session on a page that is otherwise idle.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const { data, settled, refetch } = useApiQuery<MeInfo>("/api/me", {
    refreshMs: 60_000,
    emptyOnUnauthorized: false,
    select: parseMe,
  });
  const via = data?.via ?? null;
  const email = data?.email ?? null;
  const role = data?.role ?? "owner";
  const pendingRequests = data?.pendingRequests ?? null;
  const known = data != null;
  const failed = data == null && settled;

  useEffect(() => {
    // Sticky: once a page is known to be remote, a failed poll must not demote it to "unknown".
    if (via) setSessionVia(via);
  }, [via]);

  useEffect(() => {
    // `data` only changes on a successful poll, which proves the session is alive.
    if (data) clearSessionExpired();
  }, [data]);

  return (
    <SessionContext.Provider value={{ role, via, email, pendingRequests, known, failed, retry: refetch }}>
      {children}
      <SessionExpiredPrompt />
    </SessionContext.Provider>
  );
}

export function useSessionInfo(): SessionInfo {
  return useContext(SessionContext);
}

function SessionExpiredPrompt() {
  const expired = useSyncExternalStore(
    subscribeSessionExpired,
    isSessionExpired,
    () => false,
  );
  if (!expired) return null;
  return (
    <div
      role="alert"
      data-session-expired
      className="fixed inset-x-0 top-0 z-[70] border-b border-[var(--warning)]/40 bg-[var(--bg-elevated)] shadow-[var(--shadow-md)]"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      <div className="container-app flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="min-w-0 text-sm text-[var(--text)]">
          Your remote session expired.{" "}
          <span className="text-[var(--text-secondary)]">
            Reload to sign in through Cloudflare again.
          </span>
        </p>
        <Button
          type="button"
          onClick={() => window.location.reload()}
          className="min-h-[44px] shrink-0"
          aria-label="Reload to sign in again"
          data-session-reload
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Reload
        </Button>
      </div>
    </div>
  );
}
