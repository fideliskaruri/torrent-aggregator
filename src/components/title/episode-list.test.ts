import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EpisodeList } from "./episode-list";
import { postTitleAction } from "./title-action-request";
import type { EpisodeRowModel } from "./merge-extras";

let failures = 0;

function check(name: string, fn: () => void | Promise<void>) {
  Promise.resolve()
    .then(fn)
    .then(
      () => console.log(`  PASS  ${name}`),
      (err) => {
        failures += 1;
        console.error(`  FAIL  ${name}`);
        console.error(`        ${err instanceof Error ? err.message : String(err)}`);
      },
    );
}

function episode(overrides: Partial<EpisodeRowModel> = {}): EpisodeRowModel {
  return {
    season: 1,
    episode: 1,
    label: "S01E01",
    availability: null,
    infoHash: null,
    filePath: null,
    downloadFraction: null,
    watchedFraction: null,
    resumePositionSec: null,
    watched: false,
    nextUp: false,
    fromPack: false,
    meta: null,
    ...overrides,
  };
}

console.log("\ntitle episode list");

check("episode row renders distinct Stream and Download controls", () => {
  const html = renderToStaticMarkup(
    React.createElement(EpisodeList, {
      seasons: [{ season: 1, knownEpisodes: 1, pack: null }],
      season: 1,
      episodes: [episode()],
      truncated: false,
      loadState: { status: "ready" },
      busy: false,
      statusFor: () => "idle" as const,
      seasonGrabStatus: { status: "idle" },
      onSeasonChange: () => {},
      onSeasonGrab: () => {},
      onAction: () => {},
    }),
  );

  assert.match(html, /data-action="stream"/);
  assert.match(html, /data-action="download"/);
  assert.match(html, />Stream</);
  assert.match(html, />Download</);
});

check("episode actions post stream versus keep retention", async () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    calls.push(String(init?.body ?? ""));
    return new Response(JSON.stringify({ ok: true, infoHash: "abc123" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    await postTitleAction({
      workKey: "example-show",
      title: "Example Show",
      mediaType: "tv",
      year: 2024,
      action: { kind: "stream", label: "Stream", season: 1, episode: 1 },
      retention: "stream",
    });
    await postTitleAction({
      workKey: "example-show",
      title: "Example Show",
      mediaType: "tv",
      year: 2024,
      action: { kind: "get", label: "Download", season: 1, episode: 1 },
      retention: "keep",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(JSON.parse(calls[0]).retention, "stream");
  assert.equal(JSON.parse(calls[1]).retention, "keep");
});

setTimeout(() => {
  console.log(
    `\n${failures === 0 ? "episode-list: all tests passed" : `episode-list: ${failures} failing`}`,
  );
  process.exit(failures === 0 ? 0 : 1);
}, 0);
