/**
 * `test:watchlist` — renders /watchlist with rows actually in it.
 *
 * This gate exists because of a blind spot that hid two real defects on the
 * home page: every other QA script renders against an empty database, so the
 * *populated* version of a page could regress for weeks without one red test.
 * /watchlist was the last high-traffic page still in that position — its
 * happy path had never been looked at by anything.
 *
 * It also guards the specific risk in the `useApiQuery` refactor: the rows are
 * server-owned but locally editable, so they are synced into component state
 * during render. That sync is easy to get subtly wrong in a way no failure
 * test would catch — the page would load, show nothing, and look "empty".
 * Hence the filter assertions: they prove the sync produced live state the
 * page can still operate on, not a frozen snapshot.
 *
 * Cleanup is scoped to the exact rows this seeded. `local` is the app's real
 * single user, so a blanket deleteMany here would wipe the user's library.
 */
import { chromium } from "playwright";
import { PrismaClient } from "@prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import path from "node:path";
import "dotenv/config";

const BASE = process.env.BASE_URL || "http://127.0.0.1:3210";
const USER = "local";
/** Prefix that makes every seeded row unambiguously ours to delete. */
const MARK = "qagate";

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

const SEED = [
  {
    mediaType: "tv",
    externalId: `${MARK}-1`,
    title: "Severance",
    status: "watching",
    monitored: true,
  },
  {
    mediaType: "movie",
    externalId: `${MARK}-2`,
    title: "Dune Part Two",
    status: "planned",
    monitored: false,
  },
  {
    mediaType: "anime",
    externalId: `${MARK}-3`,
    title: "Frieren",
    status: "watching",
    monitored: true,
  },
];

const prisma = createPrisma();
let failures = 0;

function check(ok, label) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
}

async function cleanup() {
  await prisma.watchListItem.deleteMany({
    where: { userId: USER, externalId: { in: SEED.map((s) => s.externalId) } },
  });
}

const browser = await chromium.launch({ channel: "msedge" });
try {
  await cleanup();
  await prisma.user.upsert({
    where: { id: USER },
    update: {},
    create: { id: USER, email: "local@localhost", name: "Local" },
  });
  for (const s of SEED) {
    await prisma.watchListItem.create({ data: { ...s, userId: USER } });
  }

  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(`${BASE}/watchlist`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);

  const body = await page.locator("body").innerText();

  check(body.includes("Severance"), "a seeded row is rendered");
  check(
    body.includes("Dune Part Two") && body.includes("Frieren"),
    "every seeded row renders",
  );
  check(!/No items yet/i.test(body), "empty state is not shown while rows exist");
  check(
    !/Could not load your library/i.test(body),
    "no error state on a good load",
  );

  await page.screenshot({
    path: "qa-screens/watchlist-populated.png",
    fullPage: true,
  });

  const planned = page.getByRole("button", { name: /^Planned/i }).first();
  if (await planned.count()) {
    await planned.click();
    await page.waitForTimeout(600);
    const filtered = await page.locator("body").innerText();
    check(filtered.includes("Dune Part Two"), "filtering keeps the matching row");
    check(!filtered.includes("Severance"), "filtering drops the non-matching row");
  } else {
    check(false, "the status filter is reachable");
  }
} finally {
  await browser.close();
  await cleanup();
  const left = await prisma.watchListItem.count({
    where: { externalId: { startsWith: MARK } },
  });
  if (left) {
    console.log(`  FAIL  cleanup left ${left} seeded rows behind`);
    failures++;
  }
  await prisma.$disconnect();
}

console.log(
  failures
    ? `\n${failures} check(s) FAILED`
    : "\nALL GREEN — the library renders its data",
);
process.exit(failures ? 1 : 0);
