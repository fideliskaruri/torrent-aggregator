"use client";

/**
 * "More like this" — the answer to a film page being a hero and then nothing.
 *
 * A series fills the space under the hero with its episode list. A film had
 * no equivalent, so `/title/dune-part-two` was a hero, a quiet link, and then
 * several hundred pixels of black before the footer, which reads as an
 * unfinished page rather than a short one.
 *
 * The fix is content, not explanation: a rail of neighbouring works, each one
 * a link to its own title page, so the page ends in somewhere to go next. When
 * the provider returns nothing this component renders nothing at all — an
 * empty rail with a heading over it would be the same void with a label.
 *
 * The tiles carry no words. The title is printed underneath each one, and a
 * poster that repeats its own caption is the duplicate-title bug this repo has
 * already fixed once.
 */
import Link from "next/link";
import { PosterImage } from "@/components/browse/poster-image";
import { posterTint } from "@/components/browse/poster";
import type { TitleSimilar } from "./types";

export function MoreLikeThis({
  items,
  heading = "More like this",
}: {
  items: TitleSimilar[];
  heading?: string;
}) {
  if (items.length === 0) return null;

  return (
    <section aria-labelledby="title-similar-heading" data-title-similar>
      <h2 id="title-similar-heading" className="text-title">
        {heading}
      </h2>

      <ul className="mt-3 grid grid-cols-3 gap-x-3 gap-y-4 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
        {items.map((item) => (
          <li key={`${item.workKey}:${item.title}:${item.year ?? ""}`}>
            <Link
              href={item.href}
              data-similar-card
              className="group block rounded-[var(--radius)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            >
              <div
                className="relative aspect-[2/3] w-full overflow-hidden rounded-[var(--radius)] border border-[var(--border)] transition-colors group-hover:border-[var(--border-strong)]"
                style={{ background: posterTint(item.title) }}
              >
                <PosterImage
                  src={item.posterUrl}
                  title={item.title}
                  sizes="(min-width: 1024px) 12vw, (min-width: 640px) 22vw, 30vw"
                />
              </div>
              <p
                className="mt-1.5 line-clamp-2 text-[12px] leading-snug text-[var(--text-secondary)] transition-colors group-hover:text-[var(--text)]"
                title={item.title}
              >
                {item.title}
              </p>
              {/* Adjacent inline facts inside a flex row: the whitespace
                  between them is not rendered, because flex generates no
                  anonymous boxes for whitespace-only text. The separator is a
                  real element with real text so it survives — and so a screen
                  reader hears something between "2024" and "8.1". */}
              {item.year != null || item.rating != null ? (
                <span className="mt-0.5 flex items-center text-[11px] tabular-nums text-[var(--text-tertiary)]">
                  {item.year != null ? <span>{item.year}</span> : null}
                  {item.year != null && item.rating != null ? (
                    <span className="mx-1">·</span>
                  ) : null}
                  {item.rating != null ? (
                    <span>{item.rating.toFixed(1)}</span>
                  ) : null}
                </span>
              ) : null}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
