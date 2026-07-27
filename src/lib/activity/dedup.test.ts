/**
 * Activity de-duplication tests.
 *
 * Rule class: the identity of an activity event is its infoHash (the torrent's
 * 40-hex-char SHA-1). Two entries with the same infoHash+status represent the
 * same logical event regardless of how the magnet URI encodes trackers, display
 * name, or other parameters.
 */
import {
  infoHashFromMagnet,
  activityKey,
  deduplicateActivity,
  type ActivityItem,
} from "./dedup";

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
// Helpers
// ---------------------------------------------------------------------------

const HASH_A = "aabbccdd00112233445566778899aabbccddeeff";
const HASH_B = "1122334455667788990011223344556677889900";
const HASH_C = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

function magnet(hash: string, extra = ""): string {
  return `magnet:?xt=urn:btih:${hash}${extra}`;
}

function item(overrides: Partial<ActivityItem> & { id: string }): ActivityItem {
  return {
    type: "grab",
    title: "Test",
    status: "sent",
    message: null,
    source: null,
    kind: null,
    query: null,
    magnet: null,
    infoHash: null,
    savePath: null,
    category: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// infoHashFromMagnet — table-driven
// ---------------------------------------------------------------------------

const magnetCases: { label: string; input: string | null; expected: string | null }[] = [
  {
    label: "standard magnet",
    input: magnet(HASH_A),
    expected: HASH_A,
  },
  {
    label: "magnet with trackers and dn",
    input: magnet(HASH_A, "&dn=Some+Show+S01E01&tr=udp://tracker1:6969&tr=udp://tracker2:80"),
    expected: HASH_A,
  },
  {
    label: "uppercase hash is normalized to lowercase",
    input: `magnet:?xt=urn:btih:${HASH_A.toUpperCase()}&dn=test`,
    expected: HASH_A,
  },
  {
    label: "null magnet returns null",
    input: null,
    expected: null,
  },
  {
    label: "empty string returns null",
    input: "",
    expected: null,
  },
  {
    label: "magnet without btih returns null",
    input: "magnet:?xt=urn:sha1:abcdef0123456789",
    expected: null,
  },
  {
    label: "truncated hash (too short) returns null",
    input: "magnet:?xt=urn:btih:aabbccdd",
    expected: null,
  },
];

for (const tc of magnetCases) {
  const got = infoHashFromMagnet(tc.input);
  assert(`infoHashFromMagnet: ${tc.label}`, got === tc.expected, `got ${got}`);
}

// ---------------------------------------------------------------------------
// activityKey — table-driven
// ---------------------------------------------------------------------------

const keyCases: { label: string; item: ActivityItem; expectNull: boolean; expectedPrefix?: string }[] = [
  {
    label: "item with infoHash uses it directly",
    item: item({ id: "1", infoHash: HASH_A, status: "sent" }),
    expectNull: false,
    expectedPrefix: HASH_A,
  },
  {
    label: "item without infoHash extracts from magnet",
    item: item({ id: "2", magnet: magnet(HASH_B), status: "sent" }),
    expectNull: false,
    expectedPrefix: HASH_B,
  },
  {
    label: "infoHash takes precedence over magnet extraction",
    item: item({ id: "3", infoHash: HASH_A, magnet: magnet(HASH_B), status: "sent" }),
    expectNull: false,
    expectedPrefix: HASH_A,
  },
  {
    label: "null magnet and null infoHash → null key",
    item: item({ id: "4", magnet: null, infoHash: null, status: "sent" }),
    expectNull: true,
  },
  {
    label: "different status produces different key",
    item: item({ id: "5", infoHash: HASH_A, status: "failed" }),
    expectNull: false,
    expectedPrefix: `${HASH_A}|failed`,
  },
];

for (const tc of keyCases) {
  const got = activityKey(tc.item);
  if (tc.expectNull) {
    assert(`activityKey: ${tc.label}`, got === null, `got ${got}`);
  } else {
    assert(`activityKey: ${tc.label}`, got !== null && got.startsWith(tc.expectedPrefix!), `got ${got}`);
  }
}

// ---------------------------------------------------------------------------
// deduplicateActivity — the core tests
// ---------------------------------------------------------------------------

// Case 1: same magnet from two sources (grab + history) → merged
{
  const m = magnet(HASH_A, "&tr=udp://tracker1:6969");
  const grab = item({
    id: "grab-1", type: "grab", title: "One Piece S23E1234", magnet: m,
    infoHash: HASH_A, source: "nyaa", status: "sent", createdAt: "2024-01-01T00:01:00Z",
  });
  const hist = item({
    id: "hist-1", type: "history", title: "One Piece S23E1234", magnet: m,
    infoHash: HASH_A, source: "nyaa", status: "sent", createdAt: "2024-01-01T00:00:30Z",
  });
  const result = deduplicateActivity([grab, hist], 50);
  assert("same torrent from grab+history: only grab kept", result.length === 1, `got ${result.length}`);
  assert("same torrent from grab+history: grab is the one kept", result[0].type === "grab");
}

// Case 2: same infoHash, different magnet encodings (trackers/dn differ)
{
  const m1 = magnet(HASH_A, "&dn=Breaking+Bad+S05E16&tr=udp://tracker1:6969");
  const m2 = magnet(HASH_A, "&dn=Breaking.Bad.S05E16.720p&tr=udp://tracker2:80&tr=udp://tracker3:80");
  const grab = item({
    id: "grab-2", type: "grab", title: "Breaking Bad S05E16", magnet: m1,
    infoHash: HASH_A, source: "1337x", status: "sent", createdAt: "2024-01-01T00:02:00Z",
  });
  const hist = item({
    id: "hist-2", type: "history", title: "Breaking Bad S05E16", magnet: m2,
    infoHash: null, source: "apibay", status: "sent", createdAt: "2024-01-01T00:01:30Z",
  });
  const result = deduplicateActivity([grab, hist], 50);
  assert("different magnet encodings same hash: merged to 1", result.length === 1, `got ${result.length}`);
}

// Case 3: different episodes of the same show — must NOT merge
{
  const grab1 = item({
    id: "grab-3a", type: "grab", title: "Family Guy S22E05", magnet: magnet(HASH_A),
    infoHash: HASH_A, source: "eztv", status: "sent", createdAt: "2024-01-01T00:03:00Z",
  });
  const grab2 = item({
    id: "grab-3b", type: "grab", title: "Family Guy S22E06", magnet: magnet(HASH_B),
    infoHash: HASH_B, source: "eztv", status: "sent", createdAt: "2024-01-01T00:02:00Z",
  });
  const result = deduplicateActivity([grab1, grab2], 50);
  assert("different episodes: both kept", result.length === 2, `got ${result.length}`);
}

// Case 4: entries with null magnet and null infoHash — never merged
{
  const a = item({
    id: "null-a", type: "grab", title: "Failed Search A", magnet: null,
    infoHash: null, status: "failed", createdAt: "2024-01-01T00:04:00Z",
  });
  const b = item({
    id: "null-b", type: "history", title: "Failed Search B", magnet: null,
    infoHash: null, status: "failed", createdAt: "2024-01-01T00:03:30Z",
  });
  const result = deduplicateActivity([a, b], 50);
  assert("null magnet/infoHash entries: both kept (never merged)", result.length === 2, `got ${result.length}`);
}

// Case 5: entries that legitimately must NOT merge — same hash, different status
{
  const sent = item({
    id: "sent-1", type: "grab", title: "Simpsons S35E10", magnet: magnet(HASH_C),
    infoHash: HASH_C, source: "eztv", status: "sent", createdAt: "2024-01-01T00:05:00Z",
  });
  const failed = item({
    id: "failed-1", type: "history", title: "Simpsons S35E10", magnet: magnet(HASH_C),
    infoHash: HASH_C, source: "eztv", status: "failed", createdAt: "2024-01-01T00:04:30Z",
  });
  const result = deduplicateActivity([sent, failed], 50);
  assert("same hash different status: both kept", result.length === 2, `got ${result.length}`);
}

// Case 6: uppercase hash in magnet, no stored infoHash — still merges with lowercase stored hash
{
  const grab = item({
    id: "case-grab", type: "grab", title: "Anime Show EP50",
    infoHash: HASH_A, magnet: null, source: "nyaa", status: "sent",
    createdAt: "2024-01-01T00:06:00Z",
  });
  const hist = item({
    id: "case-hist", type: "history", title: "Anime Show EP50",
    infoHash: null, magnet: `magnet:?xt=urn:btih:${HASH_A.toUpperCase()}&dn=test`,
    source: "nyaa", status: "sent", createdAt: "2024-01-01T00:05:30Z",
  });
  const result = deduplicateActivity([grab, hist], 50);
  assert("uppercase magnet hash matches lowercase stored infoHash: merged", result.length === 1, `got ${result.length}`);
}

// Case 7: grab+history from *different sources* for the same torrent
{
  const grab = item({
    id: "src-grab", type: "grab", title: "The Simpsons S35E10 720p",
    magnet: magnet(HASH_B, "&tr=udp://open.stealth.si:80"), infoHash: HASH_B,
    source: "1337x", status: "sent", createdAt: "2024-01-01T00:07:00Z",
  });
  const hist = item({
    id: "src-hist", type: "history", title: "The Simpsons S35E10 720p",
    magnet: magnet(HASH_B, "&tr=udp://tracker.opentrackr.org:1337"), infoHash: null,
    source: "eztv", status: "sent", createdAt: "2024-01-01T00:06:30Z",
  });
  const result = deduplicateActivity([grab, hist], 50);
  assert("same hash from different sources: merged to 1", result.length === 1, `got ${result.length}`);
  assert("same hash from different sources: grab preferred", result[0].source === "1337x");
}

// Case 8: limit is respected
{
  const many = Array.from({ length: 100 }, (_, i) =>
    item({
      id: `many-${i}`, type: "grab", title: `Item ${i}`,
      infoHash: `${String(i).padStart(40, "0")}`, status: "sent",
      createdAt: new Date(Date.now() - i * 1000).toISOString(),
    }),
  );
  const result = deduplicateActivity(many, 50);
  assert("limit caps output at 50", result.length === 50, `got ${result.length}`);
}

// Case 9: history-only entries (no grab) are kept
{
  const hist1 = item({
    id: "hist-only-1", type: "history", title: "Movie A",
    infoHash: HASH_A, status: "sent", createdAt: "2024-01-01T00:08:00Z",
  });
  const hist2 = item({
    id: "hist-only-2", type: "history", title: "Movie B",
    infoHash: HASH_B, status: "sent", createdAt: "2024-01-01T00:07:30Z",
  });
  const result = deduplicateActivity([hist1, hist2], 50);
  assert("different history-only entries: both kept", result.length === 2, `got ${result.length}`);
}

// Case 10: multiple history entries for the same hash — only first kept (no grab to preempt)
{
  const hist1 = item({
    id: "dup-hist-1", type: "history", title: "Same Movie",
    infoHash: HASH_A, status: "sent", createdAt: "2024-01-01T00:09:00Z",
  });
  const hist2 = item({
    id: "dup-hist-2", type: "history", title: "Same Movie",
    infoHash: HASH_A, status: "sent", createdAt: "2024-01-01T00:08:30Z",
  });
  // No grab registered HASH_A, so first history goes through, second is not blocked.
  // This is correct: without a grab, history items are passed through.
  const result = deduplicateActivity([hist1, hist2], 50);
  assert("duplicate history entries without grab: both kept (no grab to preempt)", result.length === 2, `got ${result.length}`);
}

// ---------------------------------------------------------------------------
// Base32 ↔ hex cross-encoding merging
// ---------------------------------------------------------------------------

// Known pair: hex "aabbccdd00112233445566778899aabbccddeeff" ↔ base32 "VK54ZXIAEERJGRCVMZ3YRGDKXPGN33XP"
const BASE32_OF_A = "VK54ZXIACERDGRCVMZ3YRGNKXPGN33X7";

// Case 11: grab has hex infoHash, history has base32 magnet — must merge
{
  const grab = item({
    id: "b32-grab", type: "grab", title: "Naruto Shippuden EP400",
    infoHash: HASH_A, magnet: magnet(HASH_A), source: "nyaa", status: "sent",
    createdAt: "2024-01-01T00:10:00Z",
  });
  const hist = item({
    id: "b32-hist", type: "history", title: "Naruto Shippuden EP400",
    infoHash: null, magnet: magnet(BASE32_OF_A, "&dn=Naruto"),
    source: "torrentscsv", status: "sent", createdAt: "2024-01-01T00:09:30Z",
  });
  const result = deduplicateActivity([grab, hist], 50);
  assert("base32 magnet + hex infoHash for same torrent: merged", result.length === 1, `got ${result.length}`);
}

// Case 12: both have base32-encoded infoHash stored directly — must merge
{
  const grab = item({
    id: "b32-both-grab", type: "grab", title: "Dragon Ball Super EP131",
    infoHash: BASE32_OF_A, magnet: null, source: "nyaa", status: "sent",
    createdAt: "2024-01-01T00:11:00Z",
  });
  const hist = item({
    id: "b32-both-hist", type: "history", title: "Dragon Ball Super EP131",
    infoHash: HASH_A, magnet: null, source: "eztv", status: "sent",
    createdAt: "2024-01-01T00:10:30Z",
  });
  const result = deduplicateActivity([grab, hist], 50);
  assert("base32 stored infoHash vs hex stored infoHash: merged", result.length === 1, `got ${result.length}`);
}

// Case 13: base32 and hex that are DIFFERENT torrents — must NOT merge
{
  // HASH_B base32 would be something else entirely; use a different base32
  const grab = item({
    id: "b32-diff-grab", type: "grab", title: "Show A",
    infoHash: HASH_A, source: "nyaa", status: "sent",
    createdAt: "2024-01-01T00:12:00Z",
  });
  const hist = item({
    id: "b32-diff-hist", type: "grab", title: "Show B",
    infoHash: HASH_B, source: "eztv", status: "sent",
    createdAt: "2024-01-01T00:11:30Z",
  });
  const result = deduplicateActivity([grab, hist], 50);
  assert("genuinely different hashes (hex vs hex): both kept", result.length === 2, `got ${result.length}`);
}

// ---------------------------------------------------------------------------
console.log(failures === 0 ? "\nPASS dedup" : `\nFAIL dedup (${failures})`);
process.exit(failures === 0 ? 0 : 1);
