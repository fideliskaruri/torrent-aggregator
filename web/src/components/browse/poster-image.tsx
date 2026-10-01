import { useCallback, useState, type CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { isOptimizableImageUrl, posterInitial, posterTint } from "./poster";

const FILL: CSSProperties = {
  position: "absolute",
  height: "100%",
  width: "100%",
  inset: 0,
  color: "transparent",
};

/**
 * Artwork for a card, row thumbnail or hero, with the no-artwork case treated
 * as normal.
 *
 * The caller owns the box and its aspect ratio; this fills it absolutely, so
 * nothing reflows when an image arrives late. Inside that box there are three
 * states, and each one has a look:
 *
 *  - **Loading:** a pulsing skeleton in the poster's own box. The image fades
 *    in over it once decoded, so a rail fills in quietly instead of popping
 *    card by card.
 *  - **Loaded:** the image, `object-cover`.
 *  - **No artwork, or the URL failed:** the designed tile below.
 *
 * Only the hero and the first visible row pass `priority`; everything else is
 * lazy and decodes off the main thread.
 */
export function PosterImage({
  src,
  title,
  sizes,
  priority = false,
  variant = "card",
  className,
}: {
  src: string | null;
  title: string;
  /** The `<img>` `sizes` hint for the filled poster box. */
  sizes: string;
  priority?: boolean;
  /**
   * `plain` is the hero backdrop: a large ghosted initial and no words, since
   * the hero sets the title over it. `card` is every poster box, from a 40px
   * row thumbnail to a rail poster; it sizes itself to its box.
   */
  variant?: "card" | "plain";
  className?: string;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const usable = src && failedSrc !== src ? src : null;
  const loaded = usable != null && loadedSrc === usable;

  // A cached image can finish before React attaches onLoad; check on mount.
  const imgRef = useCallback(
    (img: HTMLImageElement | null) => {
      if (img && usable && img.complete && img.naturalWidth > 0) setLoadedSrc(usable);
    },
    [usable],
  );

  if (!usable) {
    return <FallbackTile title={title} variant={variant} className={className} />;
  }

  const optimizable = isOptimizableImageUrl(usable);
  return (
    <>
      {loaded ? null : (
        <span
          aria-hidden
          data-poster-pending
          className="absolute inset-0 animate-pulse bg-muted motion-reduce:animate-none"
        />
      )}
      <img
        ref={imgRef}
        src={usable}
        alt=""
        loading={priority ? "eager" : "lazy"}
        fetchPriority={priority ? "high" : "auto"}
        decoding="async"
        // Known provider hosts get the sizes hint; any other host a
        // self-hosted install points at gets a plain tag.
        sizes={optimizable ? sizes : undefined}
        style={FILL}
        onLoad={() => setLoadedSrc(usable)}
        onError={() => setFailedSrc(usable)}
        className={cn(
          "object-cover transition-opacity duration-300 ease-out motion-reduce:transition-none",
          loaded ? "opacity-100" : "opacity-0",
          className,
        )}
      />
    </>
  );
}

/**
 * The designed no-artwork tile.
 *
 * Posters miss reliably for manually added magnets and for releases the
 * metadata join cannot name, so this is a layout a large share of boxes will
 * use, not a degraded one. It must never look like an empty box: an empty
 * tinted box is indistinguishable from a card that failed to render.
 *
 * It is a size container and adapts to its box. A poster big enough to read
 * (a rail card, the title page) sets the title itself in the middle of the
 * tile, clear of the availability chip at the top and the action row at the
 * bottom, with the ghosted initial as a mark in the corner. A row thumbnail
 * (40 to 88px) has room only for the initial, centred. The hero (`plain`)
 * keeps the large mark and no words, because its h1 sits directly over it.
 * `aria-hidden` throughout: the card's own label already carries the title.
 */
function FallbackTile({
  title,
  variant,
  className,
}: {
  title: string;
  variant: "card" | "plain";
  className?: string;
}) {
  return (
    <div
      aria-hidden
      data-poster-fallback
      className={cn("@container absolute inset-0 select-none overflow-hidden", className)}
      style={{ background: posterTint(title) }}
    >
      {/* A hairline inside the tile, so a tinted surface still reads as a
          deliberate object next to cards that do have art. */}
      <span className="absolute inset-0 rounded-[inherit] ring-1 ring-inset ring-foreground/7" />

      {variant === "plain" ? (
        <span className="pointer-events-none absolute -bottom-[0.16em] -right-[0.04em] font-semibold leading-none text-subtle-foreground text-[12rem] opacity-15">
          {posterInitial(title)}
        </span>
      ) : (
        <>
          {/* Thumbnail: the initial alone, centred. */}
          <span className="absolute inset-0 flex items-center justify-center font-semibold leading-none text-subtle-foreground text-[42cqw] @min-[6rem]:hidden">
            {posterInitial(title)}
          </span>
          {/* Poster: the title in words, with the initial as a quiet mark. */}
          <span className="pointer-events-none absolute -bottom-[0.18em] -right-[0.06em] hidden font-semibold leading-none text-subtle-foreground text-[60cqw] opacity-20 @min-[6rem]:block">
            {posterInitial(title)}
          </span>
          <span className="absolute inset-x-0 top-1/2 hidden -translate-y-1/2 px-3 text-center @min-[6rem]:block">
            <span className="line-clamp-4 text-balance break-words text-[13px] font-semibold leading-snug text-foreground @min-[10rem]:text-[15px]">
              {title}
            </span>
          </span>
        </>
      )}
    </div>
  );
}
