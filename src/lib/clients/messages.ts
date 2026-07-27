import type { AddTorrentResult } from "./types";

function pctLabel(pct: number): number {
  return Math.max(0, Math.min(100, Math.round(Number.isFinite(pct) ? pct : 0)));
}

function peerLabel(peers: number): string {
  const n = Math.max(0, Math.round(Number.isFinite(peers) ? peers : 0));
  return `${n} ${n === 1 ? "peer" : "peers"}`;
}

export function formatAddTorrentMessage(result: AddTorrentResult): string {
  const details = result.ok ? result.details : undefined;
  if (details?.type !== "builtin-transfer") return result.message;

  const progress = `${pctLabel(details.pct)}%`;
  if (details.action === "already_complete") {
    return `Already complete (${progress})`;
  }

  const suffix = `${progress} · ${peerLabel(details.peers)}`;
  return details.action === "already_downloading"
    ? `Download already in progress (${suffix})`
    : `Download started (${suffix})`;
}

export function withFormattedAddTorrentMessage<T extends AddTorrentResult>(
  result: T,
): T {
  return { ...result, message: formatAddTorrentMessage(result) };
}
