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

export interface SessionInfo {
  role: "owner";
  /** "tunnel" when this page came through Cloudflare Access; null until known. */
  via: SessionVia | null;
  email: string | null;
}

const SessionContext = createContext<SessionInfo>({
  role: "owner",
  via: null,
  email: null,
});

function parseMe(json: unknown): SessionInfo {
  const body = (json ?? {}) as { via?: unknown; email?: unknown };
  return {
    role: "owner",
    via: body.via === "tunnel" ? "tunnel" : body.via === "local" ? "local" : null,
    email: typeof body.email === "string" ? body.email : null,
  };
}

/**
 * `/api/me` for the whole app. The minute poll also notices an expired
 * Cloudflare Access session on a page that is otherwise idle.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const { data } = useApiQuery<SessionInfo>("/api/me", {
    refreshMs: 60_000,
    emptyOnUnauthorized: false,
    select: parseMe,
  });
  const via = data?.via ?? null;
  const email = data?.email ?? null;

  useEffect(() => {
    // Sticky: once a page is known to be remote, a failed poll must not demote it to "unknown".
    if (via) setSessionVia(via);
  }, [via]);

  useEffect(() => {
    // `data` only changes on a successful poll, which proves the session is alive.
    if (data) clearSessionExpired();
  }, [data]);

  return (
    <SessionContext.Provider value={{ role: "owner", via, email }}>
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
