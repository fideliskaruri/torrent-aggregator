import { useState } from "react";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  RULE_CATEGORIES,
  RULE_RESOLUTIONS,
  type Rule,
} from "./rule-types";
import {
  bytesToMaxSizeGbInput,
  parseRuleSources,
  RULE_SOURCE_OPTIONS,
  type RuleFormState,
} from "@/lib/rules/form";

const EMPTY_FORM: RuleFormState = {
  name: "",
  query: "",
  category: "all",
  minSeeders: "10",
  resolution: "",
  sources: [],
  maxSizeGb: "",
};

function formFromRule(rule: Rule): RuleFormState {
  return {
    name: rule.name,
    query: rule.query,
    category: rule.category,
    minSeeders: String(rule.minSeeders),
    resolution: rule.resolution ?? "",
    sources: parseRuleSources(rule.sources),
    maxSizeGb: bytesToMaxSizeGbInput(rule.maxSizeBytes),
  };
}

export function RuleEditorDialog({
  rule,
  open,
  saving,
  onOpenChange,
  onSave,
}: {
  rule: Rule | null;
  open: boolean;
  saving: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (form: RuleFormState, rule: Rule | null) => Promise<boolean>;
}) {
  const [form, setForm] = useState<RuleFormState>(() =>
    open && rule ? formFromRule(rule) : EMPTY_FORM,
  );

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await onSave(form, rule)) onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{rule ? "Edit rule" : "New rule"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={(event) => void submit(event)} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="Rule name" htmlFor="rule-name">
              <Input id="rule-name" value={form.name} required onChange={(e) =>
                setForm((current) => ({ ...current, name: e.target.value }))} />
            </FormField>
            <FormField label="Search query" htmlFor="rule-query" hint="Run against enabled indexers">
              <Input id="rule-query" value={form.query} required onChange={(e) =>
                setForm((current) => ({ ...current, query: e.target.value }))} />
            </FormField>
            <FormField label="What to watch" htmlFor="rule-category">
              <Select value={form.category} onValueChange={(category) =>
                setForm((current) => ({ ...current, category }))}>
                <SelectTrigger id="rule-category" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{RULE_CATEGORIES.map((option) =>
                  <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
              </Select>
            </FormField>
            <FormField label="Resolution" htmlFor="rule-resolution">
              <Select value={form.resolution || "__any"} onValueChange={(resolution) =>
                setForm((current) => ({ ...current, resolution: resolution === "__any" ? "" : resolution }))}>
                <SelectTrigger id="rule-resolution" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{RULE_RESOLUTIONS.map((option) =>
                  <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
              </Select>
            </FormField>
            <FormField label="Min seeders" htmlFor="rule-seeders">
              <Input id="rule-seeders" inputMode="numeric" value={form.minSeeders} onChange={(e) =>
                setForm((current) => ({ ...current, minSeeders: e.target.value }))} />
            </FormField>
            <FormField label="Skip sources larger than" htmlFor="rule-max-size">
              <div className="flex items-center gap-2">
                <Input id="rule-max-size" inputMode="decimal" value={form.maxSizeGb} placeholder="Any size"
                  onChange={(e) => setForm((current) => ({ ...current, maxSizeGb: e.target.value }))} />
                <span className="text-sm text-subtle-foreground">GB</span>
              </div>
            </FormField>
          </div>
          <FormField label="Search only these indexers" htmlFor="rule-sources"
            hint="Leave all unselected to search every enabled source.">
            <ToggleGroup id="rule-sources" type="multiple" value={form.sources}
              onValueChange={(sources) => setForm((current) => ({ ...current, sources }))}
              className="flex w-full flex-wrap gap-2">
              {RULE_SOURCE_OPTIONS.map((source) => (
                <ToggleGroupItem key={source.value} value={source.value}
                  className="min-h-11 rounded-full border border-border px-3 text-xs data-[state=on]:border-brand/50 data-[state=on]:bg-brand-dim">
                  {source.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </FormField>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? "Saving…" : rule ? "Save rule" : "Create rule"}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
