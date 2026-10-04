import { send } from "@/lib/api";
import { toast } from "@/lib/toast";
import { readJsonBody, sendErrorFromBody } from "@/lib/api-json";
import {
  parseTorrentSourceInput,
  TORRENT_SOURCE_INPUT_HINT,
} from "@/lib/torrents/magnet-input";
import type { ClientTorrent, TorrentRowAction } from "./types";
import { transferLabel, transfersLabel } from "./release-display";
import type { useDownloads } from "./use-downloads";
import type { useDownloadsPageState } from "./use-downloads-page-state";

type Ui = ReturnType<typeof useDownloadsPageState>;
type Data = ReturnType<typeof useDownloads>;
type Selection = {
  openDeleteDialog: (rows: ClientTorrent[]) => void;
};
type ActionResult = { ok: true } | { ok: false; reason: string };

async function postRowAction(
  act: "pause" | "resume" | "force",
  torrent: ClientTorrent,
): Promise<ActionResult> {
  const response = await send("/api/client/torrents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: act,
      hash: torrent.hash,
    }),
  }).catch(() => null);
  if (!response) return { ok: false, reason: "Couldn't reach TorrentFlow. Try again." };
  const body = await readJsonBody<{ ok?: boolean; message?: string; detail?: string; error?: string }>(response);
  if (response.ok && body?.ok !== false) return { ok: true };
  return {
    ok: false,
    reason: body?.detail?.trim() || body?.message?.trim() || body?.error?.trim() ||
      `TorrentFlow answered HTTP ${response.status}. Try again.`,
  };
}

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function useDownloadRowActions(
  ui: Ui,
  data: Data,
  selection: Selection,
) {
  async function action(act: TorrentRowAction, torrent: ClientTorrent) {
    if (act === "find-another-release") {
      ui.setFindAnotherTorrent(torrent);
      return;
    }
    data.invalidateInFlight();
    const label = transferLabel(torrent);
    const verb = act === "force" ? "start" : act;
    const outcome = await postRowAction(act, torrent);
    void data.load();
    if (!outcome.ok) {
      toast.error(`Couldn't ${verb} ${label}`, { description: outcome.reason });
      ui.setAnnouncement(`Couldn't ${verb} ${label}.`);
      return;
    }
    if (act === "force") {
      toast.success(`Started ${label}`);
      ui.setAnnouncement(`Started ${label}.`);
      return;
    }
    ui.setAnnouncement(`${act === "pause" ? "Paused" : "Resumed"} ${label}.`);
  }

  async function confirmFindAnother() {
    const torrent = ui.findAnotherTorrent;
    if (!torrent || ui.findingAnother) return;
    ui.setFindingAnother(true);
    const label = transferLabel(torrent);
    data.invalidateInFlight();
    try {
      const response = await send(`/api/downloads/${encodeURIComponent(torrent.transferId)}/find-another`, {
        method: "POST",
      });
      const body = await readJsonBody<{ ok?: boolean; message?: string; error?: string }>(response);
      if (!response.ok || body?.ok !== true) {
        toast.error(`Couldn't find another release for ${label}`, {
          description: body?.message?.trim() || body?.error?.trim() ||
            `TorrentFlow answered HTTP ${response.status}. Try again.`,
        });
        return;
      }
      ui.setFindAnotherTorrent(null);
      ui.setSelected((previous) => {
        if (!previous.has(torrent.transferId)) return previous;
        const next = new Set(previous);
        next.delete(torrent.transferId);
        return next;
      });
      toast.success(`Looking for another release of ${label}`);
      ui.setAnnouncement(`Looking for another release of ${label}.`);
      void data.load();
    } catch {
      toast.error(`Couldn't find another release for ${label}`, {
        description: "Couldn't reach TorrentFlow. Try again.",
      });
    } finally {
      ui.setFindingAnother(false);
    }
  }

  async function sendRawTorrent() {
    const parsed = parseTorrentSourceInput(ui.rawSendValue);
    if (!parsed) {
      ui.setRawSendError({ message: TORRENT_SOURCE_INPUT_HINT, field: "source" });
      return;
    }
    ui.setRawSendError(null);
    data.invalidateInFlight();
    if (!(await ui.ensureDownloadSetup())) return;
    ui.setSendingRaw(true);
    try {
      const response = await send("/api/torrent/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...parsed, source: "manual", target: "primary", retention: "keep" }),
      });
      const body = await readJsonBody<{ ok?: boolean; message?: string; error?: string }>(response);
      if (response.ok && body && body.ok !== false) {
        toast.success(body.message || "Added to downloads");
        ui.setRawSendValue("");
      } else {
        ui.setRawSendError(sendErrorFromBody(body, response.status));
      }
    } catch (cause) {
      ui.setRawSendError({
        message: cause instanceof Error && cause.message ? cause.message : "Couldn't reach TorrentFlow. Try again.",
        field: null,
      });
    } finally {
      ui.setSendingRaw(false);
      void data.load();
    }
  }

  async function actionMany(act: "pause" | "resume" | "delete", transfers: ClientTorrent[], deleteFiles = false) {
    if (!transfers.length) return;
    data.invalidateInFlight();
    if (act === "delete") {
      const what = transfersLabel(transfers);
      try {
        const response = await send("/api/client/torrents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "delete", hashes: transfers.map((torrent) => torrent.hash), deleteFiles }),
        });
        const body = await readJsonBody<{ ok?: boolean; message?: string; error?: string }>(response);
        if (!response.ok || body?.ok !== true) {
          toast.error(`Couldn't remove ${what}`, {
            description: body?.message?.trim() || body?.error?.trim() ||
              `TorrentFlow answered HTTP ${response.status}. Try again.`,
          });
          return;
        }
        const summary = deleteFiles ? `Removed ${what} and its files` : `Removed ${what} but kept its files`;
        toast.success(summary);
        ui.setAnnouncement(`${summary}.`);
        ui.setSelected(new Set());
        ui.setPendingDelete(null);
        void data.load();
      } catch {
        toast.error(`Couldn't remove ${what}`, { description: "Couldn't reach TorrentFlow. Try again." });
      }
      return;
    }
    const outcomes = await Promise.all(transfers.map((torrent) => postRowAction(act, torrent)));
    void data.load();
    const reasons = outcomes.flatMap((outcome) => outcome.ok ? [] : [outcome.reason]);
    const done = transfers.length - reasons.length;
    const verb = act === "pause" ? "Paused" : "Resumed";
    const what = transfersLabel(transfers);
    if (!reasons.length) {
      toast.success(`${verb} ${what}`);
      ui.setAnnouncement(`${verb} ${what}.`);
    } else if (done > 0) {
      const summary = `${verb} ${done} of ${transfers.length} downloads`;
      toast.warning(summary, { description: `${plural(reasons.length, "download")} couldn't ${act}: ${reasons[0]}` });
      ui.setAnnouncement(`${summary}.`);
    } else {
      toast.error(`Couldn't ${act} ${what}`, { description: reasons[0] });
      ui.setAnnouncement(`Couldn't ${act} ${what}.`);
    }
  }

  function openBulkDelete() {
    selection.openDeleteDialog(data.torrents.filter((torrent) => ui.selected.has(torrent.transferId)));
  }

  return { action, confirmFindAnother, sendRawTorrent, actionMany, openBulkDelete };
}
