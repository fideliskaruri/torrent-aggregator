import { SearchOverlayView } from "./search-overlay-view";
import { openSearchOverlay } from "./search-overlay-event";
import { useSearchOverlayController } from "./use-search-overlay-controller";
import { useTitleSearch } from "./use-title-search";

export { openSearchOverlay };

export function SearchOverlay() {
  const search = useTitleSearch();
  const controller = useSearchOverlayController(search);

  return <SearchOverlayView search={search} controller={controller} />;
}
