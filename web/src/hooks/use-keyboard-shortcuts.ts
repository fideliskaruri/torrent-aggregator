import { useEffect } from "react";
import { useNavigate } from "react-router";
import { SEARCH_HREF } from "@/lib/navigation";
import { openSearchOverlay } from "@/components/search/search-overlay";

/**
 * Global shortcuts:
 * /  — open the search overlay (command palette), from any page
 * g then h/s/w/c/a/r/t — navigate package flow
 *   h home (browse) · s search · w library · c client · a activity · r rules · t settings
 */
export function useKeyboardShortcuts() {
  const navigate = useNavigate();

  useEffect(() => {
    let pendingG = false;
    let gTimer: ReturnType<typeof setTimeout> | null = null;

    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      const editable =
        tag === "input" ||
        tag === "textarea" ||
        tag === "select" ||
        target?.isContentEditable;

      if (e.key === "/" && !editable) {
        e.preventDefault();
        // Open the command palette in place — no route change. `/search`
        // remains reachable as a deep-link fallback via `g s`.
        openSearchOverlay();
        return;
      }

      if (editable) return;

      if (e.key === "g" && !e.metaKey && !e.ctrlKey) {
        pendingG = true;
        if (gTimer) clearTimeout(gTimer);
        gTimer = setTimeout(() => {
          pendingG = false;
        }, 800);
        return;
      }

      if (pendingG) {
        pendingG = false;
        if (e.key === "h") void navigate("/");
        if (e.key === "s") void navigate(SEARCH_HREF);
        if (e.key === "w") void navigate("/watchlist");
        if (e.key === "c") void navigate("/downloads");
        if (e.key === "a") void navigate("/notifications");
        if (e.key === "r") void navigate("/rules");
        // d = downloads log (history subset); prefer Activity for “what ran”
        if (e.key === "d") void navigate("/history");
        if (e.key === "t") void navigate("/settings");
      }
    }

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (gTimer) clearTimeout(gTimer);
    };
  }, [navigate]);
}
