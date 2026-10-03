import { QualityOptions } from "@/components/settings/quality-options";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useFeatures, useDisplayPath } from "@/lib/features";
import { DownloadRecovery, prefetchDownloadRecovery } from "@/components/settings/download-recovery";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  FolderSearch,
  HardDrive,
  Plus,
  Tags,
  Trash2,
} from "lucide-react";
import { Link } from "react-router";
import { invalidateDownloadPrefs } from "@/hooks/use-download-prefs";
import { DesktopSection } from "@/components/settings/desktop-section";
import { DownloadLocationFields } from "@/components/settings/download-location-fields";
import { FolderPicker } from "@/components/settings/folder-picker";
import { RemoteAccessSection } from "@/components/settings/remote-access-section";
import { DownloadWindowsPanel } from "@/components/settings/download-windows-panel";
import {
  clampMaxActive,
  MaxActiveDownloadsControl,
} from "@/components/settings/max-active-downloads";
import { SettingsDisclosure } from "@/components/settings/settings-disclosure";
import { SourcesSettings } from "@/components/settings/sources-settings";
import { JellyfinSettings } from "@/components/settings/jellyfin-settings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { LoadingGlyph, PageSkeletonFrame, SkeletonBlock } from "@/components/ui/loading";
import { PageQueryBoundary } from "@/components/tf/page-query-boundary";
import { TfPageHeader } from "@/components/tf/page-header";
import { useApiQuery } from "@/hooks/use-api-query";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { STORAGE_CAP_FOCUS_PARAM } from "@/lib/library/storage-override";
import {
  toDraft,
  toWindow,
  type DownloadWindow,
  type DownloadWindowDraft,
} from "@/lib/download-windows";
import {
  detectUnsafeDownloadPath,
  unsafeDownloadPathMessage,
  type UnsafeDownloadPathReason,
} from "./download-path-safety";

type ClientType = "qbittorrent" | "transmission" | "builtin";
type ExternalClientType = Exclude<ClientType, "builtin">;
type AudioLanguage = "auto" | "english" | "any";

