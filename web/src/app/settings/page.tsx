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
import { Link } from "react-router";
import { invalidateDownloadPrefs } from "@/hooks/use-download-prefs";
import { FolderPicker } from "@/components/settings/folder-picker";
import { RetentionPanel } from "@/components/settings/retention-panel";
import { SettingsDisclosure } from "@/components/settings/settings-disclosure";
import { SwarmProbePanel } from "@/components/settings/swarm-probe-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { LoadingGlyph, PageSkeletonFrame, SkeletonBlock } from "@/components/ui/loading";
import { useStableLoading } from "@/components/ui/use-stable-loading";
import { TfErrorState } from "@/components/tf/error-state";
import { TfPageHeader } from "@/components/tf/page-header";
import { cn } from "@/lib/utils";
import { STORAGE_CAP_FOCUS_PARAM } from "@/lib/library/storage-override";
import {
  detectUnsafeDownloadPath,
  unsafeDownloadPathMessage,
  type UnsafeDownloadPathReason,
} from "./download-path-safety";

type ClientType = "qbittorrent" | "transmission" | "builtin";
type ExternalClientType = Exclude<ClientType, "builtin">;
type RetentionPolicy = "EPHEMERAL" | "KEPT";

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
  automationIntervalMinutes: number;
  verboseDiagnostics: boolean;
  defaultRetentionPolicy: RetentionPolicy;
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

const QUALITY_CHOICES = [
  { value: 480, label: "480p", hint: "Small files" },
  { value: 720, label: "720p", hint: "Balanced" },
  { value: 1080, label: "1080p", hint: "Recommended" },
  { value: 2160, label: "4K", hint: "Largest files" },
] as const;

const FILE_BEHAVIOR_OPTIONS = [
  {
    value: "EPHEMERAL",
    label: "Delete temporary streams when space is needed",
  },
  {
    value: "KEPT",
    label: "Keep new downloads until I remove them",
  },
] as const;

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
  automationIntervalMinutes: 0,
  verboseDiagnostics: false,
  defaultRetentionPolicy: "EPHEMERAL",
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

function parseSettingsTab(
  value: string | null,
): "connection" | "folders" | "categories" | null {
  return value === "connection" || value === "folders" || value === "categories"
    ? value
    : null;
}

