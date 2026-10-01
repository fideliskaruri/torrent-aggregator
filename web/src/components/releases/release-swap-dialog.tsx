/**
 * "Find another source": replace one built-in download with a different
 * release of the same film or episode. Downloads (film rows, series episode
 * cards) and the title page (film hero, episode cards) open this one dialog.
 *
 * Codes against the owner-only contract (docs/audio-language-plan.md, 6.4.7):
 *   GET  /api/client/torrents/{hash}/alternatives[?source=id]
 *        → { health, alternatives[], sources[], recommendedToken?, current?, note? }
 *   POST /api/client/torrents/{hash}/alternatives { token, allowBlocked? } → { ok, message, hash }
 *   POST /api/client/torrents/{hash}/alternatives { best: true, source? } → { ok, message, hash }
 * Optional properties may be omitted or null, and render nothing when absent.
 * Alternatives keep the server's order: best first, blocked releases last.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { LoadingGlyph, SkeletonBlock } from "@/components/ui/loading";
import { TfEmptyState } from "@/components/tf/empty-state";
import { TfErrorState } from "@/components/tf/error-state";
import { isDownloaded } from "@/app/downloads/grouping";
import { stateLabel } from "@/app/downloads/release-display";
import { readJsonBody } from "@/lib/api-json";
import { RULE_SOURCE_OPTIONS } from "@/lib/rules/form";
import { sessionAwareFetch } from "@/lib/session-expiry";
import { toast } from "@/lib/toast";
import { formatDuration, formatSpeed } from "@/lib/format";
import { cn } from "@/lib/utils";
import { FIND_ANOTHER_SOURCE_LABEL } from "./find-another-source";
import { ReleaseCard, ReleaseFacts, releaseSourceLabel, type ReleaseCardData } from "./release-card";
import { ReleaseLanguages, type ReleaseLanguageInfo } from "./release-language";

export interface ReleaseSwapHealth {
  connectedSeeders?: number | null;
  connectedPeers?: number | null;
  downloadBytesPerSecond: number;
  stalledForSeconds: number;
  state: string;
}

export interface ReleaseAlternative extends ReleaseCardData {
  /** Indexer leechers, not connected peers. */
  peers: number;
}

/** An enabled searchable site. `count` stays empty until that site has been searched. */
export interface ReleaseSwapSource {
  id: string;
  name: string;
  count?: number | null;
}

/** The download being replaced, as the server sees it. */
export interface ReleaseSwapCurrent {
  title: string;
  source?: string | null;
  sizeBytes?: number | null;
  quality?: number | null;
  finished: boolean;
  languages?: ReleaseLanguageInfo | null;
}

export interface ReleaseAlternatives {
  health: ReleaseSwapHealth;
  alternatives: ReleaseAlternative[];
  sources?: ReleaseSwapSource[];
  recommendedToken?: string | null;
  current?: ReleaseSwapCurrent | null;
  /** What happens to the current files, written by the server for the download's state. */
  note?: string | null;
}

/** What the dialog replaces. Pages pass what they already know, and the server's answer fills in the rest. */
export interface ReleaseSwapSubject {
  /** The download's info hash. */
  hash: string;
  /** The film or show, for the search link. */
  workTitle?: string | null;
  /** How the page names this download, e.g. "Sintel" or "Frieren S01E28". */
  label?: string | null;
  /** Live facts a Downloads row already has, shown while the server answers. */
  live?: {
    state: string;
    queuePosition?: number | null;
    peers?: number | null;
    dlspeed?: number | null;
  } | null;
}

const CHOICES_TTL_MS = 10 * 60_000;
/** RadioGroup value for "no site filter"; Radix values must be strings. */
const ALL_SOURCES = "all";
/** Said for an unfinished download when the server sends no note of its own. */
const UNFINISHED_NOTE = "Switching removes this release's partial files. Completed files and other downloads are kept.";

function alternativesEndpoint(hash: string): string {
  return `/api/client/torrents/${encodeURIComponent(hash.toLowerCase())}/alternatives`;
}

const sourceLabel = releaseSourceLabel;

/** Server messages name sites by id ("on apibay"); show the same names the chips use. */
function withSourceLabels(message: string): string {
  return message.replace(/\bon ([a-z0-9][a-z0-9_-]*)\b/gi, (match, id: string) => {
    const label = RULE_SOURCE_OPTIONS.find((option) => option.value === id.toLowerCase())?.label;
    return label ? `on ${label}` : match;
  });
}

