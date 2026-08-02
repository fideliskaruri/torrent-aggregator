/**
 * Media-type filter rules for the Downloads page.
 *
 * Run: npx tsx src/app/downloads/media-filter.test.ts
 *
 * The cases worth writing down are all about evidence: a torrent row is a raw
 * release name plus, sometimes, a category, and the ways this can go wrong are
 * (a) guessing a type it does not have, so a row is filed where nobody looks
 * for it, and (b) deciding "Series" differently from the Library, so the same
 * show sits under different tabs on two pages.
 */
import assert from "node:assert/strict";
import {
  LIBRARY_TABS,
  LIBRARY_TAB_LABELS,
  filterByTab,
} from "@/app/watchlist/library-tabs";
import {
  DEFAULT_DOWNLOAD_TAB,
  DOWNLOAD_TABS,
  DOWNLOAD_TAB_LABELS,
  downloadInTab,
  downloadMediaType,
  filterDownloadsByTab,
  isSeriesDownload,
  tabForDownload,
  type DownloadTab,
} from "./media-filter";

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures++;
    console.error(`FAIL  ${name}`);
    console.error(`      ${(error as Error).message}`);
  }
}

const NARROW = ["movies", "series", "anime"] as const;

check("the tab bar is literally the Library's, not a copy of it", () => {
  // Same object, not merely the same contents. A copy is how the two surfaces
  // start to drift: someone adds Documentaries to one list and the other keeps
  // classifying rows with a vocabulary that no longer matches.
  assert.equal(DOWNLOAD_TABS, LIBRARY_TABS);
  assert.equal(DOWNLOAD_TAB_LABELS, LIBRARY_TAB_LABELS);
  assert.deepEqual([...DOWNLOAD_TABS], ["all", "movies", "series", "anime"]);
  assert.equal(DEFAULT_DOWNLOAD_TAB, "all");
});

check("a stored category places the row, whatever its name looks like", () => {
  const cases: { name: string; category: string; tab: DownloadTab }[] = [
    {
      name: "Star Wars The Rise Of Skywalker (2019) (1080p BluRay x265 HEVC 10bit AAC 7.1 Vyndros)",
      category: "Movies",
      tab: "movies",
    },
    {
      name: "www.UIndex.org    -    Rick and Morty S09E01 1080p AMZN WEB-DL DDP5 1 H 264-Kitsune",
      category: "TV",
      tab: "series",
    },
    // The case no rule reading the name alone can get right: this is
    // structurally identical to a television episode, and only the category
    // recorded when it was sent knows it is anime.
    {
      name: "[SubsPlease] Sousou no Frieren - 28 (1080p) [F1D2A9C0].mkv",
      category: "Anime",
      tab: "anime",
    },
    { name: "Dune.2021.2160p.WEB-DL.x265", category: "movie", tab: "movies" },
  ];
  for (const c of cases) {
    assert.equal(tabForDownload(c), c.tab, c.name);
  }
});

check("anime is its own tab, not a corner of Series", () => {
  const anime = {
    name: "[Erai-raws] Frieren - 12 [1080p].mkv",
    category: "Anime",
  };
  assert.equal(downloadMediaType(anime), "anime");
  assert.equal(downloadInTab(anime, "anime"), true);
  assert.equal(downloadInTab(anime, "series"), false);
  assert.equal(downloadInTab(anime, "movies"), false);
});

check("what the row says it is beats what its name looks like", () => {
  // A category is a decision this app already made from a categorised search.
  // `Star Wars Episode 1` reads as an episode marker to any name parser, and
  // the app's own record is the better evidence — the same precedence
  // `release-art.ts` applies when it picks a poster provider.
  const film = {
    name: "Star.Wars.Episode.1.The.Phantom.Menace.1999.1080p.BluRay.x264",
    category: "Movies",
  };
  assert.equal(downloadMediaType(film), "movie");
  assert.equal(isSeriesDownload(film), false);
});

check("with no category at all, the release name still finds a series", () => {
  // The rows an external client holds, and anything sideloaded, arrive with no
  // category whatsoever. Season structure in the name is real evidence and the
  // app already reads it everywhere else.
  const named = [
    "Rick.and.Morty.S09E02.1080p.x265-ELiTE[EZTVx.to].mkv",
    "Breaking Bad S01 COMPLETE 1080p",
    "Severance 1x05 2160p ATVP WEB-DL",
    "[SubsPlease] Sousou no Frieren - 28 (1080p) [F1D2A9C0].mkv",
  ];
  for (const name of named) {
    assert.equal(downloadMediaType({ name }), "tv", name);
    assert.equal(isSeriesDownload({ name }), true, name);
    assert.equal(downloadInTab({ name }, "series"), true, name);
  }
});

