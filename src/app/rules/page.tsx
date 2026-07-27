"use client";

import { FormEvent, useState } from "react";
import { toast } from "sonner";
import { Loader2, Play, Plus, Trash2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { TfPageHeader } from "@/components/tf/page-header";
import { TfEmptyState } from "@/components/tf/empty-state";
import { TfErrorState } from "@/components/tf/error-state";
import { useApiQuery } from "@/hooks/use-api-query";

interface Rule {
  id: string;
  name: string;
  query: string;
  category: string;
  minSeeders: number;
  resolution: string | null;
  enabled: boolean;
  lastRunAt: string | null;
  lastMatchTitle: string | null;
  matchCount: number;
}

const selectClass =
  "flex h-9 w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-1 text-sm text-[var(--text)] shadow-sm transition-colors focus-visible:outline-none focus-visible:border-[var(--primary)] focus-visible:ring-2 focus-visible:ring-[var(--accent-dim)] disabled:cursor-not-allowed disabled:opacity-50";

export default function RulesPage() {
  const {
    data: rulesData,
    loading,
    error,
    refetch: load,
  } = useApiQuery<Rule[]>("/api/rules", {
    select: (json) => (json as { rules?: Rule[] }).rules ?? [],
  });
  const rules = rulesData ?? [];
  const [running, setRunning] = useState(false);
  const [runLog, setRunLog] = useState<string | null>(null);
  const [pendingRemove, setPendingRemove] = useState<Rule | null>(null);
  const [removing, setRemoving] = useState(false);
  const [form, setForm] = useState({
    name: "",
    query: "",
    category: "all",
    minSeeders: "10",
    resolution: "",
  });

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    try {
      const res = await fetch("/api/rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          query: form.query,
          category: form.category,
          minSeeders: parseInt(form.minSeeders, 10) || 10,
          resolution: form.resolution || null,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || "Could not create rule");
        return;
      }
      setForm({
        name: "",
        query: "",
        category: "all",
        minSeeders: "10",
        resolution: "",
      });
      toast.success("Rule created");
      void load();
    } catch {
      toast.error("Network error");
    }
  }

  async function toggle(id: string, enabled: boolean) {
    await fetch("/api/rules", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, enabled }),
    });
    void load();
  }

  async function confirmRemove() {
    if (!pendingRemove) return;
    setRemoving(true);
    try {
      await fetch(`/api/rules?id=${encodeURIComponent(pendingRemove.id)}`, {
        method: "DELETE",
      });
      setPendingRemove(null);
      toast.success("Rule deleted");
      void load();
    } catch {
      toast.error("Could not delete rule");
    } finally {
      setRemoving(false);
    }
  }

  async function runAll() {
    setRunning(true);
    setRunLog(null);
    try {
      const res = await fetch("/api/rules/run", { method: "POST" });
      const data = await res.json().catch(() => ({
        ok: false,
        message: "Empty response from server",
        summary: [],
      }));
      const lines = (data.summary ?? [])
        .map(
          (s: { message: string; title?: string; status?: string }) =>
            `${s.status ? `[${s.status}] ` : ""}${s.title ? s.title + " — " : ""}${s.message}`,
        )
        .join("\n");
      setRunLog(lines || data.message || "No rules ran");
      if (res.ok && data.ok !== false) {
        if (data.offline) {
          toast.warning(data.message || "Client offline during rules run");
        } else {
          toast.success(data.message || "Rules run complete");
        }
      } else if (data.offline || res.status === 503) {
        toast.warning(data.message || "Torrent client offline");
      } else {
        toast.error(data.message || data.error || "Failed to run rules");
      }
      void load();
    } catch {
      toast.error("Network error running rules");
    } finally {
      setRunning(false);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center gap-2 text-[var(--text-tertiary)]">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }


  return (
    <div className="container-app max-w-3xl py-6 sm:py-8 space-y-5 min-w-0">
      <TfPageHeader
        title="Auto-download rules"
        description="When a match appears with enough seeders, send it to your client."
        actions={
          <Button
            type="button"
            size="sm"
            onClick={() => void runAll()}
            disabled={running || !rules.length}
          >
            {running ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            Run now
          </Button>
        }
      />

      <form onSubmit={onCreate} className="surface p-4 sm:p-5 space-y-3">
        <p className="text-sm font-medium text-[var(--text)] flex items-center gap-2">
          <Plus className="h-4 w-4 text-[var(--text-tertiary)]" />
          New rule
        </p>
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Rule name" htmlFor="rule-name">
            <Input
              id="rule-name"
              placeholder="Weekly anime"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              required
            />
          </Field>
          <Field
            label="Search query"
            htmlFor="rule-query"
            hint="Run against every enabled indexer"
          >
            <Input
              id="rule-query"
              placeholder="one piece 1080p"
              value={form.query}
              onChange={(e) => setForm((f) => ({ ...f, query: e.target.value }))}
              required
            />
          </Field>
          <Field label="Category" htmlFor="rule-category">
            <select
              id="rule-category"
              className={selectClass}
              value={form.category}
              onChange={(e) =>
                setForm((f) => ({ ...f, category: e.target.value }))
              }
            >
              {["all", "anime", "movies", "tv", "music", "games"].map((c) => (
                <option key={c} value={c} className="bg-[var(--bg-elevated)]">
                  {c}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Min seeders"
            htmlFor="rule-min-seeders"
            hint="Skip releases with fewer"
          >
            <Input
              id="rule-min-seeders"
              inputMode="numeric"
              placeholder="10"
              value={form.minSeeders}
              onChange={(e) =>
                setForm((f) => ({ ...f, minSeeders: e.target.value }))
              }
            />
          </Field>
          <Field label="Resolution" htmlFor="rule-resolution">
            <select
              id="rule-resolution"
              className={selectClass}
              value={form.resolution}
              onChange={(e) =>
                setForm((f) => ({ ...f, resolution: e.target.value }))
              }
            >
              <option value="" className="bg-[var(--bg-elevated)]">
                Any resolution
              </option>
              <option value="1080p" className="bg-[var(--bg-elevated)]">
                1080p
              </option>
              <option value="720p" className="bg-[var(--bg-elevated)]">
                720p
              </option>
              <option value="2160p" className="bg-[var(--bg-elevated)]">
                2160p
              </option>
            </select>
          </Field>
        </div>
        <Button type="submit" size="sm">
          Create rule
        </Button>
      </form>

      {runLog ? (
        <pre className="surface p-4 text-xs text-[var(--text-secondary)] whitespace-pre-wrap font-mono">
          {runLog}
        </pre>
      ) : null}

      <div className="space-y-2">
        {rules.map((rule) => (
          <div
            key={rule.id}
            className="surface p-4 flex flex-wrap items-start gap-3"
          >
            <div className="flex-1 min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-medium text-[var(--text)]">{rule.name}</p>
                <Badge variant={rule.enabled ? "accent" : "secondary"}>
                  {rule.enabled ? "Enabled" : "Disabled"}
                </Badge>
              </div>
              <p className="text-xs text-[var(--text-tertiary)]">
                “{rule.query}” · {rule.category} · ≥{rule.minSeeders} seeders
                {rule.resolution ? ` · ${rule.resolution}` : ""}
              </p>
              {rule.lastMatchTitle ? (
                <p className="text-xs text-[var(--accent-text)] line-clamp-1">
                  Last match: {rule.lastMatchTitle}
                </p>
              ) : null}
              <p className="text-[11px] text-[var(--text-tertiary)]">
                {rule.matchCount} sends
                {rule.lastRunAt
                  ? ` · last run ${new Date(rule.lastRunAt).toLocaleString()}`
                  : ""}
              </p>
            </div>
            <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)] cursor-pointer select-none">
              <Checkbox
                checked={rule.enabled}
                onCheckedChange={(checked) =>
                  void toggle(rule.id, checked === true)
                }
              />
              Enabled
            </label>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => setPendingRemove(rule)}
              aria-label="Delete rule"
              className="text-[var(--text-tertiary)] hover:text-[var(--danger)]"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
        {error ? (
          <TfErrorState
            title="Could not load rules"
            message={error}
            onRetry={load}
          />
        ) : !rules.length ? (
          <TfEmptyState
            icon={Zap}
            title="No rules yet"
            description="Create a rule above to auto-send matching releases."
          />
        ) : null}
      </div>

      <AlertDialog
        open={Boolean(pendingRemove)}
        onOpenChange={(open) => {
          if (!open) setPendingRemove(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete rule?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingRemove
                ? `“${pendingRemove.name}” will stop matching releases. Past sends stay in Activity.`
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removing}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void confirmRemove();
              }}
              disabled={removing}
              className="bg-[var(--destructive)] text-white hover:bg-[#e85d66]"
            >
              {removing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : null}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
