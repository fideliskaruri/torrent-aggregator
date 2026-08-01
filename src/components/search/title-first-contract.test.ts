import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  SEARCH_SCOPES,
  getScope,
} from "@/lib/torrents/search-scopes";
import type { WorkSearchCategory } from "@/lib/search/work-search";
import {
  searchDisplayFor,
  searchErrorMessage,
  searchRequestFor,
  searchUrlFor,
} from "./search-overlay-state";
import { PRIMARY_NAV } from "@/lib/navigation";

const root = process.cwd();
const read = (relative: string) =>
  fs.readFileSync(path.join(root, ...relative.split("/")), "utf8");
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const overlay = stripComments(read("src/components/search/search-overlay.tsx"));
const searchBar = stripComments(read("src/components/search/search-bar.tsx"));
const searchPage = stripComments(read("src/app/search/page.tsx"));
const everythingPage = stripComments(read("src/app/everything/page.tsx"));
const titlesRoute = stripComments(read("src/app/api/search/titles/route.ts"));
const anilist = stripComments(read("src/lib/metadata/anilist.ts"));

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log("title-first-contract.test.ts");

const categories = ["movies", "series", "anime"] as const;

check("normal Search exposes exactly Movies, Series, Anime", () => {
  assert.deepEqual(
    SEARCH_SCOPES.map(({ id, label }) => ({ id, label })),
    [
      { id: "movies", label: "Movies" },
      { id: "series", label: "Series" },
      { id: "anime", label: "Anime" },
    ],
  );
});

for (const category of categories) {
  check(`${category} calls only /api/search/titles with a durable category`, () => {
    const request = searchRequestFor(category, "Slime");
    assert.ok(request);
    const url = new URL(request.url, "http://search.test");
    assert.equal(url.pathname, "/api/search/titles");
    assert.equal(url.searchParams.get("q"), "Slime");
    assert.equal(url.searchParams.get("category"), category);
    assert.equal(request.kind, "work");
  });
}

check("invalid product category falls back to Movies", () => {
  assert.equal(getScope("music").id, "movies");
  assert.equal(getScope("not-a-category").id, "movies");
});

check("durable URL round-trips Unicode q + category", () => {
  const buildUrl = searchUrlFor as unknown as (
    query: string,
    category: WorkSearchCategory,
  ) => string;
  const url = new URL(
    buildUrl("転生したらスライムだった件", "anime"),
    "http://search.test",
  );
  assert.equal(url.pathname, "/search");
  assert.equal(url.searchParams.get("q"), "転生したらスライムだった件");
  assert.equal(url.searchParams.get("category"), "anime");
});

for (const category of categories) {
  const scopeId = category;
  check(`${category} covers prompt, short query, loading, stale, empty and error`, () => {
    assert.equal(
      searchDisplayFor({
        scopeId,
        query: "",
        loading: false,
        error: null,
        resultCount: 0,
      }).state,
      "prompt",
    );
    assert.equal(
      searchDisplayFor({
        scopeId,
        query: "s",
        loading: false,
        error: null,
        resultCount: 0,
      }).state,
      "typing",
    );
    assert.equal(
      searchDisplayFor({
        scopeId,
        query: "slime",
        loading: true,
        error: null,
        resultCount: 0,
      }).state,
      "loading",
    );
    assert.equal(
      searchDisplayFor({
        scopeId,
        query: "slime",
        loading: true,
        error: null,
        resultCount: 3,
      }).state,
      "results",
    );
    assert.equal(
      searchDisplayFor({
        scopeId,
        query: "zzzz",
        loading: false,
        error: null,
        resultCount: 0,
      }).state,
      "empty",
    );
    assert.equal(
      searchDisplayFor({
        scopeId,
        query: "slime",
        loading: false,
        error: "Temporary failure",
        resultCount: 0,
      }).state,
      "error",
    );
  });
}

check("429 and 5xx copy describes title discovery and retry stays visible", () => {
  assert.doesNotMatch(searchErrorMessage(429, null), /indexer|torrent/i);
  assert.doesNotMatch(searchErrorMessage(503, null), /indexer|torrent/i);
  assert.match(overlay, /Try search again/);
});

check("normal search imports and renders title entities only", () => {
  for (const source of [overlay, searchPage]) {
    assert.doesNotMatch(source, /ArtifactRow|TorrentResult|releases|data-artifact-row/);
  }
  assert.match(overlay, /TitleResultsList/);
  assert.doesNotMatch(
    overlay,
    /\b(?:Play|Download|provider|indexer|seeders?|leechers?|infoHash|sourceUrl)\b/i,
  );
});

check("normal search has no All, Games, Music, Software or Books controls", () => {
  for (const label of ["All categories", "Games", "Music", "Software", "Books"]) {
    assert.doesNotMatch(overlay, new RegExp(`>${label}<`));
    assert.doesNotMatch(searchBar, new RegExp(`label:\\s*"${label}"`));
  }
  assert.doesNotMatch(searchBar, /label:\s*"All"/);
  assert.doesNotMatch(searchBar, /label:\s*"TV"/);
  assert.match(searchBar, /label:\s*"Series"/);
});

check("category tabs support arrow keys while Enter opens a title result", () => {
  assert.match(overlay, /onCategoryKeyDown/);
  for (const key of ["ArrowLeft", "ArrowRight", "Home", "End"]) {
    assert.match(overlay, new RegExp(key));
  }
  assert.match(overlay, /first\.click\(\)/);
  assert.match(overlay, /openerRef/);
  assert.match(overlay, /e\.key !== "Tab"/);
  assert.match(overlay, /e\.key === "Escape"/);
});

check("title API selects TMDB movie, TMDB TV, or AniList by category", () => {
  assert.match(titlesRoute, /searchTmdbByType/);
  assert.match(titlesRoute, /searchAniListWorks/);
  for (const category of categories) {
    assert.match(titlesRoute, new RegExp(`"${category}"`));
  }
  assert.doesNotMatch(titlesRoute, /searchTorrents|TorrentResult/);
});

check("AniList work search preserves format for MOVIE, TV, ONA and OVA mapping", () => {
  assert.match(anilist, /export\s+type\s+AniListFormat/);
  assert.match(anilist, /searchAniListWorks/);
  assert.match(anilist, /format/);
  assert.match(anilist, /MOVIE/);
  assert.match(anilist, /TV/);
  assert.match(anilist, /ONA/);
  assert.match(anilist, /OVA/);
});

check("/everything is a compatibility redirect and no longer primary navigation", () => {
  assert.match(everythingPage, /redirect\(/);
  assert.match(everythingPage, /legacyEverythingRedirectUrl/);
  assert.equal(PRIMARY_NAV.some((item) => item.href === "/everything"), false);
});

if (failures > 0) {
  console.error(`title-first-contract.test.ts: ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("title-first-contract.test.ts: all assertions passed");
