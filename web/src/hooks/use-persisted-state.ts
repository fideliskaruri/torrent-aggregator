import { useCallback, useState } from "react";

/**
 * A small piece of UI state remembered in this browser (localStorage), such as
 * whether a panel is open or how a list is sorted.
 *
 * `parse` turns the stored text back into a value and returns null for
 * anything it doesn't recognise, so a stale or hand-edited entry falls back to
 * `fallback` instead of breaking the page. The stored value is read once, on
 * first render, so the page never flashes the default first.
 */
export function usePersistedState<T>(
  key: string,
  fallback: T,
  parse: (stored: string) => T | null,
  serialize: (value: T) => string = String,
): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => {
    if (typeof window === "undefined") return fallback;
    try {
      const stored = window.localStorage.getItem(key);
      return stored == null ? fallback : (parse(stored) ?? fallback);
    } catch {
      return fallback;
    }
  });

  const update = useCallback(
    (next: T) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, serialize(next));
      } catch {
        // Storage can be full or switched off; the choice still holds for this visit.
      }
    },
    [key, serialize],
  );

  return [value, update];
}

export function parseStoredBoolean(stored: string): boolean | null {
  return stored === "true" ? true : stored === "false" ? false : null;
}

/** A `parse` that accepts only one of `allowed`. */
export function storedOneOf<T extends string>(allowed: readonly T[]) {
  return (stored: string): T | null =>
    (allowed as readonly string[]).includes(stored) ? (stored as T) : null;
}
