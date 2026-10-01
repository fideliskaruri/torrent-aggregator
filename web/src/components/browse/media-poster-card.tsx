import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { PosterImage } from "./poster-image";

/**
 * The one poster box for a title, wherever it appears.
 *
 * - `rail`: a browse card, More like this, recommendations. Fills its column.
 * - `search`: the thumbnail beside a search result (`featured` is the best match).
 * - `library`: the thumbnail on a library card.
 * - `row`: a list row thumbnail (requests, upcoming).
 * - `episode`: an episode still, a tall thumbnail on phones and 16:9 from `sm`.
 *
 * The box owns geometry, the artwork, the gated look (greyscale, so a title
 * that cannot be fetched yet never reads as ready) and a top-left chip slot.
 * `MediaPosterSkeleton` draws the same box, so swapping one for the other
 * never moves the page.
 */
/** A card in a scrolling rail: fixed width per breakpoint. */
export const RAIL_CARD_WIDTH = "w-[124px] sm:w-[148px] lg:w-[168px]";

export type MediaPosterVariant = "rail" | "search" | "library" | "row" | "episode";

const BOX: Record<MediaPosterVariant, string> = {
  rail: "aspect-[2/3] w-full rounded-lg border border-border",
  search: "aspect-[2/3] w-14 shrink-0 self-start rounded-md sm:w-16",
  library: "aspect-[2/3] w-[4.5rem] shrink-0 rounded-md sm:w-[5.5rem]",
  row: "aspect-[2/3] w-12 shrink-0 self-start rounded-md sm:w-14",
  episode: "h-24 w-16 shrink-0 sm:aspect-video sm:h-auto sm:w-full",
};
const FEATURED_SEARCH = "aspect-[2/3] w-20 shrink-0 self-start rounded-md sm:w-24";

const SIZES: Record<MediaPosterVariant, string> = {
  rail: "(min-width: 1024px) 200px, (min-width: 640px) 180px, 124px",
  search: "64px",
  library: "(min-width: 640px) 88px, 72px",
  row: "56px",
  episode: "(min-width: 640px) 300px, 64px",
};

function boxClass(variant: MediaPosterVariant, featured: boolean) {
  return variant === "search" && featured ? FEATURED_SEARCH : BOX[variant];
}

export function MediaPoster({
  variant,
  src,
  title,
  featured = false,
  gated = false,
  dimmed = false,
  priority = false,
  sizes,
  chip,
  className,
  children,
  image,
  ...data
}: {
  variant: MediaPosterVariant;
  src: string | null | undefined;
  title: string;
  /** The search page's best match draws a larger thumbnail. */
  featured?: boolean;
  /** Not out yet, or in cinemas: greyscale and muted. */
  gated?: boolean;
  /** Blocked but not gated: slightly muted. */
  dimmed?: boolean;
  priority?: boolean;
  /** Overrides the variant's `<img>` sizes hint, for a box sized by its grid. */
  sizes?: string;
  /** Top-left chip: `ReleaseGateChip` or `AvailabilityChip`. */
  chip?: ReactNode;
  className?: string;
  /** Overlays inside the box (links, badges, progress). */
  children?: ReactNode;
  /** Replaces the default artwork, for a caller that memoises its image. */
  image?: ReactNode;
} & { [key: `data-${string}`]: string | boolean | undefined }) {
  return (
    <span
      {...data}
      data-media-poster={variant}
      className={cn(
        "relative block overflow-hidden bg-muted",
        boxClass(variant, featured),
        gated && "grayscale opacity-80",
        !gated && dimmed && "opacity-75",
        className,
      )}
    >
      {image ?? (
        <PosterImage
          src={src ?? null}
          title={title}
          sizes={sizes ?? (variant === "search" && featured ? "96px" : SIZES[variant])}
          priority={priority}
        />
      )}
      {chip ? <span className="absolute left-1.5 top-1.5 z-[1] max-w-[calc(100%-0.75rem)]">{chip}</span> : null}
      {children}
    </span>
  );
}

/** The caption under a `rail` poster: two lines of title and one of facts, always that tall. */
export function MediaPosterCaption({
  title,
  fullTitle,
  subtitle,
}: {
  title: string;
  /** Hover text when the shown title was cleaned. */
  fullTitle?: string;
  subtitle?: ReactNode;
}) {
  return (
    <span className="mt-2 block min-h-[2.75rem] min-w-0">
      <span
        title={fullTitle ?? title}
        className="line-clamp-2 break-words text-[12px] font-medium leading-snug text-foreground"
      >
        {title}
      </span>
      {subtitle ? (
        <span className="mt-0.5 block truncate text-[12px] tabular-nums text-subtle-foreground">
          {subtitle}
        </span>
      ) : null}
    </span>
  );
}

/** Placeholder with the poster's exact box, plus the rail caption when asked. */
export function MediaPosterSkeleton({
  variant,
  featured = false,
  caption = variant === "rail",
  className,
}: {
  variant: MediaPosterVariant;
  featured?: boolean;
  caption?: boolean;
  className?: string;
}) {
  return (
    <>
      <Skeleton className={cn(boxClass(variant, featured), "border-0", className)} />
      {caption ? (
        <span className="mt-2 block min-h-[2.75rem]" aria-hidden>
          <Skeleton className="h-3 w-4/5 rounded" />
          <Skeleton className="mt-1.5 h-2.5 w-2/5 rounded" />
        </span>
      ) : null}
    </>
  );
}
