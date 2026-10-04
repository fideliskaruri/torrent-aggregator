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
import { send as apiSend } from "@/lib/api";
import { Check, Loader2, Plus, X } from "lucide-react";
import { toast } from "@/lib/toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/tf/confirm-dialog";
import { useMediaQuery } from "@/hooks/use-media-query";
import { LibraryAddDialog } from "./library-add-dialog";
import {
  addQuestions,
  answersToPayload,
  defaultAnswers,
} from "./add-to-library-questions";
import type { TitleLibraryState } from "./types";
import { removeFromLibraryCopy } from "@/lib/library/remove-copy";

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
  /** The page already says "In your library" (owned-quality line), so no second pill. */
  ownedShown?: boolean;
}

type Phase = "idle" | "pending";

export function LibraryControls({
  library,
  isSeries,
  seasons = [],
  releaseDate = null,
  title = null,
  onChanged,
  ownedShown = false,
}: LibraryControlsProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [asking, setAsking] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const isMobile = useMediaQuery("(max-width: 767px)");
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const removeButtonRef = useRef<HTMLButtonElement>(null);
  // Adding swaps "Add to library" for "Remove", and removing swaps it back,
  // but only once the refetched payload arrives. The control that had focus is
  // gone by then, so this names the one that should take over.
  const pendingFocusRef = useRef<"add" | "remove" | null>(null);

  const subject = { isSeries, seasons, releaseDate };
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

  const add = (chosen: Parameters<typeof answersToPayload>[0]) =>
    send(
      () =>
        apiSend("/api/watchlist", {
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
        apiSend(`/api/watchlist?id=${encodeURIComponent(itemId)}&confirm=true`, {
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
    setAsking(true);
  };

  const busy = phase === "pending";

  // Neither dialog has a Radix trigger, so return focus to the control that
  // opened it or the control that replaced it.
  const returnFocus = (event: Event) => {
    if (focusLibraryControl()) event.preventDefault();
  };

  return (
    <div
      data-title-library
      className="flex w-full min-w-0 flex-wrap items-center gap-2 md:w-auto"
    >
      {library.inLibrary ? (
        <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 md:flex md:w-auto">
          {ownedShown ? null : (
            <Badge
              className="min-h-[44px] gap-1.5 rounded-lg bg-card px-3 py-2 font-normal [&>svg]:size-3.5!"
              data-in-library
            >
              <Check aria-hidden />
              In Library
            </Badge>
          )}
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

      <LibraryAddDialog
        subject={subject}
        title={title}
        open={asking}
        onOpenChange={setAsking}
        onAdd={add}
        busy={busy}
        isMobile={isMobile}
        onCloseAutoFocus={returnFocus}
      />

      <ConfirmDialog
        open={confirmingRemove}
        onOpenChange={setConfirmingRemove}
        contentData={{ "data-remove-library-dialog": true }}
        confirmData={{ "data-remove-library-confirm": true }}
        onCloseAutoFocus={returnFocus}
        title={removeFromLibraryCopy(title).title}
        description={removeFromLibraryCopy(title).body}
        variant="destructive"
        busy={busy}
        confirmLabel={removeFromLibraryCopy(title).confirmLabel}
        onConfirm={remove}
      />
    </div>
  );
}
