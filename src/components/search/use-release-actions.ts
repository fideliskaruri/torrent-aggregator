"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useSession } from "@/components/providers/session-provider";
import { useDownloadPrefs } from "@/hooks/use-download-prefs";
import type { TorrentResult } from "@/lib/torrents/types";
import type { ActionButtonStatus } from "@/components/ui/action-button";

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
  const [sending, setSending] = useState(false);
  const [playback, setPlayback] = useState<ReleasePlayback | null>(null);
  const [status, setStatus] = useState<{
    action: ReleaseAction;
    status: ActionButtonStatus;
  } | null>(null);
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    setSending(true);
    try {
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
        }),
      });
      const data = await res.json();
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
    } catch {
      toast.error("Network error");
      flash(action, { message: "Network error", variant: "error" });
    } finally {
      setSending(false);
    }
  }

  return {
    sending,
    canPlay,
    canSend,
    status,
    playback,
    closePlayback: () => setPlayback(null),
    play: (display: { title: string; subtitle?: string | null }) =>
      run("play", display),
    download: (display: { title: string; subtitle?: string | null }) =>
      run("download", display),
  };
}
