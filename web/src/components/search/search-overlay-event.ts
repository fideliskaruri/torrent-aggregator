import { DEFAULT_SCOPE_ID } from "@/lib/torrents/search-scopes";
import type { WorkSearchScope } from "@/lib/search/work-search";

export const OPEN_SEARCH_EVENT = "tf:open-search";

export function openSearchOverlay(
  initialQuery?: string,
  options: {
    preserveUrl?: boolean;
    category?: WorkSearchScope;
  } = {},
) {
  window.dispatchEvent(
    new CustomEvent(OPEN_SEARCH_EVENT, {
      detail: {
        query: initialQuery ?? "",
        preserveUrl: options.preserveUrl ?? false,
        category: options.category ?? DEFAULT_SCOPE_ID,
      },
    }),
  );
}
