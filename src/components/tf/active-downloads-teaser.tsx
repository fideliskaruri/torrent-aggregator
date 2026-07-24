"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { ArrowRight, HardDriveDownload } from "lucide-react";
import { formatBytes } from "@/lib/utils";

interface TeaserTorrent {
  hash: string;
  name: string;
  progress: number;
  dlspeed: number;
  state: string;
}

function isDownloading(state: string) {
  return /down|meta|stalledDL|allocat|queuedDL|checking/i.test(state);
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
        const active = torrents.filter((t) => isDownloading(t.state));
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
    return () => {
      cancelled = true;
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
          return (
            <li key={t.hash}>
              <Link
                href="/client"
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
