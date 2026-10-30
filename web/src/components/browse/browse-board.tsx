import { useCallback, useMemo, useState, type ReactNode } from "react";
import { send } from "@/lib/api";
import type { ActionStatus, CatalogCardAction } from "@/lib/api/catalog-types";
import { Link } from "react-router";
import { toast } from "@/lib/toast";
import type { BrowsePayload, RailItem } from "@/lib/browse";
import { browseHref } from "@/lib/browse/views";
import { useDownloadSetup } from "@/components/setup/download-setup";
import { RAIL_PREVIEWS, missingRailPreviews } from "./first-run";
import { HeroBanner } from "./hero-banner";
import { pickHeroItem } from "./hero";
import { Rail, RailGrid } from "./rail";
import { UpNextRail } from "./up-next-rail";

/**
 * The browse page's one piece of state.
 *
 * Cards and the hero are deliberately dumb: they render an action and report a
 * click. Everything that can fail — asking for a grab — lands here, so there
 * is a single place that knows what is in flight and a single place a
 * duplicate grab could be prevented.
 */
export function BrowseBoard({ payload, filters }: { payload: BrowsePayload; filters?: ReactNode }) {
  const [statuses, setStatuses] = useState<Record<string, ActionStatus>>({});
  const { ensureDownloadSetup } = useDownloadSetup();

  const rails = payload.rails;
  // A genre page is one list shown whole as a grid, led by a hero from that
  // genre like every other view.
  const genrePage = Boolean(payload.genre);
  const hero = useMemo(() => pickHeroItem(rails), [rails]);
  // The hero already features its title, so the rail it came from drops that
  // card and keeps the rest in order. A rail left empty is hidden.
  const shownRails = useMemo(
    () =>
      rails
        .map((rail) =>
          hero && rail.id === hero.railId
            ? { ...rail, items: rail.items.filter((item) => item.id !== hero.item.id) }
            : rail,
        )
        .filter((rail) => rail.items.length > 0),
    [rails, hero],
  );

  const runAction = useCallback(
    async (item: RailItem, action: CatalogCardAction) => {
      if (action.kind !== "get") return;
      if (statuses[item.id] === "pending") return;
      if (!(await ensureDownloadSetup())) return;

      const label = item.title;
      setStatuses((prev) => ({ ...prev, [item.id]: "pending" }));
      try {
        const res = await send("/api/library/ondemand", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...action.request, retention: "keep" }),
        });
        const data = (await res.json().catch(() => null)) as {
          ok?: boolean;
          message?: string;
        } | null;
        if (!res.ok || data?.ok === false) {
          throw new Error(data?.message ?? `Grab failed (${res.status})`);
        }
        setStatuses((prev) => ({ ...prev, [item.id]: "done" }));
        toast.success(`Grabbing ${label}`, {
          description: item.subtitle
            ? `${item.subtitle}. Sent to your client.`
            : "Sent to your client.",
        });
      } catch (err) {
        setStatuses((prev) => ({ ...prev, [item.id]: "error" }));
        toast.error(`Could not grab ${label}`, {
          description: err instanceof Error ? err.message : undefined,
        });
      }
    },
    [statuses, ensureDownloadSetup],
  );

  return (
    <>
      {hero ? (
        <HeroBanner
          pick={hero}
          status={statuses[hero.item.id]}
          onAction={runAction}
        />
      ) : null}

      <div className="container-app min-w-0 pb-14" data-browse-board>
        {filters}
        {!genrePage && (payload.view ?? "all") === "all" ? <UpNextRail /> : null}
        {genrePage
          ? shownRails.map((rail) => (
              <RailGrid
                key={rail.id}
                rail={rail}
                statuses={statuses}
                onAction={runAction}
              />
            ))
          : shownRails.map((rail, index) => (
              <Rail
                key={rail.id}
                rail={rail}
                index={index}
                statuses={statuses}
                onAction={runAction}
                seeAllHref={
                  rail.kind && rail.genre
                    ? browseHref(rail.kind, rail.genre)
                    : undefined
                }
              />
            ))}
        {(payload.view ?? "all") === "all" ? <MissingRailsNote rails={rails} /> : null}
      </div>
    </>
  );
}

/**
 * The partially-empty page: some rails populated, some not.
 *
 * An empty rail is omitted rather than drawn, because a rail heading is a
 * promise of contents and a title over blank space is both a broken promise
 * and pure vertical noise between two rows that do have something. But
 * omitting it silently teaches nothing (the user cannot tell whether a rail
 * is empty or does not exist), so the rails that are missing are named
 * once, compactly, at the bottom, where they cannot interrupt real content.
 *
 * Renders nothing when every rail is populated, and nothing on a first run
 * either: with no rails at all the whole page is already the first-run state,
 * and a footer listing every rail would be saying it twice.
 */
function MissingRailsNote({ rails }: { rails: BrowsePayload["rails"] }) {
  const missing = useMemo(() => missingRailPreviews(rails), [rails]);
  if (!missing.length || missing.length === RAIL_PREVIEWS.length) return null;

  return (
    <section
      data-missing-rails
      aria-labelledby="missing-rails-title"
      className="mt-8 border-t border-border pt-6"
    >
      <h2
        id="missing-rails-title"
        className="text-[13px] font-medium text-muted-foreground"
      >
        Not showing yet
      </h2>
      <ul className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {missing.map((preview) => (
          <li key={preview.id} className="surface flex flex-col gap-1.5 p-3.5">
            <span className="text-[13px] font-medium text-foreground">
              {preview.title}
            </span>
            <span className="text-[12px] leading-relaxed text-subtle-foreground">
              {preview.blurb}
            </span>
            <Link
              to={preview.href}
              className="mt-auto inline-flex items-center self-start min-h-[44px] pt-1 text-[12px] text-brand-foreground underline-offset-4 transition-colors hover:text-brand hover:underline lg:min-h-0"
            >
              {preview.cta}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
