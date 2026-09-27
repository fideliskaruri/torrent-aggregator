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
import { Check, Loader2, Plus } from "lucide-react";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
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
  /** Re-reads the payload so the controls reflect the server, not a guess. */
  onChanged: () => void;
}

type Phase = "idle" | "pending";

export function LibraryControls({
  library,
  isSeries,
  seasons = [],
  releaseDate = null,
  onChanged,
}: LibraryControlsProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [asking, setAsking] = useState(false);
  const [answers, setAnswers] = useState<AddAnswers>(defaultAnswers);
  const isMobile = useMediaQuery("(max-width: 767px)");
  const addButtonRef = useRef<HTMLButtonElement>(null);

  const subject: AddSubject = { isSeries, seasons, releaseDate };
  const questions = addQuestions(subject);

  async function send(request: () => Promise<Response>, failure: string) {
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
      toast.success("Added to library");
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

  const questionPanel = (
    <div
      data-add-questions
      role="group"
      aria-label="Add to library options"
      className="w-full min-w-0 space-y-3 md:mt-2 md:max-w-md md:rounded-[var(--radius)] md:border md:border-[var(--border)] md:bg-[var(--bg-elevated)] md:p-3"
    >
      {questions.map((question) => (
        <div key={question.id} className="space-y-1.5">
          <p className="text-[13px] font-medium text-[var(--text)]">
            {question.prompt}
          </p>
          <select
            data-question="start-point"
            aria-label={question.prompt}
            value={
              answers.startPoint.kind === "season"
                ? `season:${answers.startPoint.season}`
                : answers.startPoint.kind
            }
            onChange={(event) => {
              const next = parseStartPoint(event.target.value);
              if (next) setAnswers((a) => ({ ...a, startPoint: next }));
            }}
            className="min-h-[44px] w-full min-w-0 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] px-2 text-[13px] text-[var(--text)]"
          >
            {question.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
                {!isMobile && option.hint ? ` — ${option.hint}` : ""}
              </option>
            ))}
          </select>
        </div>
      ))}

      <p
        data-add-summary
        className="text-[12px] leading-relaxed text-[var(--text-tertiary)]"
      >
        {addSummary(subject, answers)}
      </p>

      <div className="grid grid-cols-1 gap-2 md:flex md:items-center">
        <Button
          type="button"
          size="sm"
          data-add-confirm
          disabled={busy}
          onClick={() => void add(answers)}
          className="min-h-[44px] w-full md:w-auto lg:min-h-0"
        >
          {busy ? <Loader2 className="animate-spin" aria-hidden /> : null}
          Add to library
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          data-add-cancel
          onClick={() => setAsking(false)}
          className="min-h-[44px] w-full text-[var(--text-secondary)] md:w-auto lg:min-h-0"
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
        <span
          className="inline-flex items-center gap-1.5 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2 text-[12px] text-[var(--text-secondary)]"
          data-in-library
        >
          <Check className="h-3.5 w-3.5" aria-hidden />
          In Library
        </span>
      ) : (
        <Button
          ref={addButtonRef}
          type="button"
          size="sm"
          variant="ghost"
          data-add-to-library
          disabled={busy}
          onClick={onAddPressed}
          className="min-h-[44px] w-full justify-center text-[var(--text-secondary)] md:w-auto lg:min-h-0"
        >
          {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Plus aria-hidden />}
          Add to library
        </Button>
      )}

      {isMobile ? (
        <Dialog open={asking} onOpenChange={setAsking}>
          <DialogContent
            data-add-library-dialog
            className="top-auto max-h-[90dvh] gap-4 overflow-y-auto rounded-t-[var(--radius-lg)] p-4 pb-[calc(env(safe-area-inset-bottom)+1rem)]"
            onCloseAutoFocus={(event) => {
              if (addButtonRef.current) {
                event.preventDefault();
                addButtonRef.current.focus();
              }
            }}
          >
            <DialogTitle className="pr-12">Add to library</DialogTitle>
            <DialogDescription>
              Choose which episodes to add and keep up with.
            </DialogDescription>
            {questionPanel}
          </DialogContent>
        </Dialog>
      ) : asking ? questionPanel : null}
    </div>
  );
}
