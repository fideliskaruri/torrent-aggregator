import type { ReactNode } from "react";
import { TfErrorState } from "@/components/tf/error-state";
import { useSessionInfo } from "@/lib/session";

/** The owner's own machine never needs to wait for `/api/me`. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
}

/**
 * Everyone gets the same app. Every page waits for `/api/me` first, so the
 * role — and with it every capability — is known before any page mounts and
 * nobody fires API calls their role can't make. A loopback page is the owner
 * by construction, so it still renders if `/api/me` fails; the wait itself is
 * one local round trip. (Loopback is not proof of the owner on its own: a
 * tunnel or dev proxy can also arrive at 127.0.0.1.)
 */
export function ShellGate({ children }: { children: ReactNode }) {
  const session = useSessionInfo();
  const local = typeof window !== "undefined" && isLoopbackHost(window.location.hostname);
  if (session.known || (local && session.failed)) return <>{children}</>;
  if (session.failed) {
    return (
      <div className="container-app py-10" data-shell-failed>
        <TfErrorState
          title="Couldn't reach TorrentFlow"
          message="Check your connection and try again."
          onRetry={session.retry}
        />
      </div>
    );
  }
  return (
    <div className="flex min-h-[60vh] items-center justify-center" aria-busy="true" data-shell-pending>
      <span className="sr-only">Loading</span>
      <span className="h-7 w-7 animate-pulse rounded-md bg-[var(--accent)]/60 motion-reduce:animate-none" aria-hidden />
    </div>
  );
}
