import type { ClientConnectionConfig } from "@/lib/clients/types";
import {
  existingRetentionOrigin,
  markTorrentStreamOnly,
  promoteTorrentToKept,
  shouldSendAsStreamOnly,
  streamingRetentionEnabled,
} from "./retention";

export type SendRetention = "stream" | "keep";

export async function applySendRetention(opts: {
  userId: string;
  config: ClientConnectionConfig;
  infoHash: string | null | undefined;
  retention: SendRetention;
  watchListItemId?: string | null;
}): Promise<void> {
  const infoHash = opts.infoHash?.trim();
  if (!infoHash || opts.config.clientType !== "builtin") return;

  const existingOrigin = await existingRetentionOrigin(opts.userId, infoHash);
  const streamOnly = shouldSendAsStreamOnly({
    enabled: streamingRetentionEnabled(),
    clientType: opts.config.clientType,
    sendTarget: "primary",
    watchListItemId: opts.watchListItemId ?? null,
    retention: opts.retention,
    existingOrigin,
  });

  if (streamOnly) {
    await markTorrentStreamOnly(opts.userId, infoHash, {
      allowFreshDefaultOrigin: existingOrigin == null,
    });
    return;
  }

  await promoteTorrentToKept(opts.userId, infoHash);
}
