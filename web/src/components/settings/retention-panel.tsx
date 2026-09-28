import { readJsonBody } from "@/lib/api-json";
import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FileWarning,
  FolderOpen,
  HardDrive,
  Loader2,
  Lock,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { toast } from "@/lib/toast";
import { useFeatures, useDisplayPath } from "@/lib/features";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export type RetentionPolicy = "EPHEMERAL" | "KEPT";

/** One untracked file, as the disk inventory reports it. */
interface OrphanFile {
  relativePath: string;
  path: string;
  name: string;
  bytes: number;
  modifiedMs: number | null;
}

/** A release folder (or the loose-files bucket) nothing in the app accounts for. */
interface OrphanGroup {
  relativePath: string;
  path: string;
  name: string;
  loose: boolean;
  bytes: number;
  fileCount: number;
  folderDeletable: boolean;
  files: OrphanFile[];
  filesTruncated: boolean;
  modifiedMs: number | null;
}

interface DiskScan {
  root: string;
  status: "complete" | "partial" | "unavailable";
  authoritative: boolean;
  observedBytes: number;
  trackedBytes: number;
  internalBytes: number;
  fileCount: number;
  orphanFileCount: number;
  truncated: boolean;
  truncatedBy: string[];
  groupsTruncated: boolean;
  unreadablePaths: string[];
  linksSkipped: number;
  scannedAtMs: number;
}

interface StorageUsage {
  totalBytes: number;
  ephemeralBytes: number;
  keptBytes: number;
  indeterminateBytes: number;
  budgetBytes: number | null;
  graceMs: number;
  items: Array<{
    hash: string;
    name: string;
    retentionPolicy: RetentionPolicy | "INDETERMINATE";
    sizeBytes: number;
    progress: number;
    status: string;
  }>;
  diskBytes: number | null;
  orphanBytes: number;
  orphans: OrphanGroup[];
  disk: DiskScan | null;
}

interface SweepResult {
  mode: "preview" | "delete";
  reclaimedBytes: number;
  wouldDelete: Array<{ hash: string; name: string; onDiskBytes: number }>;
  deleted: Array<{ hash: string; name: string; onDiskBytes: number }>;
  skipped: Array<{ hash: string; reason: string; name?: string }>;
  satisfied: boolean;
}

const RETENTION_OPTIONS: Array<{
  value: RetentionPolicy;
  label: string;
  hint: string;
}> = [
  {
    value: "EPHEMERAL",
    label: "Free up space after watching",
    hint: "New Play/stream sends use a temporary cache. Tracked, watchlisted, or explicitly kept items stay.",
  },
  {
    value: "KEPT",
    label: "Keep new downloads",
    hint: "New built-in sends stay on disk until you remove them.",
  },
];

