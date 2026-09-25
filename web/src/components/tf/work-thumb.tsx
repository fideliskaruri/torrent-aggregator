import {
  isOptimizableImageUrl,
  posterInitial,
  posterTint,
} from "@/components/browse/poster";
import { cn } from "@/lib/utils";

/**
 * The poster a list row wears.
 *
 * Browse had artwork and every other surface did not, so Client, Activity and
 * the Download log read as log files rather than as a media library. This is
 * the shared thumbnail those rows use.
 *
 * Two rules it exists to keep:
 *
 *  - **A tile is not a caption.** The fallback draws one large initial as a
 *    graphic element, not the title again in a box — the row already says the
 *    title, and repeating it in a square is noise pretending to be design.
 *  - **Known provider hosts get the sized image, others a plain `<img>`.**
 *    The host list lives in `components/browse/poster.ts`.
 */
export function TfWorkThumb({
  title,
  posterUrl,
  className,
  sizePx = 44,
}: {
  title: string;
  posterUrl?: string | null;
  className?: string;
  /** Rendered width. Height is always 3:2 of it — posters are 2:3. */
  sizePx?: number;
}) {
  const width = sizePx;
  const height = Math.round(sizePx * 1.5);

  const frame = cn(
    "relative shrink-0 overflow-hidden rounded-[calc(var(--radius)-3px)] border border-[var(--border)]",
    className,
  );

  if (!posterUrl) {
    return (
      <div
        className={frame}
        style={{ width, height, background: posterTint(title) }}
        aria-hidden="true"
      >
        <span
          className="absolute inset-0 flex items-center justify-center font-semibold text-[var(--text-tertiary)]"
          style={{ fontSize: Math.round(sizePx * 0.42) }}
        >
          {posterInitial(title)}
        </span>
      </div>
    );
  }

  return (
    <div className={frame} style={{ width, height, background: "var(--bg-muted)" }}>
      {isOptimizableImageUrl(posterUrl) ? (
        <img
          src={posterUrl}
          loading="lazy"
          decoding="async"
          style={{ color: "transparent" }}
          alt=""
          width={width}
          height={height}
          className="h-full w-full object-cover"
        />
      ) : (
        <img
          src={posterUrl}
          alt=""
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover"
        />
      )}
    </div>
  );
}
