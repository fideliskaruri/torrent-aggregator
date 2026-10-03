export type TimelineEntry = {
  id: string;
  kind: "check" | "airs" | "queued";
  title: string;
  episode?: string | null;
  posterUrl?: string | null;
  at?: string | null;
  nextCheckAt?: string | null;
  lane?: string | null;
  queuePosition?: number | null;
  waitReason: {
    reason: "None" | "OutsideWindow" | "QueueFull" | "WaitingForSeeders" | "NotAiredYet" | "LowerLane" | "NextCheckScheduled";
    text: string;
    until?: string | null;
    since?: string | null;
  };
  workKey?: string | null;
  targetId?: string | null;
  state?: CalendarState;
  release?: "episode" | "digital" | "physical" | "theatrical" | "release";
  followed?: boolean;
  grabNow?: boolean;
  quality?: number | null;
  mediaType?: "movie" | "tv" | null;
};

export type CalendarState = "pending" | "expected" | "searching" | "found" | "downloading" | "in_library";

export type RequesterCalendarEntry = {
  id: string; title: string; posterUrl?: string | null; at?: string | null;
  state: CalendarState; mediaType: "movie" | "tv";
};
export type RequesterCalendarResponse = { entries?: RequesterCalendarEntry[] };

export const stateLabels: Record<CalendarState, string> = {
  pending: "Waiting for approval", expected: "Expected", searching: "Searching", found: "Found",
  downloading: "Downloading", in_library: "In library",
};

/** One group per local calendar day; undated rows go last. */
export function groupByDay<T extends { at?: string | null }>(entries: readonly T[], now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const map = new Map<string, { key: string; label: string; entries: T[] }>();
  for (const entry of entries) {
    const at = entry.at ? new Date(entry.at) : null;
    const valid = at && Number.isFinite(at.getTime());
    const day = valid ? new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime() : NaN;
    const key = valid ? String(day) : "none";
    const diff = Math.round((day - today) / 86_400_000);
    const label = !valid ? "Date not known" : diff === 0 ? "Today" : diff === 1 ? "Tomorrow" : diff === -1 ? "Yesterday"
      : at.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short",
        ...(at.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
    if (!map.has(key)) map.set(key, { key, label, entries: [] });
    map.get(key)!.entries.push(entry);
  }
  return [...map.values()].sort((a, b) => (a.key === "none" ? 1 : b.key === "none" ? -1 : Number(a.key) - Number(b.key)));
}

export type TimelineResponse = { entries: TimelineEntry[]; airTimesUnavailable: boolean };
export type TimelineGroup = { label: "Today" | "Tomorrow" | "Later"; entries: TimelineEntry[] };

/** Calendar boundaries, not 24-hour durations: tomorrow can be 23 or 25 hours across DST. */
export function groupTimeline(entries: readonly TimelineEntry[], now = new Date()): TimelineGroup[] {
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  const later = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2).getTime();
  const groups: TimelineGroup[] = [
    { label: "Today", entries: [] }, { label: "Tomorrow", entries: [] }, { label: "Later", entries: [] },
  ];
  for (const entry of entries) {
    const at = entry.at ? new Date(entry.at).getTime() : NaN;
    // Overdue checks and queues with no start estimate belong to the current day.
    groups[!Number.isFinite(at) || at < tomorrow ? 0 : at < later ? 1 : 2].entries.push(entry);
  }
  return groups.filter((group) => group.entries.length > 0);
}

export function timelineTime(at: string | null | undefined, now = new Date()): string {
  if (!at || !Number.isFinite(new Date(at).getTime())) return "Start time not known";
  const seconds = (new Date(at).getTime() - now.getTime()) / 1000;
  if (seconds <= 0) return "Due now";
  if (seconds < 60) return "In less than a minute";
  const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "always" });
  if (seconds < 3600) return relative.format(Math.ceil(seconds / 60), "minute");
  if (seconds < 86400) return relative.format(Math.ceil(seconds / 3600), "hour");
  return relative.format(Math.ceil(seconds / 86400), "day");
}
