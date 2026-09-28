/**
 * "Find another release": replace one incomplete built-in download with a
 * different release of the same movie or episode.
 *
 * Codes against the owner-only contract in docs/dotnet-port.md
 * ("Manual release replacement → UI integration contract"):
 *   GET  /api/client/torrents/{hash}/alternatives → { health, alternatives[] }
 *   POST /api/client/torrents/{hash}/alternatives { token } → { ok, message, hash }
 * Nullable properties are omitted by the server, so every optional field is
 * `?:` here. Alternatives are rendered in the order the server ranked them.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { LoadingGlyph, SkeletonBlock } from "@/components/ui/loading";
import { TfEmptyState } from "@/components/tf/empty-state";
import { TfErrorState } from "@/components/tf/error-state";
import { readJsonBody } from "@/lib/api-json";
import { toast } from "@/lib/toast";
import { formatBytes, formatDuration } from "@/lib/utils";
import { isDownloaded } from "./grouping";
import { stateLabel } from "./release-display";
import type { ClientTorrent } from "./types";

export interface ReleaseSwapHealth {
  connectedSeeders?: number;
  connectedPeers?: number;
  downloadBytesPerSecond: number;
  stalledForSeconds: number;
  state: string;
}

export interface ReleaseAlternative {
  token: string;
  hash: string;
  title: string;
  seeders: number;
  /** Indexer leechers — not connected peers. */
  peers: number;
  sizeBytes?: number;
  quality?: number;
  source: string;
  why: string;
}

export interface ReleaseAlternatives {
  health: ReleaseSwapHealth;
  alternatives: ReleaseAlternative[];
}

/** Only incomplete, built-in, non-imported rows have a release to replace. */
export function canFindAnotherRelease(t: ClientTorrent): boolean {
  return t.ownerClientType === "builtin" && !t.imported && t.progress < 0.9999 && !isDownloaded(t.state);
}

function alternativesEndpoint(hash: string): string {
  return `/api/client/torrents/${encodeURIComponent(hash.toLowerCase())}/alternatives`;
}

function failureMessage(body: { message?: string; title?: string } | null, status: number, fallback: string): string {
  if (body?.message?.trim()) return body.message.trim();
  if (status === 403) return "Only the owner can replace a release.";
  if (!body) return `TorrentFlow didn't answer properly (HTTP ${status}). Check that it's running, then try again.`;
  return fallback;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; data: ReleaseAlternatives }
  | { kind: "error"; message: string };

