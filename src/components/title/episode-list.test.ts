import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EpisodeList } from "./episode-list";
import { postTitleAction } from "./title-action-request";
import type { EpisodeRowModel } from "./merge-extras";

let failures = 0;

/**
 * Run checks strictly one after another.
 *
 * Several checks below swap `globalThis.fetch` and restore it in a `finally`.
 * Fire-and-forget scheduling let those overlap: one check's restore ran while
 * another was still mid-await, so the second call escaped to the real `fetch`
 * and failed with "Could not send this episode". Serialising makes the shared
 * global safe to borrow, and makes the run deterministic.
 */
let queue: Promise<void> = Promise.resolve();

function check(name: string, fn: () => void | Promise<void>) {
  queue = queue.then(() =>
    Promise.resolve()
      .then(fn)
      .then(
        () => console.log(`  PASS  ${name}`),
        (err) => {
          failures += 1;
          console.error(`  FAIL  ${name}`);
          console.error(`        ${err instanceof Error ? err.message : String(err)}`);
        },
      ),
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
    transfer: null,
    meta: null,
    ...overrides,
  };
}

/** Common props so each case only spells out what it is testing. */
function baseProps(episodes: EpisodeRowModel[], season = 1) {
  return {
    seasons: [{ season, knownEpisodes: episodes.length, pack: null, transfer: null }],
    season,
    episodes,
    truncated: false,
    loadState: { status: "ready" } as const,
    busy: false,
    statusFor: () => "idle" as const,
    seasonGrabStatus: { status: "idle" } as const,
    onSeasonChange: () => {},
    onSeasonGrab: () => {},
    onAction: () => {},
  };
}

console.log("\ntitle episode list");

// ---------------------------------------------------------------------------
// The filmstrip card model.
//
// The card is the play target (data-action="stream"); every aired episode also
// carries a compact Download control (data-action="download"). Play and keep
// remain distinct actions on distinct elements — a click on Download can never
// fire Play, because Download is a sibling layered over the card button, never
// a child of it.
// ---------------------------------------------------------------------------

check("card is the play target and carries a distinct Download control", () => {
  const html = renderToStaticMarkup(
    React.createElement(EpisodeList, baseProps([episode()])),
  );

  // The strip, not a vertical list.
  assert.match(html, /data-episode-strip="true"/);
  // The card play button.
  assert.match(html, /data-episode-action="true" data-action="stream"/);
  assert.match(html, /data-action-kind="stream"/);
  assert.match(html, /aria-label="Play — S01E01"/);
  // The compact keep-it control, distinct from the card.
  assert.match(html, /data-episode-action="true" data-action="download"/);
  assert.match(html, /aria-label="Download — S01E01"/);
  // A 16:9 still tops the card, with an E-badge overlaid.
  assert.match(html, /data-episode-still="true"[^>]*aspect-video/);
  assert.match(html, /data-episode-badge="true"[^>]*>E1</);
});

check("watched header reports X of Y and a rounded percent", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      EpisodeList,
      baseProps([
        episode({ episode: 1, label: "S01E01", watched: true }),
        episode({ episode: 2, label: "S01E02", watched: true }),
        episode({ episode: 3, label: "S01E03", watched: false }),
      ]),
    ),
  );

  assert.match(html, /data-watched-label="true"/);
  // 2 of 3 watched → round(66.67) = 67.
  assert.match(html, /Watched 2 of 3 \(67%\)/);
});

check("watched header reads 0 of Y (0%) when nothing is watched", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      EpisodeList,
      baseProps([
        episode({ episode: 1, label: "S01E01" }),
        episode({ episode: 2, label: "S01E02" }),
      ]),
    ),
  );

  assert.match(html, /Watched 0 of 2 \(0%\)/);
});

check("season toolbar has one Download season action and no Play season", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      EpisodeList,
      baseProps([episode(), episode({ episode: 2, label: "S01E02" })]),
    ),
  );

  assert.match(html, />Download season</);
  assert.doesNotMatch(html, /Play season/);
  assert.match(html, /data-season-count="true"[^>]*>2 episodes</);
  assert.doesNotMatch(html, /Review season|Review download/i);
  // The per-card actions still exist alongside the season action.
  assert.match(html, /data-action="stream"/);
  assert.match(html, /data-action="download"/);
});

check("locally backed episode keeps immediate Play", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      EpisodeList,
      baseProps([
        episode({
          availability: "ready",
          infoHash: "0123456789abcdef0123456789abcdef01234567",
        }),
      ]),
    ),
  );

  assert.match(html, /data-action-kind="play"/);
  assert.match(html, /aria-label="Play — S01E01"/);
});

