import { Link } from "react-router";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

export function HeaderBrand({
  pageTitle,
  showWordmark,
  isDesktop,
}: {
  pageTitle: string | null;
  showWordmark: boolean;
  isDesktop: boolean;
}) {
  return (
    <>
      <Link
        to="/"
        aria-label="TorrentFlow home"
        data-brand-home
        className={cn(
          "flex h-11 min-h-[44px] min-w-[44px] items-center gap-2 shrink-0 rounded-md",
          showWordmark && isDesktop ? "w-auto justify-start" : "w-11 justify-center",
        )}
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--brand)] text-[var(--primary-foreground)]">
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
        {showWordmark && isDesktop ? (
          <span className="text-sm font-semibold tracking-tight text-[var(--text)] whitespace-nowrap">
            TorrentFlow
          </span>
        ) : null}
      </Link>
      {pageTitle ? (
        <>
          <Separator orientation="vertical" className="md:hidden data-vertical:h-4 data-vertical:self-center" />
          <span
            data-header-page-title
            className="md:hidden min-w-0 truncate text-[13px] font-medium text-muted-foreground"
          >
            {pageTitle}
          </span>
        </>
      ) : null}
    </>
  );
}
