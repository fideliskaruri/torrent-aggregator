import type { ReactNode } from "react";
import { useLocation } from "react-router";
import { ShareUnavailable } from "@/components/pwa/share-unavailable";
import { TfErrorState } from "@/components/tf/error-state";
import { useSessionInfo } from "@/lib/session";
import { RequesterShell } from "./requester-shell";

/** The owner's own machine never needs to wait for `/api/me`. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
}

/**
 * Picks the shell for the signed-in role. Requesters get the trimmed shell and
 * the owner tree is never mounted for them; remote pages wait for `/api/me` so
 * the owner shell never flashes (and never fires owner API calls) for a friend.
 */
export function ShellGate({ owner }: { owner: ReactNode }) {
  const session = useSessionInfo();
  const location = useLocation();
  if (session.role === "requester") {
    // Share-target is owner-only; keep requesters out of the download pipeline UI.
    if (location.pathname === "/share") {
      return (
        <div className="container-app max-w-xl py-8 sm:py-12 min-w-0" data-share-page>
          <ShareUnavailable />
        </div>
      );
    }
    return <RequesterShell email={session.email} />;
  }
  const local = typeof window !== "undefined" && isLoopbackHost(window.location.hostname);
  if (local || session.known) return <>{owner}</>;
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
