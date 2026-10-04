import type { StatusCounts } from "./grouping";

export type StatusTone = "danger" | "accent" | "default";

export function needsAttentionLabel(count: number): string {
  return `${count} ${count === 1 ? "needs" : "need"} attention`;
}

export function summarizeStatus(counts: StatusCounts): { label: string | null; tone: StatusTone } {
  if (counts.error <= 0) return { label: null, tone: "default" };
  const parts: string[] = [];
  if (counts.downloading > 0) parts.push(`${counts.downloading} downloading`);
  if (counts.queued > 0) parts.push(`${counts.queued} queued`);
  if (counts.paused > 0) parts.push(`${counts.paused} paused`);
  if (counts.done > 0) parts.push(`${counts.done} ready`);
  parts.push(needsAttentionLabel(counts.error));
  const moving = counts.downloading + counts.queued;
  return {
    label: parts.join(" · "),
    tone: counts.error * 2 > counts.total || moving === 0 ? "danger" : moving > 0 ? "accent" : "default",
  };
}
