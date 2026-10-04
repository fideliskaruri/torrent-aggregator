import { useCallback, useEffect, useRef, useState } from "react";
import { get } from "@/lib/api";
import { useVisiblePoll } from "@/hooks/use-visible-poll";
import { useMaxActiveDownloads } from "./use-max-active";
import {
  applySnapshot,
  emptySnapshotState,
  shouldApplySnapshot,
  type SnapshotState,
} from "./snapshot-sync";
import type { ClientTorrent } from "./types";
import { useWantedRows } from "@/components/wanted/wanted-actions";

export function useDownloads(pausePolling: boolean) {
  const [snapshot, setSnapshot] = useState<SnapshotState<ClientTorrent>>(() => emptySnapshotState<ClientTorrent>());
  const { torrents, error, authoritative } = snapshot;
  const [loading, setLoading] = useState(true);
  const requestSeqRef = useRef(0);
  const appliedSeqRef = useRef(0);

  const invalidateInFlight = useCallback(() => {
    requestSeqRef.current += 1;
    appliedSeqRef.current = requestSeqRef.current;
  }, []);

  const load = useCallback(async (opts?: { quiet?: boolean }) => {
    if (!opts?.quiet) setLoading(true);
    const seq = ++requestSeqRef.current;
    const commit = (apply: () => void) => {
      if (!shouldApplySnapshot(seq, appliedSeqRef.current)) return false;
      appliedSeqRef.current = seq;
      apply();
      return true;
    };
    try {
      const res = await get("/api/client/torrents");
      const text = await res.text();
      let data: { torrents?: ClientTorrent[]; message?: string; error?: string } = {};
      try {
        data = text ? JSON.parse(text) as typeof data : {};
      } catch {
        throw new Error(text.trim() ? `Bad response: ${text.slice(0, 120)}` : "Empty response from TorrentFlow");
      }
      if (!res.ok) throw new Error(data.message || data.error || `TorrentFlow answered HTTP ${res.status}.`);
      commit(() => setSnapshot((previous) => applySnapshot(previous, {
        ok: true,
        torrents: data.torrents ?? [],
      })));
    } catch (cause) {
      commit(() => setSnapshot((previous) => applySnapshot(previous, {
        ok: false,
        error: cause instanceof Error ? cause.message : String(cause),
      })));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useVisiblePoll(() => load({ quiet: true }), {
    intervalMs: 5_000,
    paused: pausePolling,
  });
  const maxActive = useMaxActiveDownloads({
    enabled: true,
    onSaved: () => void load({ quiet: true }),
  });
  const wanted = useWantedRows();

  return {
    torrents,
    error,
    authoritative,
    loading,
    load,
    invalidateInFlight,
    maxActive,
    wanted,
  };
}
