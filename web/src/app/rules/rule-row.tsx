import { useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ConfirmAction } from "@/components/tf/confirm-action";
import { StatusChip } from "@/components/tf/status-chip";
import { RULE_CATEGORIES, isSupportedCategory, type Rule } from "./rule-types";
import { bytesToMaxSizeGbInput, parseRuleSources, RULE_SOURCE_OPTIONS } from "@/lib/rules/form";

export function RuleRow({
  rule,
  busy,
  onToggle,
  onRetarget,
  onEdit,
  onDelete,
}: {
  rule: Rule;
  busy: boolean;
  onToggle: (id: string, enabled: boolean) => void;
  onRetarget: (id: string, category: string) => void;
  onEdit: (rule: Rule) => void;
  onDelete: (rule: Rule) => Promise<void>;
}) {
  const [category, setCategory] = useState<string>("all");
  const supported = isSupportedCategory(rule.category);
  const sources = parseRuleSources(rule.sources);
  const sourceLabels = RULE_SOURCE_OPTIONS
    .filter((source) => sources.includes(source.value))
    .map((source) => source.label);
  const maxSize = bytesToMaxSizeGbInput(rule.maxSizeBytes);

  return (
    <article className="surface flex min-w-0 flex-wrap items-start gap-3 p-4">
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-medium text-foreground">{rule.name}</p>
          <StatusChip label={rule.enabled ? "Enabled" : "Disabled"} tone={rule.enabled ? "active" : "neutral"} />
          {!supported ? <Badge variant="secondary">Unsupported category</Badge> : null}
        </div>
        <p className="break-words text-xs text-subtle-foreground">
          “{rule.query}” · {supported ? RULE_CATEGORIES.find((item) => item.value === rule.category)?.label : `Unsupported: ${rule.category}`}
          {" · "}≥{rule.minSeeders} seeders{rule.resolution ? ` · ${rule.resolution}` : ""}
          {sourceLabels.length ? ` · ${sourceLabels.join(", ")}` : ""}
          {maxSize ? ` · ≤${maxSize} GB` : ""}
        </p>
        {rule.lastMatchTitle ? <p className="line-clamp-1 text-xs text-brand-foreground">Last match: {rule.lastMatchTitle}</p> : null}
        <p className="text-xs text-subtle-foreground">
          {rule.matchCount} sends{rule.lastRunAt ? ` · last run ${new Date(rule.lastRunAt).toLocaleString()}` : ""}
        </p>
        {!supported ? (
          <div className="space-y-2 rounded-lg border border-border bg-muted p-3 text-xs text-muted-foreground">
            <p>This legacy rule is blocked until you retarget it to video or delete it.</p>
            <div className="flex flex-wrap gap-2">
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger aria-label={`Retarget ${rule.name}`} className="w-44"><SelectValue /></SelectTrigger>
                <SelectContent>{RULE_CATEGORIES.map((option) =>
                  <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
              </Select>
              <Button type="button" variant="secondary" disabled={busy}
                onClick={() => onRetarget(rule.id, category)}>Retarget</Button>
            </div>
          </div>
        ) : null}
      </div>
      <Label htmlFor={`rule-${rule.id}-enabled`} className="flex min-h-11 items-center gap-2 text-xs font-normal">
        <Switch id={`rule-${rule.id}-enabled`} aria-label={`Enable ${rule.name}`}
          checked={rule.enabled} disabled={busy || !supported}
          onCheckedChange={(enabled) => onToggle(rule.id, enabled === true)} />
        Enabled
      </Label>
      <Button type="button" size="icon-sm" variant="ghost" aria-label={`Edit ${rule.name}`}
        disabled={busy} onClick={() => onEdit(rule)}><Pencil className="size-4" /></Button>
      <ConfirmAction
        label={<><Trash2 className="size-4" /><span className="sr-only">Delete rule</span></>}
        title="Delete rule?"
        description={`"${rule.name}" stops matching releases. Past sends stay in Notifications.`}
        confirmLabel="Delete rule"
        onConfirm={() => onDelete(rule)}
        buttonProps={{ size: "icon-sm", "aria-label": `Delete ${rule.name}` }}
      />
    </article>
  );
}
