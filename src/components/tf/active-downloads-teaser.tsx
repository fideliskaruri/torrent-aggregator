"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSession } from "@/components/providers/session-provider";
import { ArrowRight, HardDriveDownload } from "lucide-react";
import { formatBytes } from "@/lib/utils";
import { titleHrefForName } from "@/components/title/work-key";

interface TeaserTorrent {
  hash: string;
  name: string;
  progress: number;
  dlspeed: number;
  state: string;
  retentionState?: "kept" | "stream" | "prewarm" | "unknown";
}

function isDownloading(state: string) {
  return /down|meta|stalledDL|allocat|queuedDL|checking/i.test(state);
}

// A stream-only torrent only pulls the pieces the player is watching, so its
// whole-file progress and download speed stay low — it reads as a stalled
// download here even while playback is smooth. Prewarm is speculative
// background work the user never asked to "download". Neither belongs in
// "Active downloads"; only kept downloads (and legacy/external rows whose
// origin we cannot classify) do.
function isDownloadRetention(retentionState: TeaserTorrent["retentionState"]) {
  return retentionState !== "stream" && retentionState !== "prewarm";
}

/**
 * Thin home teaser for active client downloads when signed in.
 * Silent on error / unconfigured client.
 */
export function ActiveDownloadsTeaser() {
  const { status } = useSession();
  const [items, setItems] = useState<TeaserTorrent[]>([]);
  const [dlspeed, setDlspeed] = useState(0);

  useEffect(() => {
    if (status !== "authenticated") return;
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/client/torrents");
        if (!res.ok) return;
        const data = (await res.json()) as { torrents?: TeaserTorrent[] };
        const torrents = data.torrents ?? [];
        const active = torrents.filter(
          (t) => isDownloading(t.state) && isDownloadRetention(t.retentionState),
        );
        if (cancelled) return;
        setItems(active.slice(0, 3));
        setDlspeed(
          active.reduce((sum, t) => sum + (t.dlspeed || 0), 0),
        );
      } catch {
        /* unconfigured / offline — no teaser */
      }
    }
    void load();
    // Without this the panel fetches once and freezes — but it shows a live
    // download *speed*, so a frozen value is not merely stale, it is wrong.
    // Hidden tabs do not poll: nobody is reading it, and the engine pays.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (cancelled) return;
      if (document.visibilityState === "visible") await load();
      if (!cancelled) timer = setTimeout(tick, 10_000);
    };
    timer = setTimeout(tick, 10_000);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [status]);

  if (status !== "authenticated" || items.length === 0) return null;

  return (
    <section
      className="pb-10 border-t border-[var(--border)] pt-10"
      data-active-downloads-teaser
    >
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-[13px] font-medium text-[var(--text-secondary)] inline-flex items-center gap-2">
          <HardDriveDownload className="h-3.5 w-3.5 text-[var(--accent-text)]" />
          Active downloads
          {/* A screen reader concatenates adjacent text nodes and cannot see
              the flex `gap`, so this announced as "Active downloads2". A
              whitespace-only node is no use here either — the spec drops
              whitespace-only anonymous flex items — so the separator has to be
              a real glyph, hidden visually and read as a pause. */}
          <span className="sr-only">,</span>
          <span className="text-[11px] font-normal text-[var(--text-tertiary)] tabular-nums">
            {items.length}
            {dlspeed > 0 ? ` · ↓ ${formatBytes(dlspeed)}/s` : ""}
          </span>
        </h2>
        <Link
          href="/client"
          className="text-[12px] text-[var(--text-tertiary)] hover:text-[var(--accent-text)] inline-flex items-center gap-1"
        >
          Open client
          <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
      <ul className="space-y-1.5">
        {items.map((t) => {
          const pct = Math.min(100, Math.round(t.progress * 1000) / 10);
          const titleHref = titleHrefForName(t.name) ?? "/client";
          return (
            <li key={t.hash}>
              <Link
                href={titleHref}
                className="surface-interactive flex items-center gap-3 px-3 py-2.5 min-w-0"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium text-[var(--text)] truncate">
                    {t.name}
                  </p>
                  <div className="mt-1.5 flex items-center gap-2">
                    <div className="h-1 flex-1 max-w-[12rem] rounded-full bg-[var(--bg-muted)] overflow-hidden">
                      <div
                        className="h-full rounded-full bg-[var(--accent)]"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="text-[11px] tabular-nums text-[var(--text-tertiary)] font-mono">
                      {pct.toFixed(0)}%
                    </span>
                  </div>
                </div>
                <span className="shrink-0 text-[11px] tabular-nums font-mono text-[var(--accent-text)]">
                  ↓ {formatBytes(t.dlspeed)}/s
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
