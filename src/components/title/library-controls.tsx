"use client";

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
import { useState } from "react";
import { Check, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
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

  return (
    <div
      data-title-library
      className="flex w-full flex-wrap items-center gap-2 sm:w-auto"
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
        // A tertiary control, not a third primary button: ghost weight and
        // compact size so it sits quietly beside Play and Download instead of
        // stranded on its own row competing for the eye.
        <Button
          type="button"
          size="sm"
          variant="ghost"
          data-add-to-library
          disabled={busy}
          onClick={onAddPressed}
          className="min-h-[44px] w-full justify-center text-[var(--text-secondary)] sm:w-auto lg:min-h-0"
        >
          {busy ? (
            <Loader2 className="animate-spin" aria-hidden />
          ) : (
            <Plus aria-hidden />
          )}
          Add to library
        </Button>
      )}

      {asking ? (
        <div
          data-add-questions
          role="group"
          aria-label="Add to library options"
          className="mt-2 w-full max-w-md space-y-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-elevated)] p-3"
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
                className="min-h-[44px] w-full rounded-[6px] border border-[var(--border)] bg-[var(--bg)] px-2 text-[13px] text-[var(--text)]"
              >
                {question.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                    {option.hint ? ` — ${option.hint}` : ""}
                  </option>
                ))}
              </select>
            </div>
          ))}

          {/* The consequence, not the settings. A panel of controls describes
              its own state; this describes what happens when Add is pressed,
              which is the only thing the user was ever trying to find out. */}
          <p
            data-add-summary
            className="text-[12px] leading-relaxed text-[var(--text-tertiary)]"
          >
            {addSummary(subject, answers)}
          </p>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              data-add-confirm
              disabled={busy}
              onClick={() => void add(answers)}
              className="min-h-[44px] lg:min-h-0"
            >
              {busy ? <Loader2 className="animate-spin" aria-hidden /> : null}
              Add to library
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setAsking(false)}
              className="min-h-[44px] text-[var(--text-secondary)] lg:min-h-0"
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
