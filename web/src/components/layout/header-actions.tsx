import { Link } from "react-router";
import { CircleUser, Eye, LogOut, Search } from "lucide-react";
import { NotificationBell } from "@/components/notifications/notification-feed";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { signOut } from "@/lib/sign-out";
import { HEADER_SEARCH_HREF, navActive } from "@/lib/navigation";
import { setPreviewAsRequester } from "@/lib/capabilities";
import { openSearchOverlay } from "@/components/search/search-overlay";
import { cn } from "@/lib/utils";

export function HeaderActions({
  email,
  isDesktop,
  showAccount,
  showPreview,
  showPreviewLabel,
  showSearchLabel,
  pathname,
}: {
  email: string | null;
  isDesktop: boolean;
  showAccount: boolean;
  showPreview: boolean;
  showPreviewLabel: boolean;
  showSearchLabel: boolean;
  pathname: string;
}) {
  const searchActive = navActive(pathname, HEADER_SEARCH_HREF);

  function onSearchClick(e: React.MouseEvent<HTMLAnchorElement>) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    openSearchOverlay();
  }

  return (
    <div className="flex items-center gap-1 sm:gap-1.5 ml-auto shrink-0">
      <NotificationBell />
      <Button
        asChild
        variant="outline"
        className={cn(
          "hidden md:inline-flex shrink-0 text-[12px] font-normal",
          showSearchLabel ? "h-9 justify-start px-2.5" : "size-9 px-0",
          searchActive ? "border-input bg-muted text-foreground" : "bg-card text-subtle-foreground hover:text-muted-foreground",
        )}
      >
        <Link
          to={HEADER_SEARCH_HREF}
          onClick={onSearchClick}
          aria-current={searchActive ? "page" : undefined}
          aria-label="Search"
          data-header-search
          data-search-trigger
        >
          <Search className="size-3.5 shrink-0" aria-hidden />
          {showSearchLabel ? (
            <>
              <span className="min-w-[7rem] text-left" aria-hidden>Search</span>
              <Kbd aria-hidden>/</Kbd>
            </>
          ) : null}
        </Link>
      </Button>
      <Button
        asChild
        variant="ghost"
        size="icon"
        className={cn("md:hidden size-11", searchActive ? "bg-muted text-foreground" : "text-subtle-foreground")}
      >
        <Link
          to={HEADER_SEARCH_HREF}
          onClick={onSearchClick}
          aria-label="Search"
          aria-current={searchActive ? "page" : undefined}
          data-search-trigger
        >
          <Search className="size-4" aria-hidden />
        </Link>
      </Button>
      {showPreview && isDesktop ? (
        <Button
          type="button"
          variant="ghost"
          onClick={() => setPreviewAsRequester(true)}
          data-preview-toggle
          aria-label="View as requester"
          title="See the app the way people you share it with do"
          className="hidden md:inline-flex h-9 min-w-9 pointer-coarse:h-11 pointer-coarse:min-w-11 shrink-0 px-2.5 text-[12px] text-subtle-foreground hover:text-muted-foreground"
        >
          <Eye className="size-3.5 shrink-0" aria-hidden />
          {showPreviewLabel ? <span aria-hidden>View as requester</span> : null}
        </Button>
      ) : null}
      {showAccount && isDesktop ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              data-account-menu
              aria-label={`Account, signed in as ${email}`}
              title={email ?? undefined}
              className="hidden md:inline-flex size-9 pointer-coarse:size-11 shrink-0 text-subtle-foreground hover:text-muted-foreground"
            >
              <CircleUser className="size-4" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuLabel className="flex flex-col gap-0.5 font-normal">
              <span className="text-[12px] text-subtle-foreground">Signed in as</span>
              <span data-account-email className="truncate text-[13px] font-medium text-foreground">
                {email}
              </span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={signOut} data-sign-out className="min-h-11 text-[13px]">
              <LogOut className="size-4" aria-hidden />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}
