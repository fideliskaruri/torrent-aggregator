/**
 * Does the home page look like a catalog, or like a torrent list?
 *
 * ## Why this exists
 *
 * The owner's verdict on this app was: *"this is not a product, it's a website
 * you go to view torrent lists and that it."* Every other gate in this repo
 * checks that the code is correct. None of them checked the one thing that
 * complaint is actually about — what the cards on the front page **say** and
 * whether they have a picture.
 *
 * That gap is not theoretical. Two separate, invisible failures shipped through
 * a fully green suite:
 *
 *  1. A deliberate-sabotage edit left in `catalog/works.ts` disabled release-name
 *     normalisation, so all 72 catalog rows were stored under their raw scene
 *     name — `House.of.the.Dragon.S03E06.1080p.AMZN.WEB-DL.DDP5.1.Atmos.H.264-FLUX`.
 *     The rails rendered. The API returned 200. The types were fine.
 *  2. Because a filename is not a title, artwork lookup could not match any of
 *     them, and poster coverage silently went to **0/72** — a front page of
 *     grey letter-tiles.
 *
 * Both are exactly the "torrent list" the owner rejected, and both are trivially
 * detectable from the payload the page renders. So they are detected here.
 *
 * ## What this asserts
 *
 * Against the live `/api/browse`, for the **discovery** rails only:
 *
 *  - no card caption is shaped like a scene release name;
 *  - poster coverage clears a floor, because a rail of letter-tiles is the
 *    failure mode that started all of this;
 *  - no rail is titled with placeholder/self-describing copy.
 *
 * Personal rails (Continue Watching, My Library, ...) are held to the title
 * rule but not the poster floor: they are seeded from whatever the user
 * actually has, and a home-ripped file legitimately may have no poster.
 *
 * Run: `npx tsx scripts/check-catalog-quality.mts` (BASE_URL to override).
 */
const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";

/**
 * Fraction of a discovery rail's cards that must carry a poster.
 *
 * Not 100%: the catalog is a popularity feed and legitimately surfaces the
 * occasional obscure or not-yet-released title that no artwork provider has.
 * Observed healthy coverage once normalisation was restored sat well above
 * this, and the failure this guards against is 0.0 — a floor, not a target.
 */
const MIN_POSTER_RATIO = 0.6;

/** Discovery rails are the catalog; personal rails are the user's own stuff. */
const DISCOVERY_RAIL_IDS = new Set([
  "trending-now",
  "popular-series",
  "because-you-are-watching",
]);

/**
 * Personal rails reflect whatever the user actually has. A home-ripped file
 * legitimately has no poster. These rails are held to the title/dedupe rules
 * but NOT the poster-coverage floor.
 */
const PERSONAL_RAIL_IDS = new Set([
  "continue-watching",
  "my-library",
]);

/**
 * Markers of a scene release name.
 *
 * Each one is a token that appears in filenames and effectively never in a
 * real title a human would recognise. Kept narrow and evidence-based rather
 * than clever: every pattern below was observed in a real stored `title`.
 */
const RELEASE_NAME_MARKERS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: "resolution tag", re: /\b(?:2160|1080|720|480)[pi]\b/i },
  { label: "codec tag", re: /\b(?:x26[45]|h\.?26[45]|hevc|xvid|divx|av1)\b/i },
  {
    label: "source tag",
    re: /\b(?:web-?dl|webrip|bluray|blu-ray|brrip|bdrip|hdrip|dvdrip|telesync|hdts|camrip|dcprip|remux|amzn|hmax|nf)\b/i,
  },
  {
    label: "audio tag",
    re: /\b(?:ddp?5[\s.]?1|dts(?:-hd)?|atmos|aac2[\s.]?0|truehd|eac3|ac3)\b/i,
  },
  { label: "episode marker", re: /\bS\d{2}E\d{2}\b/i },
  { label: "bit-depth tag", re: /\b10-?bit\b/i },
  // "Word.Word.Word" — dots used as spaces. Requires three segments so that
  // "Marvel's S.H.I.E.L.D." and "Mr. Robot" are not accused.
  { label: "dot-separated filename", re: /\w+\.\w+\.\w+/ },
  // A trailing "-GROUP" scene tag, e.g. "...x265-MeGusta".
  { label: "release group suffix", re: /-(?:[A-Z][A-Za-z0-9]{2,})$/ },
];

/**
 * Rail headings that are placeholder copy rather than a name.
 *
 * "What this page becomes" shipped as a live rail title — it was leftover
 * first-run prose that the owner had already rejected once as slop, pasted
 * into the heading slot. A rail heading names content; it never explains the
 * page to the person already looking at it.
 */
const SLOP_TITLE_MARKERS: ReadonlyArray<RegExp> = [
  /what this page becomes/i,
  /not showing yet/i,
  /nothing here yet/i,
  /coming soon/i,
  /placeholder/i,
  /^tbd\b/i,
  /fill(?:s)? (?:itself|themselves) in/i,
];

interface RailItem {
  title?: string | null;
  subtitle?: string | null;
  posterUrl?: string | null;
}
interface Rail {
  id?: string | null;
  title?: string | null;
  items?: RailItem[] | null;
}

const failures: string[] = [];
const notes: string[] = [];

function fail(msg: string) {
  failures.push(msg);
}

/** Every release marker a caption trips, for a diagnosable failure message. */
function releaseMarkersIn(title: string): string[] {
  return RELEASE_NAME_MARKERS.filter(({ re }) => re.test(title)).map(
    ({ label }) => label,
  );
}

