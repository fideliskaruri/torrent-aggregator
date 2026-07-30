import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LibraryControls } from "./library-controls";
import type { TitleLibraryState } from "./types";

const here = path.dirname(fileURLToPath(import.meta.url));
const componentSource = readFileSync(
  path.join(here, "library-controls.tsx"),
  "utf8",
);

let failures = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err instanceof Error ? err.message : String(err)}`);
  }
}

function library(overrides: Partial<TitleLibraryState> = {}): TitleLibraryState {
  return {
    inLibrary: true,
    watchListItemId: "watch-1",
    monitored: false,
    status: "planned",
    cursorSeason: null,
    cursorEpisode: null,
    addPayload: {
      title: "Example Show",
      mediaType: "tv",
      externalId: "example",
      posterUrl: null,
      synopsis: null,
      rating: null,
    },
    ...overrides,
  };
}

console.log("\ntitle library controls");

check("the library side no longer renders the acquire pair (it lives in the hero)", () => {
  const html = renderToStaticMarkup(
    React.createElement(LibraryControls, {
      library: library({ inLibrary: false, watchListItemId: null }),
      isSeries: true,
      onChanged: () => {},
    }),
  );

  // Play/Download moved to the hero (title-detail.tsx), which owns the player.
  // A second, non-functional pair here was the duplicate-button regression.
  assert.doesNotMatch(html, /data-title-stream/);
  assert.doesNotMatch(html, /data-title-download/);
  assert.doesNotMatch(html, /data-title-acquire/);

  // The library side still offers its own decision: catalogue membership.
  assert.match(html, /data-add-to-library/);
  assert.match(html, />Add to library</);
});

check("the source no longer sends acquire requests to /api/torrent/send", () => {
  // Acquiring is the hero's job now; the library side only touches the
  // watchlist API. Guard against the acquire handler creeping back in.
  assert.doesNotMatch(componentSource, /\/api\/torrent\/send/);
  assert.match(componentSource, /fetch\("\/api\/watchlist"/);
});

check("monitoring off renders as a plain product-worded toggle switch", () => {
  const html = renderToStaticMarkup(
    React.createElement(LibraryControls, {
      library: library(),
      isSeries: true,
      onChanged: () => {},
    }),
  );
  // A switch, not a big CTA, and it says what it does in product terms.
  assert.match(html, /role="switch"/);
  assert.match(html, /aria-checked="false"/);
  assert.match(html, />Auto-download new episodes</);
  // No jargon ("checks") and no free-floating helper paragraph.
  assert.doesNotMatch(html, /automatic checks/);
  assert.doesNotMatch(html, /aria-describedby=/);
  assert.doesNotMatch(html, /fetched as/);
});

check("monitoring on flips the toggle label without a stale helper", () => {
  const html = renderToStaticMarkup(
    React.createElement(LibraryControls, {
      library: library({ monitored: true }),
      isSeries: true,
      onChanged: () => {},
    }),
  );
  assert.match(html, /aria-checked="true"/);
  assert.match(html, />Auto-downloading new episodes</);
  assert.doesNotMatch(html, /automatic checks/);
  assert.doesNotMatch(html, /aria-describedby=/);
});

check("a movie gets movie-worded monitoring copy, never episode copy", () => {
  const html = renderToStaticMarkup(
    React.createElement(LibraryControls, {
      library: library(),
      isSeries: false,
      onChanged: () => {},
    }),
  );
  assert.match(html, />Auto-download when available</);
  assert.doesNotMatch(html, /new episodes/);
});

console.log(
  `\n${failures === 0 ? "library-controls: all tests passed" : `library-controls: ${failures} failing`}`,
);
process.exit(failures === 0 ? 0 : 1);
