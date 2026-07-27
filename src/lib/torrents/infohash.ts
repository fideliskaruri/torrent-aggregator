/**
 * Canonical infoHash utilities.
 *
 * An infoHash is the 20-byte SHA-1 of a torrent's info dictionary. It appears
 * in two text encodings:
 *   - **Hex** — 40 lowercase `[0-9a-f]` characters (the common form).
 *   - **Base32** — 32 `[A-Z2-7]` characters (RFC 4648, used by some magnet
 *     generators and older clients).
 *
 * Both forms denote the **same torrent**. Any code that compares, deduplicates,
 * or indexes by infoHash must normalise to one canonical form first.
 *
 * Canonical form: **40-char lowercase hex**.
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * Decode a 32-char base32 (RFC 4648) string to a 40-char lowercase hex string.
 * Returns null when the input is not valid base32 or does not produce exactly
 * 20 bytes (40 hex chars).
 */
export function base32ToHex(value: string): string | null {
  if (value.length !== 32) return null;

  let bits = "";
  for (const ch of value.toUpperCase()) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) return null;
    bits += idx.toString(2).padStart(5, "0");
  }

  let hex = "";
  for (let i = 0; i + 4 <= bits.length && hex.length < 40; i += 4) {
    hex += Number.parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex.length === 40 ? hex : null;
}

/**
 * Normalise a raw infoHash string (hex or base32) to 40-char lowercase hex.
 * Returns null for anything that is not a valid infoHash.
 */
export function normalizeInfoHash(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (/^[0-9a-f]{40}$/i.test(value)) return value.toLowerCase();
  if (/^[a-z2-7]{32}$/i.test(value)) return base32ToHex(value);
  return null;
}

const BTIH_RE = /[?&]xt=([^&]+)/gi;

/**
 * Extract the canonical 40-char lowercase-hex infoHash from a magnet URI.
 *
 * Handles both hex and base32 btih values, and percent-encoded `xt` params.
 * Returns null when the magnet has no recognisable btih.
 */
export function infoHashFromMagnet(
  magnet: string | null | undefined,
): string | null {
  if (!magnet) return null;

  const matches = magnet.match(BTIH_RE) ?? [];
  for (const match of matches) {
    const raw = match.replace(/^[?&]?xt=/i, "");
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw).replace(/^urn:btih:/i, "");
    } catch {
      continue;
    }
    const normalised = normalizeInfoHash(decoded);
    if (normalised) return normalised;
  }
  return null;
}
