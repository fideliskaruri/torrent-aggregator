type CheckScheduleProps = {
  nextCheckAt?: string | null;
  nextCheckReason?: string | null;
  monitored?: boolean | null;
  status: string;
  automationEnabled?: boolean;
};

export function CheckSchedule({ nextCheckAt, nextCheckReason, monitored, status, automationEnabled = true }: CheckScheduleProps) {
  if (!automationEnabled || !monitored || !["watching", "planned"].includes(status) || !nextCheckAt) return null;
  const at = new Date(nextCheckAt);
  if (!Number.isFinite(at.getTime())) return null;
  const label = at.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const reason = nextCheckReason === "not aired yet" ? "Not aired yet" :
    nextCheckReason === "waiting for seeders" ? "Waiting for seeders" : null;
  const timing = at.getTime() <= Date.now() ? "Check due" : "Next check";
  return (
    <p data-check-schedule className="mt-1 min-w-0 text-[11px] text-[var(--text-tertiary)]">
      {reason ? `${reason} · ` : ""}{timing} <time dateTime={at.toISOString()} title={at.toLocaleString()}>{label}</time>
    </p>
  );
}