export default function SettingsPage() {
  const [form, setForm] = useState<ClientForm>(EMPTY_FORM);
  const [savedForm, setSavedForm] = useState<ClientForm>(EMPTY_FORM);
  const [hasPassword, setHasPassword] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadKey, setLoadKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [newCategory, setNewCategory] = useState("");
  const [pathsExpanded, setPathsExpanded] = useState(false);
  const [expandedCategory, setExpandedCategory] = useState<string | null>(null);
  const [openingPath, setOpeningPath] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerTarget, setPickerTarget] = useState<
    "base" | "savePath" | string | null
  >(null);
  const [setupComplete, setSetupComplete] = useState(false);
  const [persistedPathWarnings, setPersistedPathWarnings] = useState<
    DownloadPathWarning[]
  >([]);
  const [connectionOk, setConnectionOk] = useState(false);
  const [pendingCapFocus, setPendingCapFocus] = useState(false);
  const capInputRef = useRef<HTMLInputElement | null>(null);
  const legacyTargetRef = useRef<"connection" | "folders" | "categories" | null>(
    null,
  );
  const showLoading = useStableLoading(loading && !loadError);

  const isDirty = useMemo(
    () => JSON.stringify(form) !== JSON.stringify(savedForm),
    [form, savedForm],
  );
  const externalEnabled =
    form.clientType !== "builtin" || Boolean(form.externalClientType);
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
      try {
        const res = await fetch("/api/settings/client");
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as {
            error?: string;
          } | null;
          throw new Error(body?.error || `Request failed (${res.status})`);
        }
        const data = (await res.json()) as {
          settings?: Partial<Omit<ClientForm, "password" | "maxStorageGb">> & {
            maxStorageGb?: number | null;
            setupComplete?: boolean;
            hasPassword?: boolean;
            pathWarnings?: DownloadPathWarning[];
          };
          defaults?: { categories?: string[] };
        };
        if (cancelled) return;
        const settings = data.settings;
        const loaded: ClientForm = settings
          ? {
              ...EMPTY_FORM,
              clientType: settings.clientType ?? EMPTY_FORM.clientType,
              externalClientType: settings.externalClientType ?? "",
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
              automationIntervalMinutes:
                settings.automationIntervalMinutes ??
                EMPTY_FORM.automationIntervalMinutes,
              verboseDiagnostics: settings.verboseDiagnostics === true,
              defaultRetentionPolicy:
                settings.defaultRetentionPolicy ??
                EMPTY_FORM.defaultRetentionPolicy,
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
        setSetupComplete(settings?.setupComplete === true);
        setPersistedPathWarnings(settings?.pathWarnings ?? []);
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
    setMessage(null);
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
    setMessage(null);
    try {
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
          verboseDiagnostics: form.verboseDiagnostics,
          preferredResolution: form.preferredResolution,
          automationIntervalMinutes: form.automationIntervalMinutes,
          defaultRetentionPolicy: form.defaultRetentionPolicy,
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
        settings?: Partial<Omit<ClientForm, "password" | "maxStorageGb">> & {
          maxStorageGb?: number | null;
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
        automationIntervalMinutes:
          settings?.automationIntervalMinutes ?? form.automationIntervalMinutes,
        verboseDiagnostics:
          settings?.verboseDiagnostics ?? form.verboseDiagnostics,
        defaultRetentionPolicy:
          settings?.defaultRetentionPolicy ?? form.defaultRetentionPolicy,
        categories: settings?.categories ?? form.categories,
        pathRules: settings?.pathRules ?? form.pathRules,
      };
      setForm(next);
      setSavedForm(next);
      setHasPassword(Boolean(settings?.hasPassword ?? hasPassword));
      setSetupComplete(settings?.setupComplete === true);
      setPersistedPathWarnings(settings?.pathWarnings ?? []);
      invalidateDownloadPrefs();
      if (data.testResult) {
        setConnectionOk(data.testResult.ok);
        setMessage({ ok: data.testResult.ok, text: data.testResult.message });
      } else {
        setMessage({ ok: true, text: "Changes saved" });
      }
    } catch (error) {
      setConnectionOk(false);
      setMessage({
        ok: false,
        text: error instanceof Error ? error.message : "Could not save changes",
      });
    } finally {
      setSaving(false);
    }
  }

  function discardChanges() {
    setForm(savedForm);
    setMessage({ ok: true, text: "Unsaved changes discarded" });
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
      setMessage({ ok: false, text: "Choose a folder first" });
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
        setMessage({ ok: true, text: data.message || "Folder opened" });
      } else {
        const shown = data.path || data.pathOnly || path;
        if (shown) {
          await navigator.clipboard.writeText(shown);
          setMessage({
            ok: false,
            text: `${data.message || data.error || "Could not open a window"} — path copied`,
          });
        } else {
          setMessage({
            ok: false,
            text: data.message || data.error || "Could not open folder",
          });
        }
      }
    } catch {
      setMessage({ ok: false, text: "Could not open folder" });
    } finally {
      setOpeningPath(null);
    }
  }

  if (loading && !loadError) return <SettingsSkeleton visible={showLoading} />;

  if (loadError) {
    return (
      <div className="container-app max-w-2xl py-6 sm:py-8">
        <TfErrorState
          title="Could not load your settings"
          message={`${loadError} — the form stays hidden so saved values cannot be overwritten.`}
          onRetry={() => {
            setLoadError(null);
            setLoading(true);
            setLoadKey((k) => k + 1);
          }}
        />
      </div>
    );
  }

  return (
    <div className="container-app max-w-2xl space-y-5 py-6 pb-24 sm:py-8">
      <TfPageHeader
        title="Settings"
        description="Most defaults are ready. Change only what matters to you."
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
          className="flex items-start gap-3 rounded-lg border border-[var(--warning)]/40 bg-[var(--warning)]/5 p-3"
        >
          <HardDrive className="mt-0.5 h-4 w-4 shrink-0 text-[var(--warning)]" />
          <p className="text-xs leading-relaxed text-[var(--text-secondary)]">
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
        <div className="surface divide-y divide-[var(--border)] overflow-hidden rounded-xl">
          <section id="downloads" className="scroll-mt-20 space-y-4 p-4 sm:p-5">
            <div>
              <h2 className="text-sm font-medium text-[var(--text)]">Downloads</h2>
              <p className="mt-1 text-xs text-[var(--text-tertiary)]">
                Choose where files live and how much space TorrentFlow may use.
              </p>
            </div>

            {visiblePathWarnings.length ? (
              <div
                role="status"
                className="flex items-start gap-2 rounded-lg border border-[var(--warning)]/40 bg-[var(--warning)]/5 p-3"
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--warning)]" />
                <div className="space-y-1 text-xs leading-relaxed">
                  <p className="font-medium text-[var(--text)]">
                    This folder may be cleared by another tool
                  </p>
                  <p className="break-all text-[var(--text-secondary)]">
                    {visiblePathWarnings[0].path}
                  </p>
                  <p className="text-[var(--text-tertiary)]">
                    {visiblePathWarnings[0].message}
                  </p>
                </div>
              </div>
            ) : null}

            <div className="space-y-1.5">
              <label
                htmlFor="download-folder"
                className="text-xs font-medium text-[var(--text-secondary)]"
              >
                Download folder
              </label>
              <div className="flex min-w-0 gap-2">
                <Input
                  id="download-folder"
                  value={form.baseDownloadPath}
                  onChange={(event) =>
                    updateForm((current) => ({
                      ...current,
                      baseDownloadPath: event.target.value,
                    }))
                  }
                  className="h-11 min-w-0 scroll-mb-32 font-mono text-base sm:text-sm"
                  placeholder="Choose a folder or enter its path"
                  autoComplete="off"
                />
                <Button
                  type="button"
                  variant="secondary"
                  className="h-11 shrink-0"
                  onClick={() => openPicker("base")}
                >
                  <FolderOpen />
                  Browse
                </Button>
              </div>
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="storage-limit"
                className="text-xs font-medium text-[var(--text-secondary)]"
              >
                Space limit
              </label>
              <div className="flex max-w-[14rem] items-center gap-2">
                <Input
                  ref={capInputRef}
                  id="storage-limit"
                  type="number"
                  min={0}
                  step={1}
                  inputMode="decimal"
                  value={form.maxStorageGb}
                  onChange={(event) =>
                    updateForm((current) => ({
                      ...current,
                      maxStorageGb: event.target.value,
                    }))
                  }
                  className="h-11 scroll-mb-32 text-base sm:text-sm"
                  aria-describedby="storage-limit-help"
                />
                <span className="text-sm text-[var(--text-secondary)]">GB</span>
              </div>
              <p
                id="storage-limit-help"
                className="text-xs leading-relaxed text-[var(--text-tertiary)]"
              >
                Downloads pause before going beyond this amount.
              </p>
            </div>
          </section>

          <section className="space-y-4 p-4 sm:p-5">
            <div className="space-y-1.5">
              <label
                htmlFor="preferred-quality"
                className="text-xs font-medium text-[var(--text-secondary)]"
              >
                Minimum download quality
              </label>
              <select
                id="preferred-quality"
                value={form.preferredResolution}
                onChange={(event) =>
                  updateForm((current) => ({
                    ...current,
                    preferredResolution: Number(event.target.value),
                  }))
                }
                className="h-11 w-full scroll-mb-32 rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 text-base text-[var(--text)] focus-visible:border-[var(--primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-dim)] sm:text-sm"
              >
                {QUALITY_CHOICES.map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.label} — {choice.hint}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="file-behavior"
                className="text-xs font-medium text-[var(--text-secondary)]"
              >
                After watching or downloading
              </label>
              <select
                id="file-behavior"
                value={form.defaultRetentionPolicy}
                onChange={(event) =>
                  updateForm((current) => ({
                    ...current,
                    defaultRetentionPolicy: event.target.value as RetentionPolicy,
                  }))
                }
                className="h-11 w-full scroll-mb-32 rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 text-base text-[var(--text)] focus-visible:border-[var(--primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-dim)] sm:text-sm"
              >
                {FILE_BEHAVIOR_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          </section>

          <section
            id="download-app"
            className="scroll-mt-20 space-y-4 p-4 sm:p-5"
          >
            <div className="flex flex-col items-start justify-between gap-2 sm:flex-row sm:gap-3">
              <div>
                <h2 className="text-sm font-medium text-[var(--text)]">
                  Download app
                </h2>
                <p className="mt-1 text-xs text-[var(--text-tertiary)]">
                  TorrentFlow works without installing or connecting anything else.
                </p>
              </div>
              <Badge variant="success">Recommended</Badge>
            </div>

            <label
              htmlFor="use-another-download-app"
              className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-[var(--border)] bg-[var(--bg-muted)]/40 p-3"
            >
              <Checkbox
                id="use-another-download-app"
                aria-label="Use another download app"
                checked={externalEnabled}
                onCheckedChange={(checked) => setExternalEnabled(checked === true)}
              />
              <span className="pt-0.5">
                <span className="block text-sm font-medium text-[var(--text)]">
                  Use another download app
                </span>
                <span className="mt-1 block text-xs text-[var(--text-tertiary)]">
                  Choose this only if you already use qBittorrent or Transmission.
                </span>
              </span>
            </label>

            {externalEnabled ? (
              <div
                className="space-y-4 border-l-2 border-[var(--accent-ring)] pl-4"
                data-external-client-fields
              >
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="space-y-1.5">
                    <span className="text-xs font-medium text-[var(--text-secondary)]">
                      Download app
                    </span>
                    <select
                      id="external-download-app"
                      aria-label="External download app"
                      value={externalKind}
                      onChange={(event) =>
                        setExternalKind(event.target.value as ExternalClientType)
                      }
                      className="h-11 w-full scroll-mb-32 rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 text-base text-[var(--text)] sm:text-sm"
                    >
                      <option value="qbittorrent">qBittorrent</option>
                      <option value="transmission">Transmission</option>
                    </select>
                  </label>
                  <label className="space-y-1.5">
                    <span className="text-xs font-medium text-[var(--text-secondary)]">
                      How to use it
                    </span>
                    <select
                      id="external-download-mode"
                      aria-label="How to use the external download app"
                      value={externalMode}
                      onChange={(event) =>
                        setExternalMode(event.target.value as "instead" | "copy")
                      }
                      className="h-11 w-full scroll-mb-32 rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 text-base text-[var(--text)] sm:text-sm"
                    >
                      <option value="instead">Use instead of TorrentFlow</option>
                      <option value="copy">Also send a copy</option>
                    </select>
                  </label>
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
                    label={hasPassword ? "Password (blank keeps saved value)" : "Password"}
                    value={form.password}
                    onChange={(value) =>
                      updateForm((current) => ({ ...current, password: value }))
                    }
                    type="password"
                    placeholder="••••••••"
                  />
                </div>
              </div>
            ) : null}
          </section>
        </div>

        <div
          className="surface flex flex-col gap-3 rounded-xl p-4 sm:flex-row sm:items-center"
          aria-live="polite"
        >
          <div className="min-w-0 flex-1">
            {message ? (
              <p
                role={message.ok ? "status" : "alert"}
                className={cn(
                  "flex items-start gap-2 text-sm",
                  message.ok ? "text-[var(--success)]" : "text-[var(--danger)]",
                )}
              >
                {message.ok ? (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                ) : (
                  <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
                )}
                <span>{message.text}</span>
              </p>
            ) : (
              <p className="text-xs text-[var(--text-tertiary)]">
                {isDirty ? "Review and save your changes." : "Everything is saved."}
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {isDirty ? (
              <Button
                type="button"
                variant="ghost"
                onClick={discardChanges}
                disabled={saving}
                data-settings-discard
              >
                Discard
              </Button>
            ) : null}
            {externalEnabled ? (
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
            ) : null}
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

        <SettingsDisclosure
          id="advanced-settings"
          title="Advanced"
          summary="Custom folders, Library timing, cleanup tools, and troubleshooting."
          open={advancedOpen}
          onToggle={() => {
            setAdvancedOpen((open) => !open);
            const url = new URL(window.location.href);
            url.searchParams.delete("tab");
            window.history.replaceState(null, "", `${url.pathname}${url.search}`);
          }}
        >
          <div className="space-y-8" data-advanced-settings>
            <section className="space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h3 className="text-sm font-medium text-[var(--text)]">
                    Library automation timing
                  </h3>
                  <p className="mt-1 text-xs text-[var(--text-tertiary)]">
                    Rules belong in Library. This only controls when enabled rules run.
                  </p>
                </div>
                <Button asChild type="button" variant="link" className="h-auto p-0">
                  <Link to="/watchlist">Open Library automation</Link>
                </Button>
              </div>
              <label htmlFor="automation-timing" className="sr-only">
                Library automation timing
              </label>
              <select
                id="automation-timing"
                value={form.automationIntervalMinutes}
                onChange={(event) =>
                  updateForm((current) => ({
                    ...current,
                    automationIntervalMinutes: Number(event.target.value),
                  }))
                }
                className="h-11 w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 text-base text-[var(--text)] sm:text-sm"
              >
                {AUTOMATION_INTERVAL_CHOICES.map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.label}
                  </option>
                ))}
              </select>
            </section>

            <section id="advanced-categories" className="scroll-mt-20 space-y-4">
              <div className="flex items-start gap-3">
                <Tags className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent-text)]" />
                <div>
                  <h3 className="text-sm font-medium text-[var(--text)]">
                    Custom categories and folders
                  </h3>
                  <p className="mt-1 text-xs text-[var(--text-tertiary)]">
                    Leave these alone to sort into the download folder automatically.
                  </p>
                </div>
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="fallback-download-folder"
                  className="text-xs font-medium text-[var(--text-secondary)]"
                >
                  Fallback folder
                </label>
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
                    className="h-11 min-w-0 font-mono text-base sm:text-sm"
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
                    disabled={!form.savePath.trim() || Boolean(openingPath)}
                    onClick={() => void openFolder(form.savePath)}
                  >
                    {openingPath === form.savePath ? (
                      <LoadingGlyph />
                    ) : (
                      <FolderSearch />
                    )}
                  </Button>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                {form.categories.map((category) => (
                  <span
                    key={category}
                    className="inline-flex items-center rounded-full bg-[var(--bg-muted)] pl-3 text-xs text-[var(--text-secondary)] ring-1 ring-[var(--border)]"
                  >
                    {category}
                    <button
                      type="button"
                      aria-label={`Remove ${category}`}
                      onClick={() => removeCategory(category)}
                      className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center text-[var(--text-tertiary)] hover:text-[var(--danger)] lg:min-h-8 lg:min-w-8"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </span>
                ))}
              </div>

              <div className="flex gap-2">
                <div className="min-w-0 flex-1">
                  <label htmlFor="new-category" className="sr-only">
                    New category name
                  </label>
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
                    className="h-11 text-base sm:text-sm"
                    placeholder="New category name"
                  />
                </div>
                <Button type="button" variant="secondary" onClick={addCategory}>
                  <Plus />
                  Add
                </Button>
              </div>

              <div className="overflow-hidden rounded-lg border border-[var(--border)]">
                <button
                  type="button"
                  aria-expanded={pathsExpanded}
                  aria-controls="category-paths"
                  onClick={() => setPathsExpanded((open) => !open)}
                  className="flex min-h-[44px] w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-muted)]"
                >
                  <span className="flex items-center gap-2 font-medium">
                    {pathsExpanded ? <ChevronDown /> : <ChevronRight />}
                    Folder for each category
                  </span>
                  <span className="text-xs text-[var(--text-tertiary)]">
                    {Object.values(form.pathRules).filter((value) => value.trim()).length} custom
                  </span>
                </button>
                {pathsExpanded ? (
                  <div
                    id="category-paths"
                    className="space-y-2 border-t border-[var(--border)] p-3"
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
                        <div
                          key={category}
                          className="overflow-hidden rounded-md border border-[var(--border)]"
                        >
                          <button
                            type="button"
                            aria-expanded={open}
                            aria-controls={`category-${category}-path`}
                            onClick={() =>
                              setExpandedCategory(open ? null : category)
                            }
                            className="flex min-h-[44px] w-full min-w-0 items-center gap-2 px-3 text-left"
                          >
                            {open ? <ChevronDown /> : <ChevronRight />}
                            <span className="text-xs font-medium text-[var(--text)]">
                              {category}
                            </span>
                            {!open && effective ? (
                              <span className="ml-auto max-w-[55%] truncate font-mono text-[10px] text-[var(--text-tertiary)]">
                                {effective}
                              </span>
                            ) : null}
                          </button>
                          {open ? (
                            <div
                              id={`category-${category}-path`}
                              className="space-y-2 border-t border-[var(--border)] p-3"
                            >
                              <label
                                htmlFor={`category-path-${category}`}
                                className="sr-only"
                              >
                                Folder for {category}
                              </label>
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
                                  className="h-11 min-w-0 font-mono text-base sm:text-sm"
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
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            </section>

            <section className="space-y-4">
              <div>
                <h3 className="text-sm font-medium text-[var(--text)]">
                  Troubleshooting
                </h3>
                <p className="mt-1 text-xs text-[var(--text-tertiary)]">
                  Status and cleanup tools are here when something needs attention.
                </p>
              </div>
              <label
                htmlFor="verbose-diagnostics"
                className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-[var(--border)] p-3"
              >
                <Checkbox
                  id="verbose-diagnostics"
                  checked={form.verboseDiagnostics}
                  onCheckedChange={(checked) =>
                    updateForm((current) => ({
                      ...current,
                      verboseDiagnostics: checked === true,
                    }))
                  }
                />
                <span className="pt-0.5">
                  <span className="block text-sm font-medium text-[var(--text)]">
                    Show detailed playback diagnostics
                  </span>
                  <span className="mt-1 block text-xs text-[var(--text-tertiary)]">
                    Useful only while investigating playback problems.
                  </span>
                </span>
              </label>
              <SwarmProbePanel />
              <RetentionPanel showPolicy={false} />
            </section>
          </div>
        </SettingsDisclosure>
      </form>

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
    <div className="space-y-1.5">
      <label
        htmlFor={id}
        className="text-xs font-medium text-[var(--text-secondary)]"
      >
        {label}
      </label>
      <Input
        id={id}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="h-11 scroll-mb-32 text-base sm:text-sm"
      />
    </div>
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
