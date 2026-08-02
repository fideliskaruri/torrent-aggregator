"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { SEARCH_HREF } from "@/lib/navigation";
import { openSearchOverlay } from "@/components/search/search-overlay";

/**
 * Global shortcuts:
 * /  — open the search overlay (command palette), from any page
 * g then h/s/w/c/a/r/t — navigate package flow
 *   h home (browse) · s search · w library · c client · a activity · r rules · t settings
 */
export function useKeyboardShortcuts() {
  const router = useRouter();

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
        if (e.key === "h") router.push("/");
        if (e.key === "s") router.push(SEARCH_HREF);
        if (e.key === "w") router.push("/watchlist");
        if (e.key === "c") router.push("/downloads");
        if (e.key === "a") router.push("/notifications");
        if (e.key === "r") router.push("/rules");
        // d = downloads log (history subset); prefer Activity for “what ran”
        if (e.key === "d") router.push("/history");
        if (e.key === "t") router.push("/settings");
      }
    }

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (gTimer) clearTimeout(gTimer);
    };
  }, [router]);
}
