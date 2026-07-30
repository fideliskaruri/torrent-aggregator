"use client";

/**
 * The library side of the hero: what the library should do with this work.
 *
 * The acquire intents (Play watches it now, Download keeps it) are rendered by
 * the hero itself (`title-detail.tsx`), because Play has to open the in-page
 * player and only the detail container holds that machinery. This component
 * owns the decisions that come *after* acquiring: catalogue membership and
 * monitoring.
 *
 * It goes through the existing watchlist API rather than a new one:
 * `POST /api/watchlist` to add (it accepts `monitored: false` deliberately, so
 * "I want this catalogued" and "hunt every new episode for me" stay separate
 * decisions), and `PATCH` to flip monitoring afterwards. The payload is built
 * server-side and handed down whole — the client never invents a catalog id,
 * because an id it made up is an id automation will later fail to match.
 */
import { useState } from "react";
import { Bell, BellOff, Check, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { TitleLibraryState } from "./types";

export interface LibraryControlsProps {
  library: TitleLibraryState;
  isSeries: boolean;
  /** Re-reads the payload so the controls reflect the server, not a guess. */
  onChanged: () => void;
}

type Phase = "idle" | "pending";

export function LibraryControls({
  library,
  isSeries,
  onChanged,
}: LibraryControlsProps) {
  const [phase, setPhase] = useState<Phase>("idle");

  async function send(request: () => Promise<Response>, failure: string) {
    setPhase("pending");
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
      setPhase("idle");
      // A failure belongs next to nothing on the page — it belongs in a toast
      // that names what went wrong, so the hero layout never jumps to make room
      // for a red line and the message cannot strand itself away from its cause.
      toast.error(err instanceof Error ? err.message : failure);
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
    <div
      data-title-library
      className="flex flex-wrap items-center gap-2"
    >
      {library.inLibrary ? (
        <span
          className="inline-flex items-center gap-1.5 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2 text-[12px] text-[var(--text-secondary)]"
          data-in-library
        >
          <Check className="h-3.5 w-3.5" aria-hidden />
          In your library
        </span>
      ) : (
        // A tertiary control, not a third primary button: ghost weight and
        // compact size so it sits quietly beside Play and Download instead of
        // stranded on its own row competing for the eye.
        <Button
          type="button"
          size="sm"
          variant="ghost"
          data-add-to-library
          disabled={busy}
          onClick={add}
          className="min-h-[44px] text-[var(--text-secondary)] lg:min-h-0"
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
        // Monitoring is a preference, not a call to action: a plain toggle
        // that says what it *does* in product terms, not "automatic checks".
        <Button
          type="button"
          size="sm"
          variant="ghost"
          role="switch"
          data-monitor-toggle
          aria-checked={library.monitored}
          disabled={busy}
          onClick={() => setMonitored(!library.monitored)}
          className="min-h-[44px] text-[var(--text-secondary)] lg:min-h-0"
        >
          {busy ? (
            <Loader2 className="animate-spin" aria-hidden />
          ) : library.monitored ? (
            <Bell aria-hidden />
          ) : (
            <BellOff aria-hidden />
          )}
          {library.monitored
            ? isSeries
              ? "Auto-downloading new episodes"
              : "Auto-downloading when available"
            : isSeries
              ? "Auto-download new episodes"
              : "Auto-download when available"}
        </Button>
      ) : null}
    </div>
  );
}
