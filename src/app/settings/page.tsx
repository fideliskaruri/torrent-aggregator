"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  FolderSearch,
  HardDrive,
  Plus,
  Tags,
  Trash2,
  XCircle,
} from "lucide-react";
import { invalidateDownloadPrefs } from "@/hooks/use-download-prefs";
import { FolderPicker } from "@/components/settings/folder-picker";
import { RetentionPanel } from "@/components/settings/retention-panel";
import { SwarmProbePanel } from "@/components/settings/swarm-probe-panel";
import { FirstRunSetup } from "./first-run-setup";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { TfPageHeader } from "@/components/tf/page-header";
import { TfErrorState } from "@/components/tf/error-state";
import { cn } from "@/lib/utils";
import { STORAGE_CAP_FOCUS_PARAM } from "@/lib/library/storage-override";
import { LoadingGlyph, PageSkeletonFrame, SkeletonBlock } from "@/components/ui/loading";
import { useStableLoading } from "@/components/ui/use-stable-loading";
import {
  detectUnsafeDownloadPath,
  unsafeDownloadPathMessage,
  type UnsafeDownloadPathReason,
} from "./download-path-safety";

interface ClientForm {
  clientType: "qbittorrent" | "transmission" | "builtin";
  /** Optional secondary for "Send to my client" when primary is built-in */
  externalClientType: "qbittorrent" | "transmission" | "";
  host: string;
  username: string;
  password: string;
  category: string;
  savePath: string;
  baseDownloadPath: string;
  /** Max total size of download library in GB (automatic hard cap). */
  maxStorageGb: string;
  /** Target vertical resolution for ranking: 480 | 720 | 1080 | 2160. */
  preferredResolution: number;
  /** Minutes between automatic watchlist runs; 0 = never. */
  automationIntervalMinutes: number;
  /** Show extra playback diagnostics for troubleshooting. */
  verboseDiagnostics: boolean;
  categories: string[];
  pathRules: Record<string, string>;
}

interface DownloadPathWarning {
  field: "baseDownloadPath" | "savePath" | "pathRule";
  category?: string;
  path: string;
  reasons: UnsafeDownloadPathReason[];
  message: string;
}

type SettingsTab = "connection" | "folders" | "categories";

const TABS: { id: SettingsTab; label: string }[] = [
  { id: "connection", label: "Connection" },
  { id: "folders", label: "Downloads" },
  { id: "categories", label: "Categories" },
];

export const PRIMARY_DOWNLOAD_CLIENT_OPTIONS = [
  {
    value: "builtin",
    label: "Play in TorrentFlow",
    stance: "recommended",
    hint: "Starts playback in the browser and keeps downloads available without another app.",
  },
  {
    value: "qbittorrent",
    label: "Use qBittorrent instead",
    stance: "advanced",
    hint: "Advanced: new sends depend on qBittorrent being open and reachable.",
  },
  {
    value: "transmission",
    label: "Use Transmission instead",
    stance: "advanced",
    hint: "Advanced: new sends depend on Transmission being open and reachable.",
  },
] as const;

const EXTERNAL_CLIENT_OPTIONS = [
  ["", "Do not send elsewhere"],
  ["qbittorrent", "Also send to qBittorrent"],
  ["transmission", "Also send to Transmission"],
] as const;

/**
 * Quality is a *target*, not a floor — nothing is ever rejected for its
 * resolution, so no choice here can starve a monitored show. The hints say what
 * actually happens rather than just naming a number, because the previous
 * behaviour (silently grabbing 480p) was invisible precisely because nothing
 * ever stated the rule.
 */
const QUALITY_CHOICES: {
  value: number;
  label: string;
  hint: string;
}[] = [
  {
    value: 480,
    label: "480p",
    hint: "Smallest files. Anything larger is only picked when no 480p exists.",
  },
  {
    value: 720,
    label: "720p",
    hint: "Prefers 720p, falls back to 480p before ever taking 1080p or 4K.",
  },
  {
    value: 1080,
    label: "1080p",
    hint: "Prefers 1080p, falls back to 720p then 480p, and takes 4K only as a last resort.",
  },
  {
    value: 2160,
    label: "4K",
    hint: "Prefers 2160p. Expect 15–60 GB per file and much longer downloads.",
  },
];

/**
 * How often the server may check the watchlist on its own.
 *
 * Off is first and is the default: a timer that downloads files while nobody
 * is watching should be something the user turns on, not something they
 * discover afterwards. Nothing under 15 minutes — episodes do not appear that
 * fast and indexers ban IPs that poll.
 */
const AUTOMATION_INTERVAL_CHOICES: { value: number; label: string }[] = [
  { value: 0, label: "Off" },
  { value: 30, label: "30m" },
  { value: 120, label: "2h" },
  { value: 360, label: "6h" },
];

const SETUP_DISMISSED_KEY = "torrentflow:first-run-setup-dismissed";

