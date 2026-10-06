/**
 * "Pick a release yourself": when TorrentFlow could not choose a release for a
 * title, episode or season, the owner searches here, starting from the query
 * we used, and picks one. Releases that fit come first.
 *
 *   GET  /api/title/{workKey}/releases?season&episode&q → { query, releases[] }
 *   POST /api/title/{workKey}/releases { token }        → { ok, message, infoHash }
 *   POST /api/requests/{id}/pick { token }              → { ok, message, status }
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { LoadingGlyph, SkeletonBlock } from "@/components/ui/loading";
import { TfEmptyState } from "@/components/tf/empty-state";
import { TfErrorState } from "@/components/tf/error-state";
import { readJsonBody } from "@/lib/api-json";
import { sessionAwareFetch } from "@/lib/session-expiry";
import { toast } from "@/lib/toast";
import { ReleaseCard, type ReleaseCardData } from "./release-card";
import { hasNoEnglish } from "./release-language";

import { PICK_RELEASE_LABEL, releasePickSubject, type ReleasePickTarget } from "./release-picker-store";

interface PickRelease extends ReleaseCardData {
  peers: number;
  fits: boolean;
}

interface PickList {
  query: string;
  releases: PickRelease[];
}

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; data: PickList }
  | { kind: "error"; message: string };

const CHOICES_TTL_MS = 15 * 60_000;

function failureMessage(body: { message?: string; error?: string } | null, status: number, fallback: string): string {
  const said = body?.message?.trim() || body?.error?.trim();
  if (said) return said;
  if (status === 403) return "Only the owner can pick a release.";
  if (!body || status >= 500) return "TorrentFlow couldn't search just now. Try again in a moment.";
  return fallback;
}

export function ReleasePickerDialog({ target, onClose }: { target: ReleasePickTarget; onClose: () => void }) {
  const base = `/api/title/${encodeURIComponent(target.workKey)}/releases`;
  const [query, setQuery] = useState(target.query?.trim() ?? "");
  const [searched, setSearched] = useState<string | null>(target.query?.trim() || null);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [pickingToken, setPickingToken] = useState<string | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "loading" });
    setStale(false);
    setPickError(null);
    const params = new URLSearchParams();
    if (target.season != null) params.set("season", String(target.season));
    if (target.episode != null) params.set("episode", String(target.episode));
    if (searched) params.set("q", searched);
    void (async () => {
      try {
        const res = await sessionAwareFetch(`${base}?${params.toString()}`, { cache: "no-store", signal: controller.signal });
        const body = await readJsonBody<PickList & { message?: string; error?: string }>(res);
        if (controller.signal.aborted) return;
        if (!res.ok || !body || !Array.isArray(body.releases)) {
          setState({ kind: "error", message: failureMessage(body, res.status, "Couldn't search right now. Try again.") });
          return;
        }
        setQuery((current) => current || body.query);
        setState({ kind: "ready", data: body });
      } catch {
        if (!controller.signal.aborted) {
          setState({ kind: "error", message: "Couldn't reach TorrentFlow. Check your connection, then try again." });
        }
      }
    })();
    return () => controller.abort();
  }, [base, target.season, target.episode, searched, attempt]);

  useEffect(() => {
    if (state.kind !== "ready") return;
    const timer = window.setTimeout(() => {
      setStale(true);
      setPickError("These results are out of date. Search again to get fresh ones.");
    }, CHOICES_TTL_MS);
    return () => window.clearTimeout(timer);
  }, [state]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const next = query.trim() || null;
    if (next === searched) setAttempt((n) => n + 1);
    else setSearched(next);
  }

  async function pick(release: PickRelease) {
    setPickingToken(release.token);
    setPickError(null);
    try {
      const url = target.requestId ? `/api/requests/${encodeURIComponent(target.requestId)}/pick` : base;
      const res = await sessionAwareFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: release.token,
          ...(!target.requestId && target.replaceTransferId
            ? { replaceTransferId: target.replaceTransferId }
            : {}),
        }),
      });
      const body = await readJsonBody<{ ok?: boolean; message?: string; error?: string }>(res);
      if (!res.ok || !body?.ok) {
        if (!mounted.current) return;
        setPickError(failureMessage(body, res.status, "That release couldn't be started. Search again and pick another."));
        setStale(true);
        return;
      }
      toast.success(`Started ${release.title}`);
      target.onPicked?.();
      onClose();
    } catch {
      if (mounted.current) setPickError("Couldn't reach TorrentFlow. Nothing was started. Try again.");
    } finally {
      if (mounted.current) setPickingToken(null);
    }
  }

  const picking = pickingToken !== null;
  const releases = state.kind === "ready" ? state.data.releases : [];
  const fitting = releases.filter((release) => release.fits);
  const others = releases.filter((release) => !release.fits);
  const scope = target.episode != null ? "this episode" : target.season != null ? "this season" : "this title";

  const renderList = (list: PickRelease[], label: string, offset: number) => (
    <section className="space-y-2" aria-label={label}>
      <h3 className="text-xs font-medium text-muted-foreground">{label}</h3>
      <ol className="space-y-2">
        {list.map((release, index) => {
          // The server lists English first and blocked releases last; neither a blocked release nor one without English is the best match.
          const best = offset === 0 && index === 0 && release.fits && !release.blocked && !hasNoEnglish(release.languages);
          return (
            <ReleaseCard
              key={release.token}
              release={release}
              highlighted={best}
              badge={best ? <Badge variant="accent">Best match</Badge> : null}
              pending={pickingToken === release.token}
              disabled={picking || stale}
              actionLabel="Download this"
              pendingLabel="Starting…"
              onUse={() => void pick(release)}
              buttonData={{ "data-pick-release": "" }}
              data-release-pick=""
              data-release-fits={release.fits ? "true" : "false"}
              data-release-rank={offset + index + 1}
            />
          );
        })}
      </ol>
    </section>
  );

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent mobileFullscreen className="sm:max-w-2xl" data-release-picker aria-busy={state.kind === "loading" || picking}>
        <DialogHeader className="shrink-0 border-b border-border px-4 pb-3 pt-4 pr-14 sm:px-5">
          <DialogTitle>{PICK_RELEASE_LABEL}</DialogTitle>
          <DialogDescription className="break-words">{releasePickSubject(target)}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 pb-[calc(1rem+var(--safe-bottom))] sm:px-5 sm:pb-5">
          <form className="flex flex-col gap-2 sm:flex-row" onSubmit={submit} role="search" data-release-pick-search>
            <label htmlFor="release-pick-query" className="sr-only">Search for releases</label>
            <Input
              id="release-pick-query"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search for releases"
              autoComplete="off"
              className="max-md:min-h-11"
              data-release-pick-query
            />
            <Button type="submit" variant="secondary" className="max-md:min-h-11 sm:w-auto" disabled={state.kind === "loading"}>
              <Search aria-hidden />
              Search
            </Button>
          </form>

          {pickError ? (
            <p
              role="alert"
              className="rounded-sm border border-border bg-muted px-3 py-2 text-[13px] text-destructive break-words"
              data-release-pick-error
            >
              {pickError}
            </p>
          ) : null}

          {state.kind === "loading" ? (
            <div role="status" aria-live="polite" aria-label="Searching" data-release-pick-loading>
              <p className="mb-3 flex items-center gap-2 text-[13px] text-muted-foreground">
                <LoadingGlyph className="h-3.5 w-3.5" />
                Searching…
              </p>
              <ul className="space-y-2" aria-hidden>
                {Array.from({ length: 3 }).map((_, i) => (
                  <li key={i} className="space-y-2 rounded-lg border border-border p-3">
                    <SkeletonBlock className="h-4 w-4/5" />
                    <SkeletonBlock className="h-3 w-1/2" />
                    <SkeletonBlock className="h-11 w-full sm:w-36" />
                  </li>
                ))}
              </ul>
            </div>
          ) : state.kind === "error" ? (
            <TfErrorState title="Couldn't search" message={state.message} onRetry={() => setAttempt((n) => n + 1)} />
          ) : releases.length === 0 ? (
            <TfEmptyState
              title="Nothing came up for that search"
              description="Try a shorter name or another spelling, then search again."
            />
          ) : (
            <>
              {fitting.length > 0 ? renderList(fitting, `Fits ${scope}`, 0) : (
                <p className="text-[13px] leading-relaxed text-muted-foreground">
                  Nothing here clearly matches {scope}. Check the names before you pick one.
                </p>
              )}
              {others.length > 0 ? renderList(others, "Other results", fitting.length) : null}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
