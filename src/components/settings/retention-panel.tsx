"use client";

import { useEffect, useMemo, useState } from "react";
import { HardDrive, Loader2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";

export type RetentionPolicy = "EPHEMERAL" | "KEPT";

interface StorageUsage {
  totalBytes: number;
  ephemeralBytes: number;
  keptBytes: number;
  indeterminateBytes: number;
  budgetBytes: number;
  graceMs: number;
  items: Array<{
    hash: string;
    name: string;
    retentionPolicy: RetentionPolicy | "INDETERMINATE";
    sizeBytes: number;
    progress: number;
    status: string;
  }>;
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

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(1)} TB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${Math.round(bytes)} B`;
}

function retentionLabel(policy: RetentionPolicy | "INDETERMINATE"): string {
  if (policy === "EPHEMERAL") return "stream cache";
  if (policy === "KEPT") return "kept";
  return "unknown";
}

export function RetentionPanel() {
  const [policy, setPolicy] = useState<RetentionPolicy>("EPHEMERAL");
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [persisted, setPersisted] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<RetentionPolicy | null>(null);
  const [sweeping, setSweeping] = useState<"preview" | "delete" | null>(null);
  const [sweepResult, setSweepResult] = useState<SweepResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/client");
      const data = (await res.json()) as {
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
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function save(next: RetentionPolicy) {
    setSaving(next);
    setError(null);
    try {
      const res = await fetch("/api/settings/client", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultRetentionPolicy: next }),
      });
      const data = (await res.json()) as {
        settings?: {
          defaultRetentionPolicy?: RetentionPolicy;
          defaultRetentionPolicyPersisted?: boolean;
          storageUsage?: StorageUsage | null;
        };
        error?: string;
        message?: string;
        retentionWarning?: string | null;
      };
      if (!res.ok) throw new Error(data.message || data.error || "Could not save retention setting");
      setPolicy(data.settings?.defaultRetentionPolicy ?? next);
      setPersisted(data.settings?.defaultRetentionPolicyPersisted !== false);
      setUsage(data.settings?.storageUsage ?? null);
      if (data.retentionWarning) setError(data.retentionWarning);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(null);
    }
  }

  async function runSweep(mode: "preview" | "delete") {
    if (
      mode === "delete" &&
      !window.confirm(
        "Delete reclaimable stream-only files now? Kept, tracked, watchlisted, active, downloading, and unknown items are skipped.",
      )
    ) {
      return;
    }
    setSweeping(mode);
    setError(null);
    try {
      const res = await fetch("/api/settings/retention-sweep", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      const data = (await res.json()) as {
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
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSweeping(null);
    }
  }

  const topItems = useMemo(() => usage?.items.slice(0, 5) ?? [], [usage]);

  return (
    <section className="surface rounded-xl p-5 sm:p-6 space-y-5">
      <div className="flex items-start gap-3">
        <ShieldCheck className="h-5 w-5 text-[var(--accent-text)] shrink-0 mt-0.5" />
        <div>
          <h2 className="text-sm font-medium text-[var(--text)]">Retention</h2>
          <p className="text-xs text-[var(--text-tertiary)] mt-1 leading-relaxed">
            Streamed files can be treated like a cache. Tracked, watchlisted,
            or explicitly kept releases stay permanent.
          </p>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-[var(--text-tertiary)]">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading retention usage…
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {RETENTION_OPTIONS.map((option) => (
              <button
                type="button"
                key={option.value}
                aria-pressed={policy === option.value}
                disabled={saving !== null}
                onClick={() => void save(option.value)}
                className={`rounded-lg px-3 py-2.5 text-left text-sm transition-colors ring-1 disabled:opacity-40 ${
                  policy === option.value
                    ? "bg-[var(--accent-dim)] text-[var(--accent-text)] ring-[var(--accent-ring)]"
                    : "bg-[var(--bg-muted)] text-[var(--text-secondary)] ring-[var(--border)] hover:text-[var(--text)]"
                }`}
              >
                <span className="flex items-center gap-1.5 font-medium">
                  {saving === option.value ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : null}
                  {option.label}
                </span>
                <span className="mt-1 block text-[11px] leading-relaxed text-[var(--text-tertiary)]">
                  {option.hint}
                </span>
              </button>
            ))}
          </div>
 
          {!persisted ? (
            <p className="text-[11px] text-[var(--warning)] leading-relaxed">
              The app needs the pending database migration before this default can be saved persistently.
            </p>
          ) : null}

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Button
              type="button"
              variant="secondary"
              className="h-auto min-h-9 whitespace-normal py-2 text-center"
              disabled={sweeping !== null}
              onClick={() => void runSweep("preview")}
            >
              {sweeping === "preview" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Preview reclaimable files
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="h-auto min-h-9 whitespace-normal py-2 text-center"
              disabled={sweeping !== null}
              onClick={() => void runSweep("delete")}
            >
              {sweeping === "delete" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Delete reclaimable stream-only files
            </Button>
          </div>

          {sweepResult ? (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-muted)]/40 p-3 text-xs text-[var(--text-secondary)] space-y-2">
              <p>
                {sweepResult.mode === "preview" ? "Would reclaim" : "Reclaimed"}{" "}
                <span className="font-medium text-[var(--text)]">
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
                <p className="text-[var(--text-tertiary)]">
                  Skipped {sweepResult.skipped.length}: {sweepResult.skipped.slice(0, 3).map((s) => s.reason).join(", ")}
                </p>
              ) : null}
            </div>
          ) : null}

          {usage ? (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-muted)]/40 p-3 space-y-3">
              <div className="grid grid-cols-2 gap-2 text-xs">
                <UsageStat label="Stream cache" value={formatBytes(usage.ephemeralBytes)} />
                <UsageStat label="Kept" value={formatBytes(usage.keptBytes)} />
                <UsageStat label="Unknown" value={formatBytes(usage.indeterminateBytes)} />
                <UsageStat label="Cache budget" value={formatBytes(usage.budgetBytes)} />
              </div>
              {topItems.length ? (
                <ul className="space-y-1.5">
                  {topItems.map((item) => (
                    <li key={item.hash} className="flex items-center justify-between gap-3 text-xs">
                      <span className="min-w-0 truncate text-[var(--text-secondary)]">{item.name}</span>
                      <span className="shrink-0 text-[var(--text-tertiary)]">
                        {retentionLabel(item.retentionPolicy)} · {formatBytes(item.sizeBytes)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </>
      )}

      {error ? <p className="text-xs text-[var(--danger)]">{error}</p> : null}
    </section>
  );
}

function UsageStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-[var(--bg-elevated)] px-3 py-2 ring-1 ring-[var(--border)]">
      <div className="flex items-center gap-1.5 text-[var(--text-tertiary)]">
        <HardDrive className="h-3.5 w-3.5" />
        {label}
      </div>
      <div className="mt-1 font-medium text-[var(--text)]">{value}</div>
    </div>
  );
}
