import { useEffect } from "react";
import { toast } from "sonner";
import { installStore } from "./install-store";

/**
 * Registers the install-shell service worker (`public/sw.js`).
 *
 * Registered in every environment, not production-only: the worker is a plain
 * static file under `public/`, so `next dev` serves it byte-for-byte the same
 * way `next start` does, and the worker itself never caches `/_next/*`. That
 * means the install path can be verified against the already-running dev
 * server with no restart and no rebuild — load any page over MCP, then read
 * `navigator.serviceWorker.getRegistration()` via `browser_evaluate`.
 *
 * Failures are surfaced rather than swallowed. A worker that silently failed
 * to register looks identical to one that works, until the day you need it.
 */
export function ServiceWorkerRegistrar() {
  // Capture the one-shot browser event even before the owner visits About.
  useEffect(() => installStore.subscribe(() => {}), []);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    // Service workers are a secure-context feature. Over plain http:// on a
    // LAN IP, registration throws; saying so beats a dead Install button.
    if (!window.isSecureContext) {
      console.info(
        "[pwa] Service worker not registered: this origin is not a secure context. Use https:// or localhost to install.",
      );
      return;
    }

    let cancelled = false;
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((error) => {
      if (cancelled) return;
      console.error("[pwa] Service worker registration failed", error);
      toast.error("Install support unavailable", {
        description:
          error instanceof Error
            ? error.message
            : "The service worker could not be registered.",
      });
    });

    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}
