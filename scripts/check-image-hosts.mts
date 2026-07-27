/**
 * Proves that every artwork host the app can produce actually survives
 * `next/image`, by asking the running server to optimise a real URL from each.
 *
 * Why HTTP instead of importing Next's matcher: the pairing that matters is
 * `OPTIMIZED_IMAGE_HOSTS` (src/components/browse/poster.ts) against
 * `images.remotePatterns` (next.config.ts), and the failure is asymmetric —
 *   - in the Set but not in remotePatterns → next/image returns 400 and the
 *     card renders blank. Hard failure.
 *   - in remotePatterns but not in the Set → falls back to a plain <img>.
 *     Unoptimised but visible. Safe.
 * Only the first direction breaks the page. Reimplementing the matcher would
 * agree with the config right up to the point where it mattered, and importing
 * Next's own matcher alongside `next.config.ts` makes the process exit
 * silently, so the optimiser itself is used as the oracle.
 *
 * This also covers something a pure config check cannot: whether the CDN is
 * reachable from this machine at all. A 500 here means the allowlist is right
 * and the network is not.
 *
 * Usage: BASE_URL=http://127.0.0.1:3210 npx tsx scripts/check-image-hosts.mts
 */
import {
  OPTIMIZED_IMAGE_HOSTS,
  OPTIMIZED_HOST_SUFFIXES,
  isOptimizableImageUrl,
} from "../src/components/browse/poster";

const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";

/**
 * One real URL per host the app can emit. Real paths, not "/", because
 * remotePatterns may constrain the pathname and a bare root would pass a check
 * that a real poster would fail.
 */
const SAMPLES: Array<{ host: string; url: string }> = [
  {
    host: "image.tmdb.org",
    url: "https://image.tmdb.org/t/p/w500/x2FJsf1ElAgr63Y3PNPtJrcmpoe.jpg",
  },
  {
    host: "s4.anilist.co",
    url: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx154587-qQTzQnEJJ3oB.jpg",
  },
  {
    host: "static.tvmaze.com",
    url: "https://static.tvmaze.com/uploads/images/medium_portrait/527/1317633.jpg",
  },
  {
    host: "is1-ssl.mzstatic.com",
    url: "https://is1-ssl.mzstatic.com/image/thumb/Video3/v4/bb/68/b2/bb68b259-f1de-51e5-a33a-55775cd5334c/2000037211088.jpg/600x900bb.jpg",
  },
];

let failures = 0;
const pass = (m: string) => console.log(`  ok   ${m}`);
const fail = (m: string) => {
  console.log(`  FAIL ${m}`);
  failures += 1;
};

async function optimise(url: string) {
  const target = `${BASE}/_next/image?url=${encodeURIComponent(url)}&w=384&q=75`;
  const res = await fetch(target, { signal: AbortSignal.timeout(30_000) });
  return { status: res.status, type: res.headers.get("content-type") || "" };
}

console.log(`=== next/image host coverage (${BASE}) ===`);

try {
  await fetch(BASE, { signal: AbortSignal.timeout(5_000) });
} catch {
  console.log(
    `\nFAIL no server at ${BASE}. Start one and set BASE_URL — a connection\n` +
      "     refused here is not an image problem.",
  );
  process.exit(1);
}

for (const { host, url } of SAMPLES) {
  if (!isOptimizableImageUrl(url)) {
    pass(`${host} not routed through next/image (plain <img>) — nothing to prove`);
    continue;
  }

  let result: { status: number; type: string };
  try {
    result = await optimise(url);
  } catch (e) {
    fail(`${host}: request failed — ${e instanceof Error ? e.message : String(e)}`);
    continue;
  }

  if (result.status === 400) {
    fail(
      `${host} is in OPTIMIZED_IMAGE_HOSTS but next/image returned 400 — ` +
        "add it to images.remotePatterns in next.config.ts or cards go blank",
    );
  } else if (result.status !== 200) {
    fail(
      `${host} allowed but upstream fetch failed (HTTP ${result.status}) — ` +
        "the allowlist is right, the CDN is not reachable from here",
    );
  } else if (!result.type.startsWith("image/")) {
    fail(`${host} returned 200 but content-type is "${result.type}", not an image`);
  } else {
    pass(`${host} optimised → ${result.type}`);
  }
}

// Every declared host/suffix needs a sample, or this check quietly stops
// covering the thing it exists to cover.
const covered = new Set(SAMPLES.map((s) => s.host));
for (const host of OPTIMIZED_IMAGE_HOSTS) {
  if (!covered.has(host)) {
    fail(`OPTIMIZED_IMAGE_HOSTS has "${host}" with no sample URL in this script`);
  }
}
for (const suffix of OPTIMIZED_HOST_SUFFIXES) {
  if (![...covered].some((h) => h.endsWith(suffix))) {
    fail(`OPTIMIZED_HOST_SUFFIXES has "${suffix}" with no sample URL in this script`);
  }
}

// A host nobody allowlisted must still be refused, otherwise the allowlist is
// decorative and none of the above proves anything.
try {
  const stranger = await optimise("https://evil.example.com/poster.jpg");
  if (stranger.status === 400) {
    pass("unlisted host refused by next/image");
  } else {
    fail(`unlisted host returned HTTP ${stranger.status} — allowlist is too broad`);
  }
} catch {
  pass("unlisted host refused by next/image (request rejected)");
}

console.log(
  failures === 0
    ? "\nPASS every artwork host survives next/image"
    : `\nFAIL ${failures} image-host problem(s)`,
);
process.exit(failures === 0 ? 0 : 1);
