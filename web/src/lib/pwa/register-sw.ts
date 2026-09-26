import { toast } from "@/lib/toast";

/** Local loopback hosts where browsers allow SW over plain http. */
export function isSwAllowedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
}

/**
 * Register the install-shell worker. Call only from a production build on a
 * secure context (or localhost); see main.tsx.
 */
export function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator)) return;
  const secure =
    window.isSecureContext || isSwAllowedHost(window.location.hostname);
  if (!secure) {
    console.info(
      "[pwa] Service worker not registered: this origin is not a secure context. Use https:// or localhost to install.",
    );
    return;
  }

  navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((error) => {
    console.error("[pwa] Service worker registration failed", error);
    toast.error("Install support unavailable", {
      description:
        error instanceof Error
          ? error.message
          : "The service worker could not be registered.",
    });
  });
}
