import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";
import { router } from "./router";
import { installStore } from "@/components/pwa/install-store";
import { registerServiceWorker } from "@/lib/pwa/register-sw";
import { installConnectionWatch } from "@/lib/connection-watch";
import { ConnectionBanner } from "@/components/pwa/connection-banner";

// Capture beforeinstallprompt even before the owner opens Settings/About.
if (typeof window !== "undefined") {
  installStore.subscribe(() => {});
}

installConnectionWatch();

if (import.meta.env.PROD) {
  registerServiceWorker();
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
    <ConnectionBanner />
  </StrictMode>,
);
