"use client";

import { ArrowDownToLine, Loader2, Play } from "lucide-react";
import type { TorrentResult } from "@/lib/torrents/types";
import { cn } from "@/lib/utils";
import { PlayOverlay } from "@/components/browse/play-overlay";
import {
  ActionButton,
  type ActionButtonStatus,
} from "@/components/ui/action-button";
import { releaseFacts, releaseQualityName } from "./release-facts";
import { useReleaseActions } from "./use-release-actions";

interface ReleaseRowProps {
  torrent: TorrentResult;
  /** The work's display name — the only title text a row is allowed to carry. */
  titleName: string;
  searchCategory?: string;
  /** Future-gated works disable every action. */
  disabled?: boolean;
}

/**
 * One release under an expanded title — a quality choice, not a scene name.
 *
 * The product forbids narrating mechanism here: no seeders, sizes, Health %,
 * indexer names, `SxxExx`, or raw release names. A row therefore shows only
 * what a viewer picks between — a resolution and a source tier — and the two
 * actions, Play and Download. Everything else the old card carried (paths,
 * category badges, advanced-send panels, library season pickers) belonged to
 * the title page, not to a one-line choice inside a search result.
 */
export function ReleaseRow({
  torrent,
  titleName,
  searchCategory,
  disabled = false,
}: ReleaseRowProps) {
  const {
    sending,
    canPlay,
    canSend,
    status,
    playback,
    closePlayback,
    play,
    download,
  } = useReleaseActions(torrent, searchCategory);

  const facts = releaseFacts(torrent);
  const quality = releaseQualityName(torrent);
  const display = { title: titleName, subtitle: quality };
  const blocked = disabled || !canSend;

  const statusFor = (action: "play" | "download"): ActionButtonStatus | null =>
    status?.action === action ? status.status : null;

  return (
    <>
      <div
        className="flex items-center justify-between gap-3 py-2"
        data-release-row
      >
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-1">
          {facts.length ? (
            facts.map((fact, i) => (
              <span key={fact} className="contents">
                {i > 0 ? (
                  <span className="text-[var(--border-strong)]" aria-hidden>
                    ·
                  </span>
                ) : null}
                <span className="text-[13px] text-[var(--text-secondary)]">
                  {fact}
                </span>
              </span>
            ))
          ) : (
            <span className="text-[13px] text-[var(--text-tertiary)]">
              Standard
            </span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <ActionButton
            type="button"
            data-action="play"
            aria-label={`Play ${titleName} — ${quality}`}
            disabled={sending || blocked || !canPlay}
            onClick={() => void play(display)}
            className="btn btn-primary min-h-8 px-3 text-[13px]"
            status={statusFor("play")}
          >
            {sending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            Play
          </ActionButton>
          <ActionButton
            type="button"
            data-action="download"
            aria-label={`Download ${titleName} — ${quality}`}
            disabled={sending || blocked}
            onClick={() => void download(display)}
            className="btn btn-secondary min-h-8 px-3 text-[13px]"
            status={statusFor("download")}
          >
            {sending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ArrowDownToLine className="h-3.5 w-3.5" />
            )}
            Download
          </ActionButton>
        </div>
      </div>

      {/* Kept for keyboard/e2e reach without spending row width. */}
      {torrent.magnet ? (
        <a
          href={torrent.magnet}
          className={cn("sr-only")}
          data-action="magnet"
          tabIndex={-1}
          aria-hidden
        >
          Magnet
        </a>
      ) : null}

      {playback ? (
        <PlayOverlay
          infoHash={playback.infoHash}
          title={playback.title}
          subtitle={playback.subtitle}
          onClose={closePlayback}
        />
      ) : null}
    </>
  );
}
