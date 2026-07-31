"use client";

/**
 * Quality-selection hook — reads the user's preferred resolution from
 * `/api/settings/client` and exposes it for the Download quality picker.
 *
 * Intentionally narrow: only the fields the picker needs. The full settings
 * surface lives in `src/app/settings/page.tsx`, which owns the form and the
 * save path. This file only reads.
 *
 * Module-level cache mirrors the pattern in `use-download-prefs.ts` so the
 * settings round trip happens once per page load, not once per component.
 */

import { useEffect, useState } from "react";
import {
  ALWAYS_PREFERRED_KEY,
  nearestQuality,
  type QualityValue,
} from "./quality-picker-state";

const DEFAULT_RESOLUTION: QualityValue = 1080;

let cachedResolution: QualityValue | null = null;
let inflight: Promise<QualityValue> | null = null;

async function fetchPreferredResolution(): Promise<QualityValue> {
  if (cachedResolution !== null) return cachedResolution;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const res = await fetch("/api/settings/client");
      if (!res.ok) return DEFAULT_RESOLUTION;
      const data = await res.json();
      const raw = data?.settings?.preferredResolution as number | null | undefined;
      const resolved = raw != null ? nearestQuality(raw) : DEFAULT_RESOLUTION;
      cachedResolution = resolved;
      return resolved;
    } catch {
      return DEFAULT_RESOLUTION;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

/** Read whether the user has toggled "Always use my preferred quality". */
function readAlwaysPreferred(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(ALWAYS_PREFERRED_KEY) === "true";
  } catch {
    return false;
  }
}

/** Persist the "always preferred" toggle. */
export function writeAlwaysPreferred(value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    if (value) {
      localStorage.setItem(ALWAYS_PREFERRED_KEY, "true");
    } else {
      localStorage.removeItem(ALWAYS_PREFERRED_KEY);
    }
  } catch {
    // Ignore storage errors (private browsing, quota exceeded, etc.)
  }
}

export function usePreferredQuality() {
  const [preferredResolution, setPreferredResolution] =
    useState<QualityValue>(cachedResolution ?? DEFAULT_RESOLUTION);
  const [alwaysPreferred, setAlwaysPreferredState] = useState(false);
  const [loaded, setLoaded] = useState(Boolean(cachedResolution));

  useEffect(() => {
    let cancelled = false;
    void fetchPreferredResolution().then((r) => {
      if (cancelled) return;
      setPreferredResolution(r);
      setLoaded(true);
    });
    // Read localStorage after mount (avoid hydration mismatch).
    setAlwaysPreferredState(readAlwaysPreferred());
    return () => {
      cancelled = true;
    };
  }, []);

  function setAlwaysPreferred(value: boolean) {
    writeAlwaysPreferred(value);
    setAlwaysPreferredState(value);
  }

  return { preferredResolution, alwaysPreferred, setAlwaysPreferred, loaded };
}
