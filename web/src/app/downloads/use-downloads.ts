import { useCallback, useEffect, useRef, useState } from "react";
import { get, send } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useVisiblePoll } from "@/hooks/use-visible-poll";
import { useMaxActiveDownloads } from "./use-max-active";
import {
  applySnapshot,
  emptySnapshotState,
  shouldApplySnapshot,
  type SnapshotState,
} from "./snapshot-sync";
import { mergeOwnedTransferSnapshots } from "@/lib/clients/transfer-ownership";
import type { TorrentClientType } from "@/lib/clients";
import type { ClientTorrent } from "./types";

export function useDownloads(pausePolling: boolean) {
  const [snapshot, setSnapshot] = useState<SnapshotState<ClientTorrent>>(() => emptySnapshotState<ClientTorrent>());
  const { torrents, error, offline, authoritative } = snapshot;
  const [clientType, setClientType] = useState("");
  const [clientHost, setClientHost] = useState("");
  const [loading, setLoading] = useState(true);
  const [switchingBuiltin, setSwitchingBuiltin] = useState(false);
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
      let data: {
        torrents?: ClientTorrent[];
        clientType?: string;
        message?: string;
        error?: string;
        offline?: boolean;
        host?: string;
        partial?: boolean;
        clientIssues?: Array<{ clientType: TorrentClientType; message: string }>;
      } = {};
      try {
        data = text ? JSON.parse(text) as typeof data : {};
      } catch {
        throw new Error(text.trim() ? `Bad response: ${text.slice(0, 120)}` : "Empty response from client API");
      }
      if (!shouldApplySnapshot(seq, appliedSeqRef.current)) return;
      const type = data.clientType ?? "";
      setClientType(type);
      setClientHost(type === "builtin" ? "" : data.host ?? "");

      if (data.partial && data.clientIssues?.length) {
        const unavailable = data.clientIssues.map((issue) => issue.clientType);
        const warning = data.clientIssues.map((issue) => issue.message).join(" ");
        commit(() => setSnapshot((previous) => applySnapshot(previous, {
          ok: false,
          offline: false,
          torrents: mergeOwnedTransferSnapshots(previous.torrents, data.torrents ?? [], unavailable),
          error: warning,
        })));
        return;
      }
      if (!res.ok || data.offline) {
        commit(() => setSnapshot((previous) => applySnapshot(previous, {
          ok: false,
          offline: type !== "builtin" && Boolean(data.offline || !res.ok),
          torrents: data.torrents,
          error: data.message || data.error || (type === "builtin"
            ? "Built-in engine failed to respond"
            : "Torrent client is offline or unreachable"),
        })));
        return;
      }
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

  const switchToBuiltin = useCallback(async () => {
    setSwitchingBuiltin(true);
    try {
      const res = await send("/api/settings/client", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ switchToBuiltin: true }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.message || data.error || "Could not switch");
        return;
      }
      toast.success(data.message || "Switched to the built-in downloader. Your external client connection is still saved.");
      setSnapshot((previous) => ({ ...previous, error: null, offline: false }));
      await load();
    } catch {
      toast.error("Could not switch to the built-in downloader. Try again.");
    } finally {
      setSwitchingBuiltin(false);
    }
  }, [load]);

  useEffect(() => { void load(); }, [load]);
  useVisiblePoll(() => load({ quiet: true }), {
    intervalMs: offline ? 20_000 : 5_000,
    paused: pausePolling,
  });
  const maxActive = useMaxActiveDownloads({
    enabled: clientType === "builtin",
    onSaved: () => void load({ quiet: true }),
  });

  return {
    torrents,
    error,
    offline,
    authoritative,
    clientType,
    clientHost,
    loading,
    switchingBuiltin,
    switchToBuiltin,
    load,
    invalidateInFlight,
    maxActive,
  };
}
