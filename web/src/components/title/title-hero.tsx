import { Link } from "react-router";
import { PosterImage } from "@/components/browse/poster-image";
import { posterTint } from "@/components/browse/poster";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { ReleaseGateChip } from "@/components/browse/release-gate-chip";
import { WatchStateChip } from "./watch-state";
import { SeasonProgressMeter } from "./season-progress-meter";
import { RatingMetaLine } from "./title-hero-meta";


import { TitleHeroActions } from "./title-hero-actions";
import { TitleHeroDetails } from "./title-hero-details";
import type { TitleContentViewModel } from "./use-title-content-view-model";

export function TitleHero({ model }: { model: TitleContentViewModel }) {
  const { payload, title, nothingBelowHero, backdrop, gated, titlePending, heroExtrasPending, releaseGate, metaScore, metaYear, extras, seasonCount, showProgress, showProgressText } = model;
  return (
    <>
      <header
        data-title-hero
        data-hero-fills={nothingBelowHero || undefined}
        className={cn(
          "relative isolate flex flex-col overflow-hidden bg-card",
          nothingBelowHero ? "grow justify-start" : "justify-end border-b border-border",
        )}
      >
        <div
          className="absolute inset-0 -z-10"
          style={{ background: posterTint(title) }}
        >
          {backdrop ? (

            <PosterImage
              src={backdrop}
              title={title}
              sizes="100vw"
              priority
              variant="plain"
              className={cn(
                "scale-[1.06] object-cover object-[center_22%] blur-[1px]",
                gated && "grayscale",
              )}
            />
          ) : null}
        </div>

        <div
          aria-hidden
          className="absolute inset-0 -z-10 bg-background/20"
        />
        <div
          aria-hidden
          className="absolute inset-0 -z-10 bg-[linear-gradient(to_top,var(--bg)_0%,color-mix(in_srgb,var(--bg)_70%,transparent)_22%,color-mix(in_srgb,var(--bg)_20%,transparent)_50%,transparent_75%)]"
        />
        <div
          aria-hidden
          className="absolute inset-0 -z-10 bg-[linear-gradient(to_right,color-mix(in_srgb,var(--bg)_92%,transparent)_0%,color-mix(in_srgb,var(--bg)_65%,transparent)_40%,transparent_70%)]"
        />

        <div className="container-app">


          <div
            className={cn(
              "grid grid-cols-1 items-start gap-x-4 gap-y-5 py-5 sm:py-6 md:grid-cols-[168px_minmax(0,40rem)] md:gap-x-6 md:pt-6 md:pb-10 lg:grid-cols-[196px_minmax(0,44rem)]",
            )}
          >

            <div className="w-[104px] shrink-0 self-start sm:w-[120px] md:row-span-2 md:w-[168px] lg:w-[196px]">
              <div
                className={cn(
                  "relative aspect-[2/3] w-full overflow-hidden rounded-lg border border-border bg-muted shadow-md",
                  gated && "grayscale",
                )}
              >
                {titlePending && !payload.posterUrl ? (
                  <Skeleton className="size-full rounded-none" aria-hidden="true" data-title-poster-pending />
                ) : (
                  <PosterImage
                    src={payload.posterUrl}
                    title={title}
                    sizes="(min-width: 1024px) 196px, (min-width: 768px) 168px, (min-width: 640px) 120px, 104px"
                    priority
                  />
                )}
              </div>
            </div>

            <div className="min-w-0 flex-1">
              <h1
                id="title-heading"
                title={titlePending ? undefined : title}
                aria-busy={titlePending || undefined}
                data-title-heading-pending={titlePending ? "" : undefined}
                className="break-words text-[clamp(1.75rem,7vw,2.25rem)] font-semibold leading-[1.05] tracking-[-0.03em] text-foreground md:text-display"
              >
                {titlePending ? (
                  <>
                    <span className="sr-only">Loading title</span>

                    <span aria-hidden="true" className="block h-[1em] w-3/4 max-w-[28rem] animate-pulse rounded bg-muted" />
                  </>
                ) : (
                  title
                )}
              </h1>


              <div
                className={cn(
                  "mt-3 flex min-h-7 flex-wrap items-center gap-x-2.5 gap-y-2",
                )}
              >
                {gated ? (
                  <ReleaseGateChip gate={releaseGate} data-title-coming />
                ) : null}
                <RatingMetaLine
                  rating={metaScore.rating}
                  voteCount={metaScore.voteCount}
                  ratingSource={metaScore.source}
                  year={metaYear}
                  isSeries={payload.isSeries}
                  seasonCount={seasonCount}
                />
                <WatchStateChip state={payload.watchState} nextUp={payload.jellyfinNextUp}
                  className="mt-2 h-7 rounded-full bg-background/60 px-2.5" />
              </div>


              {extras?.partOf ? (
                <p className="mt-1 text-[13px] text-muted-foreground" data-title-part-of>
                  {extras.seasons.length > 0
                    ? `Season ${extras.seasons.join(", ")} of `
                    : "Part of "}
                  <Button asChild variant="link" size="sm" className="h-auto min-h-11 px-0 align-middle text-[13px]">
                    <Link to={extras.partOf.href}>{extras.partOf.title}</Link>
                  </Button>
                </p>
              ) : null}


              {showProgress && showProgressText ? (
                <SeasonProgressMeter
                  progress={showProgress}
                  label={showProgressText}
                  className="mt-3 text-[13px]"
                  data-show-progress
                />
              ) : payload.isSeries && (titlePending || heroExtrasPending) ? (
                <div aria-hidden className="mt-3 h-5" data-show-progress-pending />
              ) : null}


              <TitleHeroActions model={model} />

            </div>



            <TitleHeroDetails model={model} />
          </div>
        </div>
      </header>


    </>
  );
}
