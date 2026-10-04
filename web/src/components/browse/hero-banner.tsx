import { Link } from "react-router";
import { motion, useReducedMotion } from "framer-motion";
import type { RailItem } from "@/lib/browse";
import type { ActionStatus, CatalogCardAction } from "@/lib/api/catalog-types";
import { Button } from "@/components/ui/button";
import { cn, factsLine } from "@/lib/utils";
import { heroFacts, type HeroPick } from "./hero";
import { PosterImage } from "./poster-image";
import { posterTint } from "./poster";
import { LoadingGlyph } from "@/components/ui/loading";
import { Skeleton } from "@/components/ui/skeleton";
import { browseReleaseGate } from "@/lib/browse/release-status";
import { ReleaseGateChip } from "./release-gate-chip";
import { cardActionLabel } from "./card-action-label";

export interface HeroBannerProps {
  pick: HeroPick;
  status?: ActionStatus;
  onAction: (item: RailItem, action: CatalogCardAction) => void;
}

/**
 * The featured title at the top of Browse.
 *
 * Degrades in one step rather than breaking: with a backdrop it is a banner,
 * with only a poster it uses that, and with no artwork at all it is a solid
 * panel washed with the title's own tint — the same tint its cards use, so a
 * library with no artwork still looks composed instead of unfinished.
 *
 * The primary action is the one returned with the catalog item. A disabled
 * action carries the server's reason beside it.
 */
export function HeroBanner({ pick, status = "idle", onAction }: HeroBannerProps) {
  const { item, eyebrow } = pick;
  const titleHref = item.href;
  const action = item.action;
  const releaseGate = browseReleaseGate(item);
  const title = item.title;
  const facts = heroFacts(item);
  const factsText = factsLine(facts);
  const label = cardActionLabel(action, status, releaseGate);
  const pageOnly = !releaseGate.gated && action.kind === "local";
  const image = item.backdropUrl ?? item.posterUrl;
  const reduceMotion = useReducedMotion();

  return (
    <section
      data-browse-hero
      data-unreleased={releaseGate.gated ? "true" : undefined}
      aria-labelledby="browse-hero-title"
      className="relative isolate overflow-hidden border-b border-border bg-card"
    >
      <div
        className={cn(
          "absolute inset-0 -z-10",
          releaseGate.gated && "grayscale",
        )}
        style={{ background: posterTint(title) }}
      >
        {image ? (
          <PosterImage
            src={image}
            title={title}
            sizes="100vw"
            priority
            variant="plain"
            className="object-cover object-[center_25%]"
          />
        ) : null}
      </div>
      {/* Legibility scrims, not decoration: the text sits on artwork of unknown
          brightness, so it carries its own background with it. */}
      <div
        aria-hidden
        className="absolute inset-0 -z-10 bg-[linear-gradient(to_top,var(--bg)_0%,color-mix(in_srgb,var(--bg)_70%,transparent)_45%,transparent_100%)]"
      />
      <div
        aria-hidden
        className="absolute inset-0 -z-10 bg-[linear-gradient(to_right,var(--bg)_0%,color-mix(in_srgb,var(--bg)_55%,transparent)_50%,transparent_100%)]"
      />

      <div className="container-app">
        <motion.div
          className={HERO_FRAME}
          initial={false}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: reduceMotion ? 0 : 0.22, ease: "easeOut" }}
        >
          <p className="text-[12px] font-medium uppercase tracking-wide text-subtle-foreground">
            {eyebrow}
          </p>

          {titleHref ? (
            <Link
              to={titleHref}
              id="browse-hero-title"
              title={item.title}
              aria-label={item.title}
              className="text-display mt-2 line-clamp-2 text-balance break-words outline-none transition-colors hover:text-brand-foreground focus-visible:ring-2 focus-visible:ring-brand rounded-sm"
            >
              {title}
            </Link>
          ) : (
            <h1
              id="browse-hero-title"
              title={item.title}
              className="text-display mt-2 line-clamp-2 text-balance break-words"
            >
              {title}
            </h1>
          )}

          {/* No availability chip. "Partial" is engine vocabulary about bytes
              on disk; the viewer only needs to know what the button does.
              Gated titles still say when they land. */}
          <div className="mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-2 text-[12px] text-muted-foreground">
            <ReleaseGateChip gate={releaseGate} />
            {factsText ? <span className="tabular-nums">{factsText}</span> : null}
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-2">
            {pageOnly ? (
              <Button asChild size="lg" data-hero-primary>
                <Link to={action.href}>{action.label}</Link>
              </Button>
            ) : releaseGate.gated ? (
              titleHref ? (
                <Button asChild size="lg" variant="secondary">
                  <Link to={titleHref}>Details</Link>
                </Button>
              ) : null
            ) : action.kind === "search" || action.kind === "request" ? (
              <Button asChild size="lg" data-hero-primary>
                <Link to={action.href}>{action.label}</Link>
              </Button>
            ) : action.kind === "get" && status === "done" ? (
              <Button asChild size="lg" variant="secondary">
                <Link to="/downloads">{label}</Link>
              </Button>
            ) : (
              <Button
                size="lg"
                disabled={action.disabled || status === "pending"}
                onClick={() => onAction(item, action)}
                data-hero-primary
              >
                {status === "pending" ? <LoadingGlyph /> : null}
                {label}
              </Button>
            )}
            {!releaseGate.gated && !pageOnly && titleHref &&
            action.kind !== "search" && action.kind !== "request" ? (
              <Button asChild size="lg" variant="secondary">
                <Link to={titleHref} data-hero-details>
                  Details
                </Link>
              </Button>
            ) : null}
          </div>

          {!releaseGate.gated && action.disabled ? (
            <p
              className={cn(
                "mt-2.5 max-w-md text-[12px] leading-relaxed",
                "text-subtle-foreground",
              )}
            >
              {action.reason}
            </p>
          ) : null}
        </motion.div>
      </div>
    </section>
  );
}

/** One frame for the hero and its skeleton, so the loaded hero lands at exactly the skeleton's size. */
const HERO_FRAME =
  "flex min-h-[19rem] max-w-2xl flex-col justify-end py-8 sm:min-h-[23rem] sm:py-10 lg:min-h-[26rem]";

/** Hero-shaped placeholder, so loading the payload in cannot shift the page. */
export function HeroSkeleton() {
  return (
    <section
      aria-hidden
      className="border-b border-border bg-card"
    >
      <div className="container-app">
        <div className={HERO_FRAME}>
          <Skeleton className="h-3 w-28 rounded" />
          <Skeleton className="mt-3 h-9 w-3/4 rounded" />
          <Skeleton className="mt-3 h-3 w-40 rounded" />
          <Skeleton className="mt-3 h-3 w-full max-w-md rounded" />
          <Skeleton className="mt-5 h-11 w-40 rounded-lg" />
        </div>
      </div>
    </section>
  );
}
