import { Outlet, ScrollRestoration, type Location } from "react-router";
import { Header } from "@/components/layout/header";
import { MobileNav } from "@/components/layout/mobile-nav";
import { KeyboardRoot } from "@/components/layout/keyboard-root";
import { AuthSessionProvider } from "@/components/providers/session-provider";
import { DownloadSetupProvider } from "@/components/setup/download-setup";
import { ServiceWorkerRegistrar } from "@/components/pwa/service-worker-registrar";
import { UiPreferencesProvider } from "@/components/providers/ui-preferences";
import { Toaster } from "@/components/ui/sonner";
import { FeaturesProvider } from "@/lib/features";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./fonts.css";
import "./globals.css";

// A fresh document load always has location.key "default"; keying it per load
// keeps a new visit from restoring the last session's scroll (Next starts at the top).
const BOOT_KEY = `boot-${Math.random().toString(36).slice(2)}`;
const scrollKey = (location: Location) =>
  location.key === "default" ? BOOT_KEY : location.key;

/**
 * The root layout. `<html>`/`<body>`, metadata and viewport live in
 * `web/index.html`; everything inside `<body>` is the same tree as the Next.js
 * layout, with the page rendered through the router outlet.
 */
export default function RootLayout() {
  return (
    <>
      <ScrollRestoration getKey={scrollKey} />
      <ServiceWorkerRegistrar />
      <AuthSessionProvider>
        <FeaturesProvider>
        <UiPreferencesProvider>
          <DownloadSetupProvider>
          <KeyboardRoot>
            <a href="#main-content" className="skip-link">
              Skip to main content
            </a>
            <Header />
            <main
              id="main-content"
              tabIndex={-1}
              className="app-main pb-[calc(var(--mobile-nav-h)+var(--safe-bottom))] md:pb-0"
            >
              <Outlet />
            </main>
            <footer className="app-footer hidden md:block">
              <div className="container-app flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-[11px] text-[var(--text-tertiary)]">
                <p className="min-w-0">
                  Self-hosted aggregator · respect local law & indexer terms
                </p>
                <div className="flex items-center gap-3 shrink-0">
                  <a
                    href="/about"
                    className="inline-flex min-h-[44px] items-center px-2 hover:text-[var(--text-secondary)] lg:min-h-0 lg:px-0"
                  >
                    About
                  </a>
                  <span
                    aria-hidden="true"
                    className="hidden sm:inline text-[var(--border-strong)]"
                  >
                    ·
                  </span>
                  <span className="hidden sm:inline font-mono text-[10px]">
                    / search · j k nav
                  </span>
                </div>
              </div>
            </footer>
            <MobileNav />
            <Toaster />
          </KeyboardRoot>
          </DownloadSetupProvider>
        </UiPreferencesProvider>
        </FeaturesProvider>
      </AuthSessionProvider>
    </>
  );
}
