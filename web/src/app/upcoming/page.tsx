import { CalendarClock, ChevronDown, Info } from "lucide-react";
import { Link } from "react-router";
import { useMemo, useState } from "react";
import { useCapabilities } from "@/lib/capabilities";
import { sessionAwareFetch } from "@/lib/session-expiry";
import { MediaPoster } from "@/components/browse/media-poster-card";
import { useWorkArtwork } from "@/hooks/use-work-artwork";
import { TfEmptyState } from "@/components/tf/empty-state";
import { PageQueryBoundary } from "@/components/tf/page-query-boundary";
import { cn } from "@/lib/utils";
import { QUALITY_CHOICES, QualityOptions } from "@/components/settings/quality-options";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { useApiQuery } from "@/hooks/use-api-query";
import { groupByDay, releaseWording, stateLabels, timelineTime, type RequesterCalendarResponse, type TimelineEntry, type TimelineResponse } from "./timeline";


export default function UpcomingPage() {
  const caps = useCapabilities();
  return caps.canManage ? <OwnerCalendar /> : <RequesterCalendar />;
}

const stateTone = { pending: "outline", expected: "outline", searching: "secondary", found: "secondary",
  downloading: "default", in_library: "default" } as const;

function StateBadge({ state }: { state: keyof typeof stateLabels }) {
  return <Badge variant={stateTone[state]} data-calendar-state={state}>{stateLabels[state]}</Badge>;
}

function CalendarSkeleton({ visible }: { visible: boolean }) {
  return (
    <ul className={cn("space-y-3", !visible && "invisible")} aria-busy="true" aria-label="Loading the calendar" data-upcoming-loading>
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
  );
}

