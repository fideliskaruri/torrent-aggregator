/**
 * Screenshot the browse board in the state a real user actually sees it:
 * with a populated library.
 *
 * Why this exists: `/` is server-rendered from the local session, and the QA
 * history of this page had only ever captured it *empty*, because nothing
 * seeded the local user. An empty board and a populated one are entirely
 * different screens, and the product's actual home page had never been looked
 * at. This seeds a library, photographs the board, and removes what it seeded.
 *
 * Auth note: TorrentFlow has no sign-in — `src/lib/auth.ts` returns a fixed
 * single-user session (`LOCAL_USER_ID`). So there is no cookie to mint; the
 * rows simply have to belong to that user.
 *
 * Run: node scripts/shoot-browse.mjs   (BASE_URL overrides the host)
 */
import { chromium } from "playwright";
import { PrismaClient } from "@prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import path from "node:path";
import fs from "node:fs";
import "dotenv/config";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3210";
const OUT = path.resolve(process.env.SHOT_DIR ?? "qa-screens/browse");
fs.mkdirSync(OUT, { recursive: true });

const failures = [];
function record(name, ok, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
}

function createPrisma() {
  const raw = process.env.DATABASE_URL || "file:./dev.db";
  let url = raw;
  if (raw.startsWith("file:")) {
    const fp = raw.slice(5);
    if (!path.isAbsolute(fp)) {
      url = `file:${path.resolve(process.cwd(), fp.replace(/^\.\//, "")).replace(/\\/g, "/")}`;
    }
  }
  return new PrismaClient({ adapter: new PrismaLibSql({ url }) });
}

const userId = "local";
const metadataKeys = [];

/** A library with something in every rail, so no rail is silently untested. */
const LIBRARY = [
  { hash: "1", name: "Dune.Part.Two.2024.2160p.UHD.BluRay.x265-SWTYBLZ", status: "seeding", progress: 1 },
  { hash: "2", name: "Blade.Runner.2049.2017.1080p.BluRay.x264-GECKOS", status: "seeding", progress: 1 },
  { hash: "3", name: "Arrival.2016.1080p.BluRay.x264-DRONES", status: "seeding", progress: 1 },
  { hash: "4", name: "Sicario.2015.1080p.BluRay.x264-RARBG", status: "seeding", progress: 1 },
  { hash: "5", name: "Breaking.Bad.S05E14.Ozymandias.1080p.BluRay.x264", status: "downloading", progress: 0.62 },
  { hash: "6", name: "Severance.S02E05.1080p.ATVP.WEB-DL.DDP5.1.Atmos", status: "downloading", progress: 0.31 },
  { hash: "7", name: "The.Bear.S03E01.1080p.HULU.WEB-DL.DDP5.1", status: "seeding", progress: 1 },
  { hash: "8", name: "Chernobyl.S01E03.1080p.AMZN.WEB-DL.DDP5.1", status: "seeding", progress: 1 },
];

/** Half-watched things, which is what Continue Watching is for. */
const WATCHING = [
  { hash: "5", file: "breaking.bad.s05e14.mkv", pos: 1420, dur: 2880, title: "Breaking Bad", season: 5, episode: 14 },
  { hash: "6", file: "severance.s02e05.mkv", pos: 640, dur: 2520, title: "Severance", season: 2, episode: 5 },
  { hash: "7", file: "the.bear.s03e01.mkv", pos: 180, dur: 1860, title: "The Bear", season: 3, episode: 1 },
];

const pad = (n) => n.repeat(40).slice(0, 40);

const SEEDED_HASHES = LIBRARY.map((t) => pad(t.hash));

async function seed(prisma) {
  // The local user is created by `src/lib/auth.ts` on first request; do not
  // create or delete it here. Only the rows this script adds are ever removed —
  // this runs against the developer's real dev database.
  await prisma.user.upsert({
    where: { id: userId },
    update: {},
    create: { id: userId, name: "You", email: null },
  });
  await prisma.engineTorrent.createMany({
    data: LIBRARY.map((t) => ({
      userId,
      hash: pad(t.hash),
      name: t.name,
      status: t.status,
      progress: t.progress,
    })),
  });
  await prisma.playbackProgress.createMany({
    data: WATCHING.map((w) => ({
      userId,
      infoHash: pad(w.hash),
      filePath: w.file,
      positionSec: w.pos,
      durationSec: w.dur,
      title: w.title,
      season: w.season,
      episode: w.episode,
    })),
  });
}

