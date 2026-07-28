"use client";

/**
 * The hero action row: how to get this work, and what the library should do
 * with it afterwards.
 *
 * Two intents, kept visually distinct rather than crammed into one control —
 * the same split the search card draws (`components/search/torrent-card.tsx`):
 *
 *  - **Play** streams it. `POST /api/torrent/send` with `retention: "stream"` —
 *    a reclaimable cache entry, sent so you can watch now.
 *  - **Download** keeps it. The same endpoint with `retention: "keep"` — a
 *    permanent file that survives the retention sweep.
 *
 * A Play button with a download icon glued to its side made those two decisions
 * look like one; they are not, so they get one clear button each, matching
 * icons (Play vs Download), matching sizing, and a labelled gap between the
 * acquire pair and the library controls beside them.
 *
 * The library side still goes through the existing watchlist API rather than a
 * new one: `POST /api/watchlist` to add (it accepts `monitored: false`
 * deliberately, so "I want this catalogued" and "hunt every new episode for me"
 * stay separate decisions), and `PATCH` to flip monitoring afterwards. The
 * payload is built server-side and handed down whole — the client never invents
 * a catalog id, because an id it made up is an id automation will later fail to
 * match.
 */
import { useId, useState } from "react";
import {
  Bell,
  BellOff,
  Check,
  Download,
  Loader2,
  Play,
  Plus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { TitleLibraryState } from "./types";

export interface LibraryControlsProps {
  library: TitleLibraryState;
  isSeries: boolean;
  /** Re-reads the payload so the controls reflect the server, not a guess. */
  onChanged: () => void;
}

type Phase = "idle" | "pending" | "error";

/** The two acquire intents, named the same way the search card names them. */
type Retention = "stream" | "keep";

/** `S02E06`, or null when there is no episode cursor to name. */
function episodeLabel(season: number | null, episode: number | null): string | null {
  if (season == null || episode == null) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `S${pad(season)}E${pad(episode)}`;
}

export function LibraryControls({
  library,
  isSeries,
  onChanged,
}: LibraryControlsProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const monitoringDescriptionId = useId();

  async function send(request: () => Promise<Response>, failure: string) {
    setPhase("pending");
    setMessage(null);
    try {
      const res = await request();
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error || `${failure} (${res.status})`);
      }
      setPhase("idle");
      onChanged();
    } catch (err) {
      setPhase("error");
      setMessage(err instanceof Error ? err.message : failure);
    }
  }

  const add = () =>
    send(
      () =>
        fetch("/api/watchlist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...library.addPayload,
            // Adding from a title page is "keep track of this", not "start
            // hunting". Monitoring is one press away and is its own decision.
            monitored: false,
          }),
        }),
      "Could not add this to your library",
    );

  const setMonitored = (monitored: boolean) =>
    send(
      () =>
        fetch("/api/watchlist", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: library.watchListItemId, monitored }),
        }),
      "Could not change monitoring",
    );

  // Play and Download are one endpoint and one difference: retention. "stream"
  // is a reclaimable cache entry sent so you can watch now; "keep" is a
  // permanent file. Identity comes from the catalog payload the server built —
  // the client passes what it was handed rather than inventing a release name.
  const acquire = (retention: Retention) =>
    send(
      () =>
        fetch("/api/torrent/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: library.addPayload.title,
            source: "title",
            metadata: library.addPayload,
            watchListItemId: library.watchListItemId,
            retention,
          }),
        }),
      retention === "stream"
        ? "Could not start streaming this"
        : "Could not start downloading this",
    );

  const busy = phase === "pending";
  const epLabel = episodeLabel(library.cursorSeason, library.cursorEpisode);
  const titleText = library.addPayload.title;

  return (
    <div data-title-library className="flex flex-col gap-3">
      {/* The acquire pair. One decision each: Play streams it now, Download
          keeps the file. Matching size and a shared gap, so neither reads as a
          modifier hanging off the other. */}
      <div className="flex flex-wrap items-center gap-2" data-title-acquire>
        <Button
          type="button"
          size="lg"
          variant="default"
          data-title-stream
          data-retention="stream"
          aria-label={
            epLabel ? `Play — ${titleText} ${epLabel}` : `Play — ${titleText}`
          }
          aria-busy={busy || undefined}
          disabled={busy}
          onClick={() => acquire("stream")}
        >
          {busy ? (
            <Loader2 className="animate-spin" aria-hidden />
          ) : (
            <Play className="fill-current" aria-hidden />
          )}
          Play
          {epLabel ? (
            <span className="text-[12px] opacity-80">{epLabel}</span>
          ) : null}
        </Button>

        <Button
          type="button"
          size="lg"
          variant="secondary"
          data-title-download
          data-retention="keep"
          aria-label={
            epLabel
              ? `Download — ${titleText} ${epLabel}`
              : `Download — ${titleText}`
          }
          aria-busy={busy || undefined}
          disabled={busy}
          onClick={() => acquire("keep")}
        >
          {busy ? (
            <Loader2 className="animate-spin" aria-hidden />
          ) : (
            <Download aria-hidden />
          )}
          Download
        </Button>
      </div>

      {/* The library controls, set apart from the acquire pair rather than
          jostling it — add or confirm membership, then decide monitoring. */}
      <div className="flex flex-wrap items-center gap-2">
        {library.inLibrary ? (
          <span
            className="inline-flex items-center gap-1.5 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2 text-[12px] text-[var(--text-secondary)]"
            data-in-library
          >
            <Check className="h-3.5 w-3.5" aria-hidden />
            In your library
          </span>
        ) : (
          <Button
            type="button"
            size="lg"
            variant="secondary"
            data-add-to-library
            disabled={busy}
            onClick={add}
          >
            {busy ? (
              <Loader2 className="animate-spin" aria-hidden />
            ) : (
              <Plus aria-hidden />
            )}
            Add to library
          </Button>
        )}

        {library.inLibrary && library.watchListItemId ? (
          <div className="flex flex-col items-start gap-1.5">
            <Button
              type="button"
              size="lg"
              variant={library.monitored ? "secondary" : "default"}
              data-monitor-toggle
              aria-pressed={library.monitored}
              aria-describedby={!library.monitored ? monitoringDescriptionId : undefined}
              disabled={busy}
              onClick={() => setMonitored(!library.monitored)}
            >
              {busy ? (
                <Loader2 className="animate-spin" aria-hidden />
              ) : library.monitored ? (
                <Bell aria-hidden />
              ) : (
                <BellOff aria-hidden />
              )}
              {library.monitored
                ? "Turn automatic checks off"
                : "Turn automatic checks on"}
            </Button>
            {/* The helper only speaks when monitoring is off, but its row is
                always here so turning it on never pulls the layout up. */}
            <div className="min-h-[1.25rem]">
              {!library.monitored ? (
                <p
                  id={monitoringDescriptionId}
                  className="max-w-[24rem] text-left text-[12px] text-[var(--text-tertiary)]"
                >
                  {isSeries
                    ? "New episodes are fetched as they appear."
                    : "This is fetched as soon as a release shows up."}
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      {phase === "error" && message ? (
        <p role="alert" className="text-[12px] text-[var(--danger)]">
          {message}
        </p>
      ) : null}
    </div>
  );
}
