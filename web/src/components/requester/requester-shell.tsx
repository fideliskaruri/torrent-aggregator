import { Link, useLocation } from "react-router";
import { Inbox, Library, Search } from "lucide-react";
import { Toaster } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import { MyLibrary } from "./my-library";
import { MyRequests } from "./my-requests";
import { RequestSearch } from "./request-search";
import { requesterView, type RequesterView } from "./requests";

const NAV: { view: RequesterView; href: string; label: string; icon: typeof Search }[] = [
  { view: "search", href: "/", label: "Search", icon: Search },
  { view: "requests", href: "/requests", label: "My requests", icon: Inbox },
  { view: "library", href: "/library", label: "Library", icon: Library },
];

/**
 * Everything a requester sees. None of the owner's shell (navigation, search
 * palette, downloads, settings) is mounted, and the server refuses every owner
 * API for this role anyway.
 */
export function RequesterShell({ email }: { email: string | null }) {
  const view = requesterView(useLocation().pathname);

  return (
    <div data-requester-shell>
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>
      <header className="app-header" data-app-header>
        <div className="container-app flex h-14 items-center gap-3">
          <Link to="/" className="flex min-h-[44px] shrink-0 items-center gap-2 lg:min-h-0" aria-label="TorrentFlow search">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--accent)] text-[var(--primary-foreground)]">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  d="M12 3v10m0 0l4-4m-4 4L8 9M5 17h14"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <span className="hidden text-sm font-semibold tracking-tight text-[var(--text)] sm:inline">TorrentFlow</span>
          </Link>
          <nav className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto" aria-label="Main" data-requester-nav>
            {NAV.map(({ view: target, href, label, icon: Icon }) => {
              const active = target === view;
              return (
                <Link
                  key={href}
                  to={href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium transition-colors lg:min-h-0 lg:px-3",
                    "outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]",
                    active
                      ? "bg-[var(--bg-muted)] text-[var(--text)]"
                      : "text-[var(--text-tertiary)] hover:bg-[var(--bg-muted)] hover:text-[var(--text-secondary)]",
                  )}
                  data-requester-nav-item={target}
                >
                  <Icon className="h-4 w-4" aria-hidden="true" />
                  {label}
                </Link>
              );
            })}
          </nav>
          {email ? (
            <span
              className="hidden max-w-[16rem] truncate text-xs text-[var(--text-tertiary)] md:inline"
              title={email}
              data-requester-email
            >
              {email}
            </span>
          ) : null}
        </div>
      </header>
      <main id="main-content" tabIndex={-1} className="app-main">
        <div className="container-app max-w-4xl py-6">
          {view === "requests" ? <MyRequests /> : view === "library" ? <MyLibrary /> : <RequestSearch />}
        </div>
      </main>
      <Toaster position="bottom-right" richColors closeButton />
    </div>
  );
}
