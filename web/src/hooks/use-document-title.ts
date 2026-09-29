import { useEffect, useLayoutEffect } from "react";
import { useLocation } from "react-router";
import { titleForRoute } from "@/lib/navigation";

const DEFAULT_DOCUMENT_TITLE = "TorrentFlow";

/**
 * Format a browser tab title the same way the mobile header names a route.
 * Pages that pass an explicit `title` win; otherwise the route map fills in
 * so `/history` never keeps a stale "Notifications" document title either.
 */
export function documentTitleFor(
  pathname: string,
  title?: string | null,
  { absolute = false }: { absolute?: boolean } = {},
): string {
  const trimmed = title?.trim();
  if (trimmed) {
    return absolute ? trimmed : `${trimmed} · ${DEFAULT_DOCUMENT_TITLE}`;
  }
  const fromRoute = titleForRoute(pathname)?.trim();
  if (!fromRoute) return DEFAULT_DOCUMENT_TITLE;
  return absolute ? fromRoute : `${fromRoute} · ${DEFAULT_DOCUMENT_TITLE}`;
}

/**
 * Name the tab after the current route, for every page.
 *
 * Mounted once in the root layout. It runs as a layout effect, so it lands
 * before any page's own {@link useDocumentTitle} (a passive effect) and a page
 * that names itself still wins. Pages that have nothing better to say need no
 * code to stop showing a bare "TorrentFlow" or the previous page's title.
 */
export function useRouteDocumentTitle() {
  const pathname = useLocation().pathname;
  useLayoutEffect(() => {
    document.title = documentTitleFor(pathname);
  }, [pathname]);
}

/**
 * The SPA's replacement for Next.js `metadata.title`: the root layout's
 * `template: "%s · TorrentFlow"` / `default: "TorrentFlow"`, applied on mount.
 * `absolute` matches Next.js metadata on the root segment (`src/app/page.tsx`),
 * where the layout template does not apply.
 *
 * When `title` is omitted the current route's title is used, via
 * {@link titleForRoute}. On unmount the title goes back to the route's, but
 * only while it is still this page's: by then the next route or page has
 * usually named the tab, and resetting it would leave the old page's name or
 * a bare "TorrentFlow" behind.
 */
export function useDocumentTitle(
  title?: string | null,
  description?: string | null,
  {
    absolute = false,
    pathname,
  }: { absolute?: boolean; pathname?: string } = {},
) {
  const routePathname = useLocation().pathname;
  const path = pathname ?? routePathname;
  useEffect(() => {
    const applied = documentTitleFor(path, title, { absolute });
    document.title = applied;
    return () => {
      if (document.title === applied) {
        document.title = documentTitleFor(window.location.pathname);
      }
    };
  }, [title, absolute, path]);

  useEffect(() => {
    if (description == null) return;
    const meta = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (!meta) return;
    const previous = meta.content;
    meta.content = description;
    return () => {
      meta.content = previous;
    };
  }, [description]);
}
