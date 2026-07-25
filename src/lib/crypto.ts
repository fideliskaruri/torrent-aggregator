import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const PREFIX = "enc:v1:";

/**
 * Where the auto-generated key lives when no secret is configured.
 * Kept next to the database so a backup of the data directory stays coherent.
 */
const KEY_FILE = path.join(process.cwd(), ".torrentflow.key");

let cachedKey: Buffer | null = null;

/**
 * Reads the configured secret, or generates and persists a local one.
 *
 * TorrentFlow is self-hosted and has no sign-in, so demanding the user invent
 * an AUTH_SECRET before they can save a qBittorrent password is friction that
 * buys nothing. Generating a key on first use keeps stored credentials
 * encrypted by default. What this must never do is silently fall back to
 * plaintext — that writes the password to the database in the clear while
 * looking like it did not.
 */
function keyFromSecret(): Buffer {
  if (cachedKey) return cachedKey;

  const configured = process.env.ENCRYPTION_KEY || process.env.AUTH_SECRET;
  if (configured) {
    cachedKey = createHash("sha256").update(configured).digest();
    return cachedKey;
  }

  let material: string;
  try {
    material = fs.readFileSync(KEY_FILE, "utf8").trim();
    if (!material) throw new Error("empty key file");
  } catch {
    material = randomBytes(32).toString("base64");
    // mode 0600: the key is only useful to whoever already has the database.
    fs.writeFileSync(KEY_FILE, material, { encoding: "utf8", mode: 0o600 });
  }

  cachedKey = createHash("sha256").update(material).digest();
  return cachedKey;
}

/** Encrypts sensitive strings at rest (external client passwords). */
export function encryptSecret(plain: string | null | undefined): string | null {
  if (plain == null || plain === "") return null;
  if (plain.startsWith(PREFIX)) return plain; // already encrypted

  const key = keyFromSecret();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64url")}.${tag.toString("base64url")}.${enc.toString("base64url")}`;
}

export function decryptSecret(stored: string | null | undefined): string | null {
  if (stored == null || stored === "") return null;
  // Values written before encryption existed, or before a key was available.
  if (!stored.startsWith(PREFIX)) return stored;

  try {
    const key = keyFromSecret();
    const raw = stored.slice(PREFIX.length);
    const [ivB64, tagB64, dataB64] = raw.split(".");
    if (!ivB64 || !tagB64 || !dataB64) return null;
    const iv = Buffer.from(ivB64, "base64url");
    const tag = Buffer.from(tagB64, "base64url");
    const data = Buffer.from(dataB64, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString(
      "utf8",
    );
  } catch {
    // Wrong key or tampered value — unusable rather than guessable.
    return null;
  }
}

/** Test seam: forces the next call to re-read the key. */
export function resetKeyCache(): void {
  cachedKey = null;
}
