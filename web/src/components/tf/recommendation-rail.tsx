import { useCallback, useEffect, useMemo, useState } from "react";
import { get, send } from "@/lib/api";
import { Link } from "react-router";
import { toast } from "@/lib/toast";
import { Plus } from "lucide-react";
import type { RecommendationRail } from "@/lib/recommend";
import { MediaPoster, MediaPosterCaption, RAIL_CARD_WIDTH } from "@/components/browse/media-poster-card";
import { RailStrip } from "@/components/browse/rail";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { titlePath } from "@/components/title/work-key";

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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await get("/api/recommendations");
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
      const key = `${item.provider}:${item.externalId}`;
      setBusy(key);
      try {
        const res = await send("/api/watchlist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            // A film is a film (an AniList film included): the hunter grabs it once.
            mediaType: item.titleMediaType ?? item.mediaType,
            externalId: item.externalId,
            format: item.format,
            // The catalog work it is, so its hunts know its provider (and whether it is anime).
            workKey: item.workKey,
            provider: item.provider,
            providerId: item.externalId,
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
          description: "Saved to watch later.",
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

  const visible = useMemo(
    () => rail?.items.filter((i) => !added.has(`${i.provider}:${i.externalId}`)) ?? [],
    [rail, added],
  );
  if (!rail || !visible.length) return null;

  return (
    <RailStrip
      id="recommendations"
      className="mt-10 border-t border-border pt-8"
      itemCount={visible.length}
      title={
        <>
          Because you&rsquo;re watching{" "}
          <span className="text-foreground">{rail.seedTitle}</span>
        </>
      }
    >
      {visible.map((item) => {
        const key = `${item.provider}:${item.externalId}`;
        const workKey = item.workKey.trim();
        const titleHref = workKey
          ? titlePath(workKey, {
              title: item.title,
              year: item.year,
              mediaType: item.titleMediaType,
              provider: item.provider,
              providerId: item.externalId,
              sourceType: item.sourceMediaType,
              format: item.format,
              series: item.isSeries,
            })
          : null;
        const card = (
          <>
            <MediaPoster
              variant="rail"
              src={item.posterUrl}
              title={item.title}
              sizes="(min-width: 1024px) 168px, (min-width: 640px) 148px, 124px"
              className="transition-[border-color] duration-150 group-hover:border-input"
            />
            <MediaPosterCaption title={item.title} subtitle={item.year ?? null} />
          </>
        );
        return (
          <li key={key} className={cn("group flex shrink-0 snap-start flex-col", RAIL_CARD_WIDTH)}>
            {titleHref ? (
              <Link
                to={titleHref}
                data-rail-card
                data-card-target="title"
                className="block min-h-[44px] rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                {card}
              </Link>
            ) : (
              <div data-rail-card tabIndex={0} className="rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-brand">
                {card}
              </div>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void add(item)}
              disabled={busy === key}
              aria-label={`Add ${item.title} to library`}
              className="mt-auto min-h-11 w-full text-[12px] text-muted-foreground lg:min-h-0"
            >
              <Plus className="h-3 w-3 shrink-0" aria-hidden />
              <span className="truncate">{busy === key ? "Adding…" : "Add"}</span>
            </Button>
          </li>
        );
      })}
    </RailStrip>
  );
}