check("failed download keeps the play card and offers Retry download", () => {
  const render = (row: EpisodeRowModel) =>
    renderToStaticMarkup(React.createElement(EpisodeList, baseProps([row])));
  const failed = {
    status: "failed" as const,
    progress: 0,
    infoHash: null,
    filePath: null,
    error: "The requested file is no longer available.",
  };

  const missingHtml = render(episode({ transfer: failed }));
  assert.match(missingHtml, /data-episode-action="true" data-action="stream"/);
  assert.doesNotMatch(missingHtml, /Download failed/);
  // Retry is a pressable Download control — not disabled.
  assert.match(missingHtml, /aria-label="Retry download — S01E01"/);
  assert.doesNotMatch(missingHtml, /aria-label="Retry download — S01E01"[^>]*disabled=""/);

  const localHtml = render(
    episode({
      availability: "ready",
      infoHash: "f".repeat(40),
      transfer: failed,
    }),
  );
  assert.match(localHtml, /data-episode-action="true" data-action="stream"/);
  assert.match(localHtml, /data-action-kind="play"/);
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
      action: { kind: "stream", label: "Play", season: 1, episode: 1 },
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

// ---------------------------------------------------------------------------
// Task 4: resolution threaded through Download
// The rule: Download passes resolution in the POST body; Play never does.
// ---------------------------------------------------------------------------

check("Download (keep) sends resolution in request body", async () => {
  const calls: Array<{ url: string; body: string }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? "") });
    return new Response(JSON.stringify({ ok: true, infoHash: "abc" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    await postTitleAction({
      workKey: "w",
      action: {
        kind: "get",
        label: "Download",
        season: 1,
        episode: 2,
        infoHash: "a".repeat(40),
      },
      retention: "keep",
      resolution: 1080,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const body = JSON.parse(calls[0].body);
  assert.equal(calls[0].url, "/api/title/w");
  assert.equal(body.scope, "episode");
  assert.equal(body.season, 1);
  assert.equal(body.episode, 2);
  assert.equal(body.preferredResolution, 1080);
  assert.equal(body.infoHash, undefined);
});

check("Play (stream) does not send resolution in request body", async () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    calls.push(String(init?.body ?? ""));
    return new Response(JSON.stringify({ ok: true, infoHash: "abc" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    await postTitleAction({
      workKey: "w",
      action: { kind: "stream", label: "Play", season: 1, episode: 1 },
      retention: "stream",
      // no resolution — stream grabs never send it
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(JSON.parse(calls[0]).resolution, undefined);
});

check("a legacy season pack does not make every sibling episode downloaded", () => {
  const html = renderToStaticMarkup(
    React.createElement(EpisodeList, {
      ...baseProps(
        [
          episode({
            season: 4,
            episode: 1,
            label: "S04E01",
            availability: null,
            fromPack: false,
          }),
          episode({
            season: 4,
            episode: 2,
            label: "S04E02",
            availability: null,
            fromPack: false,
            downloadFraction: null,
          }),
        ],
        4,
      ),
      seasons: [
        {
          season: 4,
          knownEpisodes: 2,
          pack: {
            name: "Example Show S04 COMPLETE 12.69GB",
            availability: "warm",
            infoHash: "b".repeat(40),
            downloadFraction: 0.061,
          },
          transfer: null,
        },
      ],
    }),
  );

  const e02 = html.match(/<li[^>]*data-episode="2"[\s\S]*?<\/li>/)?.[0] ?? "";
  assert.doesNotMatch(e02, /13% downloaded|Downloading|Downloaded|Available/);
});

check("downloading episode shows exact progress on its own Download control", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      EpisodeList,
      baseProps([
        episode({ episode: 1, label: "S01E01" }),
        episode({
          episode: 2,
          label: "S01E02",
          transfer: {
            status: "downloading",
            progress: 0.061,
            infoHash: "c".repeat(40),
            filePath: null,
            error: null,
          },
        } as Partial<EpisodeRowModel>),
      ]),
    ),
  );

  const e01 = html.match(/<li[^>]*data-episode="1"[\s\S]*?<\/li>/)?.[0] ?? "";
  const e02 = html.match(/<li[^>]*data-episode="2"[\s\S]*?<\/li>/)?.[0] ?? "";
  assert.doesNotMatch(e01, /6\.1%|Downloading/);
  assert.match(e02, /Downloading 6\.1%/);
  assert.match(e02, /aria-label="Downloading 6\.1% — S01E02"[^>]*disabled=""/);
  // A visual download-progress strip is drawn, keyed off the transfer.
  assert.match(e02, /data-episode-progress="download"/);
});

check("queued transfer is a disabled Download control on the card", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      EpisodeList,
      baseProps([
        episode({
          transfer: {
            status: "queued",
            progress: 0,
            infoHash: null,
            filePath: null,
            error: null,
          },
        }),
      ]),
    ),
  );

  assert.match(html, /aria-label="Queued — S01E01"[^>]*disabled=""/);
  assert.match(html, /data-action="stream"/);
});

check("card reserves a 16:9 still, code+title and clamped synopsis; no legacy chips", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      EpisodeList,
      baseProps([
        episode({
          availability: "warm",
          watched: true,
          nextUp: true,
          fromPack: true,
          downloadFraction: 0.42,
          watchedFraction: 0.5,
          resumePositionSec: 600,
          meta: {
            episode: 1,
            name: "Hello, Goodbye",
            airDate: "2024-01-02",
            runtimeMin: 47,
            stillUrl: null,
            overview: "The team makes a difficult choice.",
          },
        }),
      ]),
    ),
  );

  assert.match(html, /data-episode-still="true"[^>]*aspect-video/);
  // Code and title fold into one ellipsised line.
  assert.match(html, /S01E01 · Hello, Goodbye/);
  assert.match(html, /line-clamp-2/);
  assert.match(html, /The team makes a difficult choice\./);
  // A watched-progress strip is drawn on the still (playback wins over
  // download), width keyed off the fraction.
  assert.match(html, /data-episode-progress="watched"/);
  assert.match(html, /width:50%/);
  // The old per-row chips are gone: no "Next up", no "from pack", no runtime
  // facts line under the title.
  assert.doesNotMatch(html, /Next up|from pack|47 min|Partial/i);
});

