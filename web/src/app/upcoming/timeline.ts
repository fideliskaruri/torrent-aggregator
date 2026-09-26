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
};

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