export interface ClientForm {
  clientType: ClientType;
  externalClientType: ExternalClientType | "";
  host: string;
  username: string;
  password: string;
  category: string;
  savePath: string;
  baseDownloadPath: string;
  maxStorageGb: string;
  preferredResolution: number;
  audioLanguage: AudioLanguage;
  automationIntervalMinutes: number;
  maxActiveDownloads: number;
  downloadWindows: DownloadWindowDraft[];
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

const AUDIO_LANGUAGE_CHOICES: ReadonlyArray<{ value: AudioLanguage; label: string; hint: string }> = [
  {
    value: "auto",
    label: "Japanese for anime, English for the rest",
    hint: "Anime comes in Japanese with English subtitles. An English dub is used when there is none.",
  },
  {
    value: "english",
    label: "English",
    hint: "English dubs first, anime included. English subtitles are used when there is no dub.",
  },
  { value: "any", label: "Any language", hint: "Don't check the language. Any release can download." },
];

/** The server's audio language, or auto when it has none (or one this page doesn't know). */
function parseAudioLanguage(value: unknown): AudioLanguage {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized === "english" || normalized === "any" ? normalized : "auto";
}

const AUTOMATION_INTERVAL_CHOICES = [
  { value: 0, label: "Only when I run it" },
  { value: 30, label: "Every 30 minutes" },
  { value: 120, label: "Every 2 hours" },
  { value: 360, label: "Every 6 hours" },
] as const;

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
  audioLanguage: "auto",
  automationIntervalMinutes: 0,
  maxActiveDownloads: 2,
  downloadWindows: [],
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

function joinBase(base: string, category: string): string {
  const clean = base.replace(/[/\\]+$/, "");
  if (!clean) return "";
  return `${clean}${clean.includes("\\") ? "\\" : "/"}${category}`;
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

/** The cap open download hours hold right now, or null while the saved value applies. */
function scheduleCapFrom(
  settings?: { effectiveMaxActive?: number; maxActiveSource?: string } | null,
): number | null {
  return settings?.maxActiveSource === "schedule" &&
    typeof settings.effectiveMaxActive === "number"
    ? settings.effectiveMaxActive
    : null;
}

function parseSettingsTab(
  value: string | null,
): "connection" | "folders" | "categories" | null {
  return value === "connection" || value === "folders" || value === "categories"
    ? value
    : null;
}

export default function SettingsPage() {
  const { openFolder: canOpenFolder, runningInContainer } = useFeatures();
  const displayPath = useDisplayPath();
  const [form, setForm] = useState<ClientForm>(EMPTY_FORM);
  const [savedForm, setSavedForm] = useState<ClientForm>(EMPTY_FORM);
  const [hasPassword, setHasPassword] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadKey, setLoadKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [newCategory, setNewCategory] = useState("");
  const [pathsExpanded, setPathsExpanded] = useState(false);
  const [expandedCategory, setExpandedCategory] = useState<string | null>(null);
  const [openingPath, setOpeningPath] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerTarget, setPickerTarget] = useState<
    "base" | "savePath" | string | null
  >(null);
  const [externalClientsEnabled, setExternalClientsEnabled] = useState(false);
  const [setupComplete, setSetupComplete] = useState(false);
  const [persistedPathWarnings, setPersistedPathWarnings] = useState<
    DownloadPathWarning[]
  >([]);
  const [connectionOk, setConnectionOk] = useState(false);
  const [downloadWindowOpen, setDownloadWindowOpen] = useState<boolean | null>(null);
  // Set while open download hours hold their own cap (servers that report it).
  const [scheduleCap, setScheduleCap] = useState<number | null>(null);
  const [pendingCapFocus, setPendingCapFocus] = useState(false);
  const capInputRef = useRef<HTMLInputElement | null>(null);
  const legacyTargetRef = useRef<"connection" | "folders" | "categories" | null>(
    null,
  );
  // Rules are no longer advertised (see `lib/navigation.ts`), so Automatic
  // checks names them only for people who still have enabled rules it runs.
  const enabledRuleCount =
    useApiQuery<number>("/api/rules", {
      select: (json) =>
        ((json as { rules?: { enabled?: boolean | null }[] } | null)?.rules ?? [])
          .filter((rule) => rule.enabled === true).length,
    }).data ?? 0;

  const isDirty = useMemo(
    () => JSON.stringify(form) !== JSON.stringify(savedForm),
    [form, savedForm],
  );
  const externalEnabled =
    externalClientsEnabled &&
    (form.clientType !== "builtin" || Boolean(form.externalClientType));
  const externalMode = form.clientType === "builtin" ? "copy" : "instead";
  const externalKind: ExternalClientType =
    form.clientType === "builtin"
      ? form.externalClientType || "qbittorrent"
      : form.clientType;

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const target = parseSettingsTab(params.get("tab"));
    legacyTargetRef.current = target;
    // The query string is an external navigation source.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (target === "categories") setAdvancedOpen(true);
    if (params.get("focus") === STORAGE_CAP_FOCUS_PARAM) {
      setPendingCapFocus(true);
    }
  }, []);

  useEffect(() => {
    if (!pendingCapFocus || loading || !capInputRef.current) return;
    capInputRef.current.focus();
    capInputRef.current.select();
    setPendingCapFocus(false);
  }, [pendingCapFocus, loading]);

  useEffect(() => {
    if (loading) return;
    const target = legacyTargetRef.current;
    if (!target) return;
    legacyTargetRef.current = null;
    const id =
      target === "connection"
        ? "download-app"
        : target === "categories"
          ? "advanced-categories"
          : "downloads";
    window.requestAnimationFrame(() => {
      document.getElementById(id)?.scrollIntoView({ block: "start" });
    });
  }, [loading, advancedOpen]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      // Held with the settings so the storage block lands with the form, not after it.
      const recovery = prefetchDownloadRecovery();
      try {
        const res = await fetch("/api/settings/client");
        await recovery;
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as {
            error?: string;
          } | null;
          throw new Error(body?.error || `Request failed (${res.status})`);
        }
        const data = (await res.json()) as {
          settings?: Partial<Omit<ClientForm, "password" | "maxStorageGb" | "downloadWindows">> & {
            maxStorageGb?: number | null;
            downloadWindows?: DownloadWindow[];
            downloadWindowOpen?: boolean;
            effectiveMaxActive?: number;
            maxActiveSource?: string;
            setupComplete?: boolean;
            hasPassword?: boolean;
            pathWarnings?: DownloadPathWarning[];
            externalClientsEnabled?: boolean;
          };
          defaults?: { categories?: string[] };
        };
        if (cancelled) return;
        const settings = data.settings;
        const externalEnabled = settings?.externalClientsEnabled !== false;
        const loaded: ClientForm = settings
          ? {
              ...EMPTY_FORM,
              clientType: externalEnabled
                ? settings.clientType ?? EMPTY_FORM.clientType
                : "builtin",
              externalClientType: externalEnabled ? settings.externalClientType ?? "" : "",
              host: settings.host ?? EMPTY_FORM.host,
              username: settings.username ?? "",
              password: "",
              category: settings.category ?? "",
              savePath: settings.savePath ?? "",
              baseDownloadPath: settings.baseDownloadPath ?? "",
              maxStorageGb:
                settings.maxStorageGb != null && settings.maxStorageGb > 0
                  ? String(settings.maxStorageGb)
                  : "0",
              preferredResolution:
                settings.preferredResolution ?? EMPTY_FORM.preferredResolution,
              audioLanguage: parseAudioLanguage(settings.audioLanguage),
              automationIntervalMinutes:
                settings.automationIntervalMinutes ??
                EMPTY_FORM.automationIntervalMinutes,
              maxActiveDownloads:
                settings.maxActiveDownloads ?? EMPTY_FORM.maxActiveDownloads,
              downloadWindows: (settings.downloadWindows ?? []).map(toDraft),
              categories:
                settings.categories ??
                data.defaults?.categories ??
                EMPTY_FORM.categories,
              pathRules: settings.pathRules ?? {},
            }
          : {
              ...EMPTY_FORM,
              categories: data.defaults?.categories ?? EMPTY_FORM.categories,
            };
        setForm(loaded);
        setSavedForm(loaded);
        setHasPassword(Boolean(settings?.hasPassword));
        setExternalClientsEnabled(externalEnabled);
        setSetupComplete(settings?.setupComplete === true);
        setPersistedPathWarnings(settings?.pathWarnings ?? []);
        setDownloadWindowOpen(settings?.downloadWindowOpen ?? null);
        setScheduleCap(scheduleCapFrom(settings));
      } catch (error) {
        if (!cancelled) {
          setLoadError(
            error instanceof Error ? error.message : "Could not load settings",
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
  }, [loadKey]);

  const currentPathEntries = useMemo(
    () => [
      ...(form.baseDownloadPath.trim()
        ? [{ field: "baseDownloadPath" as const, path: form.baseDownloadPath.trim() }]
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
    const paths = new Set(
      currentPathEntries.map((entry) => entry.path.toLowerCase()),
    );
    const warnings = new Map<string, DownloadPathWarning>();
    for (const warning of persistedPathWarnings) {
      if (paths.has(warning.path.trim().toLowerCase())) {
        warnings.set(warning.path.trim().toLowerCase(), warning);
      }
    }
    for (const entry of currentPathEntries) {
      const safety = detectUnsafeDownloadPath(entry.path);
      if (safety.unsafe && !warnings.has(entry.path.toLowerCase())) {
        warnings.set(entry.path.toLowerCase(), {
          ...entry,
          reasons: safety.reasons,
          message: unsafeDownloadPathMessage(safety.reasons),
        });
      }
    }
    return [...warnings.values()];
  }, [currentPathEntries, persistedPathWarnings]);

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

  function updateForm(update: (current: ClientForm) => ClientForm) {
    setConnectionOk(false);
    setForm(update);
  }

  function openPicker(target: "base" | "savePath" | string) {
    setPickerTarget(target);
    setPickerOpen(true);
  }

  function handlePickerSelect(path: string) {
    updateForm((current) => {
      if (pickerTarget === "base") {
        return {
          ...current,
          baseDownloadPath: path,
          savePath: current.savePath.trim() ? current.savePath : path,
        };
      }
      if (pickerTarget === "savePath") return { ...current, savePath: path };
      if (pickerTarget) {
        return {
          ...current,
          pathRules: { ...current.pathRules, [pickerTarget]: path },
        };
      }
      return current;
    });
    setPickerOpen(false);
    setPickerTarget(null);
  }

  function setExternalEnabled(enabled: boolean) {
    updateForm((current) => ({
      ...current,
      clientType: enabled ? "qbittorrent" : "builtin",
      externalClientType: "",
      host:
        enabled && current.host.includes("9091")
          ? "http://127.0.0.1:8080"
          : current.host,
    }));
  }

  function setExternalMode(mode: "instead" | "copy") {
    updateForm((current) => ({
      ...current,
      clientType: mode === "instead" ? externalKind : "builtin",
      externalClientType: mode === "copy" ? externalKind : "",
    }));
  }

  function setExternalKind(kind: ExternalClientType) {
    updateForm((current) => ({
      ...current,
      clientType: externalMode === "instead" ? kind : "builtin",
      externalClientType: externalMode === "copy" ? kind : "",
      host:
        kind === "transmission" && current.host.includes("8080")
          ? "http://127.0.0.1:9091"
          : kind === "qbittorrent" && current.host.includes("9091")
            ? "http://127.0.0.1:8080"
            : current.host,
    }));
  }

  async function save(event: FormEvent, test: boolean) {
    event.preventDefault();
    setSaving(true);
    try {
      const downloadWindows = form.downloadWindows.map(toWindow);
      const res = await fetch("/api/settings/client", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientType: form.clientType,
          externalClientType:
            form.clientType === "builtin"
              ? form.externalClientType || null
              : form.clientType,
          host: form.host || "http://127.0.0.1:8080",
          username: form.username,
          password: form.password,
          category: null,
          savePath: form.savePath,
          baseDownloadPath: form.baseDownloadPath,
          maxStorageGb: (() => {
            const value = Number(form.maxStorageGb);
            return Number.isFinite(value) && value > 0 ? value : 0;
          })(),
          preferredResolution: form.preferredResolution,
          audioLanguage: form.audioLanguage,
          automationIntervalMinutes: form.automationIntervalMinutes,
          // Only when changed here: the Downloads page sets it too, and an
          // unrelated save must not put back the value this page loaded.
          maxActiveDownloads:
            Number.isFinite(form.maxActiveDownloads) &&
            form.maxActiveDownloads !== savedForm.maxActiveDownloads
              ? clampMaxActive(form.maxActiveDownloads, savedForm.maxActiveDownloads)
              : undefined,
          downloadWindows,
          // Downloads are always kept. Servers that still read this setting
          // use it to decide whether a pasted torrent is kept.
          defaultRetentionPolicy: "KEPT",
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
      if (!raw.trim()) throw new Error(`Server returned no details (${res.status})`);
      const data = JSON.parse(raw) as {
        error?: string;
        message?: string;
        settings?: Partial<Omit<ClientForm, "password" | "maxStorageGb" | "downloadWindows">> & {
          maxStorageGb?: number | null;
          downloadWindows?: DownloadWindow[];
          downloadWindowOpen?: boolean;
          effectiveMaxActive?: number;
          maxActiveSource?: string;
          setupComplete?: boolean;
          hasPassword?: boolean;
          pathWarnings?: DownloadPathWarning[];
        };
        testResult?: { ok: boolean; message: string };
      };
      if (!res.ok) {
        throw new Error(data.message || data.error || `Save failed (${res.status})`);
      }
      const settings = data.settings;
      const next: ClientForm = {
        ...form,
        clientType: settings?.clientType ?? form.clientType,
        externalClientType:
          settings?.externalClientType ?? form.externalClientType,
        host: settings?.host ?? form.host,
        username: settings?.username ?? form.username,
        password: "",
        category: settings?.category ?? "",
        savePath: settings?.savePath ?? form.savePath,
        baseDownloadPath:
          settings?.baseDownloadPath ?? form.baseDownloadPath,
        maxStorageGb:
          settings?.maxStorageGb != null && settings.maxStorageGb > 0
            ? String(settings.maxStorageGb)
            : "0",
        preferredResolution:
          settings?.preferredResolution ?? form.preferredResolution,
        audioLanguage:
          settings?.audioLanguage != null
            ? parseAudioLanguage(settings.audioLanguage)
            : form.audioLanguage,
        automationIntervalMinutes:
          settings?.automationIntervalMinutes ?? form.automationIntervalMinutes,
        maxActiveDownloads:
          settings?.maxActiveDownloads ?? form.maxActiveDownloads,
        downloadWindows: settings?.downloadWindows
          ? settings.downloadWindows.map(toDraft)
          : form.downloadWindows,

        categories: settings?.categories ?? form.categories,
        pathRules: settings?.pathRules ?? form.pathRules,
      };
      setForm(next);
      setSavedForm(next);
      setHasPassword(Boolean(settings?.hasPassword ?? hasPassword));
      setSetupComplete(settings?.setupComplete === true);
      setPersistedPathWarnings(settings?.pathWarnings ?? []);
      setDownloadWindowOpen(settings?.downloadWindowOpen ?? null);
      setScheduleCap(scheduleCapFrom(settings));
      invalidateDownloadPrefs();
      if (data.testResult) {
        setConnectionOk(data.testResult.ok);
        if (data.testResult.ok) {
          toast.success(data.testResult.message);
        } else {
          toast.error(data.testResult.message);
        }
      } else {
        toast.success("Changes saved");
      }
    } catch (error) {
      setConnectionOk(false);
      toast.error(error instanceof Error ? error.message : "Could not save changes");
    } finally {
      setSaving(false);
    }
  }

  function discardChanges() {
    setForm(savedForm);
    toast.success("Unsaved changes discarded");
    setConnectionOk(false);
  }

  function addCategory() {
    const name = newCategory.trim();
    if (!name) return;
    if (form.categories.some((category) => category.toLowerCase() === name.toLowerCase())) {
      setNewCategory("");
      return;
    }
    updateForm((current) => ({
      ...current,
      categories: [...current.categories, name],
    }));
    setNewCategory("");
  }

  function removeCategory(name: string) {
    updateForm((current) => {
      const pathRules = { ...current.pathRules };
      delete pathRules[name];
      return {
        ...current,
        categories: current.categories.filter((category) => category !== name),
        pathRules,
      };
    });
    if (expandedCategory === name) setExpandedCategory(null);
  }

  async function openFolder(folderPath: string, category?: string) {
    const path = folderPath.trim();
    if (!path && !category) {
      toast.error("Choose a folder first");
      return;
    }
    setOpeningPath(path || category || "default");
    try {
      const res = await fetch("/api/settings/open-folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: path || null, category: category || null }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        message?: string;
        error?: string;
        path?: string;
        pathOnly?: string;
      };
      if (data.ok) {
        toast.success(data.message || "Folder opened");
      } else {
        const shown = data.path || data.pathOnly || path;
        if (shown) {
          await navigator.clipboard.writeText(shown);
          toast.success(
            `Path copied: ${shown}`,
            {
              description:
                data.message || data.error || "Could not open a window",
            },
          );
        } else {
          toast.error(data.message || data.error || "Could not open folder");
        }
      }
    } catch {
      toast.error("Could not open folder");
    } finally {
      setOpeningPath(null);
    }
  }

  const settingsQuery = {
    // A failed load keeps the form hidden, so there is no data to show under the error.
    data: loading || loadError ? null : true,
    loading,
    error: loadError,
    refetch: () => {
      setLoadError(null);
      setLoading(true);
      setLoadKey((k) => k + 1);
    },
  };

  return (
    <PageQueryBoundary
      query={settingsQuery}
      skeleton={(visible) => <SettingsSkeleton visible={visible} />}
      errorTitle="Could not load your settings"
      errorMessage={(error) =>
        `${error.replace(/\.?\s*$/, ".")} The form stays hidden so saved values cannot be overwritten.`
      }
      frame={(node) => <div className="container-app max-w-2xl py-6 sm:py-8">{node}</div>}
    >
    {() => (
    <div className={cn("container-app max-w-2xl space-y-5 py-6 pb-24 sm:py-8", (isDirty || saving) && "pb-40 sm:pb-40")}>
      <TfPageHeader
        title="Settings"
        description="Most defaults are ready. Change only what matters to you."
        meta={
          <Link to="/settings/library" className="inline-flex min-h-11 items-center gap-1.5 text-[13px] text-foreground underline-offset-4 hover:underline md:min-h-0">
            <HardDrive className="size-3.5" aria-hidden />
            Drives and import
          </Link>
        }
        actions={
          isDirty ? (
            <Badge variant="outline">Unsaved changes</Badge>
          ) : connectionOk ? (
            <Badge variant="success">Download app connected</Badge>
          ) : null
        }
      />

      {!setupComplete ? (
        <div
          role="status"
          className="flex min-w-0 items-start gap-3 rounded-lg border border-brand/30 bg-brand-dim p-3"
        >
          <HardDrive className="mt-0.5 h-4 w-4 shrink-0 text-brand-foreground" />
          <p className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground break-words whitespace-normal">
            Choose a download folder and a space limit before saving your first
            download.
          </p>
        </div>
      ) : null}

      <form
        onSubmit={(event) => void save(event, false)}
        className="space-y-5"
        data-settings-form
      >
        <div className="surface divide-y divide-border overflow-hidden rounded-xl">
          <section id="downloads" className="scroll-mt-20 space-y-4 p-4 sm:p-5">
            <div>
              <h2 className="text-sm font-medium text-foreground">Downloads</h2>
              <p className="mt-1 text-xs text-subtle-foreground">
                Choose where files live and how much space TorrentFlow may use.
              </p>
            </div>
            <DownloadRecovery revision={savedForm.baseDownloadPath} />

            {visiblePathWarnings.length ? (
              <div
                role="status"
                className="flex items-start gap-2 rounded-lg border border-brand/30 bg-brand-dim p-3"
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-brand-foreground" />
                <div className="space-y-1 text-xs leading-relaxed">
                  <p className="font-medium text-foreground">
                    This folder may be cleared by another tool
                  </p>
                  <p className="break-all text-muted-foreground">
                    {visiblePathWarnings[0].path}
                  </p>
                  <p className="text-subtle-foreground">
                    {visiblePathWarnings[0].message}
                  </p>
                </div>
              </div>
            ) : null}

            <DownloadLocationFields
              folder={form.baseDownloadPath}
              onFolderChange={(value) =>
                updateForm((current) => ({ ...current, baseDownloadPath: value }))
              }
              onBrowse={() => openPicker("base")}
              spaceGb={form.maxStorageGb}
              onSpaceGbChange={(value) =>
                updateForm((current) => ({ ...current, maxStorageGb: value }))
              }
              spaceInputRef={capInputRef}
            />
            {runningInContainer ? (
              <p className="break-all text-xs text-subtle-foreground" data-container-path>
                Container paths are used for downloads.{" "}
                {displayPath(form.baseDownloadPath || "/media") !== (form.baseDownloadPath || "/media")
                  ? `Host location: ${displayPath(form.baseDownloadPath || "/media")}. `
                  : "Set MEDIA_DISPLAY_PATH to show the host location. "}
                Open the media folder on your computer; folder launching is unavailable in a container.
              </p>
            ) : null}
            <FormField label="Downloads at once" htmlFor="max-active-downloads">
              <MaxActiveDownloadsControl
                id="max-active-downloads"
                describedBy="max-active-downloads-help"
                value={form.maxActiveDownloads}
                onChange={(maxActiveDownloads) =>
                  updateForm((current) => ({ ...current, maxActiveDownloads }))
                }
                className="max-w-fit"
              />
              <p
                id="max-active-downloads-help"
                className="text-xs leading-relaxed text-subtle-foreground"
              >
                The rest wait in line. Download now starts one right away.
                {scheduleCap != null
                  ? ` Download hours allow ${scheduleCap} at once right now.`
                  : null}
              </p>
            </FormField>
            <DownloadWindowsPanel
              windows={form.downloadWindows}
              onChange={(downloadWindows) =>
                updateForm((current) => ({ ...current, downloadWindows }))
              }
              open={
                JSON.stringify(form.downloadWindows) ===
                JSON.stringify(savedForm.downloadWindows)
                  ? downloadWindowOpen
                  : null
              }
            />
          </section>

          <section className="space-y-4 p-4 sm:p-5">
            <fieldset className="min-w-0 space-y-1.5" data-preferred-quality>
              <legend className="mb-1.5 text-xs text-subtle-foreground">
                Minimum download quality
              </legend>
              <QualityOptions
                name="preferred-quality"
                value={form.preferredResolution}
                onChange={(value) =>
                  updateForm((current) => ({ ...current, preferredResolution: value }))
                }
              />
            </fieldset>

            <fieldset className="min-w-0 space-y-1.5" data-audio-language>
              <legend className="mb-1.5 text-xs text-subtle-foreground">
                Audio language
              </legend>
              <RadioGroup
                name="audio-language"
                aria-label="Audio language"
                aria-describedby="audio-language-help"
                value={form.audioLanguage}
                onValueChange={(value) =>
                  updateForm((current) => ({
                    ...current,
                    audioLanguage: parseAudioLanguage(value),
                  }))
                }
                className="grid grid-cols-1 gap-2"
              >
                {AUDIO_LANGUAGE_CHOICES.map((choice) => (
                  <Label
                    key={choice.value}
                    htmlFor={`audio-language-${choice.value}`}
                    className="flex min-h-11 cursor-pointer items-start gap-2.5 rounded-lg border border-border bg-background px-3 py-2.5 font-normal transition-colors hover:border-input has-data-checked:border-brand has-data-checked:bg-brand-dim"
                  >
                    <RadioGroupItem
                      id={`audio-language-${choice.value}`}
                      value={choice.value}
                      className="mt-0.5"
                    />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="text-[13px] font-medium text-foreground">{choice.label}</span>
                      <span className="text-xs text-subtle-foreground">{choice.hint}</span>
                    </span>
                  </Label>
                ))}
              </RadioGroup>
              <p id="audio-language-help" className="pt-1 text-xs leading-relaxed text-subtle-foreground">
                Automatic downloads need English audio or English subtitles. TorrentFlow reads the release name and
                the site&apos;s category before it picks, then the file list once it arrives, magnets included. When
                those don&apos;t settle it, it reads the start of the video for up to 45 seconds. A release with no
                English is stopped and another one is tried. If the check can&apos;t finish, the download keeps going
                and shows English not confirmed. When nothing has English, the item waits for an English release and
                you can pick one yourself. A release you pick yourself always downloads.
              </p>

            </fieldset>

          </section>

          <section
            id="download-app"
            className="scroll-mt-20 space-y-4 p-4 sm:p-5"
          >
            <div className="flex flex-col items-start justify-between gap-2 sm:flex-row sm:gap-3">
              <div>
                <h2 className="text-sm font-medium text-foreground">
                  Download app
                </h2>
                <p className="mt-1 text-xs text-subtle-foreground">
                  TorrentFlow works without installing or connecting anything else.
                </p>
              </div>
              <Badge variant="success">Recommended</Badge>
            </div>

            {externalClientsEnabled ? (
              <>
                <Label
                  htmlFor="use-another-download-app"
                  className="flex min-h-11 cursor-pointer items-center justify-between gap-4 rounded-lg border border-border bg-muted/40 p-3 font-normal"
                >
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-foreground">
                      Use another download app
                    </span>
                    <span className="mt-1 block text-xs text-subtle-foreground">
                      Choose this only if you already use qBittorrent or Transmission.
                    </span>
                  </span>
                  <Switch
                    id="use-another-download-app"
                    aria-label="Use another download app"
                    checked={externalEnabled}
                    onCheckedChange={(checked) =>
                      setExternalEnabled(checked === true)
                    }
                  />
                </Label>

                {externalEnabled ? (
                  <div
                    className="space-y-4 border-l-2 border-brand/40 pl-4"
                    data-external-client-fields
                  >
                    <div className="grid gap-4 sm:grid-cols-2">
                      <FormField label="Download app" htmlFor="external-download-app">
                        <Select
                          value={externalKind}
                          onValueChange={(value) =>
                            setExternalKind(value as ExternalClientType)
                          }
                        >
                          <SelectTrigger
                            id="external-download-app"
                            aria-label="External download app"
                            className="w-full scroll-mb-32"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="qbittorrent">qBittorrent</SelectItem>
                            <SelectItem value="transmission">Transmission</SelectItem>
                          </SelectContent>
                        </Select>
                      </FormField>
                      <FormField label="How to use it" htmlFor="external-download-mode">
                        <Select
                          value={externalMode}
                          onValueChange={(value) =>
                            setExternalMode(value as "instead" | "copy")
                          }
                        >
                          <SelectTrigger
                            id="external-download-mode"
                            aria-label="How to use the external download app"
                            className="w-full scroll-mb-32"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="instead">Use instead of TorrentFlow</SelectItem>
                            <SelectItem value="copy">Also send a copy</SelectItem>
                          </SelectContent>
                        </Select>
                      </FormField>
                    </div>
                    <SettingsField
                      id="external-host"
                      label="Address"
                      value={form.host}
                      onChange={(value) =>
                        updateForm((current) => ({ ...current, host: value }))
                      }
                      placeholder={
                        externalKind === "qbittorrent"
                          ? "http://127.0.0.1:8080"
                          : "http://127.0.0.1:9091"
                      }
                    />
                    <div className="grid gap-4 sm:grid-cols-2">
                      <SettingsField
                        id="external-username"
                        label="Username"
                        value={form.username}
                        onChange={(value) =>
                          updateForm((current) => ({ ...current, username: value }))
                        }
                        placeholder="admin"
                      />
                      <SettingsField
                        id="external-password"
                        label={
                          hasPassword
                            ? "Password (blank keeps saved value)"
                            : "Password"
                        }
                        value={form.password}
                        onChange={(value) =>
                          updateForm((current) => ({ ...current, password: value }))
                        }
                        type="password"
                        placeholder="••••••••"
                      />
                    </div>
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={saving}
                      onClick={(event) =>
                        void save(event as unknown as FormEvent, true)
                      }
                      data-settings-save
                    >
                      Save & test app
                    </Button>
                  </div>
                ) : null}
              </>
            ) : null}
          </section>
        </div>

        {isDirty || saving ? (
          <div
            role="region"
            aria-label="Unsaved changes"
            className="fixed inset-x-0 bottom-[calc(var(--mobile-nav-h)+var(--safe-bottom)+0.5rem)] z-30 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 md:bottom-4"
            data-settings-save-bar
          >
            <div className="container-app max-w-2xl">
              <div className="flex items-center justify-between gap-2 rounded-xl border border-border bg-popover/95 py-2.5 pr-2.5 pl-4 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-popover/85">
                <p className="min-w-0 truncate text-sm text-muted-foreground">
                  <span className="sm:hidden">Unsaved</span>
                  <span className="max-sm:hidden">Unsaved changes</span>
                </p>
                <div className="flex shrink-0 gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={discardChanges}
                    disabled={saving}
                    data-settings-discard
                  >
                    Discard
                  </Button>
                  <Button
                    type="submit"
                    disabled={saving || !isDirty}
                    data-settings-save
                  >
                    {saving ? <LoadingGlyph /> : null}
                    Save changes
                  </Button>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        <SettingsDisclosure
          id="advanced-settings"
          title="Advanced"
          summary="Library timing, and custom categories and folders."
          open={advancedOpen}
          onToggle={() => {
            setAdvancedOpen((open) => !open);
            const url = new URL(window.location.href);
            url.searchParams.delete("tab");
            window.history.replaceState(null, "", `${url.pathname}${url.search}`);
          }}
        >
          <div className="space-y-8" data-advanced-settings>
            <section className="space-y-3" data-automatic-checks>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="text-sm font-medium text-foreground">
                    Automatic checks
                  </h3>
                  <p className="mt-1 text-xs text-subtle-foreground">
                    How often TorrentFlow checks monitored Library titles for
                    new releases. A title is checked sooner right after an
                    episode airs.
                    {enabledRuleCount > 0
                      ? ` This also runs your ${enabledRuleCount} enabled auto-download ${enabledRuleCount === 1 ? "rule" : "rules"}.`
                      : null}
                  </p>
                </div>
                <div className="flex flex-wrap gap-x-4">
                  <Button asChild type="button" variant="link" className="h-auto p-0">
                    <Link to="/watchlist">Open Library</Link>
                  </Button>
                  {enabledRuleCount > 0 ? (
                    <Button asChild type="button" variant="link" className="h-auto p-0">
                      <Link to="/rules" data-automatic-checks-rules>
                        Manage rules
                      </Link>
                    </Button>
                  ) : null}
                </div>
              </div>
              <FormField label="Check automatically" htmlFor="automation-timing">
                <Select
                  value={String(form.automationIntervalMinutes)}
                  onValueChange={(value) =>
                    updateForm((current) => ({
                      ...current,
                      automationIntervalMinutes: Number(value),
                    }))
                  }
                >
                  <SelectTrigger
                    id="automation-timing"
                    className="w-full"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {AUTOMATION_INTERVAL_CHOICES.map((choice) => (
                      <SelectItem key={choice.value} value={String(choice.value)}>
                        {choice.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
            </section>

            <section id="advanced-categories" className="scroll-mt-20 space-y-4">
              <div className="flex items-start gap-3">
                <Tags className="mt-0.5 h-4 w-4 shrink-0 text-brand-foreground" />
                <div>
                  <h3 className="text-sm font-medium text-foreground">
                    Custom categories and folders
                  </h3>
                  <p className="mt-1 text-xs text-subtle-foreground">
                    Leave these alone to sort into the download folder automatically.
                  </p>
                </div>
              </div>

              <FormField label="Fallback folder" htmlFor="fallback-download-folder">
                <div className="flex min-w-0 gap-2">
                  <Input
                    id="fallback-download-folder"
                    value={form.savePath}
                    onChange={(event) =>
                      updateForm((current) => ({
                        ...current,
                        savePath: event.target.value,
                      }))
                    }
                    className="min-w-0 font-mono placeholder:font-sans placeholder:text-muted-foreground"
                    placeholder="Uses the main download folder when blank"
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    size="icon"
                    aria-label="Browse for fallback folder"
                    onClick={() => openPicker("savePath")}
                  >
                    <FolderOpen />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Open fallback folder"
                    disabled={!canOpenFolder || !form.savePath.trim() || Boolean(openingPath)}
                    onClick={() => void openFolder(form.savePath)}
                  >
                    {openingPath === form.savePath ? (
                      <LoadingGlyph />
                    ) : (
                      <FolderSearch />
                    )}
                  </Button>
                </div>
              </FormField>

              <div className="flex flex-wrap gap-2">
                {form.categories.map((category) => (
                  <span
                    key={category}
                    className="inline-flex items-center rounded-full bg-muted pl-3 text-xs text-muted-foreground ring-1 ring-border"
                  >
                    {category}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove ${category}`}
                      onClick={() => removeCategory(category)}
                      className="rounded-full text-subtle-foreground hover:bg-transparent hover:text-destructive max-lg:min-h-11 max-lg:min-w-11"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </span>
                ))}
              </div>

              <div className="flex gap-2">
                <div className="min-w-0 flex-1">
                  <Label htmlFor="new-category" className="sr-only">
                    New category name
                  </Label>
                  <Input
                    id="new-category"
                    value={newCategory}
                    onChange={(event) => setNewCategory(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        addCategory();
                      }
                    }}
                    placeholder="New category name"
                  />
                </div>
                <Button type="button" variant="secondary" onClick={addCategory}>
                  <Plus />
                  Add
                </Button>
              </div>

              <Collapsible
                open={pathsExpanded}
                onOpenChange={setPathsExpanded}
                className="overflow-hidden rounded-lg border border-border"
              >
                <CollapsibleTrigger
                  aria-controls="category-paths"
                  className="flex min-h-11 w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-sm text-muted-foreground outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  <span className="flex items-center gap-2 font-medium">
                    {pathsExpanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                    Folder for each category
                  </span>
                  <span className="text-xs text-subtle-foreground">
                    {Object.values(form.pathRules).filter((value) => value.trim()).length} custom
                  </span>
                </CollapsibleTrigger>
                <CollapsibleContent
                    id="category-paths"
                    className="space-y-2 border-t border-border p-3"
                  >
                    {form.categories.map((category) => {
                      const open = expandedCategory === category;
                      const derived = form.baseDownloadPath.trim()
                        ? joinBase(form.baseDownloadPath.trim(), category)
                        : form.savePath;
                      const effective = effectiveCategoryPath(
                        category,
                        form.pathRules,
                        form.baseDownloadPath,
                        form.savePath,
                      );
                      return (
                        <Collapsible
                          key={category}
                          open={open}
                          onOpenChange={(next) =>
                            setExpandedCategory(next ? category : null)
                          }
                          className="overflow-hidden rounded-md border border-border"
                        >
                          <CollapsibleTrigger
                            aria-controls={`category-${category}-path`}
                            className="flex min-h-11 w-full min-w-0 items-center gap-2 px-3 text-left outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
                          >
                            {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                            <span className="text-xs font-medium text-foreground">
                              {category}
                            </span>
                            {!open && effective ? (
                              <span className="ml-auto max-w-[55%] truncate font-mono text-xs text-subtle-foreground">
                                {effective}
                              </span>
                            ) : null}
                          </CollapsibleTrigger>
                          <CollapsibleContent
                              id={`category-${category}-path`}
                              className="space-y-2 border-t border-border p-3"
                            >
                              <Label
                                htmlFor={`category-path-${category}`}
                                className="sr-only"
                              >
                                Folder for {category}
                              </Label>
                              <div className="flex min-w-0 gap-2">
                                <Input
                                  id={`category-path-${category}`}
                                  value={form.pathRules[category] ?? ""}
                                  onChange={(event) =>
                                    updateForm((current) => ({
                                      ...current,
                                      pathRules: {
                                        ...current.pathRules,
                                        [category]: event.target.value,
                                      },
                                    }))
                                  }
                                  className="min-w-0 font-mono placeholder:font-sans placeholder:text-muted-foreground"
                                  placeholder={derived || "Uses the fallback folder"}
                                />
                                <Button
                                  type="button"
                                  variant="secondary"
                                  size="icon"
                                  aria-label={`Browse for ${category} folder`}
                                  onClick={() => openPicker(category)}
                                >
                                  <FolderOpen />
                                </Button>
                              </div>
                          </CollapsibleContent>
                        </Collapsible>
                      );
                    })}
                </CollapsibleContent>
              </Collapsible>
            </section>

          </div>
        </SettingsDisclosure>
      </form>
      <SourcesSettings />

      <JellyfinSettings />

      <RemoteAccessSection />

      <DesktopSection />

      <FolderPicker
        open={pickerOpen}
        initialPath={pickerInitialPath}
        title={
          pickerTarget === "base"
            ? "Choose download folder"
            : pickerTarget === "savePath"
              ? "Choose fallback folder"
              : pickerTarget
                ? `Choose folder for ${pickerTarget}`
                : "Choose folder"
        }
        onClose={() => {
          setPickerOpen(false);
          setPickerTarget(null);
        }}
        onSelect={handlePickerSelect}
      />
    </div>
    )}
    </PageQueryBoundary>
  );
}

function SettingsField({
  id,
  label,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <FormField label={label} htmlFor={id}>
      <Input
        id={id}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="scroll-mb-32"
      />
    </FormField>
  );
}

function SettingsSkeleton({ visible = true }: { visible?: boolean }) {
  return (
    <PageSkeletonFrame
      aria-label="Loading settings"
      className={cn(
        "container-app max-w-2xl space-y-5 py-6 pb-24 transition-opacity duration-150 sm:py-8",
        !visible && "opacity-0",
      )}
    >
      {/* Always-present h1 so a11y tools are never left without a page landmark. */}
      <h1 className="sr-only">Settings</h1>
      <div className="space-y-2">
        <SkeletonBlock className="h-8 w-32" />
        <SkeletonBlock className="h-4 w-80 max-w-full" />
      </div>
      <div className="surface space-y-5 p-4 sm:p-5">
        <SkeletonBlock className="h-5 w-36" />
        <SkeletonBlock className="h-11 w-full" />
        <SkeletonBlock className="h-11 w-48 max-w-full" />
        <SkeletonBlock className="h-11 w-full" />
        <SkeletonBlock className="h-11 w-full" />
      </div>
    </PageSkeletonFrame>
  );
}
