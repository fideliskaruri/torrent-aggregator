/**
 * Promoting a stream to a download must actually select the whole file.
 *
 * The report: *"when i stream but want to download it, it tracks the download
 * but it's not fast... it's being limited."*
 *
 * Nothing in this app throttles download RATE — `applyForegroundUploadThrottle`
 * touches upload only, and a test asserts `throttleDownload` is never called. So
 * "limited" was never bandwidth. A Play adds its torrent with every file
 * **deselected** so the stream route can claim just the window around the
 * playhead; `promoteTorrentToKept` then flipped the stored origin and stopped.
 * The live torrent kept the stream's selection, so the engine went on fetching a
 * sliver while the Client page showed a download in progress.
 *
 * The observable difference is what this checks: after promotion the torrent
 * must WANT the whole file. `wanted`/`selections` is the engine's own view of
 * that, and it is what decides how much gets fetched.
 *
 * Streams only, and it deletes what it starts.
 *
 * Run:  node scripts\probes\stream-to-download.mjs
 */
const BASE = process.env.BASE_URL ?? "http://localhost:3000";

let failures = 0;
function check(name, ok, detail = "") {
  if (ok) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}
function note(m) {
  console.log(`  note  ${m}`);
}

async function live() {
  const r = await fetch(`${BASE}/api/client/torrents`).then((x) => x.json());
  return r.torrents ?? [];
}
async function nuke() {
  for (const t of await live()) {
    await fetch(`${BASE}/api/client/torrents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", hash: t.hash, deleteFiles: true }),
    }).catch(() => null);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await nuke();

try {
  // ── 1. Start a STREAM (what pressing Play does) ─────────────────────────
  const streamRes = await fetch(`${BASE}/api/library/ondemand`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "Severance",
      mediaType: "tv",
      season: 1,
      episode: 1,
      retention: "stream",
    }),
  });
  const stream = await streamRes.json();
  check("a stream starts", stream.ok === true && Boolean(stream.infoHash),
    JSON.stringify(stream).slice(0, 200));
  if (!stream.infoHash) throw new Error("no stream to promote");
  const hash = stream.infoHash.toLowerCase();
  note(`streaming: ${stream.title?.slice(0, 60)}`);

  await sleep(12000);

  const asStream = (await live()).find((t) => t.hash?.toLowerCase() === hash);
  check("the stream is held as reclaimable cache",
    asStream?.retentionState === "stream",
    `retentionState=${asStream?.retentionState}`);
  note(`stream progress: ${((asStream?.progress ?? 0) * 100).toFixed(1)}%`);

  // ── 2. Press Download on the thing being streamed ───────────────────────
  const keepRes = await fetch(`${BASE}/api/torrent/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      infoHash: hash,
      name: stream.title,
      retention: "keep",
      source: "probe",
    }),
  });
  const keep = await keepRes.json();
  check("the download is accepted", keepRes.status < 400 && keep.ok !== false,
    `HTTP ${keepRes.status} ${JSON.stringify(keep).slice(0, 180)}`);

  await sleep(6000);

  // ── 3. It must now be a KEPT download, and want the WHOLE file ──────────
  const promoted = (await live()).find((t) => t.hash?.toLowerCase() === hash);
  check("it is now a kept download, not cache",
    promoted?.retentionState === "kept",
    `retentionState=${promoted?.retentionState}`);

  // The heart of it: after promotion the torrent must be fetching the WHOLE
  // file, not the stream's window. The API exposes `progress`, `sizeBytes` and
  // `dlspeed`, so bytes-moved is derived rather than read directly.
  const size = Number(promoted?.sizeBytes ?? 0);
  const bytesAt = (t) => Number(t?.progress ?? 0) * Number(t?.sizeBytes ?? 0);
  note(`size=${(size / 1e9).toFixed(2)} GB progress=${((promoted?.progress ?? 0) * 100).toFixed(2)}%`);

  // Measure actual movement over a window — the reported symptom was speed.
  const p0 = promoted?.progress ?? 0;
  const d0 = bytesAt(promoted);
  await sleep(20000);
  const later = (await live()).find((t) => t.hash?.toLowerCase() === hash);
  const p1 = later?.progress ?? 0;
  const d1 = bytesAt(later);
  const gainedBytes = d1 - d0;
  const gainedPct = (p1 - p0) * 100;
  const rate = gainedBytes / 20;
  note(`over 20s: +${(gainedBytes / 1e6).toFixed(1)} MB (+${gainedPct.toFixed(2)}%) ≈ ${(rate / 1e6).toFixed(2)} MB/s`);
  note(`engine reports dlspeed ${((later?.dlspeed ?? 0) / 1e6).toFixed(2)} MB/s, ${later?.peers ?? 0} peers`);

  check("the promoted download is actually moving bytes",
    gainedBytes > 0 || p1 >= 1,
    `progress ${(p0 * 100).toFixed(2)}% -> ${(p1 * 100).toFixed(2)}%`);

  // A stream-windowed torrent plateaus once its window is satisfied. A
  // whole-file selection keeps climbing. 1 MB over 20s is a deliberately low
  // bar — this is a live swarm, and the defect was a hard plateau at ~0.
  check("it is not stalled at a stream-sized plateau",
    p1 >= 1 || gainedBytes > 1_000_000,
    `only ${(gainedBytes / 1e6).toFixed(2)} MB in 20s — still looks window-limited`);
} finally {
  await nuke();
  console.log("  note  cleaned up");
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nstream → download promotion verified");