check("a row nothing vouches for stays under All and claims no narrow tab", () => {
  // The failure this exists to stop: reading "no season marker" as "therefore
  // a film". This list is not restricted to media — the client holds whatever
  // was sent to it — so an unrecognised row filed under Movies is a row hidden
  // in a tab nobody would think to open.
  const unknown = [
    { name: "Dune.2021.2160p.WEB-DL.x265" },
    { name: "ubuntu-24.04.1-desktop-amd64.iso" },
    { name: "Interstellar 2014 2160p UHD BluRay", category: null },
    { name: "Some Collection Of Things", category: "documentary" },
    { name: "" },
  ];
  for (const row of unknown) {
    assert.equal(
      downloadMediaType(row),
      null,
      `${JSON.stringify(row.name)} must claim no media type`,
    );
    assert.equal(tabForDownload(row), null, JSON.stringify(row.name));
    assert.equal(
      downloadInTab(row, "all"),
      true,
      `${JSON.stringify(row.name)} must still be visible under All`,
    );
    for (const tab of NARROW) {
      assert.equal(downloadInTab(row, tab), false, `${row.name} in ${tab}`);
    }
  }
  // And it survives the filter the page actually calls.
  assert.equal(filterDownloadsByTab(unknown, "all").length, unknown.length);
  assert.equal(filterDownloadsByTab(unknown, "movies").length, 0);
});

check("All holds every row and the narrow tabs never hold one twice", () => {
  const rows = [
    { name: "Star Wars The Rise Of Skywalker (2019) 1080p", category: "Movies" },
    { name: "Rick and Morty S09E02 1080p", category: "TV" },
    { name: "Rick and Morty S09E01 1080p", category: "TV" },
    { name: "[SubsPlease] Frieren - 28 (1080p).mkv", category: "Anime" },
    { name: "ubuntu-24.04.1-desktop-amd64.iso" },
  ];
  assert.equal(filterDownloadsByTab(rows, "all").length, 5);
  assert.equal(filterDownloadsByTab(rows, "movies").length, 1);
  assert.equal(filterDownloadsByTab(rows, "series").length, 2);
  assert.equal(filterDownloadsByTab(rows, "anime").length, 1);
  for (const row of rows) {
    const hits = NARROW.filter((tab) => downloadInTab(row, tab));
    assert.ok(hits.length <= 1, `${row.name} appeared in ${hits.join(", ")}`);
  }
});

check("grouping and the tab bar cannot disagree about what a series is", () => {
  // `isSeriesDownload` decides which rows collapse into a combined row, and
  // `tabForDownload` decides what the Series and Anime tabs hold. Two answers
  // would let a row be grouped as a show while sitting under Movies.
  const rows = [
    { name: "Rick and Morty S09E02 1080p", category: "TV" },
    { name: "[SubsPlease] Frieren - 28 (1080p).mkv", category: "Anime" },
    { name: "Star Wars The Rise Of Skywalker (2019) 1080p", category: "Movies" },
    { name: "Star.Wars.Episode.1.The.Phantom.Menace.1999.1080p", category: "Movies" },
    { name: "Breaking Bad S01 COMPLETE 1080p" },
    { name: "ubuntu-24.04.1-desktop-amd64.iso" },
  ];
  for (const row of rows) {
    const tab = tabForDownload(row);
    assert.equal(
      isSeriesDownload(row),
      tab === "series" || tab === "anime",
      `${row.name} groups=${isSeriesDownload(row)} tab=${tab}`,
    );
  }
});

check("the Library's own filter agrees, given the type this module derives", () => {
  // The end-to-end statement of "one rule, two surfaces": feed the derived
  // media type into the Library's untouched filter and the same rows come out.
  const rows = [
    { name: "Rick and Morty S09E02 1080p", category: "TV" },
    { name: "[SubsPlease] Frieren - 28 (1080p).mkv", category: "Anime" },
    { name: "Star Wars The Rise Of Skywalker (2019) 1080p", category: "Movies" },
    { name: "ubuntu-24.04.1-desktop-amd64.iso" },
  ];
  const asLibraryRows = rows.map((row) => ({
    mediaType: downloadMediaType(row),
    name: row.name,
  }));
  for (const tab of DOWNLOAD_TABS) {
    assert.deepEqual(
      filterDownloadsByTab(rows, tab).map((r) => r.name),
      filterByTab(asLibraryRows, tab).map((r) => r.name),
      `tab ${tab}`,
    );
  }
});

if (failures > 0) {
  console.error(`\n${failures} downloads media-filter test(s) failed.`);
  process.exit(1);
}
console.log("\nAll downloads media-filter tests passed.");
