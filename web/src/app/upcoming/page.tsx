import { CalendarClock, Info } from "lucide-react";
import { Link } from "react-router";
import { useMemo } from "react";
import { MediaPoster } from "@/components/browse/media-poster-card";
import { useWorkArtwork } from "@/hooks/use-work-artwork";
import { TfEmptyState } from "@/components/tf/empty-state";
import { PageQueryBoundary } from "@/components/tf/page-query-boundary";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { useApiQuery } from "@/hooks/use-api-query";
import { groupTimeline, timelineTime, type TimelineResponse } from "./timeline";

const labels = { check: "Release check", airs: "Expected to air", queued: "Queued download" };

export default function UpcomingPage() {
  const list = useApiQuery<TimelineResponse>("/api/timeline", { refreshMs: 30_000, emptyOnUnauthorized: false });
  const rows = list.data?.entries ?? [];
  const now = new Date();
  const groups = groupTimeline(rows, now);
  // Rows saved without a poster ask the shared artwork lookup by title.
  const missingArt = useMemo(
    () => rows.filter((r) => !r.posterUrl).map((r) => ({ name: r.title, workTitle: r.title })),
    [rows],
  );
  const artwork = useWorkArtwork(missingArt);

  return (
    <div className="container-app max-w-4xl space-y-6 py-6" data-upcoming>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-foreground">Upcoming</h1>
          <p className="text-sm text-muted-foreground">Next checks, expected air times, and downloads waiting their turn.</p>
          <p className="text-xs text-subtle-foreground">Times are shown in your local timezone. Queue times are not completion estimates.</p>
        </div>
        <Button asChild variant="secondary" className="max-md:min-h-11 pointer-coarse:min-h-11">
          <Link to="/downloads" aria-label="Open Downloads" data-upcoming-downloads>
            Downloads
          </Link>
        </Button>
      </div>

      {list.data?.airTimesUnavailable ? (
        <Alert role="status" data-upcoming-metadata-warning>
          <Info aria-hidden />
          <AlertDescription>
            Some air times are unavailable. Checks and queued downloads are still shown; we’ll retry on the next refresh.
          </AlertDescription>
        </Alert>
      ) : null}

      <PageQueryBoundary
        query={list}
        errorTitle="Couldn't load upcoming"
        refreshErrorTitle="Couldn't refresh upcoming"
        isEmpty={(data) => (data.entries ?? []).length === 0}
        skeleton={(visible) => (
        <ul className={cn("space-y-3", !visible && "invisible")} aria-busy="true" aria-label="Loading upcoming events" data-upcoming-loading>
          {Array.from({ length: 3 }, (_, index) => (
            <li key={index} aria-hidden>
              <Card size="sm" className="flex-row gap-3 p-3 sm:gap-4">
                <Skeleton className="aspect-[2/3] w-12 shrink-0 sm:w-14" />
                <div className="flex flex-1 flex-col gap-2.5">
                  <Skeleton className="h-4 w-1/2" />
                  <Skeleton className="h-3 w-2/3" />
                  <Skeleton className="h-5 w-40 rounded-full" />
                </div>
              </Card>
            </li>
          ))}
        </ul>
        )}
        empty={
        <TfEmptyState icon={CalendarClock} title="Nothing upcoming"
          description="Monitor a title in Library to schedule release checks, or add a download to start your queue."
          actionLabel="Open Library" actionHref="/watchlist" />
        }
      >
        {() => (
        <div className="space-y-8" data-upcoming-groups>
          {groups.map((group) => (
            <section key={group.label} aria-labelledby={`upcoming-${group.label}`} data-upcoming-group={group.label}>
              <h2 id={`upcoming-${group.label}`} className="mb-3 flex items-center gap-3 text-sm font-semibold text-foreground">
                <span className="size-2 rounded-full bg-brand" aria-hidden />
                {group.label}
                <Badge variant="outline" className="font-mono text-xs font-normal text-subtle-foreground">{group.entries.length}</Badge>
              </h2>
              <ul className="space-y-2 border-l border-border pl-3 sm:pl-5">
                {group.entries.map((entry) => (
                  <li key={entry.id} data-upcoming-row={entry.kind}>
                    <Card size="sm" className="flex-row gap-3 p-3 sm:gap-4">
                    <MediaPoster variant="row" src={entry.posterUrl ?? artwork.artFor({ name: entry.title, workTitle: entry.title })?.posterUrl} title={entry.title} />
                    <div className="flex min-w-0 flex-1 flex-col gap-2">
                      <div className="flex min-w-0 flex-col gap-1 md:flex-row md:justify-between md:gap-4">
                        <h3 className="min-w-0 break-words text-sm font-medium text-foreground">{entry.title}</h3>
                        {entry.at ? (
                          <time dateTime={entry.at} title={new Date(entry.at).toLocaleString()}
                            className="shrink-0 text-xs tabular-nums text-muted-foreground">
                            {timelineTime(entry.at, now)}
                          </time>
                        ) : <span className="text-xs text-subtle-foreground">Start time not known</span>}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {labels[entry.kind]}{entry.episode ? ` · ${entry.episode}` : ""}
                        {entry.lane ? ` · ${entry.lane} lane` : ""}
                        {entry.queuePosition ? ` · #${entry.queuePosition}` : ""}
                      </p>
                      <Badge className="self-start whitespace-normal break-words" data-wait-reason={entry.waitReason.reason}>
                        {entry.waitReason.text}
                      </Badge>
                      {entry.waitReason.since ? (
                        <p className="text-xs text-subtle-foreground">
                          Waiting since <time dateTime={entry.waitReason.since}>{new Date(entry.waitReason.since).toLocaleString()}</time>
                          {entry.waitReason.until ? ` · seeder grace ends ${timelineTime(entry.waitReason.until, now)}` : ""}
                        </p>
                      ) : null}
                    </div>
                    </Card>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        )}
      </PageQueryBoundary>
    </div>
  );
}