async function cleanup(prisma) {
  // Scoped to the exact hashes seeded above — never a blanket delete by userId,
  // because `local` is the real user and may own rows this script did not add.
  await prisma.playbackProgress
    .deleteMany({ where: { userId, infoHash: { in: SEEDED_HASHES } } })
    .catch(() => {});
  await prisma.engineTorrent
    .deleteMany({ where: { userId, hash: { in: SEEDED_HASHES } } })
    .catch(() => {});
  for (const cacheKey of metadataKeys) {
    await prisma.cachedMetadata.delete({ where: { cacheKey } }).catch(() => {});
  }
}

async function main() {
  const prisma = createPrisma();
  const browser = await chromium.launch({ channel: "msedge" });
  try {
    console.log("── Seeding a populated library ──");
    await seed(prisma);

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    console.log("\n── Browse board, populated ──");
    await page.goto(BASE, { waitUntil: "networkidle", timeout: 90_000 });
    await page.waitForTimeout(1_500);

    const rails = await page.$$eval("[data-rail]", (els) =>
      els.map((el) => ({
        id: el.getAttribute("data-rail"),
        tiles: el.querySelectorAll("[data-rail-card]").length,
      })),
    );
    const headings = await page.$$eval("h2", (els) =>
      els.map((el) => el.textContent?.trim()).filter(Boolean),
    );
    console.log(`  rails: ${JSON.stringify(rails)}`);
    console.log(`  headings: ${JSON.stringify(headings)}`);

    record("the board renders at least two rails", rails.length >= 2, `${rails.length} rails`);
    record("every rendered rail has tiles in it", rails.every((r) => r.tiles > 0), JSON.stringify(rails.map((r) => r.tiles)));

    // A populated board must never also be telling the user it is empty. Assert
    // on the empty state's own marker rather than on prose, which drifts.
    const board = await page.locator("[data-browse-board]").count();
    const empty = await page.locator("[data-browse-empty]").count();
    record("the real browse board rendered", board > 0, `data-browse-board: ${board}`);
    record("a populated board does not also render the empty state", empty === 0, `data-browse-empty: ${empty}`);

    // Every card prints its title in a caption under the poster. When the
    // poster is missing — which is the common case, not the error case — the
    // fallback tile used to set the title *again* inside the artwork box, so
    // the name appeared twice, eight pixels apart. It read as a rendering bug.
    const dupes = await page.$$eval("[data-rail] li", (lis) =>
      lis
        .map((li) => {
          const caption = li.querySelector("div.mt-2 p")?.textContent?.trim() ?? "";
          const card = li.querySelector("[data-rail-card]");
          const inCard = card?.textContent?.trim() ?? "";
          return caption && inCard.includes(caption) ? caption : null;
        })
        .filter(Boolean),
    );
    record(
      "a card never prints its title twice",
      dupes.length === 0,
      dupes.length ? `duplicated: ${JSON.stringify(dupes)}` : "",
    );

    // A screen reader concatenates adjacent text nodes and cannot see a CSS
    // margin, so a count spaced only by `ml-*` is announced glued to its label.
    const glued = await page.$$eval("h2", (els) =>
      els.map((el) => el.textContent?.trim() ?? "").filter((t) => /[a-z]\d/.test(t)),
    );
    record(
      "no heading glues a count onto its label",
      glued.length === 0,
      glued.length ? JSON.stringify(glued) : "",
    );

    await page.screenshot({ path: path.join(OUT, "browse-1440.png"), fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(800);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth);
    record("at 390px the board does not overflow", overflow <= 391, `scrollWidth ${overflow}`);
    await page.screenshot({ path: path.join(OUT, "browse-390.png"), fullPage: true });

    await context.close();
  } finally {
    await cleanup(prisma);
    await prisma.$disconnect().catch(() => {});
    await browser.close();
  }

  console.log(`\nScreenshots: ${OUT}`);
  if (failures.length) {
    console.log(`\nshoot-browse: ${failures.length} FAILED`);
    process.exit(1);
  }
  console.log("\nbrowse board clean");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
