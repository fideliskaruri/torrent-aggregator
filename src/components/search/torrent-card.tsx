"use client";

import { ArrowDownToLine, Loader2, Play } from "lucide-react";
import type { TorrentResult } from "@/lib/torrents/types";
import { cn } from "@/lib/utils";
import { PlayOverlay } from "@/components/browse/play-overlay";
import {
  ActionButton,
  type ActionButtonStatus,
} from "@/components/ui/action-button";
import {
  episodeLabel,
  releaseFacts,
  releaseQualityName,
  seedStrength,
} from "./release-facts";
import { useReleaseActions } from "./use-release-actions";

/** Swarm-strength dot colour by tier — token-only, never a raw hex. */
const SEED_DOT: Record<string, string> = {
  strong: "bg-[var(--success)]",
  fair: "bg-[var(--accent)]",
  weak: "bg-[var(--danger)]",
};

interface ReleaseRowProps {
  torrent: TorrentResult;
  /** The work's display name — the only title text a row is allowed to carry. */
  titleName: string;
  searchCategory?: string;
  /** Future-gated works disable every action. */
  disabled?: boolean;
}

/**
 * One release under an expanded title — the row a viewer picks between.
 *
 * A picker is not the watch surface: here the distinguishing facts *are* the
 * product, because a series otherwise renders a dozen rows that all read
 * "1080p · WEB-DL". So a row leads with which episode/season it is, then
 * resolution · source · size, and a swarm-strength dot that says whether Play
 * will actually start — each as its own element with real separators, never an
 * adjacent-text blob. All of that string-building lives in `release-facts.ts`;
 * this component only lays it out and wires the two actions, Play and Download.
 * Indexer names, Health %, and raw scene names are still withheld.
 */
export function ReleaseRow({
  torrent,
  titleName,
  searchCategory,
  disabled = false,
}: ReleaseRowProps) {
  const {
    pending,
    sending,
    canPlay,
    canSend,
    status,
    playback,
    closePlayback,
    play,
    download,
  } = useReleaseActions(torrent, searchCategory);

  const episode = episodeLabel(torrent);
  const facts = releaseFacts(torrent);
  const strength = seedStrength(torrent);
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
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          {/* Episode/season — the strongest differentiator, rendered first and
              with emphasis so a series' rows read apart at a glance. */}
          {episode ? (
            <span className="text-[13px] font-medium tabular-nums text-[var(--text)]">
              {episode}
            </span>
          ) : null}

          {/* Resolution · source · size — the muted, curated middle facts. */}
          {facts.length ? (
            <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] text-[var(--text-secondary)]">
              {facts.map((fact, i) => (
                <span key={fact} className="contents">
                  {i > 0 || episode ? (
                    <span className="text-[var(--border-strong)]" aria-hidden>
                      ·
                    </span>
                  ) : null}
                  <span className="tabular-nums">{fact}</span>
                </span>
              ))}
            </span>
          ) : !episode ? (
            <span className="text-[13px] text-[var(--text-tertiary)]">
              Standard
            </span>
          ) : null}

          {/* Swarm strength — will it actually play? A coloured dot plus the
              live seeder count, so 300 seeds reads apart from 1. */}
          <span
            className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--bg-muted)] px-2 py-0.5 text-[12px] text-[var(--text-secondary)]"
            title={strength.label}
            data-seed-strength={strength.level}
          >
            <span
              className={cn(
                "h-1.5 w-1.5 shrink-0 rounded-full",
                SEED_DOT[strength.level],
              )}
              aria-hidden
            />
            <span className="tabular-nums" aria-hidden>
              {strength.count}
            </span>
            <span className="sr-only">
              {strength.count === 1 ? "seeder" : "seeders"}
            </span>
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <ActionButton
            type="button"
            data-action="play"
            aria-label={`Play ${titleName} — ${quality}`}
            disabled={sending || blocked || !canPlay}
            onClick={() => void play(display)}
            className="btn btn-primary min-h-11 px-3 text-[13px] sm:min-h-10"
            status={statusFor("play")}
          >
            {pending === "play" ? (
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
            className="btn btn-secondary min-h-11 px-3 text-[13px] sm:min-h-10"
            status={statusFor("download")}
          >
            {pending === "download" ? (
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
