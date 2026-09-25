"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useSession } from "@/components/providers/session-provider";
import { useDownloadPrefs } from "@/hooks/use-download-prefs";
import type { TorrentResult } from "@/lib/torrents/types";
import type { ActionButtonStatus } from "@/components/ui/action-button";
import { useStorageCapOverride } from "@/components/storage/use-storage-cap-override";
import {
  parseStorageOverrideFacts,
  StorageLimitError,
} from "@/lib/library/storage-override";

export type ReleaseAction = "play" | "download";

export interface ReleasePlayback {
  infoHash: string;
  title: string;
  subtitle?: string | null;
}

/**
 * The two actions a viewer has — Play (watch now, ephemeral) and Download
 * (keep) — for a single release, with just enough transient state to reflect
 * them without ever reflowing the card.
 *
 * Both the title card (acting on the work's best release) and each release row
 * inside the expander drive this hook, so the send/playback logic lives in one
 * place instead of being copied per surface.
 */
export function useReleaseActions(
  torrent: TorrentResult,
  searchCategory?: string,
) {
  const { data: session } = useSession();
  const { prefs } = useDownloadPrefs();
  const [pending, setPending] = useState<ReleaseAction | null>(null);
  const [playback, setPlayback] = useState<ReleasePlayback | null>(null);
  const [status, setStatus] = useState<{
    action: ReleaseAction;
    status: ActionButtonStatus;
  } | null>(null);
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Synchronous in-flight latch — see the guard in `run`. */
  const inFlightRef = useRef(false);
  // Over-cap Download asks instead of refusing. Play never gets here.
  const cap = useStorageCapOverride();

  useEffect(
    () => () => {
      if (statusTimer.current) clearTimeout(statusTimer.current);
    },
    [],
  );

  function flash(action: ReleaseAction, s: ActionButtonStatus) {
    if (statusTimer.current) clearTimeout(statusTimer.current);
    setStatus({ action, status: s });
    statusTimer.current = setTimeout(() => setStatus(null), 4500);
  }

  const primaryClient = prefs.clientType || "builtin";
  /** Play-only (ephemeral) needs the built-in engine. */
  const canPlay = primaryClient === "builtin";
  const canSend = Boolean(torrent.magnet || torrent.torrentUrl);

  function infoHashForPlayback(): string | null {
    const direct = torrent.infoHash?.trim().toLowerCase();
    if (direct) return direct;
    const xt = /(?:^|[?&])xt=urn:btih:([^&]+)/i.exec(torrent.magnet ?? "")?.[1];
    if (!xt) return null;
    try {
      return decodeURIComponent(xt).trim().toLowerCase() || null;
    } catch {
      return xt.trim().toLowerCase() || null;
    }
  }

  async function run(
    action: ReleaseAction,
    display: { title: string; subtitle?: string | null },
  ) {
    const play = action === "play";
    if (!session) {
      toast.message(play ? "Sign in to play" : "Sign in to download");
      return;
    }
    // A ref, not the `pending` state, because state updates are async: two
    // clicks inside one tick both read `pending === null` and both send. The
    // `disabled` attribute has the same hole — it only takes effect after the
    // re-render. This closes it synchronously, on the first line that runs.
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setPending(action);
    try {
      const outcome = await cap.run(async ({ overrideStorageCap }) => {
        const res = await fetch("/api/torrent/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            magnet: torrent.magnet,
            torrentUrl: torrent.torrentUrl,
            name: torrent.title,
            source: torrent.source,
            infoHash: torrent.infoHash,
            tags: torrent.tags,
            searchCategory: searchCategory ?? null,
            metadata: torrent.metadata ?? null,
            target: "primary",
            retention: play ? "stream" : "keep",
            ...(overrideStorageCap ? { overrideStorageCap: true } : {}),
          }),
        });
        const body = await res.json();
        // A storage refusal is thrown, not returned, so the shared rule can
        // decide whether it is the owner's cap (offer a choice) or the disk's
        // wont-fit refusal (never overridable). Every other failure keeps its
        // existing shape and falls through to the inline error below.
        if (!body?.ok) {
          const storage = parseStorageOverrideFacts(body?.storage);
          if (storage?.overridable) {
            throw new StorageLimitError(body?.message || "Storage limit", storage);
          }
        }
        return body as { ok?: boolean; message?: string };
      });

      // Declined the confirmation: nothing was sent, so leave no error state.
      if (outcome.status === "cancelled") return;

      const data = outcome.value;
      if (data.ok) {
        if (play) {
          const infoHash = infoHashForPlayback();
          if (infoHash) {
            setPlayback({
              infoHash,
              title: display.title,
              subtitle: display.subtitle ?? null,
            });
            flash("play", { message: "Starting", variant: "success" });
          } else {
            flash("play", { message: "Started", variant: "success" });
          }
        } else {
          toast.success("Downloading");
          flash("download", { message: "Downloading", variant: "success" });
        }
      } else {
        const msg = data.message || "Failed";
        toast.error(msg);
        flash(action, { message: msg, variant: "error" });
      }
    } catch (err) {
      // A refusal that survived the override (or any transport failure) lands
      // here. Report what actually happened rather than always blaming the
      // network — a second storage refusal is not a connectivity problem.
      const msg =
        err instanceof StorageLimitError
          ? err.message
          : err instanceof Error && err.message
            ? err.message
            : "Network error";
      toast.error(msg);
      flash(action, { message: msg, variant: "error" });
    } finally {
      inFlightRef.current = false;
      setPending(null);
    }
  }

  return {
    // Which action is in flight, so only the pressed button shows a spinner
    // while the other stays disabled-but-idle. `sending` remains the
    // "any action in flight" flag the disabled logic reads.
    pending,
    sending: pending !== null,
    canPlay,
    canSend,
    status,
    playback,
    /** Spread onto `<StorageCapDialog />` on whichever surface renders this. */
    storageDialogProps: cap.dialogProps,
    closePlayback: () => setPlayback(null),
    play: (display: { title: string; subtitle?: string | null }) =>
      run("play", display),
    download: (display: { title: string; subtitle?: string | null }) =>
      run("download", display),
  };
}
