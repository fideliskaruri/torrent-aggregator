import type { ReactNode } from "react";
import { Link } from "react-router";
import type { TitleResult } from "./group-titles";
import { cn } from "@/lib/utils";
import { PosterImage } from "@/components/browse/poster-image";

interface TitleResultCardProps {
  title: TitleResult;
  /** Kept for call-site compatibility; ignored — torrents live on the title page. */
  searchCategory?: string;
  /** The top-ranked work renders larger, as the answer to the query. */
  featured?: boolean;
  /**
   * Controls under the text (e.g. the requester's Request button). Only rendered
   * on cards without an href: a button must never sit inside the card link.
   */
  actions?: ReactNode;
}

/**
 * One clickable card per TMDB title.
 *
 * Search is discovery only: poster + name + year + type. The whole card is a
 * single link to the title page. Play / Download / Releases must never run
 * here — torrent matching starts only after the title click.
 */
export function TitleResultCard({
  title,
  featured = false,
  actions,
}: TitleResultCardProps) {
  const typeLabel = mediaTypeLabel(
    title.mediaType,
    title.isSeries,
    title.format,
  );
  const accessibleName = [
    title.name,
    title.year ? String(title.year) : null,
    typeLabel,
    title.status.comingLabel,
  ]
    .filter(Boolean)
    .join(" — ");

  const body = (
    <div className="flex gap-3 sm:gap-4">
      <div
        className={cn(
          "relative aspect-[2/3] shrink-0 self-start overflow-hidden rounded-md bg-[var(--bg-muted)]",
          featured ? "w-20 sm:w-24" : "w-14 sm:w-16",
        )}
      >
        <PosterImage
          src={title.posterUrl}
          title={title.name}
          sizes={featured ? "96px" : "64px"}
        />
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="min-w-0 space-y-1">
          {featured ? (
            <span className="badge badge-accent">Best match</span>
          ) : null}
          <h2
            className={cn(
              "font-medium leading-snug text-[var(--text)]",
              featured
                ? "text-base line-clamp-2 sm:text-lg"
                : "text-sm line-clamp-2",
            )}
          >
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
          </h2>
          <div className="flex flex-wrap items-center gap-1.5">
            {typeLabel ? (
              <span className="badge text-[11px] text-[var(--text-tertiary)]">{typeLabel}</span>
            ) : null}
            {title.status.comingLabel ? (
              <span className="text-[12px] font-medium text-[var(--text-tertiary)]">
                {title.status.comingLabel}
              </span>
            ) : null}
          </div>
        </div>
        {title.overview ? (
          <p className="line-clamp-2 text-[12px] leading-snug text-[var(--text-tertiary)]">
            {title.overview}
          </p>
        ) : null}
        {actions && !title.href ? (
          <div className="mt-1 flex flex-wrap items-center gap-2" data-title-card-actions>
            {actions}
          </div>
        ) : null}
      </div>
    </div>
  );

  const shellClass = cn(
    "surface group relative block scroll-mt-24 transition-colors motion-reduce:transition-none",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
    featured ? "border-[var(--accent)]/60 p-3 sm:p-4" : "p-3 sm:p-4",
    title.status.unreleased && "opacity-60 saturate-[0.35]",
    title.href && "hover:border-[var(--border-strong)]",
  );

  if (!title.href) {
    return (
      <article
        className={shellClass}
        data-title-card
        data-featured-result={featured ? "true" : undefined}
        data-unreleased={title.status.unreleased ? "true" : undefined}
        aria-label={accessibleName}
      >
        {body}
      </article>
    );
  }

  return (
    <Link
      to={title.href}
      aria-label={accessibleName}
      data-card-target="title"
      data-title-card
      data-featured-result={featured ? "true" : undefined}
      data-unreleased={title.status.unreleased ? "true" : undefined}
      className={shellClass}
    >
      {body}
    </Link>
  );
}

function mediaTypeLabel(
  mediaType: string | null | undefined,
  isSeries: boolean,
  format?: string | null,
): string | null {
  const t = (mediaType ?? "").toLowerCase();
  if (t === "movie") return "Movie";
  if (t === "tv" || t === "series") return "Series";
  if (t === "anime") {
    if (format === "MOVIE" || !isSeries) return "Anime film";
    return format === "ONA" || format === "OVA" ? format : "Anime series";
  }
  if (isSeries) return "Series";
  return null;
}

/**
 * Placeholder matching real card geometry so results swapping in never shift
 * the page (no CLS).
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
          <div className="skeleton h-3 w-4/5 rounded" />
        </div>
      </div>
    </div>
  );
}
