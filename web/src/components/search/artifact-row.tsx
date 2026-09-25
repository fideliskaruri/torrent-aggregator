"use client";

/**
 * One non-video release — the row you pick between when there is no "work".
 *
 * ## Why this is not `ReleaseRow`
 *
 * `ReleaseRow` renders a release *underneath a title*: the work's name is
 * already on screen, so the row shows only which print it is — episode,
 * resolution, source tier, and a Play button. Every one of those assumptions
 * breaks here.
 *
 *  - **There is no title above.** An album, a game, a program or a book has no
 *    TMDB work behind it, so the release name *is* the identity. It has to lead
 *    the row, not be omitted as redundant.
 *  - **Video facts are meaningless.** An album has no resolution; a PDF has no
 *    source tier. Reusing the video fact builder would have printed
 *    "1080p · WEB-DL" on a FLAC rip — a row that looks informative and states
 *    nothing true, which is worse than showing the bare filename.
 *  - **Play is usually a lie.** You cannot stream Photoshop. An album is a
 *    folder of tracks and the player addresses a single file, so Play would
 *    open on one arbitrary track or fail. `scope.playable` decides, and it is
 *    true only for genuine video (anime) — see `search-scopes.ts`.
 *
 * What it *does* share is deliberate: the same `useReleaseActions` hook (so the
 * send path, the storage-cap confirmation and the inline status are identical
 * everywhere), the same size and swarm helpers, and the same tokens. The
 * difference is confined to which facts are shown and which actions exist.
 */

import { ArrowDownToLine, Check, Loader2, Play } from "lucide-react";
import type { TorrentResult } from "@/lib/torrents/types";
import type { SearchScope } from "@/lib/torrents/search-scopes";
import { cn } from "@/lib/utils";
import { PlayOverlay } from "@/components/browse/play-overlay";
import { StorageCapDialog } from "@/components/storage/storage-cap-dialog";
import {
  ActionButton,
  type ActionButtonStatus,
} from "@/components/ui/action-button";
import { artifactActionName, artifactFacts } from "./artifact-facts";
import { seedStrength, sizeFact } from "./release-facts";
import { useReleaseActions } from "./use-release-actions";
import {
  downloadControlFor,
  heldFor,
  invalidateHeldReleases,
  useHeldReleases,
} from "./use-held-releases";

/** Swarm-strength dot colour by tier — token-only, never a raw hex. */
const SEED_DOT: Record<string, string> = {
  strong: "bg-[var(--success)]",
  fair: "bg-[var(--accent)]",
  weak: "bg-[var(--danger)]",
};

export interface ArtifactRowProps {
  torrent: TorrentResult;
  /** Decides the download folder we promise, and whether Play is offered. */
  scope: SearchScope;
}

export function ArtifactRow({ torrent, scope }: ArtifactRowProps) {
  const {
    pending,
    sending,
    canPlay,
    canSend,
    status,
    playback,
    closePlayback,
    storageDialogProps,
    play,
    download,
  } = useReleaseActions(torrent, scope.category ?? undefined);

  const size = sizeFact(torrent);
  const facts = artifactFacts(torrent.title, size);
  const strength = seedStrength(torrent);
  const actionName = artifactActionName(torrent.title, size);
  const display = { title: torrent.title, subtitle: facts.join(" · ") || null };
  // Play is offered only where it can actually work AND the engine supports it.
  const showPlay = scope.playable && canPlay;

  // What the engine already holds for this exact release. Without it the row
  // invited a second Download of something already on disk — which is both the
  // "still clickable" report and the "double downloading" one.
  const { held, refresh } = useHeldReleases();
  const state = heldFor(held, torrent.infoHash, torrent.magnet);
  const control = downloadControlFor(state);

  const statusFor = (action: "play" | "download"): ActionButtonStatus | null =>
    status?.action === action ? status.status : null;

  return (
    <>
      <div
        className="flex flex-col gap-2 border-b border-[var(--border)] py-3 last:border-b-0 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
        data-artifact-row
      >
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {/* The release name leads: with no work above it, this is the only
              thing that says WHAT this is. Two lines on narrow screens rather
              than an ellipsis at 40 characters — these names carry the edition
              and the format, and truncating them removes the decision. */}
          <span
            className="line-clamp-2 break-words text-[13px] font-medium text-[var(--text)] sm:line-clamp-1"
            title={torrent.title}
          >
            {torrent.title}
          </span>

          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {facts.length ? (
              <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px] text-[var(--text-secondary)]">
                {facts.map((fact, i) => (
                  <span key={`${fact}-${i}`} className="contents">
                    {i > 0 ? (
                      <span className="text-[var(--border-strong)]" aria-hidden>
                        ·
                      </span>
                    ) : null}
                    <span className="tabular-nums">{fact}</span>
                  </span>
                ))}
              </span>
            ) : null}

            {/* Swarm strength — for a download this is "will it ever finish?" */}
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
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {showPlay ? (
            <ActionButton
              type="button"
              data-action="play"
              aria-label={`Play ${actionName}`}
              disabled={sending || !canSend}
              onClick={() => void play(display)}
              className="btn btn-secondary min-h-11 px-3 text-[13px] sm:min-h-10"
              status={statusFor("play")}
            >
              {pending === "play" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
              Play
            </ActionButton>
          ) : null}
          <ActionButton
            type="button"
            data-action="download"
            data-held={state.state}
            aria-label={
              control.hint
                ? `${control.label} — ${actionName}. ${control.hint}.`
                : `Download ${actionName}`
            }
            title={control.hint ?? undefined}
            disabled={sending || !canSend || control.disabled}
            onClick={() => {
              // Guard the click itself, not just the attribute. React state is
              // async, so a fast second press can land before the disabled
              // re-render — and each press was its own send.
              if (control.disabled || sending) return;
              void download(display).finally(() => {
                // The row must reflect the new reality immediately, or it goes
                // on offering a download that already started.
                invalidateHeldReleases();
                refresh();
              });
            }}
            className="btn btn-primary min-h-11 px-3 text-[13px] sm:min-h-10"
            status={statusFor("download")}
          >
            {pending === "download" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : state.state === "downloaded" ? (
              <Check className="h-3.5 w-3.5" />
            ) : (
              <ArrowDownToLine className="h-3.5 w-3.5" />
            )}
            {control.label}
          </ActionButton>
        </div>
      </div>

      {playback ? (
        <PlayOverlay
          infoHash={playback.infoHash}
          title={playback.title}
          subtitle={playback.subtitle}
          onClose={closePlayback}
        />
      ) : null}
      <StorageCapDialog {...storageDialogProps} />
    </>
  );
}
