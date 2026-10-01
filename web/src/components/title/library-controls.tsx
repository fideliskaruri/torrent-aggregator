/**
 * The library side of the hero: what the library should do with this work.
 *
 * The acquire intent (Download) is rendered by the hero itself
 * (`title-detail.tsx`), because only the detail container holds the quality
 * picker and the transfer polling. This component owns catalogue membership.
 *
 * It goes through the existing watchlist API rather than a new one:
 * `POST /api/watchlist` adds and monitors the title. The payload is built
 * server-side and handed down whole; the client never invents a catalog id,
 * because an id it made up is an id automation will later fail to match.
 */
import { useLayoutEffect, useRef, useState } from "react";
import { Check, Loader2, Plus, X } from "lucide-react";
import { toast } from "@/lib/toast";
import { Badge } from "@/components/ui/badge";
import { SeasonSwitcher } from "@/components/tf/season-switcher";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ConfirmDialog } from "@/components/tf/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { useMediaQuery } from "@/hooks/use-media-query";
import {
  addQuestions,
  addSummary,
  answersToPayload,
  defaultAnswers,
  parseStartPoint,
  type AddAnswers,
  type AddSubject,
} from "./add-to-library-questions";
import type { TitleLibraryState } from "./types";

export interface LibraryControlsProps {
  library: TitleLibraryState;
  isSeries: boolean;
  /** Season numbers the provider knows about, ascending. */
  seasons?: number[];
  /** `YYYY-MM-DD`, or null. Used when describing the title being added. */
  releaseDate?: string | null;
  /** Display title, used in the remove confirmation. */
  title?: string | null;
  /** Re-reads the payload so the controls reflect the server, not a guess. */
  onChanged: () => void;
}

type Phase = "idle" | "pending";

