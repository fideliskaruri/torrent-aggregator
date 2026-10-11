import type { TitleContentViewModel } from "./use-title-content-view-model";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { GenreChips,HeroMetaList } from "./title-hero-meta";


export function TitleHeroDetails({ model }: { model: TitleContentViewModel }) {
  const { payload, extras, heroExtrasPending, genres, metaListPresent, releaseDate } = model;
  return (
            <div className="min-w-0 flex flex-col gap-4 md:col-start-2 md:flex-row md:gap-6">

                <div className="min-w-0 flex-1 md:max-w-2xl md:min-h-[9.40625rem]">
                  {payload.overview ?? extras?.overview ? (
                    <p
                      data-title-overview
                      className="text-body line-clamp-5 max-w-xl"
                    >
                      {payload.overview ?? extras?.overview}
                    </p>
                  ) : heroExtrasPending ? (
                    <div aria-hidden data-title-overview-placeholder className="max-w-xl">
                      <div className="text-body">
                        {["w-full", "w-full", "w-11/12", "w-full", "w-2/3"].map((width, i) => (
                          <div key={i} className="flex h-lh items-center">
                            <Skeleton className={cn("h-3 rounded", width)} />
                          </div>
                        ))}
                      </div>
                      <div className="mt-4 flex gap-2">
                        <Skeleton className="h-[1.625rem] w-16 rounded-full" />
                        <Skeleton className="h-[1.625rem] w-20 rounded-full" />
                        <Skeleton className="h-[1.625rem] w-14 rounded-full" />
                      </div>
                    </div>
                  ) : null}

                  <GenreChips genres={genres} />
                </div>

                {metaListPresent ? (
                  <div className="w-full md:w-[200px] md:shrink-0">
                    <HeroMetaList
                      originalLanguage={extras?.originalLanguage ?? null}
                      releaseDate={releaseDate}
                      certification={extras?.certification ?? null}
                    />
                  </div>
                ) : heroExtrasPending ? (
                  <div aria-hidden className="grid w-full gap-y-2 text-[13px] md:w-[200px] md:shrink-0">
                    {["w-40", "w-48", "w-32"].map((width) => (
                      <div key={width} className="flex h-lh items-center">
                        <Skeleton className={cn("h-3 rounded", width)} />
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
  );
}
