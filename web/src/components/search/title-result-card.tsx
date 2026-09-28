import type { ReactNode } from "react";
import { Link } from "react-router";
import type { TitleResult } from "./group-titles";
import { cn } from "@/lib/utils";
import { PosterImage } from "@/components/browse/poster-image";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { requestViewFor } from "@/lib/requests";

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
  const request = title.request
    ? requestViewFor(title.request, title.isSeries)
    : null;
  const accessibleName = [
    title.name,
    title.year ? String(title.year) : null,
    typeLabel,
    title.status.comingLabel,
    request?.label,
  ]
    .filter(Boolean)
    .join(", ");

  const body = (
    <div className="flex gap-3 sm:gap-4">
      <div
        className={cn(
          "relative aspect-[2/3] shrink-0 self-start overflow-hidden rounded-md bg-muted",
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
            <Badge variant="accent">Best match</Badge>
          ) : null}
          <h2
            className={cn(
              "font-medium leading-snug text-foreground break-words",
              featured
                ? "text-base line-clamp-2 sm:text-lg"
                : "text-sm line-clamp-2",
            )}
          >
            <span>{title.name}</span>
            {title.year ? (
              <>
                <span
                  className="mx-1.5 text-subtle-foreground"
                  aria-hidden
                >
                  ·
                </span>
                <span className="font-normal tabular-nums text-subtle-foreground">
                  {title.year}
                </span>
              </>
            ) : null}
          </h2>
          <div className="flex flex-wrap items-center gap-1.5">
            {typeLabel ? (
              <Badge variant="outline" className="text-[12px] text-muted-foreground">{typeLabel}</Badge>
            ) : null}
            {title.status.comingLabel ? (
              <span className="text-[12px] font-medium text-subtle-foreground">
                {title.status.comingLabel}
              </span>
            ) : null}
            {request?.label ? (
              <Badge
                variant={request.tone}
                data-title-request-status={
                  title.request?.inLibrary
                    ? "available"
                    : (title.request?.requestStatus ?? "")
                }
              >
                {request.label}
              </Badge>
            ) : null}
          </div>
        </div>
        {title.overview ? (
          <p className="hidden line-clamp-2 text-[12px] leading-snug text-subtle-foreground sm:block">
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
    "group relative block scroll-mt-24 rounded-xl outline-none",
    "focus-visible:ring-2 focus-visible:ring-ring",
    title.status.unreleased && "opacity-60 saturate-[0.35]",
  );
  const card = (
    <Card
      className={cn(
        "gap-0 py-0 p-3 transition-shadow motion-reduce:transition-none sm:p-4",
        featured && "ring-brand/60",
        title.href && "group-hover:ring-foreground/25",
      )}
    >
      {body}
    </Card>
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
        {card}
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
      {card}
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
    <Card
      className={cn("gap-0 py-0 p-3 sm:p-4", featured && "ring-brand/30")}
      aria-hidden
      data-title-card-skeleton
    >
      <div className="flex gap-3 sm:gap-4">
        <Skeleton
          className={cn(
            "aspect-[2/3] shrink-0",
            featured ? "w-20 sm:w-24" : "w-14 sm:w-16",
          )}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <Skeleton className="h-4 w-3/5" />
          <Skeleton className="h-3 w-1/4" />
          <Skeleton className="h-3 w-4/5" />
        </div>
      </div>
    </Card>
  );
}