export function LibraryControls({
  library,
  isSeries,
  seasons = [],
  releaseDate = null,
  title = null,
  onChanged,
}: LibraryControlsProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [asking, setAsking] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [answers, setAnswers] = useState<AddAnswers>(defaultAnswers);
  const isMobile = useMediaQuery("(max-width: 767px)");
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const removeButtonRef = useRef<HTMLButtonElement>(null);
  // Adding swaps "Add to library" for "Remove", and removing swaps it back,
  // but only once the refetched payload arrives. The control that had focus is
  // gone by then, so this names the one that should take over.
  const pendingFocusRef = useRef<"add" | "remove" | null>(null);

  const subject: AddSubject = { isSeries, seasons, releaseDate };
  const questions = addQuestions(subject);

  // Whichever library control is on screen now.
  const focusLibraryControl = () => {
    const target = removeButtonRef.current ?? addButtonRef.current;
    if (!target?.isConnected) return false;
    target.focus();
    return true;
  };

  // A layout effect, so focus moves in the same commit that removed the old
  // control, before anything else can react to focus sitting on <body>.
  useLayoutEffect(() => {
    const wanted = pendingFocusRef.current;
    if (wanted !== (library.inLibrary ? "remove" : "add")) return;
    pendingFocusRef.current = null;
    const active = document.activeElement;
    // Only when focus was lost with the old control; never take it from
    // somewhere the user has moved on to.
    if (active && active !== document.body) return;
    focusLibraryControl();
  }, [library.inLibrary]);

  async function send(
    request: () => Promise<Response>,
    failure: string,
    success = "Added to library",
    focusAfter: "add" | "remove" = "remove",
  ) {
    setPhase("pending");
    try {
      const res = await request();
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error || `${failure} (${res.status})`);
      }
      setPhase("idle");
      toast.success(success);
      pendingFocusRef.current = focusAfter;
      onChanged();
    } catch (err) {
      setPhase("idle");
      // A failure belongs next to nothing on the page — it belongs in a toast
      // that names what went wrong, so the hero layout never jumps to make room
      // for a red line and the message cannot strand itself away from its cause.
      toast.error(err instanceof Error ? err.message : failure);
    }
  }

  const add = (chosen: AddAnswers) =>
    send(
      () =>
        fetch("/api/watchlist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...library.addPayload,
            ...answersToPayload(chosen),
          }),
        }),
      "Could not add this to your library",
    ).then(() => setAsking(false));

  const itemId = library.watchListItemId;
  const remove = () => {
    if (!itemId) return;
    void send(
      () =>
        fetch(`/api/watchlist?id=${encodeURIComponent(itemId)}`, {
          method: "DELETE",
        }),
      "Could not remove this from your library",
      "Removed from library",
      "add",
    ).then(() => setConfirmingRemove(false));
  };

  // Only interrupt when there is something to decide. A film has no season to
  // start from, so a dialog would be a confirmation step wearing a question's
  // clothes.
  const onAddPressed = () => {
    if (questions.length === 0) {
      void add(defaultAnswers());
      return;
    }
    setAnswers(defaultAnswers());
    setAsking(true);
  };

  const busy = phase === "pending";

  const addDescription = title?.trim()
    ? `Choose which episodes of ${title.trim()} to get and keep up with.`
    : "Choose which episodes to get and keep up with.";
  // Neither the add dialog nor the remove confirmation has a Radix trigger, so
  // Radix would drop focus on <body>. Send it to the library control instead:
  // the one that opened the dialog, or the one that replaced it.
  const returnFocus = (event: Event) => {
    if (focusLibraryControl()) event.preventDefault();
  };

  const selectedStart =
    answers.startPoint.kind === "season"
      ? `season:${answers.startPoint.season}`
      : answers.startPoint.kind;
  const pickStart = (value: string) => {
    const next = parseStartPoint(value);
    if (next) setAnswers((a) => ({ ...a, startPoint: next }));
  };

  // Radio cards rather than a select: the choice is the whole point of the
  // dialog, so every option and what it means stays visible at once.
  const questionPanel = (
    <div
      data-add-questions
      role="group"
      aria-label="Add to library options"
      className="w-full min-w-0 space-y-4"
    >
      {questions.map((question) => {
        const main = question.options.filter((o) => !o.value.startsWith("season:"));
        const bySeason = question.options.filter((o) => o.value.startsWith("season:"));
        return (
          <fieldset key={question.id} data-question={question.id} className="min-w-0 space-y-2">
            <legend className="mb-2 text-[13px] font-medium text-foreground">
              {question.prompt}
            </legend>
            {/* One group for both layouts, so arrow keys run through every
                choice, the season pills included. */}
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
                <p className="mb-2 text-[12px] text-subtle-foreground">Or start from a season</p>
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
          onClick={() => void add(answers)}
          className="min-h-[44px] w-full sm:w-auto"
        >
          {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Plus aria-hidden />}
          Add to library
        </Button>
        <Button
          type="button"
          variant="ghost"
          data-add-cancel
          onClick={() => setAsking(false)}
          className="min-h-[44px] w-full text-muted-foreground sm:w-auto"
        >
          Cancel
        </Button>
      </div>
    </div>
  );

  return (
    <div
      data-title-library
      className="flex w-full min-w-0 flex-wrap items-center gap-2 md:w-auto"
    >
      {library.inLibrary ? (
        <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 md:flex md:w-auto">
          <Badge
            className="min-h-[44px] gap-1.5 rounded-lg bg-card px-3 py-2 font-normal [&>svg]:size-3.5!"
            data-in-library
          >
            <Check aria-hidden />
            In Library
          </Badge>
          {itemId ? (
            <Button
              ref={removeButtonRef}
              type="button"
              size="sm"
              variant="ghost"
              data-remove-from-library
              aria-label="Remove from library"
              disabled={busy}
              onClick={() => setConfirmingRemove(true)}
              className="min-h-[44px] text-muted-foreground"
            >
              {busy ? <Loader2 className="animate-spin" aria-hidden /> : <X aria-hidden />}
              Remove
            </Button>
          ) : null}
        </div>
      ) : (
        <Button
          ref={addButtonRef}
          type="button"
          size="sm"
          variant="secondary"
          data-add-to-library
          disabled={busy}
          onClick={onAddPressed}
          className="min-h-[44px] w-full justify-center md:w-auto"
        >
          {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Plus aria-hidden />}
          Add to library
        </Button>
      )}

      {/* One modal on every width: inline, the questions pushed the poster
          below the title and put a second "Add to library" beside the first.
          Phones get a bottom sheet, wider screens a centred dialog. */}
      {isMobile ? (
        <Sheet open={asking} onOpenChange={setAsking}>
          <SheetContent
            side="bottom"
            data-add-library-dialog
            className="max-h-[90dvh] gap-4 overflow-y-auto rounded-t-xl p-4 pb-[calc(env(safe-area-inset-bottom)+1rem)]"
            onCloseAutoFocus={returnFocus}
          >
            <SheetHeader className="space-y-1 p-0 pr-12">
              <SheetTitle>Add to library</SheetTitle>
              <SheetDescription>{addDescription}</SheetDescription>
            </SheetHeader>
            {questionPanel}
          </SheetContent>
        </Sheet>
      ) : (
        <Dialog open={asking} onOpenChange={setAsking}>
          <DialogContent
            data-add-library-dialog
            className="gap-4 overflow-y-auto p-5 sm:max-w-lg"
            onCloseAutoFocus={returnFocus}
          >
            <div className="space-y-1 pr-12">
              <DialogTitle>Add to library</DialogTitle>
              <DialogDescription>{addDescription}</DialogDescription>
            </div>
            {questionPanel}
          </DialogContent>
        </Dialog>
      )}

      <ConfirmDialog
        open={confirmingRemove}
        onOpenChange={setConfirmingRemove}
        contentData={{ "data-remove-library-dialog": true }}
        confirmData={{ "data-remove-library-confirm": true }}
        onCloseAutoFocus={returnFocus}
        title="Remove from library?"
        description={`${title?.trim() ? `“${title.trim()}”` : "This title"} leaves your library and TorrentFlow stops looking for it. Downloaded files are kept.`}
        variant="destructive"
        busy={busy}
        confirmLabel="Remove, keep files"
        onConfirm={remove}
      />
    </div>
  );
}
