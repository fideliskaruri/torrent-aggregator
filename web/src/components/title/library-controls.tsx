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
import { BellPlus, Bookmark, BookmarkCheck, Check, Loader2, Plus, X } from "lucide-react";
import { toast } from "@/lib/toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/tf/confirm-dialog";
import { PlaybackUncheckedNote } from "@/components/tf/playback-unchecked-note";
import { deleteFailure, PlaybackUncheckedError } from "@/lib/api/delete-refusal";
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
  gated: boolean;
  settled: boolean;
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

class FilesOnDiskError extends Error {}

export function LibraryControls({
  library,
  isSeries,
  gated,
  settled,
  seasons = [],
  releaseDate = null,
  title = null,
  onChanged,
  ownedShown = false,
}: LibraryControlsProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [asking, setAsking] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [unchecked, setUnchecked] = useState<string | null>(null);
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
  ): Promise<"done" | "failed" | "unchecked"> {
    setPhase("pending");
    try {
      const res = await request();
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => null);
        throw deleteFailure(body, `${failure} (${res.status})`);
      }
      setPhase("idle");
      toast.success(success);
      pendingFocusRef.current = focusAfter;
      onChanged();
      return "done";
    } catch (err) {
      setPhase("idle");
      if (err instanceof PlaybackUncheckedError) {
        setUnchecked(err.message);
        return "unchecked";
      }
      if (err instanceof FilesOnDiskError) {
        setConfirmingRemove(true);
        return "failed";
      }
      // A failure belongs next to nothing on the page — it belongs in a toast
      // that names what went wrong, so the hero layout never jumps to make room
      // for a red line and the message cannot strand itself away from its cause.
      toast.error(err instanceof Error ? err.message : failure);
      return "failed";
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
      !isSeries && gated
        ? "We'll download it when it's out"
        : library.inLibrary && !library.monitored && ownedShown
          ? "Following this series"
          : "Added to library",
    ).then(() => setAsking(false));

  const itemId = library.watchListItemId;
  const remove = () => {
    if (!itemId) return;
    const anyway = unchecked != null ? "&deleteAnyway=true" : "";
    void send(
      () =>
        apiSend(`/api/watchlist?id=${encodeURIComponent(itemId)}&confirm=true${anyway}`, {
          method: "DELETE",
        }),
      "Could not remove this from your library",
      "Removed from library",
      "add",
    ).then((outcome) => {
      if (outcome === "unchecked") return;
      setConfirmingRemove(false);
      setUnchecked(null);
    });
  };

  // Saved, not wanted yet: nothing is fetched until the owner chooses to.
  const saveForLater = () =>
    void send(
      () =>
        apiSend("/api/watchlist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...library.addPayload, status: "planned", monitored: false }),
        }),
      "Could not save this to your watchlist",
      "Saved to your watchlist",
    );

  // Only the watchlist entry goes. No confirm flag, so files are never
  // touched. An entry that turns out to have files on disk is refused with a
  // 409, so offer the full removal, which says what it deletes and asks first.
  const unsave = () => {
    if (!itemId) return;
    void send(
      async () => {
        const res = await apiSend(`/api/watchlist?id=${encodeURIComponent(itemId)}`, {
          method: "DELETE",
        });
        if (res.status !== 409) return res;
        throw new FilesOnDiskError();
      },
      "Could not remove this from your watchlist",
      "Removed from your watchlist",
      "add",
    );
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

  if (!isSeries && !settled) return null;

  const filmWaiting = !isSeries && gated;
  const showAdd = isSeries || gated;
  const onWatchlist = library.inLibrary && !library.monitored;
  // Owned files mean removing deletes them, so it always asks first.
  const savedOnly = onWatchlist && !ownedShown;
  // Files on disk already put it in the library, so adding here only follows it.
  const addLabel = filmWaiting ? "Get it when it's out" : onWatchlist && ownedShown ? "Follow this series" : "Add to library";

  // Also offered once saved: a saved title is not followed yet, and the add
  // payload upserts the same entry with monitored on.
  const addButton = showAdd ? (
    <Button
      ref={addButtonRef}
      type="button"
      size={filmWaiting ? "lg" : "sm"}
      variant={filmWaiting ? "default" : "secondary"}
      data-add-to-library
      data-title-watch-release={filmWaiting || undefined}
      aria-label={`${addLabel}${title ? `, ${title}` : ""}`}
      disabled={busy}
      onClick={onAddPressed}
      className={`min-h-[44px] w-full justify-center md:w-auto${filmWaiting ? " md:min-w-[12rem]" : ""}`}
    >
      {busy ? (
        <Loader2 className="animate-spin" aria-hidden />
      ) : filmWaiting ? (
        <BellPlus aria-hidden />
      ) : (
        <Plus aria-hidden />
      )}
      {addLabel}
    </Button>
  ) : null;

  return (
    <div
      data-title-library
      className="flex w-full min-w-0 flex-wrap items-center gap-2 md:w-auto"
    >
      {onWatchlist ? addButton : null}
      {library.inLibrary ? (
        <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 md:flex md:w-auto">
          {ownedShown ? null : (
            <Badge
              className="min-h-[44px] gap-1.5 rounded-lg bg-card px-3 py-2 font-normal [&>svg]:size-3.5!"
              data-in-library
            >
              {onWatchlist ? <BookmarkCheck aria-hidden /> : <Check aria-hidden />}
              {onWatchlist ? "On your watchlist" : filmWaiting ? "We'll get it when it's out" : "In Library"}
            </Badge>
          )}
          {itemId ? (
            <Button
              ref={removeButtonRef}
              type="button"
              size="sm"
              variant="ghost"
              data-remove-from-library
              aria-label={
                savedOnly
                  ? `Remove ${title ?? "this title"} from your watchlist`
                  : filmWaiting
                    ? `Stop waiting for ${title ?? "this title"}`
                    : "Remove from library"
              }
              disabled={busy}
              onClick={savedOnly ? unsave : () => setConfirmingRemove(true)}
              className="min-h-[44px] text-muted-foreground"
            >
              {busy ? <Loader2 className="animate-spin" aria-hidden /> : <X aria-hidden />}
              {filmWaiting && !onWatchlist ? "Stop" : "Remove"}
            </Button>
          ) : null}
        </div>
      ) : (
        <>
          {addButton}
          <Button
            ref={showAdd ? undefined : addButtonRef}
            type="button"
            size={showAdd && !filmWaiting ? "sm" : "lg"}
            variant="secondary"
            data-watch-later-save
            aria-label={`Watch later${title ? `, ${title}` : ""}`}
            disabled={busy}
            onClick={saveForLater}
            className="min-h-[44px] w-full justify-center md:w-auto"
          >
            {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Bookmark aria-hidden />}
            Watch later
          </Button>
        </>
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
        label={filmWaiting ? undefined : addLabel}
      />

      <ConfirmDialog
        open={confirmingRemove}
        onOpenChange={(open) => {
          setConfirmingRemove(open);
          if (!open) setUnchecked(null);
        }}
        contentData={{ "data-remove-library-dialog": true }}
        confirmData={{ "data-remove-library-confirm": true }}
        onCloseAutoFocus={returnFocus}
        title={removeFromLibraryCopy(title).title}
        description={removeFromLibraryCopy(title).body}
        variant="destructive"
        busy={busy}
        confirmLabel={unchecked != null ? "Delete anyway" : removeFromLibraryCopy(title).confirmLabel}
        onConfirm={remove}
      >
        {unchecked != null ? <PlaybackUncheckedNote message={unchecked} /> : null}
      </ConfirmDialog>
    </div>
  );
}
