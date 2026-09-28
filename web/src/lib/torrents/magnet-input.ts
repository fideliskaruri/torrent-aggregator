/**
 * Validate free-text "add magnet / .torrent URL" input on Downloads.
 *
 * Accepts:
 *   - magnet:?xt=urn:btih:<40 hex | 32 base32> (plus extra params)
 *   - magnet:?xt=urn:btmh:… (v2 multihash magnets)
 *   - http(s) URL whose path ends in .torrent
 *
 * Empty input is invalid for submit (the form disables Add when empty).
 */
import { infoHashFromMagnet } from "./infohash";

/** Shown under the field when the value is non-empty and not a usable source. */
export const TORRENT_SOURCE_INPUT_HINT =
  "Paste a magnet link (magnet:?xt=urn:btih:…) or a link to a .torrent file.";

const BTMH_XT_RE = /[?&]xt=([^&]+)/gi;

function magnetHasBtmh(magnet: string): boolean {
  const matches = magnet.match(BTMH_XT_RE) ?? [];
  for (const match of matches) {
    const raw = match.replace(/^[?&]?xt=/i, "");
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      decoded = raw;
    }
    if (/^urn:btmh:/i.test(decoded)) {
      const body = decoded.replace(/^urn:btmh:/i, "").trim();
      if (body.length >= 8) return true;
    }
  }
  return false;
}

/** True when `raw` is a magnet with a real btih/btmh or an http(s) .torrent URL. */
export function isValidTorrentSourceInput(raw: string | null | undefined): boolean {
  if (raw == null) return false;
  const value = raw.trim();
  if (!value) return false;

  if (/^magnet:\?/i.test(value)) {
    if (infoHashFromMagnet(value)) return true;
    return magnetHasBtmh(value);
  }

  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (url.protocol !== "http:" && url.protocol !== "https:") return false;
      return /\.torrent$/i.test(url.pathname);
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * Parse a validated magnet / .torrent URL into the send payload shape.
 * Returns null when the input is empty or invalid.
 */
export function parseTorrentSourceInput(
  raw: string,
): { magnet?: string; torrentUrl?: string; name?: string } | null {
  const value = raw.trim();
  if (!isValidTorrentSourceInput(value)) return null;

  if (/^magnet:\?/i.test(value)) {
    const dn = (() => {
      try {
        const url = new URL(value);
        return url.searchParams.get("dn")?.trim() || undefined;
      } catch {
        const match = /(?:^|[?&])dn=([^&]+)/i.exec(value)?.[1];
        if (!match) return undefined;
        try {
          return decodeURIComponent(match).trim() || undefined;
        } catch {
          return match.trim() || undefined;
        }
      }
    })();
    return dn ? { magnet: value, name: dn } : { magnet: value };
  }

  const tail = value.split("/").pop() ?? "";
  const name = tail.replace(/\.torrent(?:[?#].*)?$/i, "").trim();
  try {
    const decoded = name ? decodeURIComponent(name) : "";
    return decoded ? { torrentUrl: value, name: decoded } : { torrentUrl: value };
  } catch {
    return name ? { torrentUrl: value, name } : { torrentUrl: value };
  }
}
