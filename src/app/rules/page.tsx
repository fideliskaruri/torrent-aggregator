"use client";

import { FormEvent, useState } from "react";
import { toast } from "sonner";
import { Play, Plus, Trash2, Zap } from "lucide-react";
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
import {
  LoadingGlyph,
  PageSkeletonFrame,
  SkeletonBlock,
} from "@/components/ui/loading";
import { useStableLoading } from "@/components/ui/use-stable-loading";
import { cn } from "@/lib/utils";
import {
  buildRuleCreatePayload,
  buildRuleFilterPayload,
  bytesToMaxSizeGbInput,
  parseRuleSources,
  RULE_SOURCE_OPTIONS,
  type RuleFilterFormState,
  type RuleFormState,
} from "@/lib/rules/form";

interface Rule {
  id: string;
  name: string;
  query: string;
  category: string;
  minSeeders: number;
  maxSizeBytes: number | null;
  resolution: string | null;
  sources: string | null;
  enabled: boolean;
  lastRunAt: string | null;
  lastMatchTitle: string | null;
  matchCount: number;
}

const selectClass =
  "flex h-11 lg:h-9 w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-1 text-sm text-[var(--text)] shadow-sm transition-colors focus-visible:outline-none focus-visible:border-[var(--primary)] focus-visible:ring-2 focus-visible:ring-[var(--accent-dim)] disabled:cursor-not-allowed disabled:opacity-50";

export const RULE_CATEGORY_OPTIONS = [
  { value: "all", label: "All video" },
  { value: "anime", label: "Anime" },
  { value: "movies", label: "Movies" },
  { value: "tv", label: "TV" },
] as const;

type RuleCategoryValue = (typeof RULE_CATEGORY_OPTIONS)[number]["value"];

const RULE_CATEGORY_VALUES = new Set<string>(
  RULE_CATEGORY_OPTIONS.map((option) => option.value),
);

export function normalizeRuleCategory(
  category: string | null | undefined,
): RuleCategoryValue {
  return RULE_CATEGORY_VALUES.has(category ?? "")
    ? (category as RuleCategoryValue)
    : "all";
}

export function describeRuleCategory(category: string | null | undefined) {
  const option = RULE_CATEGORY_OPTIONS.find((entry) => entry.value === category);
  if (!option) {
    const stored = category?.trim() || "unknown";
    return {
      supported: false,
      value: normalizeRuleCategory(category),
      label: `Unsupported: ${stored}`,
      stored,
    };
  }
  return {
    supported: true,
    value: option.value,
    label: option.label,
    stored: option.value,
  };
}

export function buildRuleTogglePayload(
  id: string,
  enabled: boolean,
  _storedCategory?: string | null,
) {
  return { id, enabled };
}

export function buildRuleRetargetPayload(
  id: string,
  category: string | null | undefined,
) {
  return { id, category: normalizeRuleCategory(category) };
}