function formatBytes(bytes: number | null): string {
  if (bytes == null) return "Not set";
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(1)} TB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  // Individual untracked entries are routinely a poster or an .nfo, and "53226 B"
  // is a number the owner has to decode rather than read.
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(0)} KB`;
  return `${Math.round(bytes)} B`;
}

/**
 * The exact count, so the total on screen can actually be checked.
 *
 * Explorer's "GB" is binary and this app's is decimal, so the same folder reads
 * 37.6 GB in one place and 40.4 GB in the other. The whole point of this number
 * is that the owner can reconcile it with what Windows shows them, and only the
 * byte count is unit-agnostic — Explorer prints it in the same parentheses.
 */
function formatExactBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 bytes";
  return `${Math.round(bytes).toLocaleString()} bytes`;
}

/** What the owner is about to remove, named the way they will recognise it. */
interface PendingOrphanDelete {
  relativePath: string;
  label: string;
  bytes: number;
  fileCount: number;
  kind: "file" | "folder";
}

function retentionLabel(policy: RetentionPolicy | "INDETERMINATE"): string {
  if (policy === "EPHEMERAL") return "temporary stream";
  if (policy === "KEPT") return "kept";
  return "unknown";
}

export function RetentionPanel({
  showPolicy = true,
}: {
  showPolicy?: boolean;
} = {}) {
  const [policy, setPolicy] = useState<RetentionPolicy>("EPHEMERAL");
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [persisted, setPersisted] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<RetentionPolicy | null>(null);
  const [sweeping, setSweeping] = useState<"preview" | "delete" | null>(null);
  const [sweepResult, setSweepResult] = useState<SweepResult | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingOrphanDelete | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [revealing, setRevealing] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch("/api/settings/client");
      const data = ((await readJsonBody(res)) ?? {}) as {
        settings?: {
          defaultRetentionPolicy?: RetentionPolicy;
          defaultRetentionPolicyPersisted?: boolean;
          storageUsage?: StorageUsage | null;
        };
        error?: string;
      };
      if (!res.ok) throw new Error(data.error || "Could not load retention settings");
      setPolicy(data.settings?.defaultRetentionPolicy ?? "EPHEMERAL");
      setPersisted(data.settings?.defaultRetentionPolicyPersisted !== false);
      setUsage(data.settings?.storageUsage ?? null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // The settings API is the external store; load it after this client island mounts.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, []);

  async function save(next: RetentionPolicy) {
    setSaving(next);
    try {
      const res = await fetch("/api/settings/client", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultRetentionPolicy: next }),
      });
      const data = ((await readJsonBody(res)) ?? {}) as {
        settings?: {
          defaultRetentionPolicy?: RetentionPolicy;
          defaultRetentionPolicyPersisted?: boolean;
          storageUsage?: StorageUsage | null;
        };
        error?: string;
        message?: string;
        retentionWarning?: string | null;
      };
      if (!res.ok)
        throw new Error(data.message || data.error || "Could not save retention setting");
      setPolicy(data.settings?.defaultRetentionPolicy ?? next);
      setPersisted(data.settings?.defaultRetentionPolicyPersisted !== false);
      setUsage(data.settings?.storageUsage ?? null);
      if (data.retentionWarning) {
        toast.success("Retention setting saved", {
          description: data.retentionWarning,
        });
      } else {
        toast.success("Retention setting saved");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(null);
    }
  }

  async function runSweep(mode: "preview" | "delete") {
    if (
      mode === "delete" &&
      !window.confirm(
        "Delete temporary streams now? Downloads you chose to keep, active transfers, and unknown files are skipped.",
      )
    ) {
      return;
    }
    setSweeping(mode);
    try {
      const res = await fetch("/api/settings/retention-sweep", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      const data = ((await readJsonBody(res)) ?? {}) as {
        ok?: boolean;
        result?: SweepResult;
        error?: string;
        message?: string;
      };
      if (!res.ok || !data.result) {
        throw new Error(data.message || data.error || "Could not run retention sweep");
      }
      setSweepResult(data.result);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSweeping(null);
    }
  }

  const topItems = useMemo(() => usage?.items.slice(0, 5) ?? [], [usage]);

  /**
   * Show the owner the folder in Explorer before they decide.
   *
   * Always a *folder*, never the file itself: `explorer.exe <file>` launches the
   * file in its default player, which is not what "show me this" means here.
   * Same clipboard fallback the Client page uses when the host cannot open a
   * window (headless server, remote client).
   */
  async function reveal(target: string, key: string) {
    setRevealing(key);
    try {
      const res = await fetch("/api/settings/open-folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: target }),
      });
      const data = ((await readJsonBody(res)) ?? {}) as {
        ok?: boolean;
        message?: string;
        error?: string;
        path?: string;
        pathOnly?: string;
      };
      if (data.ok) {
        toast.success(data.message || `Opened ${target}`);
        return;
      }
      const shown = data.path || data.pathOnly || target;
      try {
        await navigator.clipboard.writeText(shown);
        toast.success(`Path copied: ${shown}`, {
          description:
            data.message || data.error || "Could not open a window here",
        });
        return;
      } catch {
        toast.error(data.message || data.error || `Could not open ${shown}`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setRevealing(null);
    }
  }

  /**
   * Remove exactly one untracked entry.
   *
   * The server re-derives orphan status from the filesystem and the live rows,
   * so this only ever sends the relative path it was shown. A refusal (a live
   * transfer owns the file, the folder still holds one, the path escapes the
   * root) is surfaced verbatim rather than retried.
   */
  async function confirmDelete() {
    const target = pendingDelete;
    if (!target) return;
    setDeleting(target.relativePath);
    try {
      const res = await fetch("/api/settings/untracked-files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ relativePath: target.relativePath }),
      });
      const data = ((await readJsonBody(res)) ?? {}) as {
        ok?: boolean;
        deleted?: { bytes: number; fileCount: number };
        usage?: StorageUsage;
        error?: string;
        message?: string;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.message || data.error || "Could not remove that entry");
      }
      setPendingDelete(null);
      if (data.usage) setUsage(data.usage);
      else await load();
      toast.success(
        `Removed ${target.label}, ${formatBytes(data.deleted?.bytes ?? target.bytes)} freed.`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(null);
    }
  }

  return (
    <section className="surface rounded-xl p-5 sm:p-6 space-y-5">
      <div className="flex items-start gap-3">
        <ShieldCheck className="h-5 w-5 text-brand-foreground shrink-0 mt-0.5" />
        <div>
          <h2 className="text-sm font-medium text-foreground">Storage cleanup</h2>
          <p className="text-xs text-subtle-foreground mt-1 leading-relaxed">
            Review storage use and remove temporary streams. Files you chose to
            keep are not removed here.
          </p>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-subtle-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading storage details…
        </div>
      ) : (
        <>
          {showPolicy ? (
          <ToggleGroup
            type="single"
            aria-label="Storage cleanup policy"
            value={policy}
            disabled={saving !== null}
            onValueChange={(value) => {
              if (value) void save(value as RetentionPolicy);
            }}
            className="grid w-full grid-cols-1 sm:grid-cols-2"
          >
            {RETENTION_OPTIONS.map((option) => (
              <ToggleGroupItem
                key={option.value}
                value={option.value}
                className="block h-auto min-h-[44px] w-full rounded-lg bg-muted px-3 py-2.5 text-left text-sm font-normal whitespace-normal text-muted-foreground ring-1 ring-border hover:bg-muted hover:text-foreground disabled:opacity-40 data-[state=on]:bg-brand-dim data-[state=on]:text-brand-foreground data-[state=on]:ring-brand/35 lg:min-h-0"
              >
                <span className="flex items-center gap-1.5 font-medium">
                  {saving === option.value ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : null}
                  {option.label}
                </span>
                <span className="mt-1 block text-xs leading-relaxed text-subtle-foreground">
                  {option.hint}
                </span>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          ) : null}
 
          {showPolicy && !persisted ? (
            <p className="text-xs text-warning leading-relaxed">
              The app needs the pending database migration before this default can be saved persistently.
            </p>
          ) : null}

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Button
              type="button"
              variant="secondary"
              className="h-auto whitespace-normal py-2 text-center max-md:min-h-11 pointer-coarse:min-h-11"
              disabled={sweeping !== null || usage?.budgetBytes == null}
              onClick={() => void runSweep("preview")}
            >
              {sweeping === "preview" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Preview files that can be removed
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="h-auto whitespace-normal py-2 text-center max-md:min-h-11 pointer-coarse:min-h-11"
              disabled={sweeping !== null || usage?.budgetBytes == null}
              onClick={() => void runSweep("delete")}
            >
              {sweeping === "delete" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Delete temporary streams now
            </Button>
          </div>

          {usage?.budgetBytes == null ? (
            <p className="text-xs leading-relaxed text-warning">
              Set a storage cap in Downloads before cache reclamation can run.
            </p>
          ) : null}

          {sweepResult ? (
            <div className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground space-y-2">
              <p>
                {sweepResult.mode === "preview" ? "Would reclaim" : "Reclaimed"}{" "}
                <span className="font-medium text-foreground">
                  {formatBytes(sweepResult.reclaimedBytes)}
                </span>
                {" from "}
                {(sweepResult.mode === "preview"
                  ? sweepResult.wouldDelete
                  : sweepResult.deleted
                ).length}{" "}
                item(s). {sweepResult.satisfied ? "Budget satisfied." : "Budget still exceeded."}
              </p>
              {sweepResult.skipped.length ? (
                <p className="text-subtle-foreground">
                  Skipped {sweepResult.skipped.length}: {sweepResult.skipped.slice(0, 3).map((s) => s.reason).join(", ")}
                </p>
              ) : null}
            </div>
          ) : null}

          {usage ? (
            <div className="rounded-lg border border-border bg-muted/40 p-3 space-y-3">
              {usage.disk && !usage.disk.authoritative ? (
                <div
                  role="status"
                  className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs leading-relaxed text-muted-foreground"
                >
                  Download-folder usage is unavailable because the scan was
                  incomplete. Check folder access and try again.
                </div>
              ) : usage.diskBytes != null && usage.disk ? (
                <div className="space-y-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <span className="text-xs text-subtle-foreground">
                      Download folder on disk
                    </span>
                    <span className="text-sm font-medium text-foreground">
                      {formatBytes(usage.diskBytes)}
                    </span>
                  </div>
                  {/* The identity the cap is enforced on, spelled out. The exact
                      byte count is what makes it checkable against Explorer,
                      whose "GB" is binary while this app's is decimal. */}
                  <p className="text-xs leading-relaxed text-subtle-foreground">
                    {formatBytes(usage.disk.trackedBytes)} tracked by transfers ·{" "}
                    <span
                      className={
                        usage.orphanBytes > 0
                          ? "text-warning"
                          : undefined
                      }
                    >
                      {formatBytes(usage.orphanBytes)} untracked
                    </span>{" "}
                    · {formatBytes(usage.disk.internalBytes)} TorrentFlow files ={" "}
                    {formatExactBytes(usage.diskBytes)}
                  </p>
                </div>
              ) : null}
              <div className="grid grid-cols-2 gap-2 text-xs">
                <UsageStat label="Temporary streams" value={formatBytes(usage.ephemeralBytes)} />
                <UsageStat label="Kept downloads" value={formatBytes(usage.keptBytes)} />
                <UsageStat label="Unclassified" value={formatBytes(usage.indeterminateBytes)} />
                <UsageStat label="Temporary file limit" value={formatBytes(usage.budgetBytes)} />
              </div>
              {topItems.length ? (
                <ul className="space-y-1.5">
                  {topItems.map((item) => (
                    <li key={item.hash} className="flex items-center justify-between gap-3 text-xs">
                      <span className="min-w-0 truncate text-muted-foreground">{item.name}</span>
                      <span className="shrink-0 text-subtle-foreground">
                        {retentionLabel(item.retentionPolicy)} · {formatBytes(item.sizeBytes)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          <UntrackedFiles
            usage={usage}
            deleting={deleting}
            revealing={revealing}
            onReveal={(target, key) => void reveal(target, key)}
            onRequestDelete={setPendingDelete}
          />
        </>
      )}

      {loadError ? (
        <p role="alert" className="text-xs leading-relaxed text-destructive">
          {loadError}
        </p>
      ) : null}

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open && deleting === null) setPendingDelete(null);
        }}
      >
        <AlertDialogContent data-untracked-delete-dialog>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete this untracked {pendingDelete?.kind ?? "file"}?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p className="break-all font-medium text-foreground">
                  {pendingDelete?.label}
                </p>
                <p>
                  {formatBytes(pendingDelete?.bytes ?? 0)}
                  {pendingDelete && pendingDelete.fileCount > 1
                    ? ` across ${pendingDelete.fileCount} files`
                    : ""}{" "}
                  will be removed from your download folder. This deletes the
                  files on disk and cannot be undone.
                </p>
                <p className="text-subtle-foreground">
                  TorrentFlow re-checks on the server that no live transfer owns
                  this before removing anything.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting !== null}>Cancel</AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              className="max-md:min-h-11 pointer-coarse:min-h-11"
              disabled={deleting !== null}
              onClick={() => void confirmDelete()}
              data-untracked-delete-confirm
            >
              {deleting !== null ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 />
              )}
              Delete from disk
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function UsageStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-card px-3 py-2 ring-1 ring-border">
      <div className="flex items-center gap-1.5 text-subtle-foreground">
        <HardDrive className="h-3.5 w-3.5" />
        {label}
      </div>
      <div className="mt-1 font-medium text-foreground">{value}</div>
    </div>
  );
}

/**
 * The bytes under the download folder that nothing in the app accounts for.
 *
 * The owner said *"i cna't even see these on my downloads"* while the folder
 * held 40.42 GB and the Client page listed zero transfers. Everything here
 * exists to answer that literally: name each untracked release, size it, let
 * them look at it in Explorer, and let them remove exactly one at a time.
 *
 * There is deliberately no bulk "clean up" control. The whole complaint was
 * about bytes disappearing without the owner's say-so; the fix is not a bigger
 * button that does more of it.
 */
function UntrackedFiles({
  usage,
  deleting,
  revealing,
  onReveal,
  onRequestDelete,
}: {
  usage: StorageUsage | null;
  deleting: string | null;
  revealing: string | null;
  onReveal: (target: string, key: string) => void;
  onRequestDelete: (target: PendingOrphanDelete) => void;
}) {
  const displayPath = useDisplayPath();
  // No download folder configured yet — the setup path already says so above,
  // and inventing an "untracked" section for a folder that does not exist would
  // be a control with nothing behind it.
  if (!usage || usage.diskBytes == null || !usage.disk) return null;

  const scan = usage.disk;
  const groups = usage.orphans;
  const busy = deleting !== null;

  return (
    <div className="rounded-lg border border-border bg-muted/40 p-3 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <h3 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <FileWarning className="h-3.5 w-3.5" />
          Untracked files
        </h3>
        <span className="text-xs text-subtle-foreground">
          {groups.length
            ? `${formatBytes(usage.orphanBytes)} · ${scan.orphanFileCount} file${
                scan.orphanFileCount === 1 ? "" : "s"
              }`
            : "None"}
        </span>
      </div>

      {scan.truncated ? (
        <p className="flex items-start gap-1.5 text-xs leading-relaxed text-warning">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            The folder is deeper or larger than one scan covers
            {scan.truncatedBy.length
              ? ` (stopped on ${scan.truncatedBy.join(" and ")})`
              : ""}
            , so these totals are a floor, not the whole picture. Remove what is
            listed and re-open this page to see the rest.
          </span>
        </p>
      ) : null}

      {scan.unreadablePaths.length ? (
        <p className="flex items-start gap-1.5 text-xs leading-relaxed text-warning">
          <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {scan.unreadablePaths.length} location
            {scan.unreadablePaths.length === 1 ? "" : "s"} could not be read, so
            anything inside is not counted, starting with{" "}
            <span className="break-all text-muted-foreground">
              {scan.unreadablePaths[0]}
            </span>
            .
          </span>
        </p>
      ) : null}

      {groups.length === 0 ? (
        <p className="flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
          <span>
            Every one of the {formatBytes(usage.diskBytes)} in{" "}
            <span className="break-all text-subtle-foreground">{displayPath(scan.root)}</span>{" "}
            is accounted for by a transfer or by TorrentFlow itself. Nothing here
            is holding space you cannot explain.
          </span>
        </p>
      ) : (
        <>
          <p className="text-xs leading-relaxed text-subtle-foreground">
            These sit under your download folder and count against the storage
            cap, but no live transfer owns them. Removing one deletes it from
            disk.
          </p>
          <ul className="space-y-2">
            {groups.map((group) => (
              <UntrackedGroupRow
                key={group.relativePath || "__loose__"}
                group={group}
                busy={busy}
                deleting={deleting}
                revealing={revealing}
                onReveal={onReveal}
                onRequestDelete={onRequestDelete}
              />
            ))}
          </ul>
          {scan.groupsTruncated ? (
            <p className="text-xs text-subtle-foreground">
              Showing the largest {groups.length}. Remove some and re-open this
              page to see the rest.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

function UntrackedGroupRow({
  group,
  busy,
  deleting,
  revealing,
  onReveal,
  onRequestDelete,
}: {
  group: OrphanGroup;
  busy: boolean;
  deleting: string | null;
  revealing: string | null;
  onReveal: (target: string, key: string) => void;
  onRequestDelete: (target: PendingOrphanDelete) => void;
}) {
  const { openFolder } = useFeatures();
  const key = group.relativePath || "__loose__";
  const title = group.loose
    ? "Loose files in the download folder"
    : group.name || group.relativePath;
  // A folder that still holds a live transfer's file is not a safe single
  // delete, and neither is the download root itself. Those expose their files
  // one row at a time instead of one folder button.
  const perFile = !group.folderDeletable;

  return (
    <li className="rounded-lg border border-border bg-card px-3 py-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="truncate text-xs font-medium text-foreground" title={title}>
            {title}
          </p>
          <p className="mt-0.5 text-xs text-subtle-foreground">
            {formatBytes(group.bytes)} · {group.fileCount} file
            {group.fileCount === 1 ? "" : "s"}
            {group.loose ? "" : ` · ${group.relativePath}`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="max-md:min-h-11 pointer-coarse:min-h-11"
            disabled={!openFolder || revealing === key}
            onClick={() => onReveal(group.path, key)}
          >
            {revealing === key ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <FolderOpen />
            )}
            Show
          </Button>
          {perFile ? null : (
            <Button
              type="button"
              variant="destructive"
              size="sm"
              className="max-md:min-h-11 pointer-coarse:min-h-11"
              disabled={busy}
              onClick={() =>
                onRequestDelete({
                  relativePath: group.relativePath,
                  label: title,
                  bytes: group.bytes,
                  fileCount: group.fileCount,
                  kind: "folder",
                })
              }
            >
              {deleting === group.relativePath ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 />
              )}
              Delete
            </Button>
          )}
        </div>
      </div>

      {perFile ? (
        <ul className="mt-2 space-y-1 border-t border-border pt-2">
          {group.files.map((file) => (
            <li
              key={file.relativePath}
              className="flex flex-wrap items-center justify-between gap-2"
            >
              <span
                className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
                title={file.relativePath}
              >
                {file.name}
              </span>
              <span className="shrink-0 text-xs text-subtle-foreground">
                {formatBytes(file.bytes)}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="min-h-[44px] shrink-0 text-destructive hover:text-destructive lg:min-h-0"
                disabled={busy}
                onClick={() =>
                  onRequestDelete({
                    relativePath: file.relativePath,
                    label: file.name,
                    bytes: file.bytes,
                    fileCount: 1,
                    kind: "file",
                  })
                }
              >
                {deleting === file.relativePath ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Trash2 />
                )}
                Delete
              </Button>
            </li>
          ))}
          {group.filesTruncated ? (
            <li className="text-xs text-subtle-foreground">
              Showing the largest {group.files.length} of {group.fileCount}.
            </li>
          ) : null}
          {!group.loose ? (
            <li className="text-xs leading-relaxed text-subtle-foreground">
              This folder still holds files a live transfer owns, so it can only
              be cleared one file at a time.
            </li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
}
