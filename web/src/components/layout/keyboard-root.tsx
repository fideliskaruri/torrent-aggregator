import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { SearchOverlay } from "@/components/search/search-overlay";

export function KeyboardRoot({ children }: { children: React.ReactNode }) {
  useKeyboardShortcuts();
  return (
    <>
      {children}
      <SearchOverlay />
    </>
  );
}
