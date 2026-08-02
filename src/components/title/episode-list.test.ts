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

console.log("\ntitle episode list");

check("remote episode row renders distinct Play and Download controls", () => {
  const html = renderToStaticMarkup(
    React.createElement(EpisodeList, {
      seasons: [{ season: 1, knownEpisodes: 1, pack: null, transfer: null }],
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
  assert.match(html, />Play</);
  assert.match(html, />Download</);
  assert.match(html, /aria-label="Play — S01E01"/);
  assert.match(html, /aria-label="Download — S01E01"/);
});

check("season toolbar has one Download season action and no Play season", () => {
  const html = renderToStaticMarkup(
    React.createElement(EpisodeList, {
      seasons: [{ season: 1, knownEpisodes: 2, pack: null, transfer: null }],
      season: 1,
      episodes: [episode(), episode({ episode: 2, label: "S01E02" })],
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

  assert.match(html, />Download season</);
  assert.doesNotMatch(html, /Play season/);
  assert.match(html, /data-season-count="true"[^>]*>2 episodes</);
  assert.doesNotMatch(html, /Review season|Review download/i);
  assert.match(html, />Play</);
  assert.match(html, />Download</);
});

check("locally backed episode keeps immediate Play", () => {
  const html = renderToStaticMarkup(
    React.createElement(EpisodeList, {
      seasons: [{ season: 1, knownEpisodes: 1, pack: null, transfer: null }],
      season: 1,
      episodes: [
        episode({
          availability: "ready",
          infoHash: "0123456789abcdef0123456789abcdef01234567",
        }),
      ],
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

  assert.match(html, /data-action-kind="play"/);
  assert.match(html, />Play</);
});

check("failed download keeps Play and offers Retry download", () => {
  const render = (row: EpisodeRowModel) =>
    renderToStaticMarkup(
      React.createElement(EpisodeList, {
        seasons: [{ season: 1, knownEpisodes: 1, pack: null, transfer: null }],
        season: 1,
        episodes: [row],
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
  assert.match(missingHtml, />Retry download</);

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
      season: 4,
      episodes: [
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

  const e02 = html.match(/<li[^>]*data-episode="2"[\s\S]*?<\/li>/)?.[0] ?? "";
  assert.doesNotMatch(e02, /13% downloaded|Downloading|Downloaded|Available/);
});

check("target-linked episode renders exact transfer progress without leaking to siblings", () => {
  const html = renderToStaticMarkup(
    React.createElement(EpisodeList, {
      seasons: [{ season: 1, knownEpisodes: 2, pack: null, transfer: null }],
      season: 1,
      episodes: [
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
      ],
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

  const e01 = html.match(/<li[^>]*data-episode="1"[\s\S]*?<\/li>/)?.[0] ?? "";
  const e02 = html.match(/<li[^>]*data-episode="2"[\s\S]*?<\/li>/)?.[0] ?? "";
  assert.doesNotMatch(e01, /6\.1%|Downloading/);
  assert.match(e02, /Downloading 6\.1%/);
  assert.match(e02, /aria-label="Downloading 6\.1% — S01E02"[^>]*disabled/);
  assert.doesNotMatch(e02, /data-episode-transfer/);
});

check("queued transfer is a disabled right-side control", () => {
  const html = renderToStaticMarkup(
    React.createElement(EpisodeList, {
      seasons: [{ season: 1, knownEpisodes: 1, pack: null, transfer: null }],
      season: 1,
      episodes: [episode({ transfer: {
        status: "queued",
        progress: 0,
        infoHash: null,
        filePath: null,
        error: null,
      } })],
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

  assert.match(html, /aria-label="Queued — S01E01"[^>]*disabled/);
  assert.match(html, /data-action="stream"/);
  assert.doesNotMatch(html, /data-episode-transfer/);
});

check("left content reserves a still and excludes playback and transfer decoration", () => {
  const html = renderToStaticMarkup(
    React.createElement(EpisodeList, {
      seasons: [{ season: 1, knownEpisodes: 1, pack: null, transfer: null }],
      season: 1,
      episodes: [episode({
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
      })],
      truncated: false,
      loadState: { status: "ready" },
      busy: false,
      statusFor: () => "pending" as const,
      seasonGrabStatus: { status: "idle" },
      onSeasonChange: () => {},
      onSeasonGrab: () => {},
      onAction: () => {},
    }),
  );

  assert.match(html, /data-episode-still="true"[^>]*h-\[50px\][^>]*w-\[88px\][^>]*sm:h-\[72px\][^>]*sm:w-\[128px\]/);
  assert.match(html, /S01E01/);
  assert.match(html, /Hello, Goodbye/);
  assert.match(html, /2 Jan 2024 · 47 min/);
  assert.match(html, /The team makes a difficult choice\./);
  assert.doesNotMatch(html, /Ready|Partial|Watched|Next up|from pack|42%|50%|10:00|Loading S01E01|Could not start|On its way/i);
});

check("future episode shows only its air date instead of actions", () => {
  const html = renderToStaticMarkup(
    React.createElement(EpisodeList, {
      seasons: [{ season: 1, knownEpisodes: 1, pack: null, transfer: null }],
      season: 1,
      episodes: [episode({ meta: {
        episode: 1,
        name: "Tomorrow",
        airDate: "2999-04-03",
        runtimeMin: 45,
        stillUrl: null,
        overview: null,
      } })],
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

  assert.match(html, /data-episode-unaired="true"[^>]*>Airs 3 Apr 2999</);
  assert.doesNotMatch(html, /data-episode-action/);
});

check("season switch replaces stale rows with labeled stable skeletons", () => {
  const html = renderToStaticMarkup(
    React.createElement(EpisodeList, {
      seasons: [
        { season: 1, knownEpisodes: 1, pack: null, transfer: null },
        { season: 2, knownEpisodes: 1, pack: null, transfer: null },
      ],
      season: 2,
      episodes: [episode({ label: "STALE-ROW" })],
      truncated: false,
      loadState: { status: "loading" },
      busy: true,
      statusFor: () => "idle" as const,
      seasonGrabStatus: { status: "idle" },
      onSeasonChange: () => {},
      onSeasonGrab: () => {},
      onAction: () => {},
    }),
  );

  assert.match(html, /data-episode-skeletons="true"/);
  assert.match(html, /Loading season 2 episodes/);
  assert.match(html, /h-\[50px\] w-\[88px\][^>]*sm:h-\[72px\] sm:w-\[128px\]/);
  assert.doesNotMatch(html, /STALE-ROW|opacity-60/);
});

check("completed target renders Play and Downloaded, not a third status line", () => {
  const html = renderToStaticMarkup(
    React.createElement(EpisodeList, {
      seasons: [{ season: 2, knownEpisodes: 1, pack: null, transfer: null }],
      season: 2,
      episodes: [
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

  // The right-hand control is the indicator. A body line that repeats it is
  // the screenshot defect ("Downloaded/Available" under a Ready row).
  assert.doesNotMatch(html, /Downloaded\/Available/);
  assert.doesNotMatch(html, /data-episode-transfer="downloaded"/);
  assert.match(html, /data-action-kind="play"/);
  assert.match(html, />Downloaded</);
});

check("downloaded transfer without a hash still owns a disabled Downloaded control", () => {
  const html = renderToStaticMarkup(
    React.createElement(EpisodeList, {
      seasons: [{ season: 1, knownEpisodes: 1, pack: null, transfer: null }],
      season: 1,
      episodes: [episode({ transfer: {
        status: "downloaded",
        progress: 1,
        infoHash: null,
        filePath: null,
        error: null,
      } })],
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

  assert.match(html, /aria-label="Downloaded — S01E01"[^>]*disabled/);
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
