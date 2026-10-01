import { PosterImage } from "@/components/browse/poster-image";
import { cn } from "@/lib/utils";

/**
 * The poster a list row wears.
 *
 * Browse had artwork and every other surface did not, so Client, Activity and
 * the Download log read as log files rather than as a media library. This is
 * the shared thumbnail those rows use: a fixed 2:3 frame around the same
 * `PosterImage` every poster box uses, so a row keeps its height while the art
 * loads, fades it in over a skeleton, and falls back to the initial tile when
 * there is none.
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
  return (
    <div
      className={cn(
        "relative shrink-0 overflow-hidden rounded-[calc(var(--radius)-3px)] border border-[var(--border)] bg-muted",
        className,
      )}
      style={{ width: sizePx, height: Math.round(sizePx * 1.5) }}
    >
      <PosterImage src={posterUrl ?? null} title={title} sizes={`${sizePx}px`} />
    </div>
  );
}