"use client";

import Image from "next/image";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { isOptimizableImageUrl, posterInitial, posterTint } from "./poster";

/**
 * Artwork for a card or hero, with the no-artwork case treated as normal.
 *
 * Most torrent releases have no poster — the engine rows that feed "Ready to
 * Play" store none at all, and the metadata join that might supply one misses
 * often — so the fallback is not an error path, it is a layout a large share of
 * cards will actually use. It therefore gets a designed surface instead of a
 * grey box: a deterministic tint keyed off the title, a hairline, and the
 * initial ghosted into the corner as a mark. A rail full of these should still
 * look composed. It deliberately sets no words: every caller already prints the
 * title next to it.
 *
 * Three states, not two: optimised image for hosts `next/image` knows, plain
 * image for anything else, and the designed tile when there is no URL *or* the
 * URL fails to load.
 *
 * The caller owns the box and its aspect ratio; this fills it absolutely, so
 * nothing reflows when an image arrives late.
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
  /** Passed straight to `next/image`; required for a `fill` image to be sized. */
  sizes: string;
  priority?: boolean;
  /**
   * Sizes the ghosted initial on the no-artwork tile. `plain` is the hero's
   * much larger mark; `card` is the rail poster's.
   */
  variant?: "card" | "plain";
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const usable = src && !failed ? src : null;

  if (!usable) {
    return <FallbackTile title={title} variant={variant} className={className} />;
  }

  if (isOptimizableImageUrl(usable)) {
    return (
      <Image
        src={usable}
        alt=""
        fill
        sizes={sizes}
        priority={priority}
        onError={() => setFailed(true)}
        className={cn("object-cover", className)}
      />
    );
  }

  return (
    // A self-hosted install can point at any image host, and an unknown host
    // makes `next/image` throw at request time rather than degrade — so unknown
    // hosts get a plain tag that can only ever fall through to the tile above.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={usable}
      alt=""
      loading={priority ? "eager" : "lazy"}
      decoding="async"
      onError={() => setFailed(true)}
      className={cn("absolute inset-0 h-full w-full object-cover", className)}
    />
  );
}

/**
 * The designed no-artwork tile.
 *
 * Same language as the initial tile already used by search rows, library cards
 * and the recommendation rail (`docs/handover.md`: a missing poster renders an
 * initial, never an empty box, because an empty box is pixel-identical to the
 * loading skeleton). Those live in 40–56px thumbnails where a centred letter is
 * all that fits; a 124–168px browse poster has room to say more, so the same
 * `--bg-muted`-based surface and `--text-tertiary` initial carry the release
 * text as well. Posters miss reliably for manually-added magnets, so this is a
 * layout a large share of cards will use, not a degraded one.
 *
 * Layout is built around what sits on top of it in a card: the availability
 * chip claims the top-left, a search affordance the top-right, and the action
 * row the bottom strip. The tile therefore carries no words of its own — the
 * card sets the title and subtitle in a caption immediately below it, and the
 * hero sets the title in an h1 directly over it, so printing them here too
 * rendered every poster-less card with its name twice, eight pixels apart.
 * That read as a rendering bug rather than a design, which is precisely the
 * reason the hero variant already existed. What is left is the mark: a
 * deterministic tint and the ghosted initial, pushed to the lower-right where
 * nothing else lands. `aria-hidden` throughout — the card's own label already
 * carries the title, and reading it twice helps nobody.
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
      className={cn("absolute inset-0 select-none overflow-hidden", className)}
      style={{ background: posterTint(title) }}
    >
      {/* A hairline inside the tile, so a tinted surface still reads as a
          deliberate object next to cards that do have art. */}
      <span className="absolute inset-0 rounded-[inherit] ring-1 ring-inset ring-[color-mix(in_srgb,var(--text)_7%,transparent)]" />

      <span
        className={cn(
          "pointer-events-none absolute select-none font-semibold leading-none text-[var(--text-tertiary)]",
          variant === "card"
            ? "-bottom-[0.18em] -right-[0.06em] text-[5.5rem] opacity-25"
            : "-bottom-[0.16em] -right-[0.04em] text-[12rem] opacity-15",
        )}
      >
        {posterInitial(title)}
      </span>
    </div>
  );
}
