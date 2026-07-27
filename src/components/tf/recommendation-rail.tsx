"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import type { RecommendationRail } from "@/lib/recommend";
import { titleHrefForName } from "@/components/title/work-key";

/**
 * One rail of suggestions, headed with the library title that explains it.
 *
 * Renders nothing at all until there is something to show. The section is a
 * bonus at the bottom of the page — a spinner or an "unavailable" message here
 * would take up more of the user's attention than the feature is worth.
 */
export function RecommendationRailSection({
  onAdded,
  refreshKey,
}: {
  onAdded?: () => void;
  /** Bump when the library changes so a removed seed stops heading the rail. */
  refreshKey?: number;
}) {
  const [rail, setRail] = useState<RecommendationRail | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [broken, setBroken] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/recommendations");
        if (!res.ok) return;
        const data = (await res.json()) as { rail: RecommendationRail | null };
        if (!cancelled) setRail(data.rail);
      } catch {
        // A suggestion shelf is never worth an error message.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const add = useCallback(
    async (item: RecommendationRail["items"][number]) => {
      const key = `${item.mediaType}:${item.externalId}`;
      setBusy(key);
      try {
        const res = await fetch("/api/watchlist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mediaType: item.mediaType,
            externalId: item.externalId,
            title: item.title,
            posterUrl: item.posterUrl,
            // A suggestion has not earned disk: it goes in as something to
            // look at, not something to start downloading tonight.
            status: "planned",
            monitored: false,
          }),
        });
        if (!res.ok) throw new Error(await res.text());
        setAdded((prev) => new Set(prev).add(key));
        toast.success(`${item.title} added to library`, {
          description: "Planned — not monitoring yet.",
        });
        onAdded?.();
      } catch {
        toast.error(`Could not add ${item.title}`);
      } finally {
        setBusy(null);
      }
    },
    [onAdded],
  );

  const visible = rail?.items.filter(
    (i) => !added.has(`${i.mediaType}:${i.externalId}`),
  );
  if (!rail || !visible?.length) return null;

  return (
    <section className="mt-10 border-t border-[var(--border)] pt-8">
      <h2 className="text-[13px] font-medium text-[var(--text-secondary)]">
        Because you&rsquo;re watching{" "}
        <span className="text-[var(--text)]">{rail.seedTitle}</span>
      </h2>

      <ul className="mt-4 grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6">
        {visible.map((item) => {
          const key = `${item.mediaType}:${item.externalId}`;
          const titleHref = titleHrefForName(item.title, {
            mediaType: item.mediaType,
          });
          return (
            <li key={key} className="min-w-0">
              <div className="surface flex h-full flex-col overflow-hidden">
                <div className="relative aspect-[2/3] shrink-0 bg-[var(--bg-muted)]">
                  {item.posterUrl && !broken.has(key) ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={item.posterUrl}
                      alt=""
                      loading="lazy"
                      onError={() =>
                        setBroken((prev) => new Set(prev).add(key))
                      }
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    // An empty `src` makes the browser re-request the page as
                    // an image and leaves a bare grey slab. Same initial-tile
                    // fallback the library cards use.
                    <div
                      className="flex h-full w-full items-center justify-center px-1"
                      aria-label="No poster"
                      title="No poster"
                    >
                      <span
                        aria-hidden
                        className="select-none text-2xl font-semibold text-[var(--text-tertiary)]"
                      >
                        {item.title.trim().charAt(0).toUpperCase() || "?"}
                      </span>
                    </div>
                  )}
                  {titleHref ? (
                    <Link
                      href={titleHref}
                      tabIndex={-1}
                      aria-hidden
                      className="absolute inset-0"
                    />
                  ) : null}
                </div>
                <div className="flex flex-1 flex-col p-2">
                  {titleHref ? (
                    <Link
                      href={titleHref}
                      className="block rounded-[6px] outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                    >
                      <p
                        className="text-[12px] font-medium text-[var(--text)] leading-snug line-clamp-2 hover:text-[var(--accent-text)]"
                        title={item.title}
                      >
                        {item.title}
                      </p>
                      {item.year ? (
                        <p className="mt-0.5 text-[11px] text-[var(--text-tertiary)]">
                          {item.year}
                        </p>
                      ) : null}
                    </Link>
                  ) : (
                    <>
                      <p
                        className="text-[12px] font-medium text-[var(--text)] leading-snug line-clamp-2"
                        title={item.title}
                      >
                        {item.title}
                      </p>
                      {item.year ? (
                        <p className="mt-0.5 text-[11px] text-[var(--text-tertiary)]">
                          {item.year}
                        </p>
                      ) : null}
                    </>
                  )}
                  {/* mt-auto on the wrapper, so a two-line title doesn't drop
                      this button 17px below its neighbours' baseline. */}
                  <div className="mt-auto pt-2">
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        add(item);
                      }}
                      disabled={busy === key}
                      aria-label={`Add ${item.title} to library`}
                      className="flex w-full items-center justify-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-muted)] hover:text-[var(--accent-text)] disabled:opacity-50"
                    >
                      <Plus className="h-3 w-3 shrink-0" aria-hidden />
                      <span className="truncate">
                        {busy === key ? "Adding…" : "Add"}
                      </span>
                    </button>
                  </div>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
