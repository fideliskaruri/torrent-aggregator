/**
 * Normalize torrent-client connection failures into clear, user-facing messages.
 * Root cause of many 502s: external client not running (ECONNREFUSED on host:port).
 * Built-in engine never needs a host:port — do not frame its errors as "offline client".
 */
export function isClientOfflineError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const cause =
    err instanceof Error && err.cause instanceof Error
      ? err.cause.message
      : "";
  const hay = `${msg} ${cause}`.toLowerCase();
  return (
    hay.includes("econnrefused") ||
    hay.includes("enotfound") ||
    hay.includes("econnreset") ||
    hay.includes("etimedout") ||
    hay.includes("networkerror") ||
    hay.includes("fetch failed") ||
    hay.includes("aborted") ||
    hay.includes("timeout") ||
    hay.includes("und_err_connect") ||
    hay.includes("connect timeout")
  );
}

function clientDisplayName(clientTypeOrLabel: string): string {
  const t = clientTypeOrLabel.toLowerCase();
  if (t === "builtin" || t.includes("built-in") || t.includes("builtin")) {
    return "built-in engine";
  }
  if (t === "qbittorrent") return "qBittorrent";
  if (t === "transmission") return "Transmission";
  return clientTypeOrLabel || "torrent client";
}

export function formatClientError(
  err: unknown,
  clientTypeOrLabel = "torrent client",
): { offline: boolean; message: string; code: string } {
  const isBuiltin =
    clientTypeOrLabel === "builtin" ||
    /built-?in/i.test(clientTypeOrLabel);
  const label = clientDisplayName(clientTypeOrLabel);
  const raw = err instanceof Error ? err.message : String(err);
  const cause =
    err instanceof Error && err.cause instanceof Error
      ? err.cause.message
      : err instanceof Error && err.cause
        ? String(err.cause)
        : "";
  const detail = [raw, cause].filter(Boolean).join(" — ");

  // Built-in has no external WebUI — network "offline" framing is wrong.
  if (isBuiltin) {
    return {
      offline: false,
      code: "ENGINE_ERROR",
      message:
        detail ||
        "Built-in engine failed. Check server logs, disk free space, and DOWNLOAD_DIR.",
    };
  }

  if (isClientOfflineError(err) || /fetch failed/i.test(detail)) {
    return {
      offline: true,
      code: "CLIENT_OFFLINE",
      message:
        `Cannot reach ${label}. Is it running, and is the Host URL in Settings correct? ` +
        `(Connection refused usually means qBittorrent/Transmission is not listening on that port.) ` +
        `Or switch Client to Built-in for one-app downloads.`,
    };
  }

  if (/login failed/i.test(detail)) {
    return {
      offline: false,
      code: "CLIENT_AUTH",
      message: `${label} login failed — check username/password in Settings.`,
    };
  }

  return {
    offline: false,
    code: "CLIENT_ERROR",
    message: detail || `Unexpected ${label} error`,
  };
}