export function ReleaseSwapDialog({
  torrent,
  onClose,
  onSwapped,
}: {
  torrent: ClientTorrent;
  onClose: () => void;
  onSwapped: (releaseName: string) => void;
}) {
  const endpoint = alternativesEndpoint(torrent.hash);
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [switchingToken, setSwitchingToken] = useState<string | null>(null);
  const [swapError, setSwapError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "loading" });
    void (async () => {
      try {
        const res = await fetch(endpoint, { cache: "no-store", signal: controller.signal });
        const body = await readJsonBody<ReleaseAlternatives & { message?: string }>(res);
        if (controller.signal.aborted) return;
        if (!res.ok || !body || !Array.isArray(body.alternatives) || !body.health) {
          setState({ kind: "error", message: failureMessage(body, res.status, "Could not search for other releases.") });
          return;
        }
        setState({ kind: "ready", data: { health: body.health, alternatives: body.alternatives } });
      } catch {
        if (!controller.signal.aborted) {
          setState({ kind: "error", message: "Couldn't reach TorrentFlow. Check your connection, then try again." });
        }
      }
    })();
    return () => controller.abort();
  }, [endpoint, attempt]);

  async function switchTo(candidate: ReleaseAlternative) {
    setSwitchingToken(candidate.token);
    setSwapError(null);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: candidate.token }),
      });
      const body = await readJsonBody<{ ok?: boolean; message?: string; title?: string }>(res);
      if (!res.ok || !body?.ok) {
        if (!mounted.current) return;
        setSwapError(failureMessage(body, res.status, "Could not switch to this release."));
        // A refused token is spent or stale; fetch fresh selections.
        retry();
        return;
      }
      toast.success(`Switched to ${candidate.title}`);
      onSwapped(candidate.title);
    } catch {
      if (mounted.current) setSwapError("Couldn't reach TorrentFlow. The release was not switched. Try again.");
    } finally {
      if (mounted.current) setSwitchingToken(null);
    }
  }

  const switching = switchingToken !== null;
  const searchHref = `/search?q=${encodeURIComponent(torrent.workTitle || torrent.name)}`;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-2xl" data-release-swap-dialog aria-busy={state.kind === "loading" || switching}>
        <DialogHeader className="shrink-0 border-b border-[var(--border)] px-4 pb-3 pt-4 pr-14 sm:px-5">
          <DialogTitle>Find another release</DialogTitle>
          <DialogDescription className="break-words">
            {torrent.name}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 pb-[calc(1rem+var(--safe-bottom))] sm:px-5 sm:pb-5">
          <HealthSummary torrent={torrent} health={state.kind === "ready" ? state.data.health : null} />

          <p className="text-[13px] leading-relaxed text-[var(--text-secondary)]">
            Switching removes this release&apos;s partial files. Completed files and other downloads are kept.
          </p>

          {swapError ? (
            <p
              role="alert"
              className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-muted)] px-3 py-2 text-[13px] text-[var(--danger)] break-words"
              data-release-swap-error
            >
              {swapError}
            </p>
          ) : null}

          {state.kind === "loading" ? (
            <div role="status" aria-live="polite" aria-label="Searching for other releases" data-release-alternatives-loading>
              <p className="mb-3 flex items-center gap-2 text-[13px] text-[var(--text-secondary)]">
                <LoadingGlyph className="h-3.5 w-3.5" />
                Searching sources for other releases…
              </p>
              <ul className="space-y-2" aria-hidden>
                {Array.from({ length: 3 }).map((_, i) => (
                  <li key={i} className="space-y-2 rounded-[var(--radius)] border border-[var(--border)] p-3">
                    <SkeletonBlock className="h-4 w-4/5" />
                    <SkeletonBlock className="h-3 w-1/2" />
                    <SkeletonBlock className="h-3 w-2/3" />
                    <SkeletonBlock className="h-11 w-full sm:w-36" />
                  </li>
                ))}
              </ul>
            </div>
          ) : state.kind === "error" ? (
            <TfErrorState title="Couldn't find other releases" message={state.message} onRetry={retry} />
          ) : state.data.alternatives.length === 0 ? (
            <TfEmptyState
              title="No other releases found."
              description="Try again later or search for the title."
              actionLabel="Search for the title"
              actionHref={searchHref}
            />
          ) : (
            <ol className="space-y-2" aria-label="Other releases, best first" data-release-alternatives>
              {state.data.alternatives.map((candidate, index) => {
                const pending = switchingToken === candidate.token;
                return (
                  <li
                    key={candidate.token}
                    className="min-w-0 space-y-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-elevated)] p-3"
                    data-release-alternative
                    data-alternative-hash={candidate.hash}
                    data-alternative-rank={index + 1}
                  >
                    <p className="break-words text-sm font-medium text-[var(--text)]">{candidate.title}</p>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--text-secondary)] tabular-nums">
                      {candidate.quality ? <Badge variant="outline">{candidate.quality}p</Badge> : null}
                      <span>{candidate.seeders} {candidate.seeders === 1 ? "seeder" : "seeders"}</span>
                      <span aria-hidden>·</span>
                      <span>{candidate.sizeBytes != null ? formatBytes(candidate.sizeBytes) : "Size unknown"}</span>
                      {candidate.source ? (
                        <>
                          <span aria-hidden>·</span>
                          <span className="break-all">{candidate.source}</span>
                        </>
                      ) : null}
                    </div>
                    {candidate.why ? (
                      <p className="text-[13px] leading-relaxed text-[var(--text-secondary)] break-words" data-alternative-reason>
                        {candidate.why}
                      </p>
                    ) : null}
                    <Button
                      type="button"
                      variant={index === 0 ? "default" : "secondary"}
                      className="min-h-[44px] w-full sm:w-auto"
                      disabled={switching}
                      aria-busy={pending}
                      aria-label={`Use this release: ${candidate.title}`}
                      onClick={() => void switchTo(candidate)}
                      data-use-release
                      data-pending={pending ? "true" : undefined}
                    >
                      {pending ? <LoadingGlyph /> : null}
                      {pending ? "Switching…" : "Use this release"}
                    </Button>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function HealthSummary({ torrent, health }: { torrent: ClientTorrent; health: ReleaseSwapHealth | null }) {
  const seeders = health?.connectedSeeders;
  const peers = health ? health.connectedPeers : torrent.peers;
  const speed = health ? health.downloadBytesPerSecond : torrent.dlspeed || 0;
  const peersText = [
    seeders != null ? `${seeders} ${seeders === 1 ? "seeder" : "seeders"}` : null,
    peers != null ? `${peers} ${peers === 1 ? "peer" : "peers"}` : null,
  ].filter(Boolean).join(" · ") || "Unknown";
  const stalledText = !health
    ? "Checking…"
    : health.stalledForSeconds > 0
      ? formatDuration(health.stalledForSeconds)
      : "Not stalled";
  const status = stateLabel(health?.state ?? torrent.state, torrent.queuePosition);

  return (
    <section
      aria-label="Current release health"
      className="rounded-[var(--radius)] bg-[var(--bg-muted)] p-3"
      data-release-health
    >
      <p className="mb-2 text-xs font-medium text-[var(--text-secondary)]">Current release · {status}</p>
      <dl className="grid grid-cols-3 gap-3 text-sm tabular-nums">
        <div className="min-w-0">
          <dt className="text-xs text-[var(--text-tertiary)]">Peers</dt>
          <dd className="break-words text-[var(--text)]" data-health-peers>{peersText}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-[var(--text-tertiary)]">Speed</dt>
          <dd className="text-[var(--text)]" data-health-speed>{formatBytes(speed)}/s</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-[var(--text-tertiary)]">Stalled for</dt>
          <dd className="text-[var(--text)]" data-health-stalled>{stalledText}</dd>
        </div>
      </dl>
    </section>
  );
}
