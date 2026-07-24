import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Header } from "@/components/layout/header";
import { MobileNav } from "@/components/layout/mobile-nav";
import { KeyboardRoot } from "@/components/layout/keyboard-root";
import { AuthSessionProvider } from "@/components/providers/session-provider";
import { UiPreferencesProvider } from "@/components/providers/ui-preferences";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "TorrentFlow",
    template: "%s · TorrentFlow",
  },
  description:
    "Self-hosted torrent search across multiple indexers, with metadata, watchlists, and client integration.",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "TorrentFlow",
  },
};

export const viewport: Viewport = {
  themeColor: "#0c0c0e",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full`}
    >
      <body className="app-shell antialiased">
        <AuthSessionProvider>
          <UiPreferencesProvider>
            <KeyboardRoot>
              <Header />
              <main className="app-main pb-[calc(var(--mobile-nav-h)+var(--safe-bottom))] md:pb-0">
                {children}
              </main>
              <footer className="app-footer hidden md:block">
                <div className="container-app flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-[11px] text-[var(--text-tertiary)]">
                  <p className="min-w-0">
                    Self-hosted aggregator · respect local law & indexer terms
                  </p>
                  <div className="flex items-center gap-3 shrink-0">
                    <a
                      href="/about"
                      className="hover:text-[var(--text-secondary)]"
                    >
                      About
                    </a>
                    <span className="hidden sm:inline text-[var(--border-strong)]">
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
      </body>
    </html>
  );
}
