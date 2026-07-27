"use client";

/**
 * Add to library, and monitoring — the two things this page can change about a
 * work beyond fetching it.
 *
 * Both go through the existing watchlist API rather than a new one:
 * `POST /api/watchlist` to add (it accepts `monitored: false` deliberately, so
 * "I want this catalogued" and "hunt every new episode for me" stay separate
 * decisions), and `PATCH` to flip monitoring afterwards. The payload is built
 * server-side and handed down whole — the client never invents a catalog id,
 * because an id it made up is an id automation will later fail to match.
 */
import { useId, useState } from "react";
import { Bell, BellOff, Check, Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { TitleLibraryState } from "./types";

export interface LibraryControlsProps {
  library: TitleLibraryState;
  isSeries: boolean;
  /** Re-reads the payload so the controls reflect the server, not a guess. */
  onChanged: () => void;
}

type Phase = "idle" | "pending" | "error";

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

  const busy = phase === "pending";

  return (
    <div data-title-library>
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
        ) : null}
      </div>

      {phase === "error" && message ? (
        <p role="alert" className="mt-2 text-[12px] text-[var(--danger)]">
          {message}
        </p>
      ) : null}
    </div>
  );
}
