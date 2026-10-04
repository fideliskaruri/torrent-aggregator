import { useLocation } from "react-router";
import { useMediaQuery } from "@/hooks/use-media-query";
import { pendingBadge } from "@/lib/requests";
import { useSessionInfo } from "@/lib/session";
import { useCapabilities } from "@/lib/capabilities";
import {
  NOTIFICATIONS_HREF,
  desktopNavRow,
  navActiveHref,
  titleForRoute,
} from "@/lib/navigation";
import { HeaderActions } from "./header-actions";
import { HeaderBrand } from "./header-brand";
import { HeaderDesktopNav } from "./header-desktop-nav";
import { HEADER_FOLD, useHeaderFold } from "./use-header-fold";

export function Header() {
  const pathname = useLocation().pathname;
  const pageTitle = titleForRoute(pathname);
  const caps = useCapabilities();
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const { items: fullRow, dividerIndex } = desktopNavRow(caps);
  const dividerHref = fullRow[dividerIndex]?.href ?? null;
  const navRow = fullRow.filter((item) => item.href !== NOTIFICATIONS_HREF);
  const activeHref = navActiveHref(fullRow, pathname);
  const { pendingRequests: pending, via, email } = useSessionInfo();
  const requestsBadge = caps.canReviewRequests ? pendingBadge(pending) : null;
  const showAccount = via === "tunnel" && Boolean(email);
  const { rowRef, navRef, fold } = useHeaderFold(
    `${navRow.map((item) => item.href).join(",")}|${requestsBadge ?? ""}|${caps.canPreview}|${showAccount}`,
    HEADER_FOLD.overflow + navRow.length - 1,
  );

  const overflowCount = Math.max(0, fold - HEADER_FOLD.overflow + 1);
  const inlineItems = overflowCount ? navRow.slice(0, navRow.length - overflowCount) : navRow;
  const moreItems = overflowCount ? navRow.slice(navRow.length - overflowCount) : [];

  return (
    <header className="app-header" data-app-header>
      <div ref={rowRef} className="container-app flex h-14 items-center gap-3 sm:gap-4">
        <HeaderBrand
          pageTitle={pageTitle}
          showWordmark={fold < HEADER_FOLD.wordmark}
          isDesktop={isDesktop}
        />
        <HeaderDesktopNav
          activeHref={activeHref}
          dividerHref={dividerHref}
          fold={fold}
          inlineItems={inlineItems}
          moreItems={moreItems}
          navRef={navRef}
          requestsBadge={requestsBadge}
          tightLinks={fold >= HEADER_FOLD.tightLinks}
        />
        <HeaderActions
          email={email}
          isDesktop={isDesktop}
          showAccount={showAccount}
          showPreview={caps.canPreview}
          showPreviewLabel={fold < HEADER_FOLD.previewLabel}
          showSearchLabel={fold < HEADER_FOLD.searchLabel}
          pathname={pathname}
        />
      </div>
    </header>
  );
}