async function main() {
  let payload: { rails?: Rail[] };
  try {
    const res = await fetch(`${BASE}/api/browse`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      fail(`GET /api/browse returned HTTP ${res.status}`);
      return;
    }
    payload = (await res.json()) as { rails?: Rail[] };
  } catch (err) {
    fail(`GET /api/browse failed: ${err instanceof Error ? err.message : err}`);
    return;
  }

  const rails = payload.rails ?? [];
  if (rails.length === 0) {
    fail("no rails at all — the home page would be blank");
    return;
  }

  let sawDiscoveryRail = false;

  for (const rail of rails) {
    const railName = rail.title ?? rail.id ?? "(unnamed)";
    const items = rail.items ?? [];

    for (const re of SLOP_TITLE_MARKERS) {
      if (rail.title && re.test(rail.title)) {
        fail(`rail "${railName}" is titled with placeholder copy`);
        break;
      }
    }

    // A rail that renders with no cards is a heading over a void.
    if (items.length === 0) {
      fail(`rail "${railName}" is present but empty`);
      continue;
    }

    for (const item of items) {
      const title = (item.title ?? "").trim();
      if (!title) {
        fail(`rail "${railName}" has a card with no caption`);
        continue;
      }
      const markers = releaseMarkersIn(title);
      if (markers.length > 0) {
        fail(
          `rail "${railName}" card caption is a scene release name ` +
            `[${markers.join(", ")}]: "${title}"`,
        );
      }
    }

    // The same work must not occupy two slots in one rail. "Recently Added"
    // shipped showing `Rick and Morty` three times, because it listed one row
    // per grabbed episode rather than collapsing to works. Rail slots are the
    // scarcest thing on the page.
    //
    // Keyed on caption *and* subtitle: two different episodes of one series in
    // Continue Watching are a legitimate pair — both read "Severance", and the
    // subtitle ("S02E05" / "S02E06") is what tells them apart. Keying on the
    // caption alone flagged those and would have pushed someone to "fix" a rail
    // that was behaving correctly.
    const captionCounts = new Map<string, number>();
    for (const item of items) {
      const caption = (item.title ?? "").trim().toLowerCase();
      if (!caption) continue;
      const key = `${caption}||${(item.subtitle ?? "").trim().toLowerCase()}`;
      captionCounts.set(key, (captionCounts.get(key) ?? 0) + 1);
    }
    for (const [key, count] of captionCounts) {
      if (count > 1) {
        const [caption] = key.split("||");
        fail(
          `rail "${railName}" shows the same work ${count} times: "${caption}"`,
        );
      }
    }

    const isPersonal = PERSONAL_RAIL_IDS.has(rail.id ?? "");

    // A rail where *nothing* has art, on a page where other rails are fully
    // illustrated, is a row of grey placeholders. This caught the user's own
    // library rendering worse than the recommendations below it: Ready to Play
    // and Recently Added were at 0 posters while Trending sat at 100%, because
    // those two rails looked artwork up in a local cache with a known-high miss
    // rate instead of the provider path.
    // Personal rails (continue-watching, my-library) are exempt: the user's
    // own files may legitimately have no artwork if they were home-ripped.
    const anyPoster = items.some((i) => Boolean(i.posterUrl));
    if (!anyPoster && items.length >= 3 && !isPersonal) {
      fail(
        `rail "${railName}" has no artwork at all on ${items.length} cards`,
      );
    }

    const isDiscovery = DISCOVERY_RAIL_IDS.has(rail.id ?? "");
    if (isDiscovery) sawDiscoveryRail = true;

    const withPoster = items.filter((i) => Boolean(i.posterUrl)).length;
    const ratio = withPoster / items.length;
    const pct = (ratio * 100).toFixed(0);

    // Coverage is checked on every non-personal rail. This check used to
    // `continue` on non-discovery rails, and Recently Added sat at 5/10 (50%)
    // un-flagged while the gate happily reported 100% for the three rails below
    // it. The rail showing the user their OWN downloads was the worst-looking
    // one on the page and the gate said PASS.
    // Personal rails (Continue Watching, My Library) are exempt: they reflect
    // whatever the user actually has, and sparse artwork is not a product bug.
    // Rails of 1-2 cards are exempt: a single missing poster is 0% or 50% and
    // says nothing about a systemic artwork failure.
    if (items.length >= 3 && ratio < MIN_POSTER_RATIO && !isPersonal) {
      fail(
        `rail "${railName}" poster coverage ${withPoster}/${items.length} ` +
          `(${pct}%) is below the ${(MIN_POSTER_RATIO * 100).toFixed(0)}% floor`,
      );
    } else {
      notes.push(`  ${railName}: ${withPoster}/${items.length} posters (${pct}%)`);
    }
  }

  // Guards the guard: if the catalog is empty, every loop above is a no-op and
  // this script would "pass" without having checked anything at all.
  if (!sawDiscoveryRail) {
    fail(
      "no discovery rail was present, so nothing was actually checked — " +
        "the catalog is empty or the rails were renamed",
    );
  }
}

await main();

if (notes.length > 0) console.log(notes.join("\n"));

if (failures.length > 0) {
  console.error(`FAIL catalog-quality: ${failures.length} problem(s)`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log("PASS catalog-quality: captions are titles, discovery rails have art");
