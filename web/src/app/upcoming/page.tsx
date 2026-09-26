import { CalendarClock } from "lucide-react";
import { Link } from "react-router";
import { PosterImage } from "@/components/browse/poster-image";
import { TfEmptyState } from "@/components/tf/empty-state";
import { TfErrorState } from "@/components/tf/error-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useApiQuery } from "@/hooks/use-api-query";
import { groupTimeline, timelineTime, type TimelineResponse } from "./timeline";

const labels = { check: "Release check", airs: "Expected to air", queued: "Queued download" };

export default function UpcomingPage() {
  const list = useApiQuery<TimelineResponse>("/api/timeline", { refreshMs: 30_000, emptyOnUnauthorized: false });
  const rows = list.data?.entries ?? [];
  const now = new Date();
  const groups = groupTimeline(rows, now);

  return (
    <div className="container-app max-w-4xl space-y-6 py-6" data-upcoming>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h1 className="text-xl font-semibold tracking-tight text-[var(--text)]">Upcoming</h1>
          <p className="text-sm text-[var(--text-secondary)]">Next checks, expected air times, and downloads waiting their turn.</p>
          <p className="text-xs text-[var(--text-tertiary)]">Times are shown in your local timezone. Queue times are not completion estimates.</p>
        </div>
        <Button asChild variant="ghost" className="min-h-[44px]">
          <Link to="/downloads" aria-label="Open Downloads" data-upcoming-downloads>Downloads</Link>
        </Button>
      </div>

      {list.error ? (
        <TfErrorState title={rows.length ? "Couldn't refresh upcoming" : "Couldn't load upcoming"}
          message={list.error} onRetry={list.refetch} retrying={list.refreshing} />
      ) : null}
      {list.data?.airTimesUnavailable ? (
        <p className="text-sm text-[var(--text-secondary)]" role="status" data-upcoming-metadata-warning>
          Some air times are unavailable. Checks and queued downloads are still shown; we’ll retry on the next refresh.
        </p>
      ) : null}

      {list.loading && !list.data ? (
        <ul className="space-y-3" aria-busy="true" aria-label="Loading upcoming events" data-upcoming-loading>
          {Array.from({ length: 3 }, (_, index) => (
            <li key={index} className="surface flex gap-3 p-4" aria-hidden>
              <div className="skeleton aspect-[2/3] w-12 shrink-0 rounded-md" />
              <div className="flex flex-1 flex-col gap-3">
                <div className="skeleton h-4 w-1/2 rounded" />
                <div className="skeleton h-3 w-2/3 rounded" />
              </div>
            </li>
          ))}
        </ul>
      ) : !list.error && rows.length === 0 ? (
        <TfEmptyState icon={CalendarClock} title="Nothing upcoming"
          description="Monitor a title in Library to schedule release checks, or add a download to start your queue."
          actionLabel="Open Library" actionHref="/watchlist" />
      ) : (
        <div className="space-y-8" data-upcoming-groups>
          {groups.map((group) => (
            <section key={group.label} aria-labelledby={`upcoming-${group.label}`} data-upcoming-group={group.label}>
              <h2 id={`upcoming-${group.label}`} className="mb-3 flex items-center gap-3 text-sm font-semibold text-[var(--text)]">
                <span className="h-2 w-2 rounded-full bg-[var(--accent)]" aria-hidden />
                {group.label}
                <span className="font-mono text-xs font-normal text-[var(--text-tertiary)]">{group.entries.length}</span>
              </h2>
              <ul className="space-y-2 border-l border-[var(--border)] pl-3 sm:pl-5">
                {group.entries.map((entry) => (
                  <li key={entry.id} className="surface flex gap-3 p-3 sm:gap-4" data-upcoming-row={entry.kind}>
                    <div className="relative aspect-[2/3] w-12 shrink-0 self-start overflow-hidden rounded-md bg-[var(--bg-muted)] sm:w-14">
                      <PosterImage src={entry.posterUrl ?? null} title={entry.title} sizes="56px" />
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col gap-2">
                      <div className="flex min-w-0 flex-col gap-1 md:flex-row md:justify-between md:gap-4">
                        <h3 className="min-w-0 break-words text-sm font-medium text-[var(--text)]">{entry.title}</h3>
                        {entry.at ? (
                          <time dateTime={entry.at} title={new Date(entry.at).toLocaleString()}
                            className="shrink-0 text-xs tabular-nums text-[var(--text-secondary)]">
                            {timelineTime(entry.at, now)}
                          </time>
                        ) : <span className="text-xs text-[var(--text-tertiary)]">Start time not known</span>}
                      </div>
                      <p className="text-xs text-[var(--text-secondary)]">
                        {labels[entry.kind]}{entry.episode ? ` · ${entry.episode}` : ""}
                        {entry.lane ? ` · ${entry.lane} lane` : ""}
                        {entry.queuePosition ? ` · #${entry.queuePosition}` : ""}
                      </p>
                      <Badge className="self-start whitespace-normal break-words" data-wait-reason={entry.waitReason.reason}>
                        {entry.waitReason.text}
                      </Badge>
                      {entry.waitReason.since ? (
                        <p className="text-xs text-[var(--text-tertiary)]">
                          Waiting since <time dateTime={entry.waitReason.since}>{new Date(entry.waitReason.since).toLocaleString()}</time>
                          {entry.waitReason.until ? ` · seeder grace ends ${timelineTime(entry.waitReason.until, now)}` : ""}
                        </p>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
