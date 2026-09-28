/**
 * The library side of the hero: what the library should do with this work.
 *
 * The acquire intents (Play watches it now, Download keeps it) are rendered by
 * the hero itself (`title-detail.tsx`), because Play has to open the in-page
 * player and only the detail container holds that machinery. This component
 * owns catalogue membership.
 *
 * It goes through the existing watchlist API rather than a new one:
 * `POST /api/watchlist` adds and monitors the title. The payload is built
 * server-side and handed down whole; the client never invents a catalog id,
 * because an id it made up is an id automation will later fail to match.
 */
import { useRef, useState } from "react";
import { Check, Loader2, Plus, X } from "lucide-react";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
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

  const subject: AddSubject = { isSeries, seasons, releaseDate };
  const questions = addQuestions(subject);

  async function send(
    request: () => Promise<Response>,
    failure: string,
    success = "Added to library",
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

  const selectedStart =
    answers.startPoint.kind === "season"
      ? `season:${answers.startPoint.season}`
      : answers.startPoint.kind;
  const pickStart = (value: string) => {
    const next = parseStartPoint(value);
    if (next) setAnswers((a) => ({ ...a, startPoint: next }));
  };

  // Styled radios rather than a native select: the choice is the whole point
  // of the dialog, so every option and what it means stays visible at once.
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
            <legend className="mb-2 text-[13px] font-medium text-[var(--text)]">
              {question.prompt}
            </legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {main.map((option) => (
                <label
                  key={option.value}
                  data-add-option={option.value}
                  className="relative flex min-h-[44px] cursor-pointer items-start gap-3 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] p-3 transition-colors hover:border-[var(--border-strong)] has-[:checked]:border-[var(--brand)] has-[:checked]:bg-[var(--accent-dim)] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--brand)]"
                >
                  <input
                    type="radio"
                    name={`add-${question.id}`}
                    value={option.value}
                    checked={selectedStart === option.value}
                    onChange={() => pickStart(option.value)}
                    className="peer sr-only"
                  />
                  <span
                    aria-hidden
                    className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border border-[var(--border-strong)] peer-checked:border-[var(--brand)] peer-checked:[&>span]:scale-100"
                  >
                    <span className="h-2 w-2 scale-0 rounded-full bg-[var(--brand)] transition-transform" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium text-[var(--text)]">
                      {option.label}
                    </span>
                    {option.hint ? (
                      <span className="mt-0.5 block text-[12px] text-[var(--text-tertiary)]">
                        {option.hint}
                      </span>
                    ) : null}
                  </span>
                </label>
              ))}
            </div>
            {bySeason.length > 1 ? (
              <div className="pt-1">
                <p className="mb-2 text-[12px] text-[var(--text-tertiary)]">Or start from a season</p>
                <div className="flex flex-wrap gap-2">
                  {bySeason.map((option) => (
                    <label
                      key={option.value}
                      data-add-option={option.value}
                      className="inline-flex h-11 min-w-[44px] cursor-pointer items-center justify-center rounded-full border border-[var(--border)] bg-[var(--bg)] px-3.5 text-[13px] tabular-nums text-[var(--text-secondary)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text)] has-[:checked]:border-[var(--brand)] has-[:checked]:bg-[var(--accent-dim)] has-[:checked]:text-[var(--text)] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--brand)]"
                    >
                      <input
                        type="radio"
                        name={`add-${question.id}`}
                        value={option.value}
                        checked={selectedStart === option.value}
                        onChange={() => pickStart(option.value)}
                        aria-label={option.label}
                        className="sr-only"
                      />
                      {option.label.replace(/^From season /, "Season ")}
                    </label>
                  ))}
                </div>
              </div>
            ) : null}
          </fieldset>
        );
      })}

      <p
        data-add-summary
        aria-live="polite"
        className="text-[12px] leading-relaxed text-[var(--text-tertiary)]"
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
          className="min-h-[44px] w-full text-[var(--text-secondary)] sm:w-auto"
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
          <span
            className="inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2 text-[12px] text-[var(--text-secondary)]"
            data-in-library
          >
            <Check className="h-3.5 w-3.5" aria-hidden />
            In Library
          </span>
          {itemId ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              data-remove-from-library
              aria-label="Remove from library"
              disabled={busy}
              onClick={() => setConfirmingRemove(true)}
              className="min-h-[44px] text-[var(--text-secondary)]"
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
          below the title and put a second "Add to library" beside the first. */}
      <Dialog open={asking} onOpenChange={setAsking}>
        <DialogContent
          data-add-library-dialog
          className={
            isMobile
              ? "top-auto bottom-0 left-0 max-h-[90dvh] max-w-none translate-x-0 translate-y-0 gap-4 overflow-y-auto rounded-none rounded-t-[var(--radius-lg)] p-4 pb-[calc(env(safe-area-inset-bottom)+1rem)]"
              : "gap-4 overflow-y-auto p-5 sm:max-w-lg"
          }
          onCloseAutoFocus={(event) => {
            if (addButtonRef.current) {
              event.preventDefault();
              addButtonRef.current.focus();
            }
          }}
        >
          <div className="space-y-1 pr-12">
            <DialogTitle>Add to library</DialogTitle>
            <DialogDescription>
              {title?.trim()
                ? `Choose which episodes of ${title.trim()} to get and keep up with.`
                : "Choose which episodes to get and keep up with."}
            </DialogDescription>
          </div>
          {questionPanel}
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={confirmingRemove}
        onOpenChange={(open) => {
          if (!busy) setConfirmingRemove(open);
        }}
      >
        <AlertDialogContent data-remove-library-dialog>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove from library?</AlertDialogTitle>
            <AlertDialogDescription>
              {`${title?.trim() ? `“${title.trim()}”` : "This title"} leaves your library and TorrentFlow stops looking for it. Downloaded files are kept.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-remove-library-confirm
              disabled={busy}
              onClick={(event) => {
                event.preventDefault();
                remove();
              }}
              className="bg-[var(--destructive)] text-white hover:bg-[#e85d66]"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
              Remove, keep files
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
