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

check("the hero offers a distinct stream action and download action", () => {
  const html = renderToStaticMarkup(
    React.createElement(LibraryControls, {
      library: library({ cursorSeason: 2, cursorEpisode: 6 }),
      isSeries: true,
      onChanged: () => {},
    }),
  );

  // The stream (Play) control: a Play intent tagged retention "stream".
  const stream = /<button[^>]*data-title-stream[^>]*>/.exec(html)?.[0];
  assert.ok(stream, `stream button missing:\n${html}`);
  assert.match(stream, /data-retention="stream"/);
  assert.match(stream, /aria-label="Play — Example Show S02E06"/);
  assert.match(html, /data-title-stream[^>]*>[\s\S]*?Play/);

  // The download control: a Keep intent tagged retention "keep".
  const download = /<button[^>]*data-title-download[^>]*>/.exec(html)?.[0];
  assert.ok(download, `download button missing:\n${html}`);
  assert.match(download, /data-retention="keep"/);
  assert.match(download, /aria-label="Download — Example Show S02E06"/);
  assert.match(html, /data-title-download[^>]*>[\s\S]*?Download/);

  // Two separate controls, not one Play with a download glued next to it.
  assert.notEqual(stream, download);
});

check("both hero actions are wired to /api/torrent/send with their retention", () => {
  // Static markup cannot fire onClick, so prove the wiring at the source: one
  // acquire() handler, hitting the same endpoint the search card uses, invoked
  // with each retention by its own button.
  assert.match(componentSource, /fetch\("\/api\/torrent\/send"/);
  assert.match(componentSource, /retention,/);
  assert.match(componentSource, /onClick=\{\(\) => acquire\("stream"\)\}/);
  assert.match(componentSource, /onClick=\{\(\) => acquire\("keep"\)\}/);
});

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
  assert.match(html, />Turn automatic checks on</);
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
  assert.match(html, />Turn automatic checks off</);
  assert.doesNotMatch(html, /aria-describedby=/);
  assert.doesNotMatch(html, /New episodes are fetched/);
});

console.log(
  `\n${failures === 0 ? "library-controls: all tests passed" : `library-controls: ${failures} failing`}`,
);
process.exit(failures === 0 ? 0 : 1);