check("future episode shows only its air date instead of actions", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      EpisodeList,
      baseProps([
        episode({
          meta: {
            episode: 1,
            name: "Tomorrow",
            airDate: "2999-04-03",
            runtimeMin: 45,
            stillUrl: null,
            overview: null,
          },
        }),
      ]),
    ),
  );

  assert.match(html, /data-episode-unaired="true"[^>]*>Airs 3 Apr 2999</);
  assert.doesNotMatch(html, /data-episode-action/);
});

check("season switch replaces stale cards with labeled stable skeletons", () => {
  const html = renderToStaticMarkup(
    React.createElement(EpisodeList, {
      ...baseProps([episode({ label: "STALE-ROW" })], 2),
      seasons: [
        { season: 1, knownEpisodes: 1, pack: null, transfer: null },
        { season: 2, knownEpisodes: 1, pack: null, transfer: null },
      ],
      loadState: { status: "loading" },
      busy: true,
    }),
  );

  assert.match(html, /data-episode-skeletons="true"/);
  assert.match(html, /Loading season 2 episodes/);
  // Skeleton cards reserve the same 16:9 still geometry as real cards.
  assert.match(html, /data-episode-skeleton="true"[\s\S]*?aspect-video/);
  assert.doesNotMatch(html, /STALE-ROW|opacity-60/);
});

check("completed target renders a play card and a Downloaded control, not a third status line", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      EpisodeList,
      baseProps(
        [
          episode({
            season: 2,
            episode: 7,
            label: "S02E07",
            availability: "ready",
            transfer: {
              status: "downloaded",
              progress: 1,
              infoHash: "d".repeat(40),
              filePath: "Show S02E07.mkv",
              error: null,
            },
          } as Partial<EpisodeRowModel>),
        ],
        2,
      ),
    ),
  );

  assert.doesNotMatch(html, /Downloaded\/Available/);
  assert.doesNotMatch(html, /data-episode-transfer/);
  assert.match(html, /data-action-kind="play"/);
  assert.match(html, /aria-label="Downloaded — S02E07"[^>]*disabled=""/);
});

check("downloaded transfer without a hash still owns a disabled Downloaded control", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      EpisodeList,
      baseProps([
        episode({
          transfer: {
            status: "downloaded",
            progress: 1,
            infoHash: null,
            filePath: null,
            error: null,
          },
        }),
      ]),
    ),
  );

  assert.match(html, /aria-label="Downloaded — S01E01"[^>]*disabled=""/);
  assert.match(html, /data-action="stream"/);
});

// ---------------------------------------------------------------------------
// Task 3: fetch failures must propagate so the caller can restore an actionable
// state. Cover both the browser's AbortError and a non-ok API response.
// ---------------------------------------------------------------------------

check("postTitleAction propagates abort as a thrown error", async () => {
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = (async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    }) as typeof fetch;
    await assert.rejects(
      postTitleAction({
        workKey: "w",
        action: { kind: "stream", label: "Play", season: 1, episode: 1 },
        retention: "stream",
      }),
      (error) => error instanceof DOMException && error.name === "AbortError",
    );

    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ ok: false, message: "forced error" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    await assert.rejects(
      postTitleAction({
        workKey: "w",
        action: { kind: "get", label: "Download", season: null, episode: null },
        retention: "keep",
      }),
      /forced error/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// Wait for the whole serialised queue before reporting, so the exit code
// reflects every check rather than whatever happened to finish in one tick.
void queue.then(() => {
  console.log(
    `\n${failures === 0 ? "episode-list: all tests passed" : `episode-list: ${failures} failing`}`,
  );
  process.exit(failures === 0 ? 0 : 1);
});
