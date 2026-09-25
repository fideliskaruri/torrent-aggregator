import { useEffect } from "react";

export const DEFAULT_DOCUMENT_TITLE = "TorrentFlow";

/**
 * The SPA's replacement for Next.js `metadata.title`: the root layout's
 * `template: "%s · TorrentFlow"` / `default: "TorrentFlow"`, applied on mount
 * and reset when the page unmounts. `absolute` matches Next.js metadata on the
 * root segment (`src/app/page.tsx`), where the layout template does not apply.
 */
export function useDocumentTitle(
  title?: string | null,
  description?: string | null,
  { absolute = false }: { absolute?: boolean } = {},
) {
  useEffect(() => {
    const trimmed = title?.trim();
    document.title = !trimmed
      ? DEFAULT_DOCUMENT_TITLE
      : absolute
        ? trimmed
        : `${trimmed} · ${DEFAULT_DOCUMENT_TITLE}`;
    return () => {
      document.title = DEFAULT_DOCUMENT_TITLE;
    };
  }, [title, absolute]);

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