function formatInterval(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`;
  const hours = minutes / 60;
  return hours === 1 ? "hour" : `${hours} hours`;
}

const EMPTY_FORM: ClientForm = {
  clientType: "builtin",
  externalClientType: "",
  host: "http://127.0.0.1:8080",
  username: "admin",
  password: "",
  category: "",
  savePath: "",
  baseDownloadPath: "",
  maxStorageGb: "0",
  preferredResolution: 1080,
  automationIntervalMinutes: 0,
  verboseDiagnostics: false,
  categories: [
    "Anime",
    "Movies",
    "TV",
    "Music",
    "Games",
    "Software",
    "Books",
    "Other",
  ],
  pathRules: {},
};

/** Client-side join for path previews (mirrors joinDownloadPath). */
function joinBase(base: string, category: string): string {
  const b = base.replace(/[/\\]+$/, "");
  if (!b) return "";
  const sep = b.includes("\\") ? "\\" : "/";
  return `${b}${sep}${category}`;
}

function effectiveCategoryPath(
  category: string,
  pathRules: Record<string, string>,
  baseDownloadPath: string,
  savePath: string,
): string {
  if (pathRules[category]?.trim()) return pathRules[category].trim();
  if (baseDownloadPath.trim()) return joinBase(baseDownloadPath.trim(), category);
  return savePath.trim();
}

function parseSettingsTab(value: string | null): SettingsTab | null {
  if (value === "connection" || value === "folders" || value === "categories") {
    return value;
  }
  return null;
}

export default function SettingsPage() {
  const [form, setForm] = useState<ClientForm>(EMPTY_FORM);
  const [hasPassword, setHasPassword] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [newCategory, setNewCategory] = useState("");
  const [openingPath, setOpeningPath] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerTarget, setPickerTarget] = useState<
    "base" | "savePath" | string | null
  >(null);
  const [message, setMessage] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);
  const [tab, setTab] = useState<SettingsTab>("connection");
  const [pathsExpanded, setPathsExpanded] = useState(false);
  const [expandedCategory, setExpandedCategory] = useState<string | null>(null);
  const [setupComplete, setSetupComplete] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupBrowsing, setSetupBrowsing] = useState(false);
  const [setupSaving, setSetupSaving] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [persistedPathWarnings, setPersistedPathWarnings] = useState<
    DownloadPathWarning[]
  >([]);
  /** Connection test succeeded — cleared when connection fields change */
  const [connectionOk, setConnectionOk] = useState(false);
  const showLoading = useStableLoading(loading && !loadError);
  /**
   * `?focus=cap` — arriving from the over-cap confirmation. Landing on the page
   * is not enough: the owner pressed "Raise the cap", so the caret belongs in
   * the cap field, not wherever the tab happens to start.
   */
  const [pendingCapFocus, setPendingCapFocus] = useState(false);
  const capInputRef = useRef<HTMLInputElement | null>(null);

  // Deep-link: ?tab=connection|folders|categories
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const fromUrl = parseSettingsTab(params.get("tab"));
    if (fromUrl) {
      // The URL is an external store; syncing the active tab on mount belongs in an effect.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTab(fromUrl);
    }
    if (params.get("focus") === STORAGE_CAP_FOCUS_PARAM) {
      setPendingCapFocus(true);
    }
  }, []);

  // The field does not exist until the folders tab has rendered its loaded
  // state, so this waits for the ref rather than firing once on mount.
  useEffect(() => {
    if (!pendingCapFocus) return;
    const el = capInputRef.current;
    if (!el) return;
    el.focus();
    el.select();
    setPendingCapFocus(false);
  }, [pendingCapFocus, tab, loading]);

  function selectTab(next: SettingsTab) {
    setTab(next);
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (next === "connection") {
      url.searchParams.delete("tab");
    } else {
      url.searchParams.set("tab", next);
    }
    const nextPath = url.pathname + (url.search || "");
    window.history.replaceState(null, "", nextPath);
  }

  function touchForm() {
    setConnectionOk(false);
  }

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch("/api/settings/client");
        if (!res.ok) {
          // Prefer the API's own explanation over a bare status code; it is
          // the only part of a failure the user can act on.
          let detail = "";
          try {
            const body = (await res.json()) as { error?: unknown };
            if (typeof body?.error === "string") detail = body.error;
          } catch {
            // Non-JSON error body. The status line is all we have.
          }
          throw new Error(detail || `Request failed (${res.status})`);
        }
        const raw = await res.text();
        if (!raw.trim()) return;
        const data = JSON.parse(raw) as {
          settings?: {
            clientType?: "qbittorrent" | "transmission" | "builtin";
            externalClientType?: "qbittorrent" | "transmission" | null;
            host?: string;
            username?: string | null;
            category?: string | null;
            savePath?: string | null;
            baseDownloadPath?: string | null;
            maxStorageGb?: number | null;
            storageCapConfigured?: boolean;
            setupComplete?: boolean;
            verboseDiagnostics?: boolean;
            preferredResolution?: number | null;
            automationIntervalMinutes?: number | null;
            categories?: string[];
            pathRules?: Record<string, string>;
            pathWarnings?: DownloadPathWarning[];
            hasPassword?: boolean;
          } | null;
          defaults?: { categories?: string[] };
        };
        if (cancelled) return;
        const s = data.settings;
        if (s) {
          setForm((f) => ({
            ...f,
            clientType: s.clientType ?? f.clientType,
            externalClientType: s.externalClientType ?? "",
            host: s.host ?? f.host,
            username: s.username ?? "",
            category: s.category ?? "",
            savePath: s.savePath ?? "",
            baseDownloadPath: s.baseDownloadPath ?? "",
            maxStorageGb:
              s.maxStorageGb != null && s.maxStorageGb > 0
                ? String(s.maxStorageGb)
                : "0",
            preferredResolution: s.preferredResolution ?? f.preferredResolution,
            automationIntervalMinutes: s.automationIntervalMinutes ?? 0,
            verboseDiagnostics: s.verboseDiagnostics === true,
            categories: s.categories ?? f.categories,
            pathRules: s.pathRules ?? {},
            password: "",
          }));
          setHasPassword(Boolean(s.hasPassword));
          const configured = s.setupComplete === true;
          setSetupComplete(configured);
          setPersistedPathWarnings(s.pathWarnings ?? []);
          if (configured) {
            window.localStorage.removeItem(SETUP_DISMISSED_KEY);
            setSetupOpen(false);
          } else {
            setSetupOpen(
              window.localStorage.getItem(SETUP_DISMISSED_KEY) !== "1",
            );
          }
        } else if (data.defaults?.categories) {
          setForm((f) => ({
            ...f,
            categories: data.defaults!.categories ?? f.categories,
          }));
          setSetupComplete(false);
          setSetupOpen(
          window.localStorage.getItem(SETUP_DISMISSED_KEY) !== "1",
          );
        }
      } catch (err) {
        // Without this the form would render its *defaults* as though they
        // were the saved settings, and the next Save would quietly overwrite
        // a working client config with them. Refusing to show the form is the
        // only safe answer: we cannot let the user edit values we never read.
        if (!cancelled) {
          setLoadError(
            err instanceof Error ? err.message : "Could not load settings",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const previewPath = useMemo(
    () => form.savePath || form.baseDownloadPath || "(client default)",
    [form.savePath, form.baseDownloadPath],
  );

  const customPathCount = useMemo(
    () =>
      form.categories.filter((c) => Boolean(form.pathRules[c]?.trim())).length,
    [form.categories, form.pathRules],
  );

  const currentPathEntries = useMemo(
    () => [
      ...(form.baseDownloadPath.trim()
        ? [
            {
              field: "baseDownloadPath" as const,
              path: form.baseDownloadPath.trim(),
            },
          ]
        : []),
      ...(form.savePath.trim()
        ? [{ field: "savePath" as const, path: form.savePath.trim() }]
        : []),
      ...Object.entries(form.pathRules)
        .filter(([, value]) => value.trim())
        .map(([category, value]) => ({
          field: "pathRule" as const,
          category,
          path: value.trim(),
        })),
    ],
    [form.baseDownloadPath, form.savePath, form.pathRules],
  );

  const visiblePathWarnings = useMemo(() => {
    const currentPaths = new Set(
      currentPathEntries.map((entry) => entry.path.toLowerCase()),
    );
    const warnings = new Map<string, DownloadPathWarning>();

    for (const warning of persistedPathWarnings) {
      const key = warning.path.trim().toLowerCase();
      if (currentPaths.has(key)) warnings.set(key, warning);
    }
    for (const entry of currentPathEntries) {
      const safety = detectUnsafeDownloadPath(entry.path);
      const key = entry.path.toLowerCase();
      if (safety.unsafe && !warnings.has(key)) {
        warnings.set(key, {
          ...entry,
          reasons: safety.reasons,
          message: unsafeDownloadPathMessage(safety.reasons),
        });
      }
    }
    return [...warnings.values()];
  }, [currentPathEntries, persistedPathWarnings]);

  const setupFolderWarning = useMemo(() => {
    const safety = detectUnsafeDownloadPath(form.baseDownloadPath);
    return safety.unsafe ? unsafeDownloadPathMessage(safety.reasons) : null;
  }, [form.baseDownloadPath]);

  const pickerInitialPath = useMemo(() => {
    if (pickerTarget === "base") return form.baseDownloadPath;
    if (pickerTarget === "savePath") return form.savePath || form.baseDownloadPath;
    if (pickerTarget && form.pathRules[pickerTarget]) {
      return form.pathRules[pickerTarget];
    }
    if (pickerTarget && form.baseDownloadPath) {
      return joinBase(form.baseDownloadPath, pickerTarget);
    }
    return form.baseDownloadPath || form.savePath || "";
  }, [pickerTarget, form.baseDownloadPath, form.savePath, form.pathRules]);

  function openPicker(target: "base" | "savePath" | string) {
    setPickerTarget(target);
    setPickerOpen(true);
  }

  function openSetupPicker() {
    setSetupBrowsing(true);
    setSetupOpen(false);
    openPicker("base");
  }

  function closePicker() {
    const reopenSetup = setupBrowsing;
    setPickerOpen(false);
    setPickerTarget(null);
    setSetupBrowsing(false);
    if (reopenSetup) setSetupOpen(true);
  }

  function handlePickerSelect(path: string) {
    const reopenSetup = setupBrowsing;
    if (pickerTarget === "base") {
      setForm((f) => ({
        ...f,
        baseDownloadPath: path,
        // If default folder empty, mirror base
        savePath: f.savePath.trim() ? f.savePath : path,
      }));
    } else if (pickerTarget === "savePath") {
      setForm((f) => ({ ...f, savePath: path }));
    } else if (pickerTarget) {
      setForm((f) => ({
        ...f,
        pathRules: { ...f.pathRules, [pickerTarget]: path },
      }));
    }
    setPickerOpen(false);
    setPickerTarget(null);
    setSetupBrowsing(false);
    if (reopenSetup) setSetupOpen(true);
  }

  async function save(e: FormEvent, test: boolean) {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/settings/client", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientType: form.clientType || "builtin",
          externalClientType:
            form.clientType === "builtin"
              ? form.externalClientType || null
              : null,
          host: form.host || "http://127.0.0.1:8080",
          username: form.username,
          password: form.password,
          // The default-label concept is gone: every send is categorised from
          // the release's own identity, so nothing is asserted here.
          category: null,
          savePath: form.savePath,
          baseDownloadPath: form.baseDownloadPath,
          maxStorageGb: (() => {
            const n = parseFloat(form.maxStorageGb);
            return Number.isFinite(n) && n > 0 ? n : 0;
          })(),
          verboseDiagnostics: form.verboseDiagnostics,
          preferredResolution: form.preferredResolution,
          automationIntervalMinutes: form.automationIntervalMinutes,
          categories: form.categories,
          pathRules: form.pathRules,
          test,
          testTarget:
            test &&
            form.clientType === "builtin" &&
            form.externalClientType
              ? "external"
              : "primary",
        }),
      });
      const raw = await res.text();
      if (!raw.trim()) {
        throw new Error(
          `Server returned empty response (${res.status}). Restart the dev server (npm run dev) and try again.`,
        );
      }
      type SaveResponse = {
        error?: string;
        message?: string;
        settings?: {
          hasPassword?: boolean;
          categories?: string[];
          pathRules?: Record<string, string>;
          category?: string | null;
          savePath?: string | null;
          baseDownloadPath?: string | null;
          maxStorageGb?: number | null;
          setupComplete?: boolean;
          verboseDiagnostics?: boolean;
          preferredResolution?: number | null;
          automationIntervalMinutes?: number | null;
          pathWarnings?: DownloadPathWarning[];
        };
        testResult?: { ok: boolean; message: string };
      };
      let data: SaveResponse;
      try {
        data = JSON.parse(raw) as SaveResponse;
      } catch {
        throw new Error(
          `Server returned non-JSON (${res.status}). ${raw.slice(0, 120)}`,
        );
      }
      if (!res.ok) {
        throw new Error(
          data.message || data.error || `Save failed (${res.status})`,
        );
      }
      setHasPassword(Boolean(data.settings?.hasPassword));
      invalidateDownloadPrefs();
      const saved = data.settings;
      if (saved) {
        setForm((f) => ({
          ...f,
          categories: saved.categories ?? f.categories,
          pathRules: saved.pathRules ?? {},
          category: saved.category ?? "",
          savePath: saved.savePath ?? "",
          baseDownloadPath: saved.baseDownloadPath ?? "",
          maxStorageGb:
            saved.maxStorageGb != null && saved.maxStorageGb > 0
              ? String(saved.maxStorageGb)
              : "0",
          verboseDiagnostics:
            saved.verboseDiagnostics ?? f.verboseDiagnostics,
          preferredResolution:
            saved.preferredResolution ?? f.preferredResolution,
          automationIntervalMinutes:
            saved.automationIntervalMinutes ?? f.automationIntervalMinutes,
        }));
        const configured = saved.setupComplete === true;
        setSetupComplete(configured);
        setPersistedPathWarnings(saved.pathWarnings ?? []);
        if (configured) {
          setSetupOpen(false);
          window.localStorage.removeItem(SETUP_DISMISSED_KEY);
        }
      }
      if (data.testResult) {
        setMessage({
          ok: data.testResult.ok,
          text: data.testResult.message,
        });
        setConnectionOk(data.testResult.ok);
      } else {
        setMessage({ ok: true, text: "Settings saved" });
      }
    } catch (err) {
      setConnectionOk(false);
      setMessage({
        ok: false,
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  }

  function dismissSetup() {
    window.localStorage.setItem(SETUP_DISMISSED_KEY, "1");
    setSetupOpen(false);
  }

  function reopenSetup() {
    setSetupError(null);
    setSetupOpen(true);
  }

  async function saveFirstRunSetup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const folder = form.baseDownloadPath.trim();
    const maxStorageGb = Number(form.maxStorageGb);
    if (!folder || !Number.isFinite(maxStorageGb) || maxStorageGb <= 0) {
      setSetupError("Choose a download folder and enter a storage cap above 0 GB.");
      return;
    }

    setSetupSaving(true);
    setSetupError(null);
    try {
      const res = await fetch("/api/settings/client", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseDownloadPath: folder,
          savePath: folder,
          maxStorageGb,
        }),
      });
      const data = (await res.json()) as {
        error?: string;
        message?: string;
        settings?: {
          baseDownloadPath?: string | null;
          savePath?: string | null;
          maxStorageGb?: number | null;
          setupComplete?: boolean;
          pathWarnings?: DownloadPathWarning[];
        };
      };
      if (!res.ok || data.settings?.setupComplete !== true) {
        throw new Error(
          data.message || data.error || "Could not finish storage setup",
        );
      }

      const saved = data.settings;
      setForm((current) => ({
        ...current,
        baseDownloadPath: saved.baseDownloadPath ?? folder,
        savePath: saved.savePath ?? folder,
        maxStorageGb:
          saved.maxStorageGb != null && saved.maxStorageGb > 0
            ? String(saved.maxStorageGb)
            : current.maxStorageGb,
      }));
      setPersistedPathWarnings(saved.pathWarnings ?? []);
      setSetupComplete(true);
      setSetupOpen(false);
      window.localStorage.removeItem(SETUP_DISMISSED_KEY);
      invalidateDownloadPrefs();
      selectTab("folders");
      setMessage({ ok: true, text: "Download folder and storage cap saved" });
    } catch (err) {
      setSetupError(
        err instanceof Error ? err.message : "Could not finish storage setup",
      );
    } finally {
      setSetupSaving(false);
    }
  }

  function addCategory() {
    const name = newCategory.trim();
    if (!name) return;
    if (form.categories.some((c) => c.toLowerCase() === name.toLowerCase())) {
      setNewCategory("");
      return;
    }
    setForm((f) => ({ ...f, categories: [...f.categories, name] }));
    setNewCategory("");
  }

  async function openFolder(folderPath: string, category?: string) {
    const pathToOpen = folderPath.trim();
    if (!pathToOpen && !category) {
      setMessage({
        ok: false,
        text: "Set a folder path first",
      });
      return;
    }
    setOpeningPath(pathToOpen || category || "default");
    try {
      const res = await fetch("/api/settings/open-folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: pathToOpen || null,
          category: category || null,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setMessage({ ok: true, text: data.message || `Opened ${data.path}` });
      } else {
        const p = data.path || data.pathOnly || pathToOpen;
        if (p) {
          try {
            await navigator.clipboard.writeText(p);
            setMessage({
              ok: false,
              text: `${data.message || data.error} — path copied: ${p}`,
            });
          } catch {
            setMessage({
              ok: false,
              text: data.message || data.error || "Could not open folder",
            });
          }
        } else {
          setMessage({
            ok: false,
            text: data.message || data.error || "Could not open folder",
          });
        }
      }
    } catch {
      setMessage({ ok: false, text: "Network error opening folder" });
    } finally {
      setOpeningPath(null);
    }
  }

  function removeCategory(name: string) {
    setForm((f) => {
      const nextRules = { ...f.pathRules };
      delete nextRules[name];
      return {
        ...f,
        categories: f.categories.filter((c) => c !== name),
        pathRules: nextRules,
        category: f.category === name ? "" : f.category,
      };
    });
    if (expandedCategory === name) setExpandedCategory(null);
  }

  function clearCategoryPath(name: string) {
    setForm((f) => {
      const nextRules = { ...f.pathRules };
      delete nextRules[name];
      return { ...f, pathRules: nextRules };
    });
  }

  if (loading && !loadError) return <SettingsSkeleton visible={showLoading} />;


  if (loadError) {
    return (
      <div className="container-app max-w-2xl py-6 sm:py-8 min-w-0">
        <TfErrorState
          title="Could not load your settings"
          message={`${loadError} — the form stays hidden so a save cannot overwrite settings we never managed to read.`}
          onRetry={() => window.location.reload()}
        />
      </div>
    );
  }

  return (
    <div className="container-app max-w-2xl py-6 sm:py-8 space-y-5 pb-28 min-w-0">
      <TfPageHeader
        title="Settings"
        description="Connection, download folders, categories, and path overrides."
        actions={
          connectionOk ? (
            <Badge variant="success" data-connection-ok>
              Connected
            </Badge>
          ) : null
        }
      />

      {!setupComplete ? (
        <section
          aria-label="Storage setup incomplete"
          className="surface flex flex-col gap-3 rounded-xl border border-[var(--warning)]/40 p-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex min-w-0 items-start gap-3">
            <HardDrive className="mt-0.5 h-5 w-5 shrink-0 text-[var(--warning)]" />
            <div>
              <h2 className="text-sm font-medium text-[var(--text)]">
                Downloads are paused until storage is set up
              </h2>
              <p className="mt-1 text-xs leading-relaxed text-[var(--text-tertiary)]">
                Choose a permanent folder and the maximum space TorrentFlow may
                use. The app will not invent either value.
              </p>
            </div>
          </div>
          <Button
            type="button"
            variant="secondary"
            className="w-full shrink-0 sm:w-auto"
            onClick={reopenSetup}
          >
            Finish setup
          </Button>
        </section>
      ) : null}

      <form onSubmit={(e) => save(e, false)} className="space-y-5">
        {/* Tab nav */}
        <div
          role="tablist"
          aria-label="Settings sections"
          className="flex gap-1 rounded-lg border border-[var(--border)] bg-[var(--bg-muted)] p-1"
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              id={`settings-tab-${t.id}`}
              onClick={() => selectTab(t.id)}
              className={cn(
                "flex-1 flex items-center justify-center min-h-[44px] rounded-md px-3 py-2 text-sm font-medium transition-colors lg:min-h-0",
                tab === t.id
                  ? "bg-[var(--accent-dim)] text-[var(--accent-text)] shadow-sm ring-1 ring-[var(--accent-ring)]"
                  : "text-[var(--text-secondary)] hover:text-[var(--text)]",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Connection */}
        {tab === "connection" && (
          <section
            role="tabpanel"
            aria-labelledby="settings-tab-connection"
            className="surface rounded-xl p-5 sm:p-6 space-y-5"
          >
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-[var(--text-tertiary)]">
                Keep playback in TorrentFlow. External clients are advanced
                fallbacks, not the normal way to watch.
              </p>
              {connectionOk ? (
                <Badge variant="success" data-connection-ok>
                  Connected
                </Badge>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-[var(--text-tertiary)]">
                How new torrents should play
              </label>
              <div className="grid grid-cols-1 gap-2">
                {PRIMARY_DOWNLOAD_CLIENT_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => {
                      touchForm();
                      setForm((f) => ({
                        ...f,
                        clientType: option.value,
                        host:
                          option.value === "qbittorrent"
                            ? f.host.includes("9091")
                              ? "http://127.0.0.1:8080"
                              : f.host || "http://127.0.0.1:8080"
                            : option.value === "transmission"
                              ? f.host.includes("8080") &&
                                !f.host.includes("9091")
                                ? "http://127.0.0.1:9091"
                                : f.host || "http://127.0.0.1:9091"
                              : f.host,
                      }));
                    }}
                    className={cn(
                      "min-h-[44px] rounded-lg px-3 py-2.5 text-left text-sm transition-colors ring-1 lg:min-h-0",
                      option.stance === "advanced" && "ml-4 sm:ml-8",
                      form.clientType === option.value
                        ? "bg-[var(--accent-dim)] text-[var(--accent-text)] ring-1 ring-[var(--accent-ring)]"
                        : "bg-[var(--bg-muted)] text-[var(--text-secondary)] ring-1 ring-[var(--border)] hover:text-[var(--text)]",
                    )}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="font-medium">{option.label}</span>
                      {option.stance === "recommended" ? (
                        <span className="rounded-full bg-[rgba(62,207,142,0.12)] px-2 py-0.5 text-[10px] uppercase tracking-wide text-[var(--success)]">
                          Recommended
                        </span>
                      ) : (
                        <span className="rounded-full bg-[var(--bg-elevated)] px-2 py-0.5 text-[10px] uppercase tracking-wide text-[var(--text-tertiary)]">
                          Advanced
                        </span>
                      )}
                    </span>
                    <span className="mt-1 block text-[11px] leading-relaxed text-[var(--text-tertiary)]">
                      {option.hint}
                    </span>
                  </button>
                ))}
              </div>
              <p className="text-xs text-[var(--text-tertiary)] leading-relaxed pt-1">
                {form.clientType === "builtin"
                  ? "This is the only mode that can make a search result immediately watchable in the browser. You can still copy sends to another client below."
                  : "TorrentFlow will hand off new sends instead of preparing them for in-browser playback. Switch back to Play in TorrentFlow when watching matters more than managing an external queue."}
              </p>
            </div>

            {/* Optional external when primary is built-in */}
            {form.clientType === "builtin" ? (
              <div className="space-y-3 rounded-lg border border-[var(--border)] bg-[var(--bg-muted)]/40 p-4">
                <div className="space-y-1">
                  <label className="text-xs text-[var(--text-tertiary)]">
                    Optional copy to another client
                  </label>
                  <p className="text-[12px] text-[var(--text-tertiary)] leading-relaxed">
                    Add a secondary send button for qBittorrent or Transmission
                    without making either app part of playback.
                  </p>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  {EXTERNAL_CLIENT_OPTIONS.map(([value, label]) => (
                    <button
                      key={value || "none"}
                      type="button"
                      onClick={() => {
                        touchForm();
                        setForm((f) => ({
                          ...f,
                          externalClientType: value,
                          host:
                            value === "transmission"
                              ? f.host.includes("8080") &&
                                !f.host.includes("9091")
                                ? "http://127.0.0.1:9091"
                                : f.host || "http://127.0.0.1:9091"
                              : value === "qbittorrent"
                                ? f.host.includes("9091")
                                  ? "http://127.0.0.1:8080"
                                  : f.host || "http://127.0.0.1:8080"
                                : f.host,
                        }));
                      }}
                      className={cn(
                        "min-h-[44px] rounded-lg px-3 py-2 text-sm transition-colors lg:min-h-0",
                        form.externalClientType === value
                          ? "bg-[var(--accent-dim)] text-[var(--accent-text)] ring-1 ring-[var(--accent-ring)]"
                          : "bg-[var(--bg-elevated)] text-[var(--text-secondary)] ring-1 ring-[var(--border)] hover:text-[var(--text)]",
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {form.externalClientType ? (
                  <>
                    <Field
                      label="Host URL"
                      value={form.host}
                      onChange={(v) => {
                        touchForm();
                        setForm((f) => ({ ...f, host: v }));
                      }}
                      placeholder={
                        form.externalClientType === "qbittorrent"
                          ? "http://127.0.0.1:8080"
                          : "http://127.0.0.1:9091"
                      }
                    />
                    <div className="grid sm:grid-cols-2 gap-4">
                      <Field
                        label="Username"
                        value={form.username}
                        onChange={(v) => {
                          touchForm();
                          setForm((f) => ({ ...f, username: v }));
                        }}
                        placeholder="admin"
                      />
                      <Field
                        label={
                          hasPassword
                            ? "Password (leave blank to keep)"
                            : "Password"
                        }
                        value={form.password}
                        onChange={(v) => {
                          touchForm();
                          setForm((f) => ({ ...f, password: v }));
                        }}
                        type="password"
                        placeholder="••••••••"
                      />
                    </div>
                  </>
                ) : null}
              </div>
            ) : null}

            {form.clientType !== "builtin" ? (
              <>
                <Field
                  label="Host URL"
                  value={form.host}
                  onChange={(v) => {
                    touchForm();
                    setForm((f) => ({ ...f, host: v }));
                  }}
                  placeholder={
                    form.clientType === "qbittorrent"
                      ? "http://127.0.0.1:8080"
                      : "http://127.0.0.1:9091"
                  }
                />
                <div className="grid sm:grid-cols-2 gap-4">
                  <Field
                    label="Username"
                    value={form.username}
                    onChange={(v) => {
                      touchForm();
                      setForm((f) => ({ ...f, username: v }));
                    }}
                    placeholder="admin"
                  />
                  <Field
                    label={
                      hasPassword
                        ? "Password (leave blank to keep)"
                        : "Password"
                    }
                    value={form.password}
                    onChange={(v) => {
                      touchForm();
                      setForm((f) => ({ ...f, password: v }));
                    }}
                    type="password"
                    placeholder="••••••••"
                  />
                </div>
              </>
            ) : null}

            <label
              htmlFor="verbose-diagnostics"
              className="flex min-h-11 cursor-pointer items-start gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg-muted)]/40 px-3 py-2.5"
            >
              <Checkbox
                id="verbose-diagnostics"
                checked={form.verboseDiagnostics}
                onCheckedChange={(checked) =>
                  setForm((current) => ({
                    ...current,
                    verboseDiagnostics: checked === true,
                  }))
                }
                aria-describedby="verbose-diagnostics-help"
              />
              <span className="min-w-0 pt-1 lg:pt-0">
                <span className="block text-sm font-medium text-[var(--text)]">
                  Verbose diagnostics
                </span>
                <span
                  id="verbose-diagnostics-help"
                  className="mt-1 block text-xs leading-relaxed text-[var(--text-tertiary)]"
                >
                  Show extra live playback details while troubleshooting. Off by
                  default.
                </span>
              </span>
            </label>
          </section>
        )}

        {/* Folders */}
        {tab === "folders" && (
          <>
            <section
              role="tabpanel"
              aria-labelledby="settings-tab-folders"
              className="surface rounded-xl p-5 sm:p-6 space-y-5"
            >
              <div className="flex items-start gap-3">
                <FolderOpen className="h-5 w-5 text-[var(--accent-text)] shrink-0 mt-0.5" />
                <div>
                  <h2 className="text-sm font-medium text-[var(--text)]">
                    Download folders
                  </h2>
                  <p className="text-xs text-[var(--text-tertiary)] mt-1 leading-relaxed">
                    Set a base folder to auto-map each category to{" "}
                    <code className="text-[var(--text-secondary)]">
                      base/Category
                    </code>
                    . Override individual categories under Categories if needed.
                    Paths must be readable by the torrent client.
                  </p>
                </div>
              </div>

            {visiblePathWarnings.length > 0 ? (
              <div
                role="status"
                className="flex items-start gap-3 rounded-lg border border-[var(--warning)]/40 bg-[var(--warning)]/5 p-3"
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--warning)]" />
                <div className="min-w-0 space-y-2">
                  <h3 className="text-sm font-medium text-[var(--text)]">
                    This download folder may be disposable
                  </h3>
                  {visiblePathWarnings.map((warning) => (
                    <div key={warning.path.toLowerCase()} className="space-y-1">
                      <p className="break-all font-mono text-xs text-[var(--warning)]">
                        {warning.path}
                      </p>
                      <p className="text-xs leading-relaxed text-[var(--text-secondary)]">
                        {warning.message}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <label className="text-xs text-[var(--text-tertiary)]">
                  Base download folder
                </label>
                <div className="flex items-center gap-2">
                  {form.baseDownloadPath.trim() && (
                    <button
                      type="button"
                      onClick={() => openFolder(form.baseDownloadPath)}
                      disabled={!!openingPath}
                      className="inline-flex items-center gap-1 min-h-[44px] text-[11px] text-[var(--accent-text)] hover:underline disabled:opacity-40 lg:min-h-0"
                    >
                      {openingPath === form.baseDownloadPath ? (
                        <LoadingGlyph className="h-3 w-3" />
                      ) : (
                        <FolderSearch className="h-3 w-3" />
                      )}
                      Open
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => openPicker("base")}
                    className="inline-flex items-center gap-1 min-h-[44px] text-[11px] text-[var(--accent-text)] hover:underline lg:min-h-0"
                  >
                    <FolderOpen className="h-3 w-3" />
                    Browse
                  </button>
                </div>
              </div>
              <div className="flex gap-2">
                <Input
                  className="h-11 font-mono"
                  value={form.baseDownloadPath}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      baseDownloadPath: e.target.value,
                    }))
                  }
                  placeholder="e.g. D:\Downloads or /downloads"
                />
                {form.baseDownloadPath && (
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-11 shrink-0 text-[var(--text-tertiary)]"
                    onClick={() =>
                      setForm((f) => ({ ...f, baseDownloadPath: "" }))
                    }
                    title="Clear base folder"
                  >
                    Clear
                  </Button>
                )}
              </div>
              {form.baseDownloadPath.trim() && (
                <p className="text-[11px] text-[var(--text-tertiary)] leading-relaxed">
                  Categories without a custom path use{" "}
                  <span className="font-mono text-[var(--text-secondary)]">
                    {joinBase(form.baseDownloadPath.trim(), "Category")}
                  </span>
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <label className="text-xs text-[var(--text-tertiary)]">
                Max library size (GB)
              </label>
              <Input
                ref={capInputRef}
                type="number"
                min={0}
                step={1}
                className="h-11 max-w-[12rem]"
                value={form.maxStorageGb}
                onChange={(e) => {
                  touchForm();
                  setForm((f) => ({ ...f, maxStorageGb: e.target.value }));
                }}
                placeholder="0"
              />
              <p className="text-[11px] text-[var(--text-tertiary)] leading-relaxed">
                Budget for kept downloads under the base download folder. Going
                over it asks you to confirm rather than refusing — streaming
                reclaims its own cache and is never blocked. 0 means unset, and
                downloads stay paused until you choose a cap. TorrentFlow also
                prefers to leave ~500 MB free on the drive, and will ask before
                dipping into it. The only download it will not do at all is one
                that is bigger than the space left.
              </p>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs text-[var(--text-tertiary)]">
                Preferred quality
              </label>
              {/* A 4-column grid, not flex-wrap: equal widths read as one
                  segmented control, and the group can never orphan "4K" onto
                  a second row at narrow widths (320px is still a real device). */}
              <div className="grid grid-cols-4 gap-1.5">
                {QUALITY_CHOICES.map((choice) => {
                  const active = form.preferredResolution === choice.value;
                  return (
                    <button
                      key={choice.value}
                      type="button"
                      aria-pressed={active}
                      onClick={() => {
                        touchForm();
                        setForm((f) => ({
                          ...f,
                          preferredResolution: choice.value,
                        }));
                      }}
                      className={`h-11 rounded-lg px-2 text-sm font-medium transition-colors ring-1 ${
                        active
                          ? "bg-[var(--accent-dim)] text-[var(--accent-text)] ring-[var(--accent-ring)]"
                          : "bg-[var(--bg-muted)] text-[var(--text-secondary)] ring-[var(--border)] hover:text-[var(--text)]"
                      }`}
                    >
                      {choice.label}
                    </button>
                  );
                })}
              </div>
              <p className="text-[11px] text-[var(--text-tertiary)] leading-relaxed">
                {
                  QUALITY_CHOICES.find(
                    (c) => c.value === form.preferredResolution,
                  )?.hint
                }{" "}
                Seeder count can never override this — but a release that is too
                thinly seeded to finish still loses to one that can.
              </p>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs text-[var(--text-tertiary)]">
                Check watchlist automatically
              </label>
              <div className="grid grid-cols-4 gap-1.5">
                {AUTOMATION_INTERVAL_CHOICES.map((choice) => {
                  const active =
                    form.automationIntervalMinutes === choice.value;
                  return (
                    <button
                      key={choice.value}
                      type="button"
                      aria-pressed={active}
                      onClick={() => {
                        touchForm();
                        setForm((f) => ({
                          ...f,
                          automationIntervalMinutes: choice.value,
                        }));
                      }}
                      className={`h-11 rounded-lg px-2 text-sm font-medium transition-colors ring-1 ${
                        active
                          ? "bg-[var(--accent-dim)] text-[var(--accent-text)] ring-[var(--accent-ring)]"
                          : "bg-[var(--bg-muted)] text-[var(--text-secondary)] ring-[var(--border)] hover:text-[var(--text)]"
                      }`}
                    >
                      {choice.label}
                    </button>
                  );
                })}
              </div>
              <p className="text-[11px] text-[var(--text-tertiary)] leading-relaxed">
                {form.automationIntervalMinutes > 0
                  ? `Every ${formatInterval(form.automationIntervalMinutes)} the server searches for the next episode of everything you are monitoring and downloads it. Nothing else starts a download on its own.`
                  : "Off. Your watchlist is only checked when you press Run automation — nothing downloads while you are away."}
              </p>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <label className="text-xs text-[var(--text-tertiary)]">
                  Default download folder
                  <span className="text-[var(--text-tertiary)]/70 ml-1">
                    (fallback)
                  </span>
                </label>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      openFolder(
                        effectiveCategoryPath(
                          form.category,
                          form.pathRules,
                          form.baseDownloadPath,
                          form.savePath,
                        ) || form.savePath,
                        form.category,
                      )
                    }
                    disabled={
                      !!openingPath ||
                      !(
                        form.savePath.trim() ||
                        form.baseDownloadPath.trim() ||
                        (form.category && form.pathRules[form.category])
                      )
                    }
                    className="inline-flex items-center gap-1 min-h-[44px] text-[11px] text-[var(--accent-text)] hover:underline disabled:opacity-40 lg:min-h-0"
                  >
                    {openingPath === form.savePath ||
                    openingPath === form.category ||
                    openingPath === "default" ? (
                      <LoadingGlyph className="h-3 w-3" />
                    ) : (
                      <FolderSearch className="h-3 w-3" />
                    )}
                    Open folder
                  </button>
                  <button
                    type="button"
                    onClick={() => openPicker("savePath")}
                    className="inline-flex items-center gap-1 min-h-[44px] text-[11px] text-[var(--accent-text)] hover:underline lg:min-h-0"
                  >
                    <FolderOpen className="h-3 w-3" />
                    Browse
                  </button>
                </div>
              </div>
              <Input
                className="h-11 font-mono"
                value={form.savePath}
                onChange={(e) =>
                  setForm((f) => ({ ...f, savePath: e.target.value }))
                }
                placeholder={
                  form.baseDownloadPath
                    ? `Falls back to base when empty: ${form.baseDownloadPath}`
                    : form.clientType === "qbittorrent"
                      ? "e.g. D:\\Downloads\\Torrents or /downloads"
                      : "e.g. /var/lib/transmission/Downloads"
                }
              />
            </div>

            <div className="rounded-lg bg-[var(--bg-muted)] border border-[var(--border)] px-3 py-2.5 text-xs text-[var(--text-tertiary)] flex flex-wrap items-center justify-between gap-2">
              <span>
                Uncategorised downloads go to:{" "}
                <span className="text-[var(--accent-text)] font-mono break-all">
                  {previewPath}
                </span>
              </span>
              <button
                type="button"
                onClick={() =>
                  openFolder(
                    typeof previewPath === "string" &&
                      previewPath !== "(client default)"
                      ? previewPath
                      : form.savePath,
                    form.category,
                  )
                }
                disabled={!!openingPath || previewPath === "(client default)"}
                className="inline-flex items-center gap-1 min-h-[44px] text-[var(--accent-text)] hover:underline disabled:opacity-40 lg:min-h-0"
              >
                <FolderSearch className="h-3.5 w-3.5" />
                Open
              </button>
            </div>
            <p className="text-[11px] text-[var(--text-tertiary)] leading-relaxed">
              Search results auto-pick a category (Anime / Movies / TV / …) from
              the title and metadata, then use the mapped folder. “Browse” lists
              folders on this server; “Open folder” opens them in your file
              manager when paths are local.
            </p>
            </section>

            <RetentionPanel />
          </>
        )}

        {/* Categories */}
        {tab === "categories" && (
          <section
            role="tabpanel"
            aria-labelledby="settings-tab-categories"
            className="surface rounded-xl p-5 sm:p-6 space-y-5"
          >
            <div className="flex items-start gap-3">
              <Tags className="h-5 w-5 text-[var(--accent-text)] shrink-0 mt-0.5" />
              <div>
                <h2 className="text-sm font-medium text-[var(--text)]">
                  Categories
                </h2>
                <p className="text-xs text-[var(--text-tertiary)] mt-1 leading-relaxed">
                  These labels choose where files are saved after TorrentFlow
                  identifies them. Remove labels you do not want to route.
                  Empty paths inherit{" "}
                  {form.baseDownloadPath.trim()
                    ? "base/Category"
                    : "the default folder"}
                  .
                </p>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              {form.categories.map((c) => {
                const hasCustom = Boolean(form.pathRules[c]?.trim());
                return (
                  <span
                    key={c}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs ring-1",
                      "bg-[var(--bg-muted)] text-[var(--text-secondary)] ring-[var(--border)]",
                    )}
                  >
                    <span>
                      {c}
                      {hasCustom && (
                        <span
                          className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-[var(--accent)]"
                          title="Custom path override"
                          aria-hidden
                        />
                      )}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeCategory(c)}
                      className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] text-[var(--text-tertiary)] hover:text-[var(--danger)] lg:min-h-0 lg:min-w-0"
                      aria-label={`Remove ${c}`}
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </span>
                );
              })}
            </div>

            <div className="flex gap-2">
              <Input
                className="h-10 flex-1"
                value={newCategory}
                onChange={(e) => setNewCategory(e.target.value)}
                placeholder="Add category name"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addCategory();
                  }
                }}
              />
              <Button
                type="button"
                variant="secondary"
                className="h-10"
                onClick={addCategory}
              >
                <Plus className="h-4 w-4" />
                Add
              </Button>
            </div>

            {/* Collapsible per-category paths */}
            <div className="rounded-lg border border-[var(--border)] overflow-hidden">
              <button
                type="button"
                onClick={() => setPathsExpanded((v) => !v)}
                className="flex w-full items-center justify-between gap-2 px-3 py-2.5 min-h-[44px] text-left text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-muted)] transition-colors lg:min-h-0"
                aria-expanded={pathsExpanded}
              >
                <span className="inline-flex items-center gap-2 font-medium">
                  {pathsExpanded ? (
                    <ChevronDown className="h-4 w-4 text-[var(--accent-text)]" />
                  ) : (
                    <ChevronRight className="h-4 w-4 text-[var(--text-tertiary)]" />
                  )}
                  Per-category paths
                </span>
                <span className="text-[11px] text-[var(--text-tertiary)] tabular-nums">
                  {customPathCount > 0
                    ? `${customPathCount} override${customPathCount === 1 ? "" : "s"}`
                    : form.baseDownloadPath.trim()
                      ? "using base/Category"
                      : "using default folder"}
                </span>
              </button>

              {pathsExpanded && (
                <div className="border-t border-[var(--border)] px-3 py-3 space-y-2">
                  <p className="text-[11px] text-[var(--text-tertiary)] leading-relaxed pb-1">
                    Expand a category to set a custom download folder. Leave
                    empty to inherit.
                  </p>
                  {form.categories.map((c) => {
                    const derived = form.baseDownloadPath.trim()
                      ? joinBase(form.baseDownloadPath.trim(), c)
                      : form.savePath;
                    const hasCustom = Boolean(form.pathRules[c]?.trim());
                    const effective = hasCustom
                      ? form.pathRules[c].trim()
                      : derived;
                    const isOpen = expandedCategory === c;

                    return (
                      <div
                        key={c}
                        className="rounded-md border border-[var(--border)] bg-[var(--bg)]"
                      >
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedCategory((prev) =>
                              prev === c ? null : c,
                            )
                          }
                          className="flex w-full items-center gap-2 px-2.5 py-2 min-h-[44px] text-left min-w-0 lg:min-h-0"
                          aria-expanded={isOpen}
                        >
                          {isOpen ? (
                            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--accent-text)]" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--text-tertiary)]" />
                          )}
                          <span className="text-xs font-medium text-[var(--text)] truncate">
                            {c}
                          </span>
                          {hasCustom ? (
                            <span className="badge badge-accent shrink-0">
                              custom
                            </span>
                          ) : form.baseDownloadPath.trim() ? (
                            <span className="text-[10px] text-[var(--text-tertiary)] shrink-0">
                              auto
                            </span>
                          ) : null}
                          {effective && !isOpen && (
                            <span className="ml-auto text-[10px] font-mono text-[var(--text-tertiary)] truncate max-w-[45%]">
                              {effective}
                            </span>
                          )}
                        </button>

                        {isOpen && (
                          <div className="px-2.5 pb-2.5 space-y-2 border-t border-[var(--border)] pt-2">
                            <div className="flex gap-2 items-center">
                              <Input
                                className="h-9 font-mono text-sm"
                                value={form.pathRules[c] ?? ""}
                                onChange={(e) =>
                                  setForm((f) => ({
                                    ...f,
                                    pathRules: {
                                      ...f.pathRules,
                                      [c]: e.target.value,
                                    },
                                  }))
                                }
                                placeholder={
                                  derived || "Same as default folder if empty"
                                }
                              />
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                onClick={() => openPicker(c)}
                                title={`Browse folder for ${c}`}
                                className="shrink-0 text-[var(--text-tertiary)] hover:text-[var(--accent-text)]"
                              >
                                <FolderOpen className="h-4 w-4" />
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                onClick={() =>
                                  openFolder(
                                    form.pathRules[c] ||
                                      derived ||
                                      form.savePath,
                                    c,
                                  )
                                }
                                disabled={
                                  !!openingPath ||
                                  !(
                                    form.pathRules[c]?.trim() ||
                                    form.baseDownloadPath.trim() ||
                                    form.savePath.trim()
                                  )
                                }
                                title={`Open folder for ${c}`}
                                className="shrink-0 text-[var(--text-tertiary)] hover:text-[var(--accent-text)]"
                              >
                                {openingPath ===
                                  (form.pathRules[c] ||
                                    derived ||
                                    form.savePath) ||
                                openingPath === c ? (
                                  <LoadingGlyph className="h-4 w-4" />
                                ) : (
                                  <FolderSearch className="h-4 w-4" />
                                )}
                              </Button>
                            </div>
                            <div className="flex items-center justify-between gap-2">
                              {!hasCustom && effective ? (
                                <p className="text-[10px] text-[var(--text-tertiary)] font-mono truncate">
                                  → {effective}
                                </p>
                              ) : (
                                <span />
                              )}
                              {hasCustom && (
                                <button
                                  type="button"
                                  onClick={() => clearCategoryPath(c)}
                                  className="inline-flex items-center min-h-[44px] text-[11px] text-[var(--text-tertiary)] hover:text-[var(--accent-text)] lg:min-h-0"
                                >
                                  Reset to auto
                                </button>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </section>
        )}

        {tab === "folders" ? (
          <p className="text-[11px] text-[var(--text-tertiary)] leading-relaxed px-0.5">
            Paths must be valid on the machine running your torrent client (not
            necessarily this app server). Browse only works for folders on the
            TorrentFlow host. For Docker clients use container paths like{" "}
            <code className="text-[var(--text-secondary)]">
              /downloads/anime
            </code>
            .
          </p>
        ) : null}

        {/* Sticky save bar — sits above mobile bottom nav; flush on desktop */}
        <div className="fixed inset-x-0 bottom-[calc(var(--mobile-nav-h)+var(--safe-bottom))] md:bottom-0 z-30 border-t border-[var(--border)] bg-[var(--bg)]/95 backdrop-blur-sm">
          <div className="container-app max-w-2xl py-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            {message ? (
              <div
                className={cn(
                  "flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-sm min-w-0",
                  message.ok
                    ? "bg-emerald-500/10 text-emerald-200"
                    : "bg-rose-500/10 text-rose-200",
                )}
              >
                {message.ok ? (
                  <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
                ) : (
                  <XCircle className="h-4 w-4 mt-0.5 shrink-0" />
                )}
                <span className="break-words">{message.text}</span>
              </div>
            ) : (
              <span className="text-xs text-[var(--text-tertiary)] hidden sm:inline">
                Changes apply after save
              </span>
            )}
            <div className="flex flex-wrap gap-2 shrink-0 sm:ml-auto">
              <Button type="submit" disabled={saving} size="lg">
                {saving && <LoadingGlyph className="h-4 w-4" />}
                Save
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="lg"
                disabled={saving}
                onClick={(e) => save(e as unknown as FormEvent, true)}
              >
                Save & test
              </Button>
            </div>
          </div>
        </div>
      </form>

      <SwarmProbePanel />

      <FirstRunSetup
        open={setupOpen}
        folder={form.baseDownloadPath}
        storageCapGb={form.maxStorageGb}
        saving={setupSaving}
        error={setupError}
        folderWarning={setupFolderWarning}
        onFolderChange={(value) =>
          setForm((current) => ({
            ...current,
            baseDownloadPath: value,
          }))
        }
        onStorageCapChange={(value) =>
          setForm((current) => ({ ...current, maxStorageGb: value }))
        }
        onBrowse={openSetupPicker}
        onSkip={dismissSetup}
        onSave={saveFirstRunSetup}
      />

      <FolderPicker
        open={pickerOpen}
        initialPath={pickerInitialPath}
        title={
          pickerTarget === "base"
            ? "Choose base download folder"
            : pickerTarget === "savePath"
              ? "Choose default download folder"
              : pickerTarget
                ? `Choose folder for ${pickerTarget}`
                : "Choose folder"
        }
        onClose={closePicker}
        onSelect={handlePickerSelect}
      />
    </div>
  );
}


function SettingsSkeleton({ visible = true }: { visible?: boolean }) {
  return (
    <PageSkeletonFrame
      aria-label="Loading settings"
      className={cn(
        "container-app max-w-2xl py-6 sm:py-8 space-y-5 pb-28 min-w-0 transition-opacity duration-150",
        !visible && "opacity-0",
      )}
    >
      <div className="space-y-2">
        <SkeletonBlock className="h-8 w-32" />
        <SkeletonBlock className="h-4 w-80 max-w-full" />
      </div>
      <SkeletonBlock className="h-11 w-full rounded-lg" />
      <div className="surface space-y-4 p-4 sm:p-5">
        <SkeletonBlock className="h-5 w-40" />
        <div className="grid gap-3 sm:grid-cols-2">
          {Array.from({ length: 4 }, (_, i) => (
            <SkeletonBlock key={i} className="h-16 w-full" />
          ))}
        </div>
        <SkeletonBlock className="h-24 w-full" />
      </div>
      <div className="surface space-y-3 p-4 sm:p-5">
        <SkeletonBlock className="h-5 w-36" />
        <SkeletonBlock className="h-16 w-full" />
        <SkeletonBlock className="h-16 w-full" />
      </div>
    </PageSkeletonFrame>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  listId,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  listId?: string;
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs text-[var(--text-tertiary)]">{label}</label>
      <Input
        type={type}
        list={listId}
        className="h-11"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}
