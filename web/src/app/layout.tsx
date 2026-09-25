import { useCallback, useState } from "react";
import { Outlet, ScrollRestoration } from "react-router";
import { Geist, Geist_Mono } from "next/font/google";
import { RouterRefreshContext } from "next/navigation";
import { Header } from "@/components/layout/header";
import { MobileNav } from "@/components/layout/mobile-nav";
import { KeyboardRoot } from "@/components/layout/keyboard-root";
import { AuthSessionProvider } from "@/components/providers/session-provider";
import { ServiceWorkerRegistrar } from "@/components/pwa/service-worker-registrar";
import { UiPreferencesProvider } from "@/components/providers/ui-preferences";
import { Toaster } from "@/components/ui/sonner";
import "./fonts.css";
import "./globals.css";

// Loads the self-hosted font faces; the CSS variables live in fonts.css.
Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

/**
 * The root layout. `<html>`/`<body>`, metadata and viewport live in
 * `web/index.html`; everything inside `<body>` is the same tree as the Next.js
 * layout, with the page rendered through the router outlet.
 */
export default function RootLayout() {
  // `router.refresh()` re-runs the page: bumping the key re-mounts the outlet.
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  return (
    <RouterRefreshContext.Provider value={refresh}>
      <ScrollRestoration />
      <ServiceWorkerRegistrar />
      <AuthSessionProvider>
        <UiPreferencesProvider>
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
              <Outlet key={refreshKey} />
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
            <Toaster position="bottom-right" richColors closeButton />
          </KeyboardRoot>
        </UiPreferencesProvider>
      </AuthSessionProvider>
    </RouterRefreshContext.Provider>
  );
}
