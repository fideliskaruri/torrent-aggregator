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

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(1)} TB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${Math.round(bytes)} B`;
}

export function RetentionPanel() {
  const [policy, setPolicy] = useState<RetentionPolicy>("EPHEMERAL");
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [persisted, setPersisted] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<RetentionPolicy | null>(null);
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

  const topItems = useMemo(() => usage?.items.slice(0, 5) ?? [], [usage]);

  return (
    <section className="surface rounded-xl p-5 sm:p-6 space-y-5">
      <div className="flex items-start gap-3">
        <ShieldCheck className="h-5 w-5 text-[var(--accent-text)] shrink-0 mt-0.5" />
        <div>
          <h2 className="text-sm font-medium text-[var(--text)]">Retention</h2>
          <p className="text-xs text-[var(--text-tertiary)] mt-1 leading-relaxed">
            Stream-only is the default. Tracked, watchlisted, or explicitly kept releases are permanent.
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
          <div className="grid grid-cols-2 gap-2">
            {([
              ["EPHEMERAL", "Stream-only"],
              ["KEPT", "Keep everything"],
            ] as const).map(([value, label]) => (
              <Button
                key={value}
                type="button"
                variant={policy === value ? "default" : "secondary"}
                disabled={saving !== null}
                onClick={() => void save(value)}
              >
                {saving === value ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {label}
              </Button>
            ))}
          </div>

          {!persisted ? (
            <p className="text-[11px] text-[var(--warning)] leading-relaxed">
              The app needs the pending database migration before this default can be saved persistently.
            </p>
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
                        {item.retentionPolicy.toLowerCase()} · {formatBytes(item.sizeBytes)}
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