export default function RulesPage() {
  const {
    data: rulesData,
    loading,
    error,
    refetch: load,
  } = useApiQuery<Rule[]>("/api/rules", {
    select: (json) => (json as { rules?: Rule[] }).rules ?? [],
  });
  const showLoading = useStableLoading(loading && rulesData == null && !error);
  const rules = rulesData ?? [];
  const [running, setRunning] = useState(false);
  const [runLog, setRunLog] = useState<string | null>(null);
  const [pendingRemove, setPendingRemove] = useState<Rule | null>(null);
  const [removing, setRemoving] = useState(false);
  const [retargeting, setRetargeting] = useState<string | null>(null);
  const [retargetCategories, setRetargetCategories] = useState<
    Record<string, RuleCategoryValue>
  >({});
  const [filterEditRuleId, setFilterEditRuleId] = useState<string | null>(null);
  const [filterEdits, setFilterEdits] = useState<
    Record<string, RuleFilterFormState>
  >({});
  const [savingFilters, setSavingFilters] = useState<string | null>(null);
  const [form, setForm] = useState<RuleFormState>({
    name: "",
    query: "",
    category: "all",
    minSeeders: "10",
    resolution: "",
    sources: [],
    maxSizeGb: "",
  });
  const hasUnsupportedRules = rules.some(
    (rule) => !describeRuleCategory(rule.category).supported,
  );

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    try {
      const res = await fetch("/api/rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildRuleCreatePayload(form)),
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
        sources: [],
        maxSizeGb: "",
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
      body: JSON.stringify(buildRuleTogglePayload(id, enabled)),
    });
    void load();
  }

  async function retarget(rule: Rule) {
    const nextCategory =
      retargetCategories[rule.id] ?? normalizeRuleCategory(rule.category);
    setRetargeting(rule.id);
    try {
      const res = await fetch("/api/rules", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildRuleRetargetPayload(rule.id, nextCategory)),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || "Could not retarget rule");
        return;
      }
      setRetargetCategories((current) => {
        const next = { ...current };
        delete next[rule.id];
        return next;
      });
      toast.success("Rule retargeted");
      void load();
    } catch {
      toast.error("Network error");
    } finally {
      setRetargeting(null);
    }
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

  function toggleSource(source: string) {
    setForm((current) => ({
      ...current,
      sources: current.sources.includes(source)
        ? current.sources.filter((value) => value !== source)
        : [...current.sources, source],
    }));
  }

  function filtersForRule(rule: Rule): RuleFilterFormState {
    return (
      filterEdits[rule.id] ?? {
        sources: parseRuleSources(rule.sources),
        maxSizeGb: bytesToMaxSizeGbInput(rule.maxSizeBytes),
      }
    );
  }

  function openFilterEditor(rule: Rule) {
    if (filterEditRuleId === rule.id) {
      setFilterEditRuleId(null);
      return;
    }
    setFilterEdits((current) => ({
      ...current,
      [rule.id]: filtersForRule(rule),
    }));
    setFilterEditRuleId(rule.id);
  }

  function toggleRuleFilterSource(rule: Rule, source: string) {
    const current = filtersForRule(rule);
    setFilterEdits((edits) => ({
      ...edits,
      [rule.id]: {
        ...current,
        sources: current.sources.includes(source)
          ? current.sources.filter((value) => value !== source)
          : [...current.sources, source],
      },
    }));
  }

  async function saveRuleFilters(rule: Rule) {
    const filters = filtersForRule(rule);
    setSavingFilters(rule.id);
    try {
      const res = await fetch("/api/rules", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildRuleFilterPayload(rule.id, filters)),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || "Could not save filters");
        return;
      }
      setFilterEditRuleId(null);
      toast.success("Rule filters saved");
      void load();
    } catch {
      toast.error("Network error");
    } finally {
      setSavingFilters(null);
    }
  }

  async function runAll() {
    if (hasUnsupportedRules) {
      const blocked = rules
        .filter((rule) => !describeRuleCategory(rule.category).supported)
        .map((rule) => `• ${rule.name}: ${describeRuleCategory(rule.category).label}`)
        .join("\n");
      const message =
        "Retarget or delete unsupported legacy rules before running automation.";
      setRunLog(`${message}\n${blocked}`);
      toast.warning(message);
      return;
    }
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

  if (loading && rulesData == null && !error) {
    return <RulesSkeleton visible={showLoading} />;
  }


  return (
    <div className="container-app max-w-3xl py-6 sm:py-8 space-y-5 min-w-0">
      <TfPageHeader
        title="Auto-download rules"
        description="Automatically grab watchable video releases when they become healthy enough to play."
        actions={
          <Button
            type="button"
            size="sm"
            onClick={() => void runAll()}
            disabled={running || !rules.length}
            title={
              hasUnsupportedRules
                ? "Retarget or delete unsupported legacy rules before running"
                : undefined
            }
          >
            {running ? (
              <LoadingGlyph className="h-3.5 w-3.5" />
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
          <Field
            label="What to watch"
            htmlFor="rule-category"
            hint="Rules only grab video the app can browse and play."
          >
            <select
              id="rule-category"
              className={selectClass}
              value={form.category}
              onChange={(e) =>
                setForm((f) => ({ ...f, category: e.target.value }))
              }
            >
              {RULE_CATEGORY_OPTIONS.map((c) => (
                <option
                  key={c.value}
                  value={c.value}
                  className="bg-[var(--bg-elevated)]"
                >
                  {c.label}
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
          <Field
            label="Search only these indexers"
            htmlFor="rule-sources"
            hint="Leave all unselected to search every enabled source."
          >
            <div
              id="rule-sources"
              className="flex flex-wrap gap-2 rounded-md border border-[var(--border)] bg-[var(--bg)] p-2"
            >
              {RULE_SOURCE_OPTIONS.map((source) => {
                const active = form.sources.includes(source.value);
                return (
                  <button
                    key={source.value}
                    type="button"
                    aria-pressed={active}
                    onClick={() => toggleSource(source.value)}
                    className={`inline-flex items-center justify-center min-h-[44px] min-w-[44px] rounded-full px-2.5 py-1 text-xs ring-1 transition-colors lg:min-h-0 lg:min-w-0 ${
                      active
                        ? "bg-[var(--accent-dim)] text-[var(--accent-text)] ring-[var(--accent-ring)]"
                        : "bg-[var(--bg-muted)] text-[var(--text-secondary)] ring-[var(--border)] hover:text-[var(--text)]"
                    }`}
                  >
                    {source.label}
                  </button>
                );
              })}
            </div>
          </Field>
          <Field
            label="Skip releases larger than"
            htmlFor="rule-max-size-gb"
            hint="Optional. Leave blank to allow any size."
          >
            <div className="flex items-center gap-2">
              <Input
                id="rule-max-size-gb"
                inputMode="decimal"
                placeholder="Any size"
                value={form.maxSizeGb}
                onChange={(e) =>
                  setForm((f) => ({ ...f, maxSizeGb: e.target.value }))
                }
              />
              <span className="shrink-0 text-sm text-[var(--text-tertiary)]">
                GB
              </span>
            </div>
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
        {rules.map((rule) => {
          const category = describeRuleCategory(rule.category);
          const selectedRetarget =
            retargetCategories[rule.id] ?? normalizeRuleCategory(rule.category);
          const ruleSources = parseRuleSources(rule.sources);
          const sourceSummary = ruleSources.length
            ? RULE_SOURCE_OPTIONS.filter((source) =>
                ruleSources.includes(source.value),
              )
                .map((source) => source.label)
                .join(", ")
            : "All sources";
          const sizeSummary = bytesToMaxSizeGbInput(rule.maxSizeBytes);
          const filterEdit = filtersForRule(rule);
          return (
            <div
              key={rule.id}
              className="surface p-4 flex flex-wrap items-start gap-3"
            >
              <div className="flex-1 min-w-0 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium text-[var(--text)]">{rule.name}</p>
                  <Badge variant={rule.enabled ? "accent" : "secondary"}>
                    {rule.enabled ? "Enabled" : "Disabled"}
                  </Badge>
                  {!category.supported ? (
                    <Badge variant="secondary">Unsupported category</Badge>
                  ) : null}
                </div>
                <p className="text-xs text-[var(--text-tertiary)]">
                  “{rule.query}” · {category.label} · ≥{rule.minSeeders} seeders
                  {rule.resolution ? ` · ${rule.resolution}` : ""}
                  {ruleSources.length ? ` · ${sourceSummary}` : ""}
                  {sizeSummary ? ` · ≤${sizeSummary} GB` : ""}
                </p>
                <button
                  type="button"
                  onClick={() => openFilterEditor(rule)}
                  className="inline-flex items-center min-h-[44px] text-xs text-[var(--accent-text)] hover:underline lg:min-h-0"
                  aria-expanded={filterEditRuleId === rule.id}
                >
                  {filterEditRuleId === rule.id
                    ? "Hide filters"
                    : "Edit source and size filters"}
                </button>
                {filterEditRuleId === rule.id ? (
                  <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-muted)] p-3 text-xs text-[var(--text-secondary)] space-y-3">
                    <div className="space-y-1.5">
                      <p className="font-medium text-[var(--text)]">
                        Search only these indexers
                      </p>
                      <p className="text-[11px] text-[var(--text-tertiary)]">
                        Leave all unselected to search every enabled source.
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {RULE_SOURCE_OPTIONS.map((source) => {
                          const active = filterEdit.sources.includes(source.value);
                          return (
                            <button
                              key={source.value}
                              type="button"
                              aria-pressed={active}
                              onClick={() => toggleRuleFilterSource(rule, source.value)}
                              className={`inline-flex items-center justify-center min-h-[44px] min-w-[44px] rounded-full px-2.5 py-1 text-xs ring-1 transition-colors lg:min-h-0 lg:min-w-0 ${
                                active
                                  ? "bg-[var(--accent-dim)] text-[var(--accent-text)] ring-[var(--accent-ring)]"
                                  : "bg-[var(--bg-elevated)] text-[var(--text-secondary)] ring-[var(--border)] hover:text-[var(--text)]"
                              }`}
                            >
                              {source.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <label
                        htmlFor={`rule-${rule.id}-max-size`}
                        className="font-medium text-[var(--text)]"
                      >
                        Skip releases larger than
                      </label>
                      <div className="flex items-center gap-2">
                        <Input
                          id={`rule-${rule.id}-max-size`}
                          inputMode="decimal"
                          placeholder="Any size"
                          value={filterEdit.maxSizeGb}
                          onChange={(event) =>
                            setFilterEdits((edits) => ({
                              ...edits,
                              [rule.id]: {
                                ...filterEdit,
                                maxSizeGb: event.target.value,
                              },
                            }))
                          }
                        />
                        <span className="shrink-0 text-sm text-[var(--text-tertiary)]">
                          GB
                        </span>
                      </div>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      onClick={() => void saveRuleFilters(rule)}
                      disabled={savingFilters === rule.id}
                    >
                      {savingFilters === rule.id ? (
                        <LoadingGlyph className="h-3.5 w-3.5" />
                      ) : null}
                      Save filters
                    </Button>
                  </div>
                ) : null}
                {!category.supported ? (
                  <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-muted)] p-3 text-xs text-[var(--text-secondary)] space-y-2">
                    <p>
                      This legacy rule targets “{category.stored}”, which
                      TorrentFlow cannot browse or play. It is blocked from Run
                      now until you retarget it to video or delete it.
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      <select
                        className={selectClass}
                        value={selectedRetarget}
                        onChange={(event) =>
                          setRetargetCategories((current) => ({
                            ...current,
                            [rule.id]: normalizeRuleCategory(event.target.value),
                          }))
                        }
                        aria-label={`Retarget ${rule.name}`}
                      >
                        {RULE_CATEGORY_OPTIONS.map((option) => (
                          <option
                            key={option.value}
                            value={option.value}
                            className="bg-[var(--bg-elevated)]"
                          >
                            {option.label}
                          </option>
                        ))}
                      </select>
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        onClick={() => void retarget(rule)}
                        disabled={retargeting === rule.id}
                      >
                        {retargeting === rule.id ? (
                          <LoadingGlyph className="h-3.5 w-3.5" />
                        ) : null}
                        Retarget
                      </Button>
                    </div>
                  </div>
                ) : null}
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
                  disabled={!category.supported}
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
          );
        })}
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
                <LoadingGlyph className="h-3.5 w-3.5" />
              ) : null}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function RulesSkeleton({ visible = true }: { visible?: boolean }) {
  return (
    <PageSkeletonFrame
      aria-label="Loading rules"
      className={cn(
        "container-app max-w-3xl py-6 sm:py-8 space-y-5 min-w-0 transition-opacity duration-150",
        !visible && "opacity-0",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-2">
          <SkeletonBlock className="h-8 w-52" />
          <SkeletonBlock className="h-4 w-80 max-w-full" />
        </div>
        <SkeletonBlock className="h-8 w-24" />
      </div>
      <div className="surface space-y-3 p-4 sm:p-5">
        <SkeletonBlock className="h-4 w-24" />
        <div className="grid gap-3 sm:grid-cols-2">
          {Array.from({ length: 4 }, (_, i) => (
            <SkeletonBlock key={i} className="h-16 w-full" />
          ))}
        </div>
      </div>
      <div className="space-y-2">
        {Array.from({ length: 3 }, (_, i) => (
          <SkeletonBlock key={i} className="h-20 w-full" />
        ))}
      </div>
    </PageSkeletonFrame>
  );
}
