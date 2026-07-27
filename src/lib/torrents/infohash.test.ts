/**
 * infoHash normalisation and extraction tests.
 *
 * Rule class: an infoHash may be expressed as 40-char hex OR 32-char base32
 * (RFC 4648). Both forms denote the SAME torrent and must normalise to one
 * canonical lowercase-hex form. Any comparison, dedup, or index that skips
 * this normalisation silently treats the same torrent as two distinct ones.
 */
import {
  base32ToHex,
  normalizeInfoHash,
  infoHashFromMagnet,
} from "./infohash";

let failures = 0;

function assert(name: string, cond: boolean, detail = "") {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// Known hex ↔ base32 pair (pre-computed with Python: base64.b32encode)
// Hex:    aabbccdd00112233445566778899aabbccddeeff
// Base32: VK54ZXIAEERJGRCVMZ3YRGDKXPGN33XP
// ---------------------------------------------------------------------------

const HEX_LOWER = "aabbccdd00112233445566778899aabbccddeeff";
const HEX_UPPER = "AABBCCDD00112233445566778899AABBCCDDEEFF";
const BASE32_UPPER = "VK54ZXIACERDGRCVMZ3YRGNKXPGN33X7";
const BASE32_LOWER = "vk54zxiacerdgrcvmz3yrgnkxpgn33x7";
const BASE32_MIXED = "Vk54ZxIaCeRdGrCvMz3yRgNkXpGn33X7";

// A second distinct hash for "must NOT merge" tests
const HEX_B = "1122334455667788990011223344556677889900";

// ---------------------------------------------------------------------------
// base32ToHex — table-driven
// ---------------------------------------------------------------------------

const base32Cases: { label: string; input: string; expected: string | null }[] = [
  { label: "valid uppercase base32", input: BASE32_UPPER, expected: HEX_LOWER },
  { label: "valid lowercase base32", input: BASE32_LOWER, expected: HEX_LOWER },
  { label: "valid mixed-case base32", input: BASE32_MIXED, expected: HEX_LOWER },
  { label: "too short (31 chars)", input: BASE32_UPPER.slice(0, 31), expected: null },
  { label: "too long (33 chars)", input: BASE32_UPPER + "A", expected: null },
  { label: "empty string", input: "", expected: null },
  { label: "invalid char '1' in base32", input: "1K54ZXIAEERJGRCVMZ3YRGDKXPGN33XP", expected: null },
  { label: "invalid char '0' in base32", input: "0K54ZXIAEERJGRCVMZ3YRGDKXPGN33XP", expected: null },
  { label: "invalid char '8' in base32", input: "8K54ZXIAEERJGRCVMZ3YRGDKXPGN33XP", expected: null },
];

for (const tc of base32Cases) {
  const got = base32ToHex(tc.input);
  assert(`base32ToHex: ${tc.label}`, got === tc.expected, `expected ${tc.expected}, got ${got}`);
}

// ---------------------------------------------------------------------------
// normalizeInfoHash — table-driven
// ---------------------------------------------------------------------------

const normCases: { label: string; input: string; expected: string | null }[] = [
  { label: "40-char lowercase hex", input: HEX_LOWER, expected: HEX_LOWER },
  { label: "40-char uppercase hex → lowercase", input: HEX_UPPER, expected: HEX_LOWER },
  { label: "40-char mixed-case hex → lowercase", input: "AaBbCcDd00112233445566778899aAbBcCdDeEfF", expected: HEX_LOWER },
  { label: "32-char base32 → hex", input: BASE32_UPPER, expected: HEX_LOWER },
  { label: "32-char base32 lowercase → hex", input: BASE32_LOWER, expected: HEX_LOWER },
  { label: "hex with whitespace is trimmed", input: `  ${HEX_LOWER}  `, expected: HEX_LOWER },
  { label: "39-char hex → null", input: HEX_LOWER.slice(0, 39), expected: null },
  { label: "41-char hex → null", input: HEX_LOWER + "0", expected: null },
  { label: "random garbage → null", input: "not-a-hash", expected: null },
  { label: "empty string → null", input: "", expected: null },
  { label: "hex with non-hex char → null", input: "aabbccdd00112233445566778899aabbccddeefg", expected: null },
];

for (const tc of normCases) {
  const got = normalizeInfoHash(tc.input);
  assert(`normalizeInfoHash: ${tc.label}`, got === tc.expected, `expected ${tc.expected}, got ${got}`);
}

// ---------------------------------------------------------------------------
// infoHashFromMagnet — table-driven
// ---------------------------------------------------------------------------

function magnet(hash: string, extra = ""): string {
  return `magnet:?xt=urn:btih:${hash}${extra}`;
}

const magnetCases: { label: string; input: string | null; expected: string | null }[] = [
  {
    label: "hex hash in magnet",
    input: magnet(HEX_LOWER),
    expected: HEX_LOWER,
  },
  {
    label: "uppercase hex hash → lowercase",
    input: magnet(HEX_UPPER),
    expected: HEX_LOWER,
  },
  {
    label: "base32 hash in magnet → hex",
    input: magnet(BASE32_UPPER),
    expected: HEX_LOWER,
  },
  {
    label: "base32 lowercase in magnet → hex",
    input: magnet(BASE32_LOWER),
    expected: HEX_LOWER,
  },
  {
    label: "hex magnet with trackers and dn",
    input: magnet(HEX_LOWER, "&dn=Some+Show+S01E01&tr=udp://tracker1:6969&tr=udp://tracker2:80"),
    expected: HEX_LOWER,
  },
  {
    label: "base32 magnet with trackers and dn",
    input: magnet(BASE32_UPPER, "&dn=Anime+EP50&tr=udp://open.stealth.si:80"),
    expected: HEX_LOWER,
  },
  {
    label: "same torrent: hex and base32 produce identical output",
    input: magnet(BASE32_MIXED, "&dn=test"),
    expected: infoHashFromMagnet(magnet(HEX_LOWER, "&dn=other")),
  },
  {
    label: "null magnet → null",
    input: null,
    expected: null,
  },
  {
    label: "empty string → null",
    input: "",
    expected: null,
  },
  {
    label: "magnet with no btih → null",
    input: "magnet:?xt=urn:sha1:abcdef0123456789",
    expected: null,
  },
  {
    label: "truncated hex (20 chars) → null",
    input: magnet("aabbccdd0011223344"),
    expected: null,
  },
  {
    label: "percent-encoded xt param",
    input: `magnet:?xt=urn%3Abtih%3A${HEX_LOWER}&dn=test`,
    expected: HEX_LOWER,
  },
  {
    label: "two genuinely different hashes: returns first",
    input: `magnet:?xt=urn:btih:${HEX_LOWER}&xt=urn:btih:${HEX_B}`,
    expected: HEX_LOWER,
  },
];

for (const tc of magnetCases) {
  const got = infoHashFromMagnet(tc.input);
  assert(`infoHashFromMagnet: ${tc.label}`, got === tc.expected, `expected ${tc.expected}, got ${got}`);
}

// ---------------------------------------------------------------------------
// Cross-encoding equivalence: the key test for the rule class.
// A hex magnet and a base32 magnet for the same torrent must produce the
// same canonical infoHash.
// ---------------------------------------------------------------------------

{
  const fromHex = infoHashFromMagnet(magnet(HEX_UPPER, "&tr=udp://tracker-a:80"));
  const fromB32 = infoHashFromMagnet(magnet(BASE32_LOWER, "&tr=udp://tracker-b:6969"));
  assert(
    "cross-encoding: hex and base32 magnets for same torrent produce identical infoHash",
    fromHex !== null && fromB32 !== null && fromHex === fromB32,
    `hex=${fromHex}, b32=${fromB32}`,
  );
}

// Two genuinely different torrents must NOT match
{
  const hashA = infoHashFromMagnet(magnet(HEX_LOWER));
  const hashB = infoHashFromMagnet(magnet(HEX_B));
  assert(
    "different torrents: distinct infoHashes do not match",
    hashA !== null && hashB !== null && hashA !== hashB,
    `a=${hashA}, b=${hashB}`,
  );
}

// ---------------------------------------------------------------------------
console.log(failures === 0 ? "\nPASS infohash" : `\nFAIL infohash (${failures})`);
process.exit(failures === 0 ? 0 : 1);
