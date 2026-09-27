import { useEffect } from "react";
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
 * The SPA's replacement for Next.js `metadata.title`: the root layout's
 * `template: "%s · TorrentFlow"` / `default: "TorrentFlow"`, applied on mount
 * and reset when the page unmounts. `absolute` matches Next.js metadata on the
 * root segment (`src/app/page.tsx`), where the layout template does not apply.
 *
 * When `title` is omitted, pass `pathname` (from `useLocation`) so the tab
 * title still tracks the route via {@link titleForRoute}.
 */
export function useDocumentTitle(
  title?: string | null,
  description?: string | null,
  {
    absolute = false,
    pathname,
  }: { absolute?: boolean; pathname?: string } = {},
) {
  useEffect(() => {
    document.title = documentTitleFor(pathname ?? "/", title, { absolute });
    return () => {
      document.title = DEFAULT_DOCUMENT_TITLE;
    };
  }, [title, absolute, pathname]);

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
