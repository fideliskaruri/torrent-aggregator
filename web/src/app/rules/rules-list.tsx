import { useCallback, useState } from "react";
import { Zap } from "lucide-react";
import { DataList } from "@/components/tf/data-list";
import { FilterBar, type FilterField } from "@/components/tf/filter-bar";
import { BulkBar } from "@/components/tf/bulk-bar";
import { useSelection } from "@/components/tf/use-selection";
import { ConfirmAction } from "@/components/tf/confirm-action";
import { TfEmptyState } from "@/components/tf/empty-state";
import type { Rule } from "./rule-types";
import { RuleRow } from "./rule-row";

const FILTERS: FilterField<Rule>[] = [
  { key: "name", label: "Search rules", kind: "search" },
];

export function RulesList({
  rules,
  busy,
  onToggle,
  onRetarget,
  onEdit,
  onDelete,
  onDeleteMany,
}: {
  rules: Rule[];
  busy: boolean;
  onToggle: (id: string, enabled: boolean) => void;
  onRetarget: (id: string, category: string) => void;
  onEdit: (rule: Rule) => void;
  onDelete: (rule: Rule) => Promise<void>;
  onDeleteMany: (rules: Rule[]) => Promise<void>;
}) {
  const [predicate, setPredicate] = useState<(rule: Rule) => boolean>(() => () => true);
  const updatePredicate = useCallback((next: (rule: Rule) => boolean) => {
    setPredicate(() => next);
  }, []);
  const filtered = rules.filter(predicate);
  const selection = useSelection(filtered, (rule) => rule.id);

  return (
    <FilterBar fields={FILTERS} onPredicateChange={updatePredicate}>
      {({ clearFilters }) => (
        <>
          <DataList
            items={filtered}
            getKey={(rule) => rule.id}
            selection={selection}
            noResults={rules.length > 0 && filtered.length === 0}
            onClearFilters={clearFilters}
            empty={<TfEmptyState icon={Zap} title="No rules yet" description="Create a rule to match releases automatically." />}
            renderRow={(rule) => (
              <RuleRow rule={rule} busy={busy} onToggle={onToggle} onRetarget={onRetarget}
                onEdit={onEdit} onDelete={onDelete} />
            )}
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
                onConfirm={() => onDeleteMany(selection.selected)}
              />
            }
          />
        </>
      )}
    </FilterBar>
  );
}
