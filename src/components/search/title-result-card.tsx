"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowDownToLine, ChevronDown, Loader2, Play } from "lucide-react";
import type { TitleResult } from "./group-titles";
import { cn } from "@/lib/utils";
import { PlayOverlay } from "@/components/browse/play-overlay";
import {
  ActionButton,
  type ActionButtonStatus,
} from "@/components/ui/action-button";
import { ReleaseRow } from "./torrent-card";
import { useReleaseActions } from "./use-release-actions";

interface TitleResultCardProps {
  title: TitleResult;
  searchCategory?: string;
  /** The top-ranked work renders larger, as the answer to the query. */
  featured?: boolean;
}

/** Bound the DOM: a work can have dozens of prints; the expander shows a slice. */
const MAX_RELEASES = 12;

/**
 * One card per work — the title-centric result.
 *
 * **The whole card opens the title page** (the user's rule): the body is a
 * `<Link>` layered behind the content, so a click anywhere that is not a
 * control navigates, while Play, Download and the expander sit above it and
 * stop there. Making the body an `<a>` rather than an `onClick` is what keeps
 * middle-click and "open in new tab" working.
 *
 * A future-dated work (per `releaseStatus`) is grayed and labelled
 * "Coming {date}", with Play/Download disabled and the expander hidden — a dead
 * Play that resolves to nothing is exactly what the gate exists to prevent.
 * Unknown dates are never gated.
 */
