"use client";

import Link from "next/link";
import { Play, Search } from "lucide-react";
import { motion, useReducedMotion } from "framer-motion";
import type { RailItem } from "@/lib/browse";
import { Button } from "@/components/ui/button";
import { cn, factsLine } from "@/lib/utils";
import {
  actionLabel,
  cleanDisplayTitle,
  clampFraction,
  resolveCardAction,
  searchAction,
  type ActionStatus,
  type CardAction,
} from "./availability";
import { AvailabilityChip } from "./availability-chip";
import { heroFacts, heroPitch, type HeroPick } from "./hero";
import { PosterImage } from "./poster-image";
import { posterTint } from "./poster";
import { titleHrefForItem } from "@/components/title/work-key";
import { LoadingGlyph, SkeletonBlock } from "@/components/ui/loading";
import { browseReleaseGate } from "@/lib/browse/release-status";

export interface HeroBannerProps {
  pick: HeroPick;
  status?: ActionStatus;
  onAction: (item: RailItem, action: CardAction) => void;
}

/**
 * The featured title at the top of Browse.
 *
 * Degrades in one step rather than breaking: with a backdrop it is a banner,
 * with only a poster it uses that, and with no artwork at all it is a solid
 * panel washed with the title's own tint — the same tint its cards use, so a
 * library with no artwork still looks composed instead of unfinished.
 *
 * The primary action is whatever {@link resolveCardAction} allows, so the
 * largest button on the page can never be a Play that does not play. When there
 * is nothing to offer, the button is disabled and the reason is printed next to
 * it — a greyed control with no explanation is the thing users file bugs about.
 */
export function HeroBanner({ pick, status = "idle", onAction }: HeroBannerProps) {
  const { item, eyebrow } = pick;
  const action = resolveCardAction(item);
  const releaseGate = browseReleaseGate(item);
  const secondary = releaseGate.gated ? null : searchAction(item);
  const title = cleanDisplayTitle(item.title);
  const facts = heroFacts(item);
  const factsText = factsLine(facts);
  const fraction = releaseGate.gated
    ? null
    : clampFraction(item.progressFraction);
  const label = releaseGate.gated
    ? (releaseGate.label ?? "Coming soon")
    : actionLabel(action, status);
  const titleHref = titleHrefForItem(item);
  const image = item.backdropUrl ?? item.posterUrl;
  const reduceMotion = useReducedMotion();

  return (
    <section
      data-browse-hero
      data-unreleased={releaseGate.gated ? "true" : undefined}
      aria-labelledby="browse-hero-title"
      className="relative isolate overflow-hidden border-b border-[var(--border)] bg-[var(--bg-elevated)]"
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
          className="flex min-h-[19rem] max-w-2xl flex-col justify-end py-8 sm:min-h-[23rem] sm:py-10 lg:min-h-[26rem]"
          initial={false}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: reduceMotion ? 0 : 0.22, ease: "easeOut" }}
        >
          <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-tertiary)]">
            {eyebrow}
          </p>

          <h1
            id="browse-hero-title"
            title={item.title}
            className="text-display mt-2 line-clamp-2"
          >
            {title}
          </h1>

          <div className="mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-2 text-[12px] text-[var(--text-secondary)]">
            {releaseGate.gated ? (
              <span className="inline-flex items-center rounded-[6px] border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1 text-[11px] font-medium leading-none text-[var(--text-secondary)]">
                {label}
              </span>
            ) : (
              <AvailabilityChip state={item.availability} />
            )}
            {factsText ? <span className="tabular-nums">{factsText}</span> : null}
          </div>

          {/* Height is reserved rather than conditional: the pitch is empty
              only while the availability probe is outstanding, so collapsing
              the paragraph would shift the progress bar and the buttons down
              the instant it resolves. Reserving one line keeps the press
              target where the eye already put it. */}
          <p className="text-body mt-3 min-h-[1.5rem] max-w-xl">{heroPitch(item)}</p>

          {fraction != null ? (
            <div
              className="mt-4 h-1 w-full max-w-sm overflow-hidden rounded-full bg-[var(--bg-muted)]"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(fraction * 100)}
              aria-label={`${title} watched`}
            >
              <div
                className="h-full rounded-full bg-[var(--accent)]"
                style={{ width: `${Math.round(fraction * 100)}%` }}
              />
            </div>
          ) : null}

          <div className="mt-5 flex flex-wrap items-center gap-2">
            {releaseGate.gated ? (
              titleHref ? (
                <Button asChild size="lg" variant="secondary">
                  <Link href={titleHref}>View details</Link>
                </Button>
              ) : null
            ) : action.kind === "search" ? (
              // Unresolved: we cannot promise a result here, so the hero simply
              // leads to the title's own page — the one surface that runs the
              // search and offers Play/Download once it knows. No "Check", no
              // mechanism, just "open this title".
              <Button asChild size="lg">
                <Link href={titleHref ?? action.href}>
                  <Play className="fill-current" />
                  Play
                </Link>
              </Button>
            ) : action.kind === "get" && status === "done" ? (
              <Button asChild size="lg" variant="secondary">
                <Link href="/downloads">{label}</Link>
              </Button>
            ) : (
              <Button
                size="lg"
                disabled={action.disabled || status === "pending"}
                onClick={() => onAction(item, action)}
                data-hero-primary
              >
                {status === "pending" ? (
                  <LoadingGlyph />
                ) : action.kind === "play" ? (
                  <Play className="fill-current" />
                ) : null}
                {label}
              </Button>
            )}

            {secondary ? (
              <Button asChild size="lg" variant="secondary">
                <Link href={secondary.href}>
                  <Search />
                  Find releases
                </Link>
              </Button>
            ) : null}
          </div>

          {!releaseGate.gated && action.disabled ? (
            <p
              className={cn(
                "mt-2.5 max-w-md text-[12px] leading-relaxed",
                "text-[var(--text-tertiary)]",
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

/** Hero-shaped placeholder, so streaming the payload in cannot shift the page. */
export function HeroSkeleton() {
  return (
    <section
      aria-hidden
      className="border-b border-[var(--border)] bg-[var(--bg-elevated)]"
    >
      <div className="container-app">
        <div className="flex min-h-[19rem] max-w-2xl flex-col justify-end py-8 sm:min-h-[23rem] sm:py-10 lg:min-h-[26rem]">
          <SkeletonBlock className="h-3 w-28 rounded" />
          <SkeletonBlock className="mt-3 h-9 w-3/4 rounded" />
          <SkeletonBlock className="mt-3 h-3 w-40 rounded" />
          <SkeletonBlock className="mt-3 h-3 w-full max-w-md rounded" />
          <SkeletonBlock className="mt-5 h-11 w-40 rounded-[var(--radius)]" />
        </div>
      </div>
    </section>
  );
}
