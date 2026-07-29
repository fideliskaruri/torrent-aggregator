"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSession } from "@/components/providers/session-provider";
import { ArrowRight, HardDriveDownload } from "lucide-react";
import { titleHrefForName, workIdentityFor } from "@/components/title/work-key";

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

/** A clean human title for a raw release name — never the scene filename. */
function displayTitle(name: string): string {
  const identity = workIdentityFor(name);
  return identity.name?.trim() || name;
}

/**
 * Thin home teaser for active client downloads when signed in.
 * Silent on error / unconfigured client.
 */
export function ActiveDownloadsTeaser() {
  const { status } = useSession();
  const [items, setItems] = useState<TeaserTorrent[]>([]);

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
      } catch {
        /* unconfigured / offline — no teaser */
      }
    }
    void load();
    // Without this the panel fetches once and freezes. Hidden tabs do not poll:
    // nobody is reading it, and the engine pays.
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
          </span>
        </h2>
        <Link
          href="/client"
          className="text-[12px] text-[var(--text-tertiary)] hover:text-[var(--accent-text)] inline-flex items-center gap-1 min-h-[44px] lg:min-h-0"
        >
          Open client
          <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
      <ul className="space-y-1.5">
        {items.map((t) => {
          const titleHref = titleHrefForName(t.name) ?? "/client";
          return (
            <li key={t.hash}>
              <Link
                href={titleHref}
                className="surface-interactive flex items-center gap-3 px-3 py-2.5 min-h-[44px] min-w-0 lg:min-h-0"
                data-teaser-item
              >
                <p className="min-w-0 flex-1 text-[13px] font-medium text-[var(--text)] truncate">
                  {displayTitle(t.name)}
                </p>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