export function TitleResultCard({
  title,
  searchCategory,
  featured = false,
}: TitleResultCardProps) {
  const [expanded, setExpanded] = useState(false);
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
  } = useReleaseActions(title.best, searchCategory);

  const unreleased = title.status.unreleased;
  const display = { title: title.name, subtitle: null as string | null };
  const blocked = unreleased || !canSend;
  const releases = title.releases.slice(0, MAX_RELEASES);
  const hasReleases = title.releases.length > 0;

  const statusFor = (action: "play" | "download"): ActionButtonStatus | null =>
    status?.action === action ? status.status : null;

  const posterInitial =
    (title.name || "?").trim().charAt(0).toUpperCase() || "?";

  const accessibleName = [
    title.name,
    title.year ? String(title.year) : null,
    title.status.comingLabel,
  ]
    .filter(Boolean)
    .join(" — ");

  return (
    <>
      <article
        className={cn(
          "surface group relative scroll-mt-24 transition-colors motion-reduce:transition-none",
          "focus-within:ring-2 focus-within:ring-[var(--accent)]",
          featured ? "border-[var(--accent)]/60 p-3 sm:p-4" : "p-3 sm:p-4",
          unreleased && "opacity-60 saturate-[0.35]",
        )}
        data-torrent-card
        data-title-card
        data-featured-result={featured ? "true" : undefined}
        data-unreleased={unreleased ? "true" : undefined}
      >
        {/* The body link fills the card and sits beneath the content. Content is
            pointer-events-none so clicks fall through to it; controls opt back
            in with pointer-events-auto. */}
        {title.href ? (
          <Link
            href={title.href}
            aria-label={accessibleName}
            data-card-target="title"
            className="absolute inset-0 z-0 rounded-[var(--radius)] outline-none"
          />
        ) : null}

        <div className="pointer-events-none relative z-10 flex gap-3 sm:gap-4">
          {/* Poster */}
          <div
            className={cn(
              "relative shrink-0 self-start overflow-hidden rounded-md bg-[var(--bg-muted)]",
              featured ? "w-20 sm:w-24" : "w-14 sm:w-16",
            )}
          >
            {title.posterUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={title.posterUrl}
                alt=""
                className="aspect-[2/3] w-full object-cover"
              />
            ) : (
              <div
                className="flex aspect-[2/3] w-full items-center justify-center"
                aria-hidden
              >
                <span className="select-none text-2xl font-semibold text-[var(--text-tertiary)]">
                  {posterInitial}
                </span>
              </div>
            )}
          </div>

          {/* Content column */}
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="min-w-0 space-y-1">
              {featured ? (
                <span className="badge badge-accent pointer-events-none">
                  Best match
                </span>
              ) : null}
              <h3
                className={cn(
                  "font-medium leading-snug text-[var(--text)]",
                  featured
                    ? "text-base line-clamp-2 sm:text-lg"
                    : "text-sm line-clamp-2",
                )}
              >
                {/* Title and year are separate nodes with a real separator —
                    never "Dune1984". */}
                <span>{title.name}</span>
                {title.year ? (
                  <>
                    <span
                      className="mx-1.5 text-[var(--border-strong)]"
                      aria-hidden
                    >
                      ·
                    </span>
                    <span className="font-normal tabular-nums text-[var(--text-tertiary)]">
                      {title.year}
                    </span>
                  </>
                ) : null}
              </h3>
              {title.status.comingLabel ? (
                <p className="text-[12px] font-medium text-[var(--text-tertiary)]">
                  {title.status.comingLabel}
                </p>
              ) : null}
            </div>

            {/* Actions — Play, Download, and an expander for releases. */}
            <div className="pointer-events-auto flex flex-wrap items-center gap-2">
              <ActionButton
                type="button"
                data-action="play"
                aria-label={`Play ${title.name}`}
                disabled={sending || blocked || !canPlay}
                onClick={() => void play(display)}
                className="btn btn-primary min-h-11 px-3 text-[13px]"
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
                aria-label={`Download ${title.name}`}
                disabled={sending || blocked}
                onClick={() => void download(display)}
                className="btn btn-secondary min-h-11 px-3 text-[13px]"
                status={statusFor("download")}
              >
                {pending === "download" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ArrowDownToLine className="h-3.5 w-3.5" />
                )}
                Download
              </ActionButton>
              {!unreleased && hasReleases ? (
                <button
                  type="button"
                  data-action="expand-releases"
                  aria-expanded={expanded}
                  aria-label={
                    expanded ? "Hide other releases" : "Show other releases"
                  }
                  onClick={() => setExpanded((v) => !v)}
                  className="btn btn-ghost min-h-11 px-2 text-[12px] text-[var(--text-tertiary)]"
                >
                  <ChevronDown
                    className={cn(
                      "h-4 w-4 transition-transform motion-reduce:transition-none",
                      expanded && "rotate-180",
                    )}
                  />
                  Releases
                </button>
              ) : null}
            </div>
          </div>
        </div>

        {/* Releases — hidden by default; a plain list of quality choices. */}
        {expanded && !unreleased ? (
          <div className="pointer-events-auto relative z-10 mt-2 divide-y divide-[var(--border)] border-t border-[var(--border)] pt-1">
            {releases.map((release) => (
              <ReleaseRow
                key={release.id}
                torrent={release}
                titleName={title.name}
                searchCategory={searchCategory}
              />
            ))}
          </div>
        ) : null}
      </article>

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

/**
 * A placeholder with a real card's geometry, so results loading in never
 * shift the page (no CLS). Fixed heights, no per-card poster reflow.
 */
export function TitleResultCardSkeleton({
  featured = false,
}: {
  featured?: boolean;
}) {
  return (
    <div
      className={cn("surface p-3 sm:p-4", featured && "border-[var(--accent)]/30")}
      aria-hidden
      data-title-card-skeleton
    >
      <div className="flex gap-3 sm:gap-4">
        <div
          className={cn(
            "skeleton aspect-[2/3] shrink-0 rounded-md",
            featured ? "w-20 sm:w-24" : "w-14 sm:w-16",
          )}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="skeleton h-4 w-3/5 rounded" />
          <div className="skeleton h-3 w-1/4 rounded" />
          <div className="mt-1 flex gap-2">
            <div className="skeleton h-9 w-20 rounded-md" />
            <div className="skeleton h-9 w-24 rounded-md" />
          </div>
        </div>
      </div>
    </div>
  );
}
