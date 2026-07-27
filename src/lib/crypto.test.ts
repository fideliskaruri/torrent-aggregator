/**
 * Credential encryption.
 *
 * The important property: a saved password must never land in the database in
 * plaintext. An earlier version returned the plaintext unchanged when no
 * secret was configured, which is the one failure mode that matters.
 */
import fs from "node:fs";
import { encryptSecret, decryptSecret, keyFilePath, resetKeyCache } from "./crypto";

let failures = 0;

function assert(name: string, cond: boolean, detail = "") {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// Ask the implementation where the key lives rather than reconstructing the
// path. The hard-coded `cwd()/.torrentflow.key` here was wrong as soon as the
// unit runner gave the suite its own database in a temp directory: the key was
// written next to that database, and "generates a key file" failed while the
// code was behaving exactly as designed.
const KEY_FILE = keyFilePath();
const hadKeyFile = fs.existsSync(KEY_FILE);
const originalEnvKey = process.env.ENCRYPTION_KEY;
const originalAuthSecret = process.env.AUTH_SECRET;

function withEnv(key: string | undefined, fn: () => void) {
  if (key === undefined) {
    delete process.env.ENCRYPTION_KEY;
    delete process.env.AUTH_SECRET;
  } else {
    process.env.ENCRYPTION_KEY = key;
  }
  resetKeyCache();
  fn();
}

// --- With an explicit key ------------------------------------------------
withEnv("test-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaa", () => {
  const secret = "hunter2-correct-horse";
  const enc = encryptSecret(secret);

  assert("returns a value", enc !== null);
  assert("is marked as encrypted", enc!.startsWith("enc:v1:"));
  assert(
    "the plaintext does not appear in the stored value",
    !enc!.includes(secret),
  );
  assert("round-trips", decryptSecret(enc) === secret);

  const again = encryptSecret(secret);
  assert(
    "a fresh IV is used each time",
    again !== enc,
    "identical ciphertext leaks that two passwords match",
  );
  assert("both ciphertexts decrypt to the same value", decryptSecret(again) === secret);

  assert("re-encrypting an encrypted value is a no-op", encryptSecret(enc) === enc);

  assert("null in, null out", encryptSecret(null) === null);
  assert("empty string in, null out", encryptSecret("") === null);
  assert("null decrypts to null", decryptSecret(null) === null);

  // Tampering must be detected by the GCM auth tag, not silently accepted.
  const tampered = enc!.slice(0, -4) + "AAAA";
  assert("a tampered value does not decrypt", decryptSecret(tampered) === null);
  assert("a malformed value does not decrypt", decryptSecret("enc:v1:junk") === null);

  // Legacy rows written before encryption existed must still be readable.
  assert("legacy plaintext passes through", decryptSecret("oldpass") === "oldpass");
});

// --- A different key must not decrypt ------------------------------------
let fromKeyA: string | null = null;
withEnv("key-A-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", () => {
  fromKeyA = encryptSecret("secret-under-key-a");
});
withEnv("key-B-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", () => {
  assert(
    "a value encrypted under another key does not decrypt",
    decryptSecret(fromKeyA) === null,
  );
});

// --- With NO key configured: must still encrypt --------------------------
withEnv(undefined, () => {
  const secret = "no-env-key-password";
  const enc = encryptSecret(secret);

  assert(
    "encrypts even when no secret is configured",
    enc !== null && enc.startsWith("enc:v1:"),
    `got ${enc}`,
  );
  assert(
    "never stores the plaintext when no secret is configured",
    enc !== secret && !enc!.includes(secret),
  );
  assert("generates a key file", fs.existsSync(KEY_FILE));
  assert("round-trips with the generated key", decryptSecret(enc) === secret);

  // The generated key must persist, or every restart orphans saved passwords.
  resetKeyCache();
  assert("the generated key survives a cache reset", decryptSecret(enc) === secret);
});

// --- Cleanup -------------------------------------------------------------
if (!hadKeyFile && fs.existsSync(KEY_FILE)) fs.unlinkSync(KEY_FILE);
if (originalEnvKey === undefined) delete process.env.ENCRYPTION_KEY;
else process.env.ENCRYPTION_KEY = originalEnvKey;
if (originalAuthSecret === undefined) delete process.env.AUTH_SECRET;
else process.env.AUTH_SECRET = originalAuthSecret;

console.log(failures === 0 ? "\nPASS crypto" : `\nFAIL crypto (${failures})`);
process.exit(failures === 0 ? 0 : 1);
