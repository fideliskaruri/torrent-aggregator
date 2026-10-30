import { useState } from "react";
import { AudioLines, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/tf/confirm-dialog";
import { PlaybackUncheckedNote } from "@/components/tf/playback-unchecked-note";
import { PlaybackUncheckedError } from "@/lib/api/delete-refusal";
import { findAnotherCopy, keepBothCopies, keepNewCopy } from "@/lib/api/library-files";
import { audioCheckLabel, type AudioCheck } from "@/lib/library/audio-check";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { ButtonBody } from "./button-body";

type Busy = "find" | "keep-new" | "keep-both" | null;

/** The actions for a file Jellyfin flagged for its audio. Shared by the film hero and the episode menu. */
export function useAudioCheckActions(check: AudioCheck, name: string, onChanged: () => void) {
  const [busy, setBusy] = useState<Busy>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [unchecked, setUnchecked] = useState<string | null>(null);
  const fileId = check.kind === "ok" ? null : check.fileId;

  async function run(kind: Exclude<Busy, null>, action: () => Promise<void>, done: string) {
    setBusy(kind);
    try {
      await action();
      toast.success(done);
      onChanged();
      return true;
    } catch (error) {
      if (error instanceof PlaybackUncheckedError) {
        setUnchecked(error.message);
        return false;
      }
      toast.error(error instanceof Error ? error.message : "Something went wrong. Try again.");
      return false;
    } finally {
      setBusy(null);
    }
  }

  return {
    busy,
    canFind: check.kind === "wrong-audio" || check.kind === "failed",
    canChoose: check.kind === "ready",
    findAnother: () => {
      if (fileId) void run("find", () => findAnotherCopy(fileId, name), `Looking for another copy of ${name}`);
    },
    keepBoth: () => {
      if (fileId) void run("keep-both", () => keepBothCopies(fileId, name), `Keeping both copies of ${name}`);
    },
    askKeepNew: () => {
      setUnchecked(null);
      setConfirmOpen(true);
    },
    dialog: (
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (busy === null) setConfirmOpen(open);
        }}
        title="Delete the old copy?"
        description={`The copy of ${name} with the wrong audio is deleted from disk. The new copy stays.`}
        variant="destructive"
        busy={busy === "keep-new"}
        confirmLabel={unchecked != null ? "Delete anyway" : "Delete old copy"}
        onConfirm={() => {
          if (!fileId) return;
          const anyway = unchecked != null;
          void run("keep-new", () => keepNewCopy(fileId, name, anyway), `Deleted the old copy of ${name}`).then((ok) => {
            if (ok) setConfirmOpen(false);
          });
        }}
      >
        {unchecked != null ? <PlaybackUncheckedNote message={unchecked} /> : null}
      </ConfirmDialog>
    ),
  };
}

/** Film hero: one line saying what is wrong or in progress, with the next step beside it. */
export function AudioCheckNotice({
  check,
  name,
  onChanged,
  className,
}: {
  check: AudioCheck;
  name: string;
  onChanged: () => void;
  className?: string;
}) {
  const actions = useAudioCheckActions(check, name, onChanged);
  const label = audioCheckLabel(check);
  if (!label) return null;
  const problem = check.kind === "wrong-audio" || check.kind === "failed";
  const BUTTON = "relative w-full min-w-0 md:w-auto";
  return (
    <div
      className={cn("flex w-full min-w-0 flex-col gap-2 md:w-auto md:flex-row md:flex-wrap md:items-center", className)}
      data-audio-check={check.kind}
    >
      <p
        role="status"
        className={cn(
          "flex min-h-10 min-w-0 items-center gap-2 text-[14px] font-medium",
          problem ? "text-destructive" : "text-foreground",
        )}
      >
        <AudioLines aria-hidden className={cn("size-4 shrink-0", problem ? "text-destructive" : "text-info")} />
        <span data-audio-check-text>{label}</span>
      </p>
      {actions.canFind ? (
        <Button
          type="button"
          size="lg"
          variant="outline"
          className={BUTTON}
          data-audio-find
          aria-busy={actions.busy === "find" || undefined}
          disabled={actions.busy !== null}
          aria-label={`${check.kind === "failed" ? "Try again" : "Find another source"} for ${name}`}
          onClick={actions.findAnother}
        >
          <ButtonBody pending={actions.busy === "find"} icon={<Search aria-hidden />}>
            {check.kind === "failed" ? "Try again" : "Find another source"}
          </ButtonBody>
        </Button>
      ) : null}
      {actions.canChoose ? (
        <>
          <Button
            type="button"
            size="lg"
            className={BUTTON}
            data-audio-keep-new
            disabled={actions.busy !== null}
            onClick={actions.askKeepNew}
          >
            Keep new
          </Button>
          <Button
            type="button"
            size="lg"
            variant="secondary"
            className={BUTTON}
            data-audio-keep-both
            aria-busy={actions.busy === "keep-both" || undefined}
            disabled={actions.busy !== null}
            onClick={actions.keepBoth}
          >
            <ButtonBody pending={actions.busy === "keep-both"} icon={null}>Keep both</ButtonBody>
          </Button>
        </>
      ) : null}
      {actions.dialog}
    </div>
  );
}