function RequesterCalendar() {
  const list = useApiQuery<RequesterCalendarResponse>("/api/requester/calendar", { refreshMs: 60_000, emptyOnUnauthorized: false });
  const rows = list.data?.entries ?? [];
  const now = new Date();
  return (
    <div className="container-app max-w-4xl space-y-6 py-6" data-upcoming data-calendar-role="requester">
      <div className="min-w-0 space-y-1">
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-foreground">Upcoming</h1>
        <p className="text-sm text-muted-foreground">When your requests are expected and where each one is.</p>
      </div>
      <PageQueryBoundary query={list} errorTitle="Couldn't load your calendar" refreshErrorTitle="Couldn't refresh your calendar"
        isEmpty={(data) => (data.entries ?? []).length === 0}
        skeleton={(visible) => <CalendarSkeleton visible={visible} />}
        empty={<TfEmptyState icon={CalendarClock} title="No open requests"
          description="Request a film or series and its expected date shows up here."
          actionLabel="Find something" actionHref="/" />}>
        {() => (
          <div className="space-y-8" data-upcoming-groups>
            {groupByDay(rows, now).map((group) => (
              <section key={group.key} aria-labelledby={`day-${group.key}`} data-upcoming-group={group.label}>
                <h2 id={`day-${group.key}`} className="mb-3 flex items-center gap-3 text-sm font-semibold text-foreground">
                  <span className="size-2 rounded-full bg-brand" aria-hidden />{group.label}
                </h2>
                <ul className="space-y-2 border-l border-border pl-3 sm:pl-5">
                  {group.entries.map((entry) => (
                    <li key={entry.id} data-upcoming-row="request">
                      <Card size="sm" className="flex-row gap-3 p-3 sm:gap-4">
                        <MediaPoster variant="row" src={entry.posterUrl ?? undefined} title={entry.title} />
                        <div className="flex min-w-0 flex-1 flex-col gap-2">
                          <h3 className="min-w-0 break-words text-sm font-medium text-foreground">{entry.title}</h3>
                          <p className="text-xs text-muted-foreground">
                            {entry.mediaType === "movie" ? "Film" : "Series"} · {releaseWording(entry.release, entry.mediaType)}{group.key === "due" || group.key === "library" ? "" : ` · ${entry.at ? timelineTime(entry.at, now) : "Date not known"}`}
                          </p>
                          <div className="self-start"><StateBadge state={entry.state} /></div>
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

function OwnerActions({ entry, onDone }: { entry: TimelineEntry; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(url: string, init: RequestInit) {
    setBusy(true); setError(null);
    try {
      const res = await sessionAwareFetch(url, { ...init, headers: { "Content-Type": "application/json" } });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "That didn't work. Try again in a moment.");
      } else onDone();
    } catch { setError("Can't reach TorrentFlow. Check that it's running and try again."); }
    finally { setBusy(false); }
  }
  // Once out, a searching film is already being grabbed the moment a release turns up.
  const released = entry.at != null && Date.parse(entry.at) <= Date.now();
  const canGrab = entry.targetId && !entry.grabNow && !released && (entry.state === "expected" || entry.state === "searching");
  const series = entry.mediaType === "tv" && entry.workKey;
  if (!series && !canGrab && !entry.grabNow) return null;
  return (
    <div className="flex flex-wrap items-center gap-2" data-calendar-actions>
      {series ? (
        <Button size="sm" variant={entry.followed ? "secondary" : "outline"} disabled={busy}
          className="max-md:min-h-11" data-calendar-follow={entry.followed ? "on" : "off"}
          onClick={() => void run(`/api/follows/${encodeURIComponent(entry.workKey!)}`,
            { method: "PUT", body: JSON.stringify({ enabled: !entry.followed }) })}>
          {entry.followed ? "Unfollow" : "Follow"}
        </Button>
      ) : null}
      {canGrab ? (
        <Button size="sm" variant="outline" disabled={busy} className="max-md:min-h-11" data-calendar-grab
          onClick={() => void run(`/api/timeline/${encodeURIComponent(entry.targetId!)}/grab-now`, { method: "POST" })}>
          Grab as soon as it appears
        </Button>
      ) : entry.grabNow ? <span className="text-xs text-muted-foreground">Grabbing as soon as it appears</span> : null}
      {error ? <p role="alert" className="w-full text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

/** Per-title minimum quality, saved at once and put back if the server says no. */
function TitleQuality({ workKey, title, quality }: { workKey: string; title: string; quality: number | null }) {
  const [value, setValue] = useState<number | null>(quality);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [synced, setSynced] = useState(quality);
  if (synced !== quality && !saving) { setSynced(quality); setValue(quality); }
  const label = QUALITY_CHOICES.find((c) => c.value === value)?.label;
  async function save(next: number) {
    const previous = value;
    setValue(next); setSaving(true); setError(null);
    try {
      const res = await sessionAwareFetch(`/api/title/${encodeURIComponent(workKey)}/quality`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ resolution: next }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
        setValue(previous);
        setError(`Quality not changed. ${body?.message ?? body?.error ?? "Try again in a moment."}`);
      }
    } catch {
      setValue(previous);
      setError("Quality not changed. Check that TorrentFlow is running and try again.");
    } finally { setSaving(false); }
  }
  return (
    <div className="contents" data-calendar-quality>
      <Button size="sm" variant="ghost" aria-expanded={open} className="max-md:min-h-11 px-1 text-xs text-muted-foreground"
        aria-label={`Minimum quality for ${title}: ${label ?? "your default"}`} onClick={() => setOpen((o) => !o)}>
        Quality: {label ?? "your default"}
        <ChevronDown aria-hidden className={cn("size-3.5 transition-transform", open && "rotate-180")} />
      </Button>
      {open ? (
        <QualityOptions name={`quality-${workKey}`} value={value} disabled={saving} onChange={(v) => void save(v)} className="basis-full" />
      ) : null}
      {error ? <p role="alert" className="basis-full text-xs text-destructive" data-calendar-quality-error>{error}</p> : null}
    </div>
  );
}

function OwnerCalendar() {
  const list = useApiQuery<TimelineResponse>("/api/timeline", { refreshMs: 30_000, emptyOnUnauthorized: false });
  const rows = list.data?.entries ?? [];
  const now = new Date();
  const groups = groupByDay(rows, now);
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
          <p className="text-sm text-muted-foreground">Air dates and release dates for what you follow, watch and approve.</p>
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
            Some air dates are not known yet. We will try again on the next refresh.</AlertDescription>
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
            <section key={group.key} aria-labelledby={`upcoming-${group.key}`} data-upcoming-group={group.label}>
              <h2 id={`upcoming-${group.key}`} className="mb-3 flex items-center gap-3 text-sm font-semibold text-foreground">
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
                        {group.key === "due" || group.key === "library" ? null : entry.at ? (
                          <time dateTime={entry.at} title={new Date(entry.at).toLocaleString()}
                            className="shrink-0 text-xs tabular-nums text-muted-foreground">
                            {timelineTime(entry.at, now)}
                          </time>
                        ) : <span className="text-xs text-subtle-foreground">Start time not known</span>}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {releaseWording(entry.release, entry.mediaType)}{entry.episode ? ` · ${entry.episode}` : ""}
                      </p>
                      <div className="flex flex-wrap items-center gap-2">
                        {entry.state ? <StateBadge state={entry.state} /> : null}
                        {entry.workKey ? <TitleQuality workKey={entry.workKey} title={entry.title} quality={entry.quality ?? null} /> : null}
                      </div>
                      <OwnerActions entry={entry} onDone={list.refetch} />
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
