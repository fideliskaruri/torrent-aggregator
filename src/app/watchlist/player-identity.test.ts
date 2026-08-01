import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PlayerIdentity } from "@/components/watch/inline-player";
import { canonicalWatchlistPlayerTitle } from "./player-identity";

const item = {
  title: "Solar Harbor",
  latestReleaseTitle: "Solar.Harbor.S01E02.1080p.WEB-DL-GROUP",
};
const canonicalTitle = canonicalWatchlistPlayerTitle(item);
const dom = renderToStaticMarkup(
  React.createElement(PlayerIdentity, {
    showTitle: canonicalTitle,
    episodeTitle: "The Long Return",
    season: 1,
    episode: 2,
  }),
);

assert.match(dom, /Solar Harbor/);
assert.doesNotMatch(dom, /Solar\.Harbor|WEB-DL|GROUP/);

const source = readFileSync("src/app/watchlist/page.tsx", "utf8");
assert.match(source, /title=\{canonicalWatchlistPlayerTitle\(item\)\}/);
assert.doesNotMatch(
  source,
  /<InlineStreamPlayer[\s\S]{0,200}title=\{item\.latestReleaseTitle/,
);
console.log("PASS watchlist canonical player identity");
