"use client";

import { useCallback, useEffect, useState } from "react";

export interface DownloadPrefs {
  category: string;
  savePath: string;
  baseDownloadPath: string;
  categories: string[];
  pathRules: Record<string, string>;
  clientType?: string;
  /** Optional secondary client for dual-send */
  externalClientType?: "qbittorrent" | "transmission" | null;
  hasExternal?: boolean;
}

function joinBase(base: string, category: string): string {
  const b = base.replace(/[/\\]+$/, "");
  if (!b) return "";
  const sep = b.includes("\\") ? "\\" : "/";
  return `${b}${sep}${category}`;
}

const DEFAULT_CATEGORIES = [
  "Anime",
  "Movies",
  "TV",
  "Music",
  "Games",
  "Software",
  "Books",
  "Other",
];

let cache: DownloadPrefs | null = null;
let inflight: Promise<DownloadPrefs> | null = null;

async function fetchPrefs(): Promise<DownloadPrefs> {
  if (cache) return cache;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const res = await fetch("/api/settings/client");
      if (!res.ok) {
        return {
          category: "",
          savePath: "",
          baseDownloadPath: "",
          categories: DEFAULT_CATEGORIES,
          pathRules: {},
        };
      }
      const data = await res.json();
      const s = data.settings;
      const prefs: DownloadPrefs = {
        category: s?.category ?? "",
        savePath: s?.savePath ?? "",
        baseDownloadPath: s?.baseDownloadPath ?? "",
        categories: s?.categories ?? data.defaults?.categories ?? DEFAULT_CATEGORIES,
        pathRules: s?.pathRules ?? {},
        clientType: s?.clientType,
        externalClientType: s?.externalClientType ?? null,
        hasExternal: Boolean(s?.hasExternal ?? s?.externalClientType),
      };
      cache = prefs;
      return prefs;
    } catch {
      return {
        category: "",
        savePath: "",
        baseDownloadPath: "",
        categories: DEFAULT_CATEGORIES,
        pathRules: {},
      };
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

export function invalidateDownloadPrefs() {
  cache = null;
}

export function useDownloadPrefs() {
  const [prefs, setPrefs] = useState<DownloadPrefs>(
    cache ?? {
      category: "",
      savePath: "",
      baseDownloadPath: "",
      categories: DEFAULT_CATEGORIES,
      pathRules: {},
    },
  );
  const [loaded, setLoaded] = useState(Boolean(cache));

  const reload = useCallback(async () => {
    cache = null;
    const next = await fetchPrefs();
    setPrefs(next);
    setLoaded(true);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetchPrefs().then((p) => {
      if (cancelled) return;
      setPrefs(p);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Resolve download folder preview.
   * base/Category  or  base/Category/ShowName when showTitle is set for TV/Anime/Movies.
   */
  function resolvePath(
    category: string,
    savePath: string,
    opts?: { showTitle?: string; nest?: boolean },
  ): string {
    if (savePath.trim()) return savePath.trim();
    if (category && prefs.pathRules[category]) {
      const root = prefs.pathRules[category];
      if (opts?.nest !== false && opts?.showTitle) {
        const show = opts.showTitle
          .replace(/[<>:"/\\|?*]/g, "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 80);
        if (show) return joinBase(root, show);
      }
      return root;
    }
    if (category && prefs.baseDownloadPath) {
      const root = joinBase(prefs.baseDownloadPath, category);
      if (opts?.nest !== false && opts?.showTitle) {
        const show = opts.showTitle
          .replace(/[<>:"/\\|?*]/g, "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 80);
        if (show) return joinBase(root, show);
      }
      return root;
    }
    return prefs.savePath || prefs.baseDownloadPath || "";
  }

  return { prefs, loaded, reload, resolvePath };
}
