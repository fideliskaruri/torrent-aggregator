import { Outlet, ScrollRestoration, type Location } from "react-router";
import { Header } from "@/components/layout/header";
import { MobileNav } from "@/components/layout/mobile-nav";
import { UpdateBanner } from "@/components/layout/update-banner";
import { KeyboardRoot } from "@/components/layout/keyboard-root";
import { AuthSessionProvider } from "@/components/providers/session-provider";
import { DownloadSetupProvider } from "@/components/setup/download-setup";
import { UiPreferencesProvider } from "@/components/providers/ui-preferences";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { FeaturesProvider } from "@/lib/features";
import { SessionProvider } from "@/lib/session";
import { ShellGate } from "@/components/layout/shell-gate";
import { PreviewBanner } from "@/components/layout/preview-banner";
import { useRouteDocumentTitle } from "@/hooks/use-document-title";
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
 * layout, with the page rendered through the router outlet. Everyone gets this one
 * shell; what each person sees comes from `useCapabilities()`.
 */
export default function RootLayout() {
  useRouteDocumentTitle();
  return (
    <>
      <ScrollRestoration getKey={scrollKey} />
      <TooltipProvider delayDuration={300}>
      <AuthSessionProvider>
        <SessionProvider>
        <ShellGate>
        <FeaturesProvider>
        <UiPreferencesProvider>
          <DownloadSetupProvider>
          <KeyboardRoot>
            <a href="#main-content" className="skip-link">
              Skip to main content
            </a>
            <PreviewBanner />
            <Header />
            <UpdateBanner />
            <main
              id="main-content"
              tabIndex={-1}
              className="app-main"
            >
              <Outlet />
            </main>
            <footer className="app-footer hidden md:block">
              <div className="container-app flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-[12px] text-subtle-foreground">
                <p className="min-w-0">
                  Self-hosted aggregator · respect local law & indexer terms
                </p>
                <div className="flex items-center gap-3 shrink-0">
                  <a
                    href="/about"
                    className="inline-flex min-h-[44px] items-center px-2 hover:text-muted-foreground lg:min-h-0 lg:px-0"
                  >
                    About
                  </a>
                  <span
                    aria-hidden="true"
                    className="hidden sm:inline text-subtle-foreground"
                  >
                    ·
                  </span>
                  <span className="hidden items-center gap-1.5 sm:inline-flex">
                    <Kbd className="font-mono">/</Kbd>
                    search
                    <KbdGroup className="ml-1.5">
                      <Kbd className="font-mono">j</Kbd>
                      <Kbd className="font-mono">k</Kbd>
                    </KbdGroup>
                    move
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
        </ShellGate>
        </SessionProvider>
      </AuthSessionProvider>
      </TooltipProvider>
    </>
  );
}
