import { FormEvent, useCallback, useState } from "react";
import { send } from "@/lib/api";
import { toast } from "@/lib/toast";
import { Play, Plus, Trash2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/form-field";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ConfirmDialog } from "@/components/tf/confirm-dialog";
import { ConfirmAction } from "@/components/tf/confirm-action";
import { DataList } from "@/components/tf/data-list";
import { FilterBar, type FilterField } from "@/components/tf/filter-bar";
import { BulkBar } from "@/components/tf/bulk-bar";
import { StatusChip } from "@/components/tf/status-chip";
import { useSelection } from "@/components/tf/use-selection";
import { TfPageHeader } from "@/components/tf/page-header";
import { TfEmptyState } from "@/components/tf/empty-state";
import { PageQueryBoundary } from "@/components/tf/page-query-boundary";
import { useApiQuery } from "@/hooks/use-api-query";
import {
  LoadingGlyph,
  PageSkeletonFrame,
  SkeletonBlock,
} from "@/components/ui/loading";
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

const RULE_FILTERS: FilterField<Rule>[] = [
  { key: "name", label: "Search rules", kind: "search" },
];

const sourceChipClass =
  "h-auto min-h-11 max-w-full shrink rounded-full border border-border bg-muted px-2.5 py-1.5 text-xs font-normal leading-snug whitespace-normal break-words text-center text-muted-foreground hover:text-foreground data-[state=on]:border-brand/50 data-[state=on]:bg-brand-dim data-[state=on]:text-brand-foreground lg:min-h-7";

const RESOLUTION_ANY = "__any";

const RULE_RESOLUTION_OPTIONS = [
  { value: RESOLUTION_ANY, label: "Any resolution" },
  { value: "1080p", label: "1080p" },
  { value: "720p", label: "720p" },
  { value: "2160p", label: "2160p" },
] as const;

const RULE_CATEGORY_OPTIONS = [
  { value: "all", label: "All video" },
  { value: "anime", label: "Anime" },
  { value: "movies", label: "Movies" },
  { value: "tv", label: "TV" },
] as const;

type RuleCategoryValue = (typeof RULE_CATEGORY_OPTIONS)[number]["value"];

const RULE_CATEGORY_VALUES = new Set<string>(
  RULE_CATEGORY_OPTIONS.map((option) => option.value),
);

function normalizeRuleCategory(
  category: string | null | undefined,
): RuleCategoryValue {
  return RULE_CATEGORY_VALUES.has(category ?? "")
    ? (category as RuleCategoryValue)
    : "all";
}

function describeRuleCategory(category: string | null | undefined) {
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

function buildRuleTogglePayload(
  id: string,
  enabled: boolean,
  _storedCategory?: string | null,
) {
  void _storedCategory;
  return { id, enabled };
}

function buildRuleRetargetPayload(
  id: string,
  category: string | null | undefined,
) {
  return { id, category: normalizeRuleCategory(category) };
}

export default function RulesPage() {
  const rulesQuery = useApiQuery<Rule[]>("/api/rules", {
    select: (json) => (json as { rules?: Rule[] }).rules ?? [],
  });
  const { data: rulesData, refetch: load } = rulesQuery;
  const rules = rulesData ?? [];
  const [rulePredicate, setRulePredicate] = useState<(rule: Rule) => boolean>(() => () => true);
  const updateRulePredicate = useCallback((predicate: (rule: Rule) => boolean) => {
    setRulePredicate(() => predicate);
  }, []);
  const filteredRules = rules.filter(rulePredicate);
  const selection = useSelection(filteredRules, (rule) => rule.id);
  const [running, setRunning] = useState(false);
  const [runReviewOpen, setRunReviewOpen] = useState(false);
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
      const res = await send("/api/rules", {
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

  /**
   * Enable or disable a rule.
   *
   * The response is checked. Previously it was not: a 401, a 500 or a rejected
   * fetch all fell through to the same `load()`, which re-rendered the rule in
   * its unchanged state with no explanation — the toggle appeared to snap back
   * on its own.
   */
  async function toggle(id: string, enabled: boolean) {
    try {
      const res = await send("/api/rules", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildRuleTogglePayload(id, enabled)),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(
          data.error || (enabled ? "Could not enable rule" : "Could not disable rule"),
        );
        return;
      }
      void load();
    } catch {
      toast.error("Network error");
    }
  }

  async function retarget(rule: Rule) {
    const nextCategory =
      retargetCategories[rule.id] ?? normalizeRuleCategory(rule.category);
    setRetargeting(rule.id);
    try {
      const res = await send("/api/rules", {
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

  async function deleteRule(rule: Rule) {
    const res = await send(`/api/rules?id=${encodeURIComponent(rule.id)}`, { method: "DELETE" });
    if (!res.ok) throw new Error(res.error?.message ?? "Could not delete rule");
  }

  async function deleteSelectedRules() {
    const count = selection.selected.length;
    const results = await Promise.all(selection.selected.map(async (rule) => {
      try {
        await deleteRule(rule);
        return true;
      } catch {
        return false;
      }
    }));
    const failures = results.filter((ok) => !ok).length;
    selection.clear();
    void load();
    if (failures) throw new Error(`Could not delete ${failures} of ${count} rules. The list has been refreshed.`);
    toast.success(`${count} ${count === 1 ? "rule" : "rules"} deleted`);
  }

  function setSources(sources: string[]) {
    setForm((current) => ({ ...current, sources }));
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

  function setRuleFilterSources(rule: Rule, sources: string[]) {
    const current = filtersForRule(rule);
    setFilterEdits((edits) => ({
      ...edits,
      [rule.id]: { ...current, sources },
    }));
  }

  async function saveRuleFilters(rule: Rule) {
    const filters = filtersForRule(rule);
    setSavingFilters(rule.id);
    try {
      const res = await send("/api/rules", {
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
      toast.warning(message, { description: blocked });
      return;
    }
    setRunning(true);
    try {
      const res = await send("/api/rules/run", { method: "POST" });
      const data = await res.json().catch(() => ({
        ok: false,
        message: "TorrentFlow didn't send back a result. Check Downloads, then run the rules again.",
        summary: [],
      }));
      const statusWords = (status: string) => {
        const words = status.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim().toLowerCase();
        return words ? `${words[0].toUpperCase()}${words.slice(1)}: ` : "";
      };
      const lines = (data.summary ?? [])
        .map(
          (s: { message: string; title?: string; status?: string }) =>
            `${s.status ? statusWords(s.status) : ""}${s.title ? s.title + ": " : ""}${s.message}`,
        )
        .join("\n");
      if (res.ok && data.ok !== false) {
        if (data.offline) {
          toast.warning(data.message || "Client offline during rules run", {
            description: lines || undefined,
          });
        } else {
          toast.success(data.message || "Rules run complete", {
            description: lines || undefined,
          });
        }
      } else if (data.offline || res.status === 503) {
        toast.warning(data.message || "Torrent client offline", {
          description: lines || undefined,
        });
      } else {
        toast.error(data.message || data.error || "Failed to run rules", {
          description: lines || undefined,
        });
      }
      void load();
    } catch {
      toast.error("Network error running rules");
    } finally {
      setRunning(false);
    }
  }



  return (
    <PageQueryBoundary
      query={rulesQuery}
      skeleton={(visible) => <RulesSkeleton visible={visible} />}
      errorTitle="Could not load rules"
      frame={(node) => <div className="container-app max-w-3xl py-6 pb-24 sm:py-8">{node}</div>}
    >
    {() => (
    <div className="container-app max-w-3xl py-6 pb-24 sm:py-8 space-y-5 min-w-0">
      <TfPageHeader
        title="Auto-download rules"
        description="Automatically grab video releases once they are healthy enough to download."
        actions={
          <Button
            type="button"
            size="sm"
            onClick={() => setRunReviewOpen(true)}
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
            Run automation
          </Button>
        }
      />

      <form onSubmit={onCreate} className="surface p-4 sm:p-5 space-y-3">
        <p className="text-sm font-medium text-foreground flex items-center gap-2">
          <Plus className="h-4 w-4 text-subtle-foreground" />
          New rule
        </p>
        <div className="grid items-start gap-3 sm:grid-cols-2">
          <FormField label="Rule name" htmlFor="rule-name">
            <Input
              id="rule-name"
              placeholder="Weekly anime"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              required
            />
          </FormField>
          <FormField
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
          </FormField>
          <FormField
            label="What to watch"
            htmlFor="rule-category"
            hint="Rules only grab video releases."
          >
            <Select
              value={form.category}
              onValueChange={(value) =>
                setForm((f) => ({ ...f, category: value }))
              }
            >
              <SelectTrigger id="rule-category" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RULE_CATEGORY_OPTIONS.map((c) => (
                  <SelectItem key={c.value} value={c.value}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <FormField label="Resolution" htmlFor="rule-resolution">
            <Select
              value={form.resolution || RESOLUTION_ANY}
              onValueChange={(value) =>
                setForm((f) => ({
                  ...f,
                  resolution: value === RESOLUTION_ANY ? "" : value,
                }))
              }
            >
              <SelectTrigger id="rule-resolution" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RULE_RESOLUTION_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <FormField
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
          </FormField>
          <FormField
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
              <span className="shrink-0 text-sm text-subtle-foreground">
                GB
              </span>
            </div>
          </FormField>
          <FormField
            label="Search only these indexers"
            htmlFor="rule-sources"
            className="sm:col-span-2"
            hint="Leave all unselected to search every enabled source."
          >
            <ToggleGroup
              id="rule-sources"
              type="multiple"
              value={form.sources}
              onValueChange={setSources}
              className="w-full min-w-0 flex-wrap rounded-md border border-border bg-background p-2"
            >
              {RULE_SOURCE_OPTIONS.map((source) => (
                <ToggleGroupItem
                  key={source.value}
                  value={source.value}
                  title={source.label}
                  className={sourceChipClass}
                >
                  {source.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </FormField>
        </div>
        <Button type="submit" size="sm">
          Create rule
        </Button>
      </form>

      <FilterBar fields={RULE_FILTERS} onPredicateChange={updateRulePredicate}>
        {({ clearFilters }) => (
        <>
        <DataList
          items={filteredRules}
          getKey={(rule) => rule.id}
          selection={selection}
          noResults={rules.length > 0 && !filteredRules.length}
          onClearFilters={clearFilters}
          empty={
            <TfEmptyState
              icon={Zap}
              title="No rules yet"
              description="Create a rule above to auto-send matching releases."
            />
          }
          renderRow={(rule) => {
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
            <div className="surface p-4 flex flex-wrap items-start gap-3">
              <div className="flex-1 min-w-0 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium text-foreground">{rule.name}</p>
                  <StatusChip label={rule.enabled ? "Enabled" : "Disabled"} tone={rule.enabled ? "active" : "neutral"} />
                  {!category.supported ? (
                    <Badge variant="secondary">Unsupported category</Badge>
                  ) : null}
                </div>
                <p className="text-xs text-subtle-foreground">
                  “{rule.query}” · {category.label} · ≥{rule.minSeeders} seeders
                  {rule.resolution ? ` · ${rule.resolution}` : ""}
                  {ruleSources.length ? ` · ${sourceSummary}` : ""}
                  {sizeSummary ? ` · ≤${sizeSummary} GB` : ""}
                </p>
                <Collapsible
                  open={filterEditRuleId === rule.id}
                  onOpenChange={() => openFilterEditor(rule)}
                  className="space-y-2"
                >
                  <CollapsibleTrigger asChild>
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      className="h-auto px-0 text-xs text-brand-foreground max-md:min-h-11 pointer-coarse:min-h-11"
                    >
                      {filterEditRuleId === rule.id
                        ? "Hide filters"
                        : "Edit source and size filters"}
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="rounded-lg border border-border bg-muted p-3 text-xs text-muted-foreground space-y-3">
                    <div className="space-y-1.5">
                      <p className="font-medium text-foreground">
                        Search only these indexers
                      </p>
                      <p className="text-xs text-subtle-foreground">
                        Leave all unselected to search every enabled source.
                      </p>
                      <ToggleGroup
                        type="multiple"
                        value={filterEdit.sources}
                        onValueChange={(sources) =>
                          setRuleFilterSources(rule, sources)
                        }
                        className="w-full flex-wrap"
                      >
                        {RULE_SOURCE_OPTIONS.map((source) => (
                          <ToggleGroupItem
                            key={source.value}
                            value={source.value}
                            title={source.label}
                            className={cn(sourceChipClass, "bg-card")}
                          >
                            {source.label}
                          </ToggleGroupItem>
                        ))}
                      </ToggleGroup>
                    </div>
                    <div className="space-y-1.5">
                      <Label
                        htmlFor={`rule-${rule.id}-max-size`}
                        className="text-xs text-foreground"
                      >
                        Skip releases larger than
                      </Label>
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
                        <span className="shrink-0 text-sm text-subtle-foreground">
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
                  </CollapsibleContent>
                </Collapsible>
                {!category.supported ? (
                  <div className="rounded-lg border border-border bg-muted p-3 text-xs text-muted-foreground space-y-2">
                    <p>
                      This legacy rule targets “{category.stored}”, which
                      TorrentFlow does not handle. It is blocked from
                      automation until you retarget it to video or delete it.
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      <Select
                        value={selectedRetarget}
                        onValueChange={(value) =>
                          setRetargetCategories((current) => ({
                            ...current,
                            [rule.id]: normalizeRuleCategory(value),
                          }))
                        }
                      >
                        <SelectTrigger
                          aria-label={`Retarget ${rule.name}`}
                          className="w-44"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {RULE_CATEGORY_OPTIONS.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
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
                  <p className="text-xs text-brand-foreground line-clamp-1">
                    Last match: {rule.lastMatchTitle}
                  </p>
                ) : null}
                <p className="text-xs text-subtle-foreground">
                  {rule.matchCount} sends
                  {rule.lastRunAt
                    ? ` · last run ${new Date(rule.lastRunAt).toLocaleString()}`
                    : ""}
                </p>
              </div>
              <Label
                htmlFor={`rule-${rule.id}-enabled`}
                className="min-h-8 cursor-pointer text-xs font-normal text-muted-foreground max-md:min-h-11 pointer-coarse:min-h-11"
              >
                <Switch
                  id={`rule-${rule.id}-enabled`}
                  aria-label="Enabled"
                  checked={rule.enabled}
                  disabled={!category.supported}
                  onCheckedChange={(checked) =>
                    void toggle(rule.id, checked === true)
                  }
                />
                Enabled
              </Label>
              <ConfirmAction
                label={<><Trash2 className="size-4" /><span className="sr-only">Delete rule</span></>}
                title="Delete rule?"
                description={`"${rule.name}" stops matching releases. Past sends stay in Notifications.`}
                confirmLabel="Delete rule"
                onConfirm={async () => {
                  await deleteRule(rule);
                  toast.success("Rule deleted");
                  void load();
                }}
                buttonProps={{ size: "icon-sm", "aria-label": "Delete rule", className: "text-subtle-foreground hover:text-destructive" }}
              />
            </div>
          );
          }}
        />
        <BulkBar
          count={selection.selected.length}
          onClear={selection.clear}
          actions={
            <ConfirmAction
              label="Delete selected"
              title="Delete selected rules?"
              description={`This will delete ${selection.selected.length} selected ${selection.selected.length === 1 ? "rule" : "rules"}.`}
              confirmLabel="Delete rules"
              onConfirm={deleteSelectedRules}
            />
          }
        />
        </>
        )}
      </FilterBar>

      <ConfirmDialog
        open={runReviewOpen}
        onOpenChange={setRunReviewOpen}
        contentData={{ "data-rules-automation-review": true }}
        title="Run rule automation?"
        description={`This searches ${rules.filter((rule) => rule.enabled).length} enabled ${
          rules.filter((rule) => rule.enabled).length === 1 ? "rule" : "rules"
        } and may download matching video releases right away.`}
        cancelLabel="Review rules"
        busy={running}
        confirmDisabled={hasUnsupportedRules}
        icon={<Play className="h-3.5 w-3.5" />}
        confirmLabel="Search and download matches"
        onConfirm={() => void runAll().finally(() => setRunReviewOpen(false))}
      />

    </div>
    )}
    </PageQueryBoundary>
  );
}

function RulesSkeleton({ visible = true }: { visible?: boolean }) {
  return (
    <PageSkeletonFrame
      aria-label="Loading rules"
      className={cn(
        "container-app max-w-3xl py-6 pb-24 sm:py-8 space-y-5 min-w-0 transition-opacity duration-150",
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