/** Keep chips stable across refetches: keep every known site and only overwrite counts the server reported. */
function mergeSources(previous: ReleaseSwapSource[], next: ReleaseSwapSource[] | undefined): ReleaseSwapSource[] {
  if (!next?.length) return previous;
  const prior = new Map(previous.map((source) => [source.id, source]));
  const merged = next.map((source) => ({ ...source, count: source.count ?? prior.get(source.id)?.count }));
  const seen = new Set(merged.map((source) => source.id));
  return [...merged, ...previous.filter((source) => !seen.has(source.id))];
}

/** The release to suggest when the server names none: the first one that is neither blocked nor in another language. */
function fallbackRecommendation(alternatives: ReleaseAlternative[]): string | null {
  return alternatives.find((candidate) => !candidate.blocked && candidate.languages?.fit !== "clash")?.token ?? null;
}

function failureMessage(body: { message?: string; title?: string } | null, status: number, fallback: string): string {
  if (body?.message?.trim()) return body.message.trim();
  if (status === 403) return "Only the owner can find another source.";
  if (!body || status >= 500) return "TorrentFlow couldn't check other releases just now. Try again in a moment.";
  return fallback;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; data: ReleaseAlternatives }
  | { kind: "error"; message: string; refused?: boolean };

export function ReleaseSwapDialog({
  subject,
  onClose,
  onSwapped,
}: {
  subject: ReleaseSwapSubject;
  onClose: () => void;
  /** Called after a switch with the confirmation the toast showed, for pages to announce or refresh. */
  onSwapped: (message: string) => void;
}) {
  const endpoint = alternativesEndpoint(subject.hash);
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [source, setSource] = useState<string | null>(null);
  const [sources, setSources] = useState<ReleaseSwapSource[]>([]);
  // The current release and the server's note outlive a site change, which refetches the list.
  const [current, setCurrent] = useState<ReleaseSwapCurrent | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [switchingToken, setSwitchingToken] = useState<string | null>(null);
  const [findingBest, setFindingBest] = useState(false);
  const [swapError, setSwapError] = useState<string | null>(null);
  // Choices are one-use tokens that expire after 10 minutes; once refused or
  // old they can't be used, so the list asks to be fetched again.
  const [stale, setStale] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const retry = useCallback(() => {
    setSwapError(null);
    setStale(false);
    setAttempt((n) => n + 1);
  }, []);

  useEffect(() => {
    if (state.kind !== "ready") return;
    const timer = window.setTimeout(() => {
      setStale(true);
      setSwapError("These choices expired. Find releases again to get fresh ones.");
    }, CHOICES_TTL_MS);
    return () => window.clearTimeout(timer);
  }, [state]);

  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "loading" });
    const url = source ? `${endpoint}?source=${encodeURIComponent(source)}` : endpoint;
    void (async () => {
      try {
        const res = await sessionAwareFetch(url, { cache: "no-store", signal: controller.signal });
        const body = await readJsonBody<ReleaseAlternatives & { message?: string }>(res);
        if (controller.signal.aborted) return;
        if (!res.ok || !body || !Array.isArray(body.alternatives) || !body.health) {
          setState({
            kind: "error",
            message: failureMessage(body, res.status, "Couldn't search right now. Try again."),
            // 409 is the server declining this download (imported, or finished), not a failed search.
            refused: res.status === 409,
          });
          return;
        }
        setSources((previous) => mergeSources(previous, body.sources));
        if (body.current) setCurrent(body.current);
        if (body.note?.trim()) setNote(body.note.trim());
        setState({
          kind: "ready",
          data: {
            health: body.health,
            alternatives: body.alternatives,
            recommendedToken: body.recommendedToken ?? fallbackRecommendation(body.alternatives),
          },
        });
      } catch {
        if (!controller.signal.aborted) {
          setState({ kind: "error", message: "Couldn't reach TorrentFlow. Check your connection, then try again." });
        }
      }
    })();
    return () => controller.abort();
  }, [endpoint, source, attempt]);

  function chooseSource(next: string | null) {
    if (next === source) return;
    setSwapError(null);
    setStale(false);
    setSource(next);
  }

  async function switchTo(candidate: ReleaseAlternative) {
    setSwitchingToken(candidate.token);
    setSwapError(null);
    try {
      const res = await sessionAwareFetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // A blocked release is only offered as "Use it anyway"; picking it overrides the block.
        body: JSON.stringify(candidate.blocked ? { token: candidate.token, allowBlocked: true } : { token: candidate.token }),
      });
      const body = await readJsonBody<{ ok?: boolean; message?: string; title?: string }>(res);
      if (!res.ok || !body?.ok) {
        if (!mounted.current) return;
        setSwapError(failureMessage(body, res.status, "That release couldn't be used. Find releases again and pick another."));
        // A refused token is spent or expired; the rest of the list may be too.
        setStale(true);
        return;
      }
      const message = body.message?.trim() || `Switched to ${candidate.title}`;
      toast.success(message);
      onSwapped(message);
    } catch {
      if (mounted.current) setSwapError("Couldn't reach TorrentFlow. The release was not switched. Try again.");
    } finally {
      if (mounted.current) setSwitchingToken(null);
    }
  }

  async function findBest() {
    setFindingBest(true);
    setSwapError(null);
    try {
      const res = await sessionAwareFetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(source ? { best: true, source } : { best: true }),
      });
      const body = await readJsonBody<{ ok?: boolean; message?: string; title?: string; hash?: string }>(res);
      if (!res.ok || !body?.ok) {
        if (!mounted.current) return;
        const message = withSourceLabels(failureMessage(body, res.status, "No better release was found. Your current download was kept."));
        retry();
        setSwapError(message);
        return;
      }
      const picked = state.kind === "ready" && body.hash
        ? state.data.alternatives.find((candidate) => candidate.hash.toLowerCase() === body.hash?.toLowerCase())
        : undefined;
      const message = body.message?.trim() || `Switched to ${picked?.title ?? "a better release"}`;
      toast.success(message);
      onSwapped(message);
    } catch {
      if (mounted.current) setSwapError("Couldn't reach TorrentFlow. The release was not switched. Try again.");
    } finally {
      if (mounted.current) setFindingBest(false);
    }
  }

  const switching = switchingToken !== null || findingBest;
  const named = subject.label?.trim() || subject.workTitle?.trim() || null;
  const searchQuery = subject.workTitle?.trim() || named || current?.title || "";
  const searchHref = `/search?q=${encodeURIComponent(searchQuery)}`;
  const selectedSource = source ? sources.find((entry) => entry.id === source) : undefined;
  const selectedLabel = source ? sourceLabel(source, selectedSource?.name) : null;
  const refused = state.kind === "error" && state.refused === true;
  const nothingToPick = (state.kind === "ready" && state.data.alternatives.length === 0) || refused;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent mobileFullscreen className="sm:max-w-2xl" data-release-swap-dialog aria-busy={state.kind === "loading" || switching}>
        <DialogHeader className="shrink-0 border-b border-border px-4 pb-3 pt-4 pr-14 sm:px-5">
          <DialogTitle>{FIND_ANOTHER_SOURCE_LABEL}</DialogTitle>
          <DialogDescription className="break-words">
            {named ?? "Replace this download with a different release."}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 pb-[calc(1rem+var(--safe-bottom))] sm:px-5 sm:pb-5">
          <CurrentRelease
            live={subject.live ?? null}
            current={current}
            health={state.kind === "ready" ? state.data.health : null}
            note={note}
            checking={state.kind === "loading"}
          />

          <section aria-label="Where to look" className="space-y-3" data-swap-finder>
            <SourcePicker sources={sources} selected={source} disabled={switching} onSelect={chooseSource} />
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
              <Button
                type="button"
                size="lg"
                className="w-full sm:w-auto"
                disabled={switching || nothingToPick}
                aria-busy={findingBest}
                onClick={() => void findBest()}
                data-swap-best
                data-pending={findingBest ? "true" : undefined}
              >
                {findingBest ? <LoadingGlyph /> : null}
                {findingBest ? "Finding the best release…" : "Find the best one for me"}
              </Button>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {nothingToPick
                  ? "There's nothing better to switch to here."
                  : `Picks the best release on ${selectedLabel ?? "any site"} and switches to it.`}
              </p>
            </div>
          </section>

          {swapError ? (
            <p
              role="alert"
              className="rounded-sm border border-border bg-muted px-3 py-2 text-[13px] text-destructive break-words"
              data-release-swap-error
            >
              {swapError}
            </p>
          ) : null}

          {stale && state.kind === "ready" ? (
            <Button
              type="button"
              variant="secondary"
              className="w-full sm:w-auto"
              onClick={retry}
              data-release-refresh
            >
              Find releases again
            </Button>
          ) : null}

          {state.kind === "loading" ? (
            <div role="status" aria-live="polite" aria-label={`Searching ${selectedLabel ?? "all sites"}`} data-release-alternatives-loading>
              <p className="mb-3 flex items-center gap-2 text-[13px] text-muted-foreground">
                <LoadingGlyph className="h-3.5 w-3.5" />
                Searching {selectedLabel ?? "all sites"}…
              </p>
              <ul className="space-y-2" aria-hidden>
                {Array.from({ length: 3 }).map((_, i) => (
                  <li key={i} className="space-y-2 rounded-lg border border-border p-3">
                    <SkeletonBlock className="h-4 w-4/5" />
                    <SkeletonBlock className="h-3 w-1/2" />
                    <SkeletonBlock className="h-3 w-2/3" />
                    <SkeletonBlock className="h-11 w-full sm:w-36" />
                  </li>
                ))}
              </ul>
            </div>
          ) : state.kind === "error" ? (
            <TfErrorState
              title={state.refused ? "This release can't be replaced" : "Couldn't find other releases"}
              message={state.message}
              onRetry={retry}
            />
          ) : state.data.alternatives.length === 0 ? (
            selectedLabel ? (
              <TfEmptyState
                title={`No other releases on ${selectedLabel}`}
                description="Try another site or search for the title."
                actionLabel="Search for the title"
                actionHref={searchHref}
              />
            ) : (
              <TfEmptyState
                title="No other releases found on any site"
                description="Try again later or search for the title."
                actionLabel="Search for the title"
                actionHref={searchHref}
              />
            )
          ) : (
            <div className="space-y-2">
              <h3 className="text-xs font-medium text-muted-foreground">Or choose one yourself</h3>
              <ol className="space-y-2" aria-label="Other releases, best first" data-release-alternatives>
                {state.data.alternatives.map((candidate, index) => {
                  const pending = switchingToken === candidate.token;
                  // Never suggest a release automatic picks would skip.
                  const recommended = candidate.token === state.data.recommendedToken && !candidate.blocked;
                  return (
                    <ReleaseCard
                      key={candidate.token}
                      release={candidate}
                      highlighted={recommended}
                      badge={recommended ? <Badge variant="accent" data-best-match>Best match</Badge> : null}
                      pending={pending}
                      disabled={switching || stale}
                      actionLabel="Use this release"
                      pendingLabel="Switching…"
                      onUse={() => void switchTo(candidate)}
                      buttonData={{ "data-use-release": "" }}
                      data-release-alternative=""
                      data-swap-card=""
                      data-recommended={recommended ? "true" : undefined}
                      data-alternative-hash={candidate.hash}
                      data-alternative-rank={index + 1}
                    />
                  );
                })}
              </ol>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Single-choice site filter. Arrow, Home and End keys move through the sites
 * and pick them; sites that were searched and found nothing can't be picked.
 */
function SourcePicker({
  sources,
  selected,
  disabled,
  onSelect,
}: {
  sources: ReleaseSwapSource[];
  selected: string | null;
  disabled: boolean;
  onSelect: (id: string | null) => void;
}) {
  const options: Array<{ id: string | null; label: string; count?: number | null }> = [
    { id: null, label: "All sites" },
    ...sources.map((entry) => ({ id: entry.id, label: sourceLabel(entry.id, entry.name), count: entry.count })),
  ];
  const valueOf = (id: string | null) => id ?? ALL_SOURCES;
  const current = options.some((option) => option.id === selected) ? valueOf(selected) : ALL_SOURCES;
  const unavailable = (option: { id: string | null; count?: number | null }) => option.id !== null && option.count === 0 && option.id !== selected;

  return (
    <div className="space-y-1.5">
      <p id="swap-source-label" className="text-xs font-medium text-muted-foreground">Look on</p>
      <ScrollArea className="-mx-1">
        <RadioGroup
          value={current}
          onValueChange={(value) => onSelect(value === ALL_SOURCES ? null : value)}
          disabled={disabled}
          orientation="horizontal"
          aria-labelledby="swap-source-label"
          className="flex w-max gap-1.5 px-1 py-1"
          data-swap-sources
        >
          {options.map((option) => {
            const value = valueOf(option.id);
            const empty = unavailable(option);
            const id = `swap-source-${value}`;
            return (
              <Label
                key={value}
                htmlFor={id}
                className={cn(
                  "h-9 shrink-0 cursor-pointer gap-2 whitespace-nowrap rounded-md border border-border px-3 text-xs tabular-nums text-muted-foreground transition-colors hover:bg-muted hover:text-foreground max-md:min-h-11 pointer-coarse:min-h-11",
                  "has-data-[state=checked]:border-brand/25 has-data-[state=checked]:bg-brand-dim has-data-[state=checked]:text-foreground",
                  (empty || disabled) && "cursor-not-allowed opacity-60 hover:bg-transparent",
                )}
              >
                <RadioGroupItem
                  id={id}
                  value={value}
                  disabled={empty}
                  aria-label={option.count === 0 ? `${option.label}, nothing found` : undefined}
                  data-swap-source={value}
                  data-swap-source-count={option.count ?? undefined}
                />
                <span>{option.label}</span>
                {option.count != null ? (
                  <>
                    <span aria-hidden>·</span>
                    <span>{option.count}</span>
                  </>
                ) : null}
              </Label>
            );
          })}
        </RadioGroup>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
    </div>
  );
}

/**
 * The release being replaced: its name, size, site and languages, what
 * happens to its files, and for an unfinished download how it is doing.
 */
function CurrentRelease({
  live,
  current,
  health,
  note,
  checking,
}: {
  live: ReleaseSwapSubject["live"];
  current: ReleaseSwapCurrent | null;
  health: ReleaseSwapHealth | null;
  note: string | null;
  checking: boolean;
}) {
  const transferState = health?.state ?? live?.state ?? null;
  const status = transferState ? stateLabel(transferState, live?.queuePosition) : null;
  // Unknown until the server answers when the page had no live row (the title page).
  const finished = current ? current.finished : transferState ? isDownloaded(transferState) : null;
  const shownNote = note ?? (finished === false ? UNFINISHED_NOTE : null);
  const showHealth = finished === false && (health !== null || live != null);

  const seeders = health?.connectedSeeders;
  const peers = health ? health.connectedPeers : live?.peers;
  const speed = health ? health.downloadBytesPerSecond : live?.dlspeed || 0;
  const peersText = [
    seeders != null ? `${seeders} ${seeders === 1 ? "seeder" : "seeders"}` : null,
    peers != null ? `${peers} ${peers === 1 ? "peer" : "peers"}` : null,
  ].filter(Boolean).join(" · ") || "Unknown";
  const stalledText = !health
    ? checking ? "Checking…" : "Unknown"
    : health.stalledForSeconds > 0
      ? formatDuration(health.stalledForSeconds) ?? "Not stalled"
      : "Not stalled";

  return (
    <section
      aria-label="Current release"
      className="min-w-0 space-y-2 rounded-lg bg-muted p-3"
      data-release-current
      data-release-health
      data-release-finished={finished == null ? undefined : String(finished)}
    >
      <p className="text-xs font-medium text-muted-foreground">
        {status ? `Current release · ${status}` : "Current release"}
      </p>
      {current ? (
        <div className="min-w-0 space-y-1.5">
          <p className="break-words text-sm font-medium text-foreground" data-release-current-title>
            {current.title}
          </p>
          <ReleaseFacts quality={current.quality} sizeBytes={current.sizeBytes} source={current.source} />
          <ReleaseLanguages info={current.languages} />
        </div>
      ) : checking ? (
        <div className="space-y-1.5" aria-hidden>
          <SkeletonBlock className="h-4 w-4/5" />
          <SkeletonBlock className="h-3 w-1/2" />
        </div>
      ) : null}
      {showHealth ? (
        <dl className="grid grid-cols-3 gap-3 text-sm tabular-nums">
          <div className="min-w-0">
            <dt className="text-xs text-subtle-foreground">Peers</dt>
            <dd className="break-words text-foreground" data-health-peers>{peersText}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-subtle-foreground">Speed</dt>
            <dd className="text-foreground" data-health-speed>{formatSpeed(speed) ?? "Idle"}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-subtle-foreground">Stalled for</dt>
            <dd className="text-foreground" data-health-stalled>{stalledText}</dd>
          </div>
        </dl>
      ) : null}
      {shownNote ? (
        <p className="text-[13px] leading-relaxed text-muted-foreground break-words" data-release-swap-note>
          {shownNote}
        </p>
      ) : null}
    </section>
  );
}

