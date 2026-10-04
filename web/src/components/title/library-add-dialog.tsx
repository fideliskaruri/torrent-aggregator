import { useLayoutEffect, useState } from "react";
import { Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { SeasonSwitcher } from "@/components/tf/season-switcher";
import {
  addQuestions,
  addSummary,
  defaultAnswers,
  parseStartPoint,
  type AddAnswers,
  type AddSubject,
} from "./add-to-library-questions";

export function LibraryAddDialog({
  subject,
  title,
  open,
  onOpenChange,
  onAdd,
  busy,
  isMobile,
  onCloseAutoFocus,
}: {
  subject: AddSubject;
  title: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (answers: AddAnswers) => void;
  busy: boolean;
  isMobile: boolean;
  onCloseAutoFocus: (event: Event) => void;
}) {
  const [answers, setAnswers] = useState<AddAnswers>(defaultAnswers);
  const questions = addQuestions(subject);

  useLayoutEffect(() => {
    if (open) setAnswers(defaultAnswers());
  }, [open]);

  const addDescription = title?.trim()
    ? `Choose which episodes of ${title.trim()} to get and keep up with.`
    : "Choose which episodes to get and keep up with.";
  const selectedStart =
    answers.startPoint.kind === "season"
      ? `season:${answers.startPoint.season}`
      : answers.startPoint.kind;
  const pickStart = (value: string) => {
    const next = parseStartPoint(value);
    if (next) setAnswers((current) => ({ ...current, startPoint: next }));
  };

  const questionPanel = (
    <div
      data-add-questions
      role="group"
      aria-label="Add to library options"
      className="w-full min-w-0 space-y-4"
    >
      {questions.map((question) => {
        const main = question.options.filter((option) => !option.value.startsWith("season:"));
        const bySeason = question.options.filter((option) => option.value.startsWith("season:"));
        return (
          <fieldset key={question.id} data-question={question.id} className="min-w-0 space-y-2">
            <legend className="mb-2 text-[13px] font-medium text-foreground">
              {question.prompt}
            </legend>
            <RadioGroup
              value={selectedStart}
              onValueChange={pickStart}
              aria-label={question.prompt}
              className="gap-0"
            >
              <div className="grid gap-2 sm:grid-cols-2">
                {main.map((option) => (
                  <Label
                    key={option.value}
                    data-add-option={option.value}
                    className="relative min-h-[44px] cursor-pointer items-start gap-3 rounded-sm border border-border bg-background p-3 font-normal leading-normal transition-colors hover:border-input has-data-checked:border-brand has-data-checked:bg-brand-dim"
                  >
                    <RadioGroupItem value={option.value} className="mt-0.5" />
                    <span className="min-w-0">
                      <span className="block text-[13px] font-medium text-foreground">
                        {option.label}
                      </span>
                      {option.hint ? (
                        <span className="mt-0.5 block text-[12px] text-subtle-foreground">
                          {option.hint}
                        </span>
                      ) : null}
                    </span>
                  </Label>
                ))}
              </div>
              {bySeason.length > 1 ? (
                <div className="pt-3">
                  <p className="mb-2 text-[12px] text-subtle-foreground">
                    Or start from a season
                  </p>
                  <SeasonSwitcher
                    variant="pills"
                    options={bySeason.map((option) => ({
                      value: option.value,
                      label: option.label.replace(/^From season /, "Season "),
                      attrs: { "data-add-option": option.value },
                    }))}
                  />
                </div>
              ) : null}
            </RadioGroup>
          </fieldset>
        );
      })}

      <p
        data-add-summary
        aria-live="polite"
        className="text-[12px] leading-relaxed text-subtle-foreground"
      >
        {addSummary(subject, answers)}
      </p>

      <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-row-reverse sm:items-center">
        <Button
          type="button"
          data-add-confirm
          disabled={busy}
          onClick={() => onAdd(answers)}
          className="min-h-[44px] w-full sm:w-auto"
        >
          {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Plus aria-hidden />}
          Add to library
        </Button>
        <Button
          type="button"
          variant="ghost"
          data-add-cancel
          onClick={() => onOpenChange(false)}
          className="min-h-[44px] w-full text-muted-foreground sm:w-auto"
        >
          Cancel
        </Button>
      </div>
    </div>
  );

  return isMobile ? (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        data-add-library-dialog
        className="max-h-[90dvh] gap-4 overflow-y-auto rounded-t-xl p-4 pb-[calc(env(safe-area-inset-bottom)+1rem)]"
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <SheetHeader className="space-y-1 p-0 pr-12">
          <SheetTitle>Add to library</SheetTitle>
          <SheetDescription>{addDescription}</SheetDescription>
        </SheetHeader>
        {questionPanel}
      </SheetContent>
    </Sheet>
  ) : (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-add-library-dialog
        className="gap-4 overflow-y-auto p-5 sm:max-w-lg"
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <div className="space-y-1 pr-12">
          <DialogTitle>Add to library</DialogTitle>
          <DialogDescription>{addDescription}</DialogDescription>
        </div>
        {questionPanel}
      </DialogContent>
    </Dialog>
  );
}
