import { useState } from "react";
import { Play, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LoadingGlyph, PageSkeletonFrame, SkeletonBlock } from "@/components/ui/loading";
import { PageQueryBoundary } from "@/components/tf/page-query-boundary";
import { TfPageHeader } from "@/components/tf/page-header";
import { ConfirmDialog } from "@/components/tf/confirm-dialog";
import { RulesList } from "./rules-list";
import { RuleEditorDialog } from "./rule-editor-dialog";
import { isSupportedCategory, type Rule } from "./rule-types";
import { useRules } from "./use-rules";
import type { RuleFormState } from "@/lib/rules/form";

export default function RulesPage() {
  const { query, running, mutating, create, update, toggle, retarget, remove, removeMany, run } = useRules();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Rule | null>(null);
  const [runDialogOpen, setRunDialogOpen] = useState(false);

  async function save(form: RuleFormState, current: Rule | null) {
    return current ? update(current.id, form) : create(form);
  }

  return (
    <PageQueryBoundary
      query={query}
      skeleton={(visible) => <RulesSkeleton visible={visible} />}
      errorTitle="Could not load rules"
      frame={(node) => <main className="container-app max-w-3xl py-6 sm:py-8">{node}</main>}
    >
      {(rules) => {
        const unsupported = rules.some((rule) => !isSupportedCategory(rule.category));
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
              onDelete={async (rule) => { await remove(rule.id); }}
              onDeleteMany={async (selected) => removeMany(selected.map((rule) => rule.id))}
            />
            <RuleEditorDialog
              key={`${editorOpen ? "open" : "closed"}-${editing?.id ?? "new"}`}
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
      }}
    </PageQueryBoundary>
  );
}

function RulesSkeleton({ visible }: { visible: boolean }) {
  return (
    <PageSkeletonFrame
      aria-label="Loading rules"
      className={`container-app max-w-3xl space-y-5 py-6 transition-opacity duration-150 ${visible ? "" : "opacity-0"}`}
    >
      <SkeletonBlock className="h-8 w-52" />
      <SkeletonBlock className="h-20 w-full" />
      <SkeletonBlock className="h-20 w-full" />
    </PageSkeletonFrame>
  );
}
