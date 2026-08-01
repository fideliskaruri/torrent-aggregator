import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright";

const base = process.env.BASE ?? "http://127.0.0.1:3112";
const distDir = process.env.NEXT_DIST_DIR ?? ".next-anime-film";
const outDir = path.join("qa-shots", "title-first-search");
fs.mkdirSync(outDir, { recursive: true });

type SearchHit = {
  title: string;
  provider: string;
  providerId: string | null;
  aliases: string[];
  mediaType: string;
  titleMediaType: string;
  isSeries: boolean;
  format: string | null;
  href: string;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function search(query: string): Promise<SearchHit[]> {
  const url = new URL("/api/search/titles", base);
  url.searchParams.set("q", query);
  url.searchParams.set("category", "anime");
  url.searchParams.set("limit", "12");
  const response = await fetch(url);
  assert(response.ok, `title search failed: HTTP ${response.status}`);
  const payload = (await response.json()) as { results?: SearchHit[] };
  return payload.results ?? [];
}

function assertIdentity(hit: SearchHit, expectedSeries: boolean) {
  const url = new URL(hit.href, base);
  assert(hit.provider === "anilist", `${hit.title}: provider identity was lost`);
  assert(Boolean(hit.providerId), `${hit.title}: provider id was lost`);
  assert(hit.mediaType === "anime", `${hit.title}: anime identity was lost`);
  assert(hit.isSeries === expectedSeries, `${hit.title}: wrong series shape`);
  assert(
    hit.titleMediaType === (expectedSeries ? "anime" : "movie"),
    `${hit.title}: wrong title-route media type`,
  );
  assert(
    url.searchParams.get("type") === hit.titleMediaType,
    `${hit.title}: href does not carry title shape`,
  );
  assert(url.searchParams.get("provider") === "anilist", `${hit.title}: href lost provider`);
  assert(
    url.searchParams.get("providerId") === hit.providerId,
    `${hit.title}: href lost provider id`,
  );
  assert(url.searchParams.get("sourceType") === "anime", `${hit.title}: href lost anime type`);
  assert(url.searchParams.get("format") === hit.format, `${hit.title}: href lost format`);
  assert(
    url.searchParams.get("series") === (expectedSeries ? "1" : "0"),
    `${hit.title}: href lost series shape`,
  );
  assert(
    JSON.stringify(url.searchParams.getAll("alias")) === JSON.stringify(hit.aliases),
    `${hit.title}: href lost provider aliases`,
  );
}

async function inspectDetail(page: Page, hit: SearchHit, expectedSeries: boolean) {
  const apiResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/api/title/") &&
      !response.url().includes("/extras") &&
      response.request().method() === "GET",
    { timeout: 30_000 },
  );
  await page.goto(new URL(hit.href, base).toString(), { waitUntil: "domcontentloaded" });
  const response = await apiResponse;
  assert(response.ok(), `${hit.title}: detail API returned HTTP ${response.status()}`);
  const payload = (await response.json()) as { isSeries?: boolean; mediaType?: string };
  assert(
    payload.isSeries === expectedSeries,
    `${hit.title}: detail API resolved isSeries=${String(payload.isSeries)}`,
  );
  await page.locator("[data-title-detail]").waitFor({ state: "visible", timeout: 30_000 });
  const episodeSections = await page.locator("[data-title-episodes]").count();
  assert(
    episodeSections === (expectedSeries ? 1 : 0),
    `${hit.title}: wrong episodic UI count ${episodeSections}`,
  );
  const primary = page.locator("[data-title-primary]");
  await primary.waitFor({ state: "visible" });
  const primaryText = (await primary.textContent())?.replace(/\s+/g, " ").trim() ?? "";
  assert(primaryText.length > 0, `${hit.title}: missing primary title action`);
  if (!expectedSeries) {
    assert(!/S\d{2}E\d{2}/.test(primaryText), `${hit.title}: film action names an episode`);
  }
  return {
    href: hit.href,
    apiMediaType: payload.mediaType,
    apiIsSeries: payload.isSeries,
    episodeSections,
    primaryText,
  };
}

const movieResults = await search("Your Name");
const movie = movieResults.find((hit) => hit.format === "MOVIE");
assert(movie, "live AniList search returned no MOVIE sample");
assertIdentity(movie, false);

const seriesResults = await search("Slime");
const series =
  seriesResults.find(
    (hit) =>
      hit.format === "TV" &&
      hit.title === "That Time I Got Reincarnated as a Slime",
  ) ?? seriesResults.find((hit) => hit.format === "TV");
assert(series, "live AniList search returned no TV sample");
assertIdentity(series, true);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
try {
  const movieDetail = await inspectDetail(page, movie, false);
  await page.screenshot({
    path: path.join(outDir, "anime-movie-non-episodic.png"),
    fullPage: true,
  });
  const seriesDetail = await inspectDetail(page, series, true);
  await page.screenshot({
    path: path.join(outDir, "anime-series-episodic.png"),
    fullPage: true,
  });
  const evidence = {
    buildId: fs.readFileSync(path.join(distDir, "BUILD_ID"), "utf8").trim(),
    movie: {
      title: movie.title,
      format: movie.format,
      providerId: movie.providerId,
      aliases: movie.aliases,
      ...movieDetail,
    },
    series: {
      title: series.title,
      format: series.format,
      providerId: series.providerId,
      aliases: series.aliases,
      ...seriesDetail,
    },
  };
  fs.writeFileSync(
    path.join(outDir, "anime-film-identity.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  console.log("[live:anilist-title-identity] PASS");
  console.log(
    `  movie ${movie.title}: type=movie, isSeries=false, episodeSections=0`,
  );
  console.log(
    `  series ${series.title}: type=anime, isSeries=true, episodeSections=1`,
  );
  console.log(`  build ${evidence.buildId}`);
} finally {
  await page.close();
  await browser.close();
}
