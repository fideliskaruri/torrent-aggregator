import { useSyncExternalStore } from "react";
import { RefreshCw, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  connectionState,
  probeNow,
  subscribeConnection,
} from "@/lib/connection-watch";
import { isSessionExpired, subscribeSessionExpired } from "@/lib/session-expiry";

/**
 * "You're offline — reconnecting…" strip for the installed app. Sits where the
 * session-expired prompt sits and yields to it: a sign-in problem is not fixed
 * by waiting, so that message wins.
 */
export function ConnectionBanner() {
  const state = useSyncExternalStore(subscribeConnection, connectionState, () => "online" as const);
  const expired = useSyncExternalStore(subscribeSessionExpired, isSessionExpired, () => false);
  if (state === "online" || expired) return null;

  const offline = state === "offline";
  return (
    <div
      role="status"
      aria-live="polite"
      data-connection-banner={state}
      className="fixed inset-x-0 top-0 z-[65] border-b border-[var(--accent-border)] bg-[var(--bg-elevated)] shadow-[var(--shadow-md)]"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      <div className="container-app flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="flex min-w-0 items-start gap-2 text-sm text-[var(--text)]">
          <WifiOff className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent-text)]" aria-hidden="true" />
          <span>
            {offline ? "You're offline. Reconnecting…" : "Can't reach TorrentFlow. Reconnecting…"}{" "}
            <span className="text-[var(--text-secondary)]">
              {offline
                ? "Your downloads keep going on your PC. This page updates when you're back online."
                : "Check that your PC is on and TorrentFlow is running. Your downloads aren't affected."}
            </span>
          </span>
        </p>
        <Button
          type="button"
          variant="secondary"
          onClick={() => void probeNow()}
          className="min-h-[44px] shrink-0"
          data-connection-retry
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Try now
        </Button>
      </div>
    </div>
  );
}
