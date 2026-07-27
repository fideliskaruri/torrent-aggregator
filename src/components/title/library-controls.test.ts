import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LibraryControls } from "./library-controls";
import type { TitleLibraryState } from "./types";

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

check("monitoring off renders as an actionable toggle with a described helper", () => {
  const html = renderToStaticMarkup(
    React.createElement(LibraryControls, {
      library: library(),
      isSeries: true,
      onChanged: () => {},
    }),
  );
  const describedBy = /aria-describedby="([^"]+)"/.exec(html)?.[1];
  assert.ok(describedBy, html);
  assert.match(html, />Turn monitoring on</);
  assert.match(html, new RegExp(`<p id="${describedBy}"[^>]*>New episodes are fetched`));
});

check("monitoring on exposes the opposite toggle without a stale helper", () => {
  const html = renderToStaticMarkup(
    React.createElement(LibraryControls, {
      library: library({ monitored: true }),
      isSeries: true,
      onChanged: () => {},
    }),
  );
  assert.match(html, />Turn monitoring off</);
  assert.doesNotMatch(html, /aria-describedby=/);
  assert.doesNotMatch(html, /New episodes are fetched/);
});

console.log(
  `\n${failures === 0 ? "library-controls: all tests passed" : `library-controls: ${failures} failing`}`,
);
process.exit(failures === 0 ? 0 : 1);
