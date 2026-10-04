import { useState } from "react";
import { Play, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LoadingGlyph, PageSkeletonFrame, SkeletonBlock } from "@/components/ui/loading";
import { TfPageHeader } from "@/components/tf/page-header";
import { TfErrorState } from "@/components/tf/error-state";
import { ConfirmDialog } from "@/components/tf/confirm-dialog";
import { RulesList } from "./rules-list";
import { RuleEditorDialog } from "./rule-editor-dialog";
import { isSupportedCategory, type Rule } from "./rule-types";
import { useRules } from "./use-rules";
import type { RuleFormState } from "@/lib/rules/form";

export default function RulesPage() {
  const { rules, query, running, mutating, create, update, toggle, retarget, remove, removeMany, run } = useRules();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Rule | null>(null);
  const [runDialogOpen, setRunDialogOpen] = useState(false);
  const unsupported = rules.some((rule) => !isSupportedCategory(rule.category));

  async function save(form: RuleFormState, current: Rule | null) {
    return current ? update(current.id, form) : create(form);
  }

  if (query.error && !query.data) {
    return (
      <div className="container-app max-w-3xl py-6 sm:py-8">
        <TfErrorState title="Could not load rules" message={query.error} onRetry={query.refetch} />
      </div>
    );
  }

  if (query.loading && !query.data) {
    return (
      <PageSkeletonFrame aria-label="Loading rules" className="container-app max-w-3xl space-y-5 py-6">
        <SkeletonBlock className="h-8 w-52" />
        <SkeletonBlock className="h-20 w-full" />
        <SkeletonBlock className="h-20 w-full" />
      </PageSkeletonFrame>
    );
  }

  return (
    <main className="container-app min-w-0 max-w-3xl space-y-5 py-6 pb-24 sm:py-8">
      <TfPageHeader
        title="Auto-download rules"
        description="Automatically grab matching video releases."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="secondary" onClick={() => {
              setEditing(null);
              setEditorOpen(true);
            }}>
              <Plus className="size-4" /> New rule
            </Button>
            <Button type="button" onClick={() => setRunDialogOpen(true)}
              disabled={running || !rules.some((rule) => rule.enabled)}
              title={unsupported ? "Retarget or delete unsupported legacy rules before running" : undefined}>
              {running ? <LoadingGlyph className="size-4" /> : <Play className="size-4" />}
              Run automation
            </Button>
          </div>
        }
      />
      {query.error ? (
        <div role="status" className="rounded-lg border border-border bg-muted p-3 text-sm text-muted-foreground">
          The list could not refresh. Your current rules are still shown.
        </div>
      ) : null}
      <RulesList
        rules={rules}
        busy={mutating}
        onToggle={(id, enabled) => void toggle(id, enabled)}
        onRetarget={(id, category) => void retarget(id, category)}
        onEdit={(rule) => {
          setEditing(rule);
          setEditorOpen(true);
        }}
        onDelete={async (rule) => {
          if (!(await remove(rule.id))) throw new Error("Could not delete rule. Try again.");
        }}
        onDeleteMany={async (selected) => removeMany(selected.map((rule) => rule.id))}
      />
      <RuleEditorDialog
        rule={editing}
        open={editorOpen}
        saving={mutating}
        onOpenChange={setEditorOpen}
        onSave={save}
      />
      <ConfirmDialog
        open={runDialogOpen}
        onOpenChange={setRunDialogOpen}
        title="Run rule automation?"
        description={`This searches ${rules.filter((rule) => rule.enabled).length} enabled rules and may download matches right away.`}
        cancelLabel="Review rules"
        busy={running}
        confirmDisabled={unsupported}
        icon={<Play className="size-4" />}
        confirmLabel="Search and download matches"
        onConfirm={() => void run().finally(() => setRunDialogOpen(false))}
      />
    </main>
  );
}
