import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import nodeAssert from "node:assert/strict";
import fs from "node:fs";
import {
  bufferedAheadOf,
  bufferedSourceRanges,
  bufferingLabel,
  byteRangesToSourceRanges,
  canAutoAdvanceToUpNext,
  candidatePlayabilityLabel,
  candidateQualityShape,
  candidateVerdictLabel,
  encodeStreamFilePath,
  fileOptionLabel,
  findSidecarSubtitle,
  hlsBufferSettingsForSource,
  hlsSeekNeedsLoadRestart,
  hlsSeekShouldRestartLoader,
  timeRangesToRanges,
  infoHashFromMagnet,
  interpretMediaElementError,
  isUpNextPlayableEnoughToAdvance,
  loaderStatusFromSamples,
  planSourceFromPlan,
  mainFeatureFile,
  nextAutomaticCandidate,
  playbackFailureCopy,
  PlayerIdentity,
  PlayerQualityChoices,
  preferredResolutionRequestBody,
  structuredFailureFromBody,
  type StructuredPlaybackFailure,
  nextViewerWaitingState,
  nextSeekIntentAction,
  nextSeekRestartAction,
  seekPositionInPlannedTimeline,
  playerControlsForMode,
  qualitySelectorEmptyCopy,
  releaseDetailChips,
  resolveVideoFileSelection,
  selectMainFeatureFile,
  isTerminalPlayback,
  selectVideoFiles,
  shouldAdoptTimeUpdate,
  shouldShowFullscreenStatusOverlay,
  shouldShowSeekSpinner,
  shouldShowUnifiedLoader,
  shouldShowViewerBuffering,
  shouldPreserveOutgoingEpisode,
  subtitleStatusCopy,
  unsupportedSubtitleNote,
  terminalPlaybackCopy,
  streamPath,
  streamStatusMessage,
  sourceTimeInRanges,
  shouldSuppressPlanEcho,
  normalizeProbeBitrate,
  normalizeUpNextCard,
  type PlanAudioEcho,
  upNextUnavailableActionLabel,
  upNextFailureMessage,
  type OnDemandGrabResponse,
  upNextStatusSentence,
  type StreamFile,
  videoPlaybackQualitySnapshot,
} from "./inline-player";
import { peerText, rateText, swarmHealth, swarmSummary, deadEvidenceFromSamples } from "./swarm-chip";

const identityDom = renderToStaticMarkup(
  React.createElement(PlayerIdentity, {
    showTitle: "Solar Harbor",
    episodeTitle: "The Long Return",
    season: 1,
    episode: 2,
  }),
);
nodeAssert.equal((identityDom.match(/S01E02/g) ?? []).length, 1);
nodeAssert.match(identityDom, /Solar Harbor/);
nodeAssert.match(identityDom, /The Long Return/);
nodeAssert.doesNotMatch(
  identityDom,
  /torrent|provider|source|hash|WEB-DL|Tracker\.Name|Video \d/i,
);

const qualityDom = renderToStaticMarkup(
  React.createElement(PlayerQualityChoices, { onSelect: () => {} }),
);
nodeAssert.deepEqual(
  [...qualityDom.matchAll(/>(\d+p)</g)].map((match) => match[1]),
  ["480p", "720p", "1080p", "2160p"],
);
nodeAssert.doesNotMatch(
  qualityDom,
  /torrent|provider|source|hash|codec|audio|size|WEB-DL/i,
);

const resolutionBody = preferredResolutionRequestBody({
  title: "Solar Harbor",
  mediaType: "tv",
  season: 1,
  episode: 2,
  preferredResolution: 1080,
});
nodeAssert.equal(JSON.stringify(resolutionBody).includes("hash"), false);

let failures = 0;

function assert(name: string, cond: boolean, detail = "") {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const files: StreamFile[] = [
  { path: "Show/Season 01/Show S01E01.mkv", length: 1_500_000_000, index: 0 },
  { path: "Show/Season 01/Show S01E01.srt", length: 42_000, index: 1 },
  { path: "Show/Season 01/Show S01E02.mp4", length: 1_200_000_000, index: 2 },
  { path: "Show/Season 01/poster.jpg", length: 90_000, index: 3 },
  { path: "Extras\\Interview.webm", length: 300_000_000, index: 4 },
];

const inlineControls = playerControlsForMode("inline");
const theatreControls = playerControlsForMode("theatre");
const fullscreenControls = playerControlsForMode("fullscreen");
assert(
  "inline and theatre use the same player controls",
  JSON.stringify(inlineControls) === JSON.stringify(theatreControls),
  `${inlineControls.join(",")} !== ${theatreControls.join(",")}`,
);
assert(
  "fullscreen uses the same player controls instead of native overflow controls",
  JSON.stringify(inlineControls) === JSON.stringify(fullscreenControls) &&
    fullscreenControls.includes("skip-back") &&
    fullscreenControls.includes("skip-forward") &&
    fullscreenControls.includes("speed") &&
    fullscreenControls.includes("subtitles") &&
    fullscreenControls.includes("audio-settings"),
  fullscreenControls.join(","),
);
assert(
  "quality selector loading copy says it is checking cached releases",
  qualitySelectorEmptyCopy(true, 0) === "Checking cached releases…",
);
assert(
  "quality selector empty state is terminal and honest",
  qualitySelectorEmptyCopy(false, 0) === "No other cached releases yet.",
);
assert(
  "quality rows expose only consumer resolution labels",
  candidateQualityShape({
    infoHash: "a".repeat(40),
    title: "Tracker.Name.Show.S01E02.1080p.WEB-DL.x265-GROUP",
    resolution: 1080,
    sourceLabel: "WEB-DL",
    sizeBytes: 12_690_000_000,
    sizeLabel: "12.69 GB",
    codec: "HEVC",
    audio: "DDP5.1",
    playability: "direct",
    seeders: 42,
    isCurrent: false,
    verdict: "good",
  } as never) === "1080p",
);

const videos = selectVideoFiles(files);
assert("selects video files only", videos.length === 3, `${videos.length}`);
assert(
  "finds a same-basename sidecar subtitle",
  findSidecarSubtitle(files, "Show/Season 01/Show S01E01.mkv")?.path.endsWith(
    ".srt",
  ) === true,
);
assert(
  "does not attach unrelated subtitle files",
  findSidecarSubtitle(files, "Show/Season 01/Show S01E02.mp4") === undefined,
);
assert(
  "unsupported bitmap-only subtitles surface an honest theatre status",
  unsupportedSubtitleNote([
    {
      id: "embedded:2",
      kind: "embedded",
      label: "English · PGS — unsupported",
      language: "eng",
      codec: "hdmv_pgs_subtitle",
      supported: false,
      unsupportedReason:
        "image-based subtitles cannot be converted to WebVTT — play this release in VLC/MPV for it",
      streamIndex: 2,
      filePath: null,
      needsExtraction: true,
      forced: false,
      hearingImpaired: false,
      src: null,
    },
  ])?.includes("image-based subtitles") === true,
);
assert(
  "subtitle preparation failures remain visible after loading stops",
  subtitleStatusCopy(
    "error",
    "That subtitle track could not be prepared. Extraction or subtitle caching failed.",
  )?.includes("caching failed") === true,
);
assert(
  "auto-selects the requested episode from a realistic season pack",
  resolveVideoFileSelection(
    [
      { path: "Pack.Show.S01E01.1080p.WEB-DL.mp4", length: 100, index: 0 },
      { path: "Pack.Show.S01E03.1080p.WEB-DL.mp4", length: 100, index: 1 },
      { path: "Pack.Show.S01E04.1080p.WEB-DL.mp4", length: 100, index: 2 },
    ],
    { season: 1, episode: 3 },
  )?.path.includes("S01E03") === true,
);
const episodeVariants = [
  "Show s01e03 1080p.mp4",
  "Show S01.E03 1080p.mp4",
  "Show 1x03 1080p.mp4",
  "Show S1E3 1080p.mp4",
];
for (const variant of episodeVariants) {
  assert(
    `auto-selects episode variant ${variant}`,
    resolveVideoFileSelection(
      [
        { path: "Show S01E01 1080p.mp4", length: 100, index: 0 },
        { path: variant, length: 100, index: 1 },
      ],
      { season: 1, episode: 3 },
    )?.path === variant,
  );
}
assert(
  "does not guess a multi-file pack when the requested episode is unknown",
  resolveVideoFileSelection(
    [
      { path: "Show S01E01.mp4", length: 100, index: 0 },
      { path: "Show S01E03.mp4", length: 100, index: 1 },
    ],
    { season: null, episode: null },
  ) === null,
);
assert(
  "does not guess when more than one file matches the requested episode",
  resolveVideoFileSelection(
    [
      { path: "Show S01E03 1080p.mp4", length: 100, index: 0 },
      { path: "Show 1x03 alt.mp4", length: 100, index: 1 },
    ],
    { season: 1, episode: 3 },
  ) === null,
);
assert(
  "single-file torrents remain selectable without an episode hint",
  resolveVideoFileSelection(
    [{ path: "Movie 2026.mp4", length: 100, index: 0 }],
    { season: null, episode: null },
  )?.path === "Movie 2026.mp4",
);

assert(
  "encodes each stream path segment without flattening folders",
  encodeStreamFilePath("Show Name/Season 01/Ep 01 [1080p].mkv") ===
    "Show%20Name/Season%2001/Ep%2001%20%5B1080p%5D.mkv",
);
assert(
  "builds the frozen stream URL",
  streamPath("abcdef", "A/B C.mkv") === "/api/stream/abcdef/A/B%20C.mkv",
);

assert(
  "extracts a hex btih magnet",
  infoHashFromMagnet(
    "magnet:?xt=urn:btih:0123456789ABCDEF0123456789ABCDEF01234567&dn=x",
  ) === "0123456789abcdef0123456789abcdef01234567",
);
assert(
  "extracts a base32 btih magnet",
  infoHashFromMagnet("magnet:?xt=urn:btih:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA") ===
    "0000000000000000000000000000000000000000",
);

const statuses: [number, string][] = [
  [409, "built-in engine"],
  [425, "still resolving"],
  [503, "coming through"],
  [404, "download it first"],
  [416, "byte range"],
];
for (const [status, expected] of statuses) {
  assert(
    `maps ${status} to human text`,
    streamStatusMessage(status).message.includes(expected),
    streamStatusMessage(status).message,
  );
}

assert(
  "buffering label uses real transfer numbers",
  bufferingLabel({ totalBytes: 30 * 1024 ** 2, progress: 0.4, peers: 4 }) ===
    "buffering — 12 MB / 30 MB · 4 peers",
);
assert(
  "buffering label degrades when only peer data exists",
  bufferingLabel({ peers: 1 }) === "buffering — waiting for torrent pieces · 1 peer",
);
assert(
  "release details render parsed chips instead of the wrapper path",
  releaseDetailChips(
    "www.UIndex.org - Rick and Morty S01E02 Lawnmower Dog 1080p AMZN WEB-DL DDP5 1 H 264-Kitsune\\Rick and Morty S01E02 Lawnmower Dog 1080p AMZN WEB-DL DDP5.1 H.264-Kitsune.mkv",
    716 * 1024 ** 2,
  ).join(" · ") === "1080p · WEB-DL · 716 MB",
);
assert(
  "release chips never expose codec/container identity (mechanism)",
  !releaseDetailChips(
    "Movie 2019 1080p BluRay x265 HEVC DTS-HD MA 5.1.mkv",
    8_000 * 1024 ** 2,
  )
    .join(" ")
    .match(/H\.26|x26|HEVC|DTS|DDP|AC-?3|AAC|MKV|MP4/i),
);
assert(
  "release details do not expose the raw release path as a label",
  !releaseDetailChips(
    "www.UIndex.org - Rick and Morty S01E02 Lawnmower Dog 1080p WEB-DL.mkv",
    716 * 1024 ** 2,
  ).join(" ").includes("www.UIndex"),
);
assert(
  "file fallback labels never expose raw Video N choices",
  !fileOptionLabel(
    { path: "bonus-feature.mkv", length: 1_000_000, index: 9 },
    9,
  ).includes("Video 10"),
);
assert(
  "moving active video suppresses the buffering overlay after a waiting event",
  !shouldShowViewerBuffering({ waiting: true, activeVideoAdvancing: true }),
);
assert(
  "fullscreen status overlay stays hidden when the visible video is advancing",
  !shouldShowFullscreenStatusOverlay({
    hasVisibleVideo: true,
    viewerWaiting: false,
    preparing: true,
    activeVideoAdvancing: true,
    seeking: false,
  }),
);
assert(
  "fullscreen seek spinner stays hidden when the visible video is advancing",
  !shouldShowSeekSpinner({ seeking: true, activeVideoAdvancing: true }),
);
assert(
  "stalled active video can show the buffering overlay",
  shouldShowViewerBuffering({ waiting: true, activeVideoAdvancing: false }),
);
assert(
  "fullscreen status overlay still shows for a stalled visible video",
  shouldShowFullscreenStatusOverlay({
    hasVisibleVideo: true,
    viewerWaiting: true,
    preparing: false,
    activeVideoAdvancing: false,
    seeking: false,
  }),
);
assert(
  "a seek over a visible video does not stack the buffering overlay on the seek spinner",
  !shouldShowFullscreenStatusOverlay({
    hasVisibleVideo: true,
    viewerWaiting: true,
    preparing: false,
    activeVideoAdvancing: false,
    seeking: true,
  }),
);
assert(
  "a source still being prepared shows its status even during a seek",
  shouldShowFullscreenStatusOverlay({
    hasVisibleVideo: true,
    viewerWaiting: false,
    preparing: true,
    activeVideoAdvancing: false,
    seeking: true,
  }),
);
assert(
  "waiting from a non-active media element does not raise viewer waiting",
  !nextViewerWaitingState(false, "waiting", false),
);
assert(
  "playing from a non-active media element does not clear active viewer waiting",
  nextViewerWaitingState(true, "playing", false),
);
assert(
  "active media progress clears viewer waiting",
  !nextViewerWaitingState(true, "advancing", true),
);
assert(
  "a refused seek is retried instead of being silently discarded",
  nextSeekIntentAction({ targetSec: 600, actualSec: 76, attempts: 1, elapsedMs: 900 }) === "retry",
);
assert(
  "a seek that lands within tolerance is settled",
  nextSeekIntentAction({ targetSec: 600, actualSec: 599.2, attempts: 1, elapsedMs: 100 }) === "settled",
);
assert(
  "seek retries are bounded",
  nextSeekIntentAction({ targetSec: 600, actualSec: 76, attempts: 3, elapsedMs: 900 }) === "failed",
);
assert(
  "a first source seek with nothing in flight starts a plan",
  nextSeekRestartAction({ inFlight: false, inFlightTargetSec: null, requestedTargetSec: 600 }) === "start",
);
assert(
  "a second seek to a new target while a restart is in flight replans (latest wins, not dropped)",
  nextSeekRestartAction({ inFlight: true, inFlightTargetSec: 600, requestedTargetSec: 900 }) === "replan",
);
assert(
  "a repeat seek to the target already being planned is ignored, not thrashed",
  nextSeekRestartAction({ inFlight: true, inFlightTargetSec: 600, requestedTargetSec: 600.5 }) === "ignore",
);
assert(
  "an in-flight restart with an unknown target still replans toward the new seek",
  nextSeekRestartAction({ inFlight: true, inFlightTargetSec: null, requestedTargetSec: 900 }) === "replan",
);
assert(
  "a rebased VOD playlist preserves the exact out-of-window seek target",
  seekPositionInPlannedTimeline(605, 600) === 5,
);
assert(
  "an exact session start needs no second relative seek",
  seekPositionInPlannedTimeline(605, 605) === 0,
);
assert(
  "same-pack next keeps the outgoing media only when the exact next file is known",
  shouldPreserveOutgoingEpisode({
    transitioning: true,
    hasPlayableSource: true,
    exactNextFileKnown: true,
  }) === true &&
    shouldPreserveOutgoingEpisode({
      transitioning: true,
      hasPlayableSource: true,
      exactNextFileKnown: false,
    }) === false,
);
assert(
  "no in-flight seek is ever silently dropped: a busy restart to a new target replans",
  nextSeekRestartAction({ inFlight: true, inFlightTargetSec: 120, requestedTargetSec: 300 }) !== "ignore",
);
assert(
  "media network errors are recoverable delivery failures, not browser incompatibility",
  (() => {
    const verdict = interpretMediaElementError({ code: 2, message: "" });
    return (
      verdict.kind === "network" &&
      verdict.recoverable &&
      verdict.problem === null &&
      verdict.title !== "This release won't play in the browser."
    );
  })(),
);
assert(
  "media decode errors remain browser playback failures",
  (() => {
    const verdict = interpretMediaElementError({ code: 3, message: "" });
    return (
      verdict.kind === "decode" &&
      !verdict.recoverable &&
      verdict.problem === "browser-error" &&
      verdict.title === "This release won't play in the browser."
    );
  })(),
);
assert(
  "unsupported media errors remain browser playback failures",
  (() => {
    const verdict = interpretMediaElementError({ code: 4, message: "" });
    return (
      verdict.kind === "unsupported" &&
      !verdict.recoverable &&
      verdict.problem === "browser-error" &&
      verdict.title === "This release won't play in the browser."
    );

    const exhausted = playbackFailureCopy({
      code: "STALLED",
      failureClass: "delivery",
      retryable: false,
      candidatesExhausted: true,
    });
    assert(
      "automatic exhaustion offers Retry only",
      exhausted.affordance === "retry" &&
        `${exhausted.headline} ${exhausted.detail ?? ""}`.includes("Retry") &&
        !`${exhausted.headline} ${exhausted.detail ?? ""}`.match(/another version/i),
    );
  })(),
);
assert(
  "terminal playback detail is never the same sentence as the title",
  (() => {
    const copy = terminalPlaybackCopy({
      problem: "browser-error",
      message: "This release won't play in the browser.",
      deliveryDetail: "no peers, almost no data",
    });
    return Boolean(copy.title && copy.detail && copy.title !== copy.detail);
  })(),
);
assert(
  "terminal playback detail is omitted when it would only repeat the title",
  (() => {
    const copy = terminalPlaybackCopy({
      problem: null,
      message: "Playback cannot start yet.",
      deliveryDetail: "no peers, almost no data",
    });
    return copy.title === "Playback cannot start yet." && copy.detail === null;
  })(),
);
assert(
  "up-next status never calls an incomplete torrent ready",
  upNextStatusSentence("downloading") === "Still downloading — you can start now, but it may pause to catch up.",
);
// COMPLAINT 3 / Issue 1: terminality is EXPLICIT. A recovering problem or a
// bare diagnostic message must NOT be terminal — the single loader stays up
// while silent auto-failover works. Only an exhausted streamFailure or a hard
// "can't play here" problem is terminal.
assert(
  "recovering problem (stalled) is NOT terminal — loader stays up during auto-failover",
  isTerminalPlayback({ problem: "stalled", hasStreamFailure: false }) === false,
);
assert(
  "recovering problem (preparing) is NOT terminal — loader stays up",
  isTerminalPlayback({ problem: "preparing", hasStreamFailure: false }) === false,
);
assert(
  "recovering problem (metadata) is NOT terminal — metadata resolving keeps the loader up while it re-attempts",
  isTerminalPlayback({ problem: "metadata", hasStreamFailure: false }) === false,
);
assert(
  "metadata that exhausts its retry budget IS terminal once escalated to a streamFailure",
  isTerminalPlayback({ problem: "metadata", hasStreamFailure: true }) === true,
);
assert(
  "no problem and no failure is NOT terminal — a bare reconnect/seek note keeps the loader",
  isTerminalPlayback({ problem: null, hasStreamFailure: false }) === false,
);
assert(
  "an exhausted streamFailure IS terminal even while the problem still reads as recovering",
  isTerminalPlayback({ problem: "stalled", hasStreamFailure: true }) === true,
);
assert(
  "a hard browser-error problem IS terminal",
  isTerminalPlayback({ problem: "browser-error", hasStreamFailure: false }) === true,
);
assert(
  "a no-audio problem IS terminal",
  isTerminalPlayback({ problem: "no-audio", hasStreamFailure: false }) === true,
);
assert(
  "a generic problem IS terminal",
  isTerminalPlayback({ problem: "generic", hasStreamFailure: false }) === true,
);
assert(
  "the up-next action label is a verb, not a status masquerading as a button",
  // It sits on a control that fetches and plays. "Not fetched yet" described
  // the state and offered nothing, which is half of why pressing it read as
  // broken. A label that names no action is the bug, whatever the wording.
  /^(fetch|play|get|load|start|watch)/i.test(upNextUnavailableActionLabel()) &&
    upNextUnavailableActionLabel() !== "Not fetched yet",
  upNextUnavailableActionLabel(),
);
{
  // A failed next-episode grab must always say something, and must prefer the
  // server's own explanation over any wording invented here.
  const cases: Array<{ name: string; body: OnDemandGrabResponse | null }> = [
    { name: "a null response", body: null },
    { name: "an empty object", body: {} },
    { name: "ok:false with no message", body: { ok: false } },
    { name: "a blank message", body: { ok: false, message: "   " } },
    { name: "a null message", body: { ok: false, message: null } },
  ];
  for (const c of cases) {
    const msg = upNextFailureMessage(c.body);
    assert(
      `next-episode failure explains itself for ${c.name}`,
      msg.trim().length > 0 && !/undefined|null|NaN|\[object/i.test(msg),
      msg,
    );
  }
  assert(
    "the server's own reason wins over the fallback",
    upNextFailureMessage({ ok: false, message: "No seeded release for S02E05" }) ===
      "No seeded release for S02E05",
  );
}
assert("quality selector calls good swarms fast", candidateVerdictLabel("good") === "Fast");
assert("quality selector keeps unknown offerable", candidateVerdictLabel("unknown") === "Untested");
assert(
  "quality selector never narrates the transcode mechanism",
  candidatePlayabilityLabel("transcode") === "Plays" &&
    !/convert|remux|transcod/i.test(candidatePlayabilityLabel("transcode")),
);
assert(
  "quality selector shows only the preferred resolution",
  candidateQualityShape({
    infoHash: "b".repeat(40),
    title: "Show S01E01 1080p WEB-DL DDP5.1 H.264.mkv",
    resolution: 1080,
    sourceLabel: "WEB-DL",
    codec: "H.264",
    audio: "DDP",
    sizeBytes: 807 * 1024 ** 2,
    sizeLabel: "807 MB",
    seeders: 4,
    verdict: "unknown",
    playability: "direct",
    isCurrent: false,
  }) === "1080p",
);
assert(
  "up-next autoplay starts for a ready next release",
  canAutoAdvanceToUpNext(
    {
      title: "the bear",
      label: "S01E02",
      season: 1,
      episode: 2,
      availability: "ready",
      infoHash: "a".repeat(40),
      progress: 1,
    },
    false,
  ),
);
assert(
  "up-next autoplay starts for a still-downloading next release",
  canAutoAdvanceToUpNext(
    {
      title: "the bear",
      label: "S01E02",
      season: 1,
      episode: 2,
      availability: "downloading",
      infoHash: "a".repeat(40),
      progress: 0.4,
    },
    false,
  ),
);
assert("up-next advance playability accepts ready", isUpNextPlayableEnoughToAdvance("ready"));
assert("up-next advance playability accepts downloading", isUpNextPlayableEnoughToAdvance("downloading"));
assert("up-next advance playability rejects not-fetched", !isUpNextPlayableEnoughToAdvance("not-fetched"));
assert("up-next advance playability rejects null", !isUpNextPlayableEnoughToAdvance(null));
assert("up-next advance playability rejects undefined", !isUpNextPlayableEnoughToAdvance(undefined));
assert(
  "up-next autoplay requires an info hash even when downloading",
  !canAutoAdvanceToUpNext(
    {
      title: "the bear",
      label: "S01E02",
      season: 1,
      episode: 2,
      availability: "downloading",
      infoHash: null,
      progress: 0.4,
    },
    false,
  ),
);
assert(
  "up-next autoplay rejects not-fetched next releases",
  !canAutoAdvanceToUpNext(
    {
      title: "the bear",
      label: "S01E02",
      season: 1,
      episode: 2,
      availability: "not-fetched",
      infoHash: "a".repeat(40),
      progress: 0,
    },
    false,
  ),
);
assert(
  "up-next autoplay respects cancellation",
  !canAutoAdvanceToUpNext(
    {
      title: "the bear",
      label: "S01E02",
      season: 1,
      episode: 2,
      availability: "ready",
      infoHash: "a".repeat(40),
      progress: 1,
    },
    true,
  ),
);

// ── Buffered band ──
//
// The band is only honest if it is drawn in the coordinate space the viewer is
// looking at. In HLS mode the media element's timeline restarts at 0 for every
// ffmpeg session, so a band drawn from raw `video.buffered` would sit at the
// far left of the bar while the viewer watches at 1:50 — a confident lie about
// what is safe to watch. These cases pin the mapping.

/** Minimal stand-in for the DOM's TimeRanges. */
function timeRanges(pairs: Array<[number, number]>): TimeRanges {
  return {
    length: pairs.length,
    start: (i: number) => pairs[i][0],
    end: (i: number) => pairs[i][1],
  } as TimeRanges;
}

assert(
  "buffered ranges are offset into the source timeline",
  JSON.stringify(bufferedSourceRanges(timeRanges([[0, 12]]), 90, 150)) ===
    JSON.stringify([{ start: 90, end: 102 }]),
  JSON.stringify(bufferedSourceRanges(timeRanges([[0, 12]]), 90, 150)),
);
assert(
  "a session that starts at 0 needs no offset",
  bufferedSourceRanges(timeRanges([[0, 8]]), 0, 150)[0].end === 8,
);
assert(
  "several ranges all move together",
  bufferedSourceRanges(timeRanges([[0, 4], [10, 20]]), 30, 150).length === 2 &&
    bufferedSourceRanges(timeRanges([[0, 4], [10, 20]]), 30, 150)[1].start === 40,
);
assert(
  "ranges are clamped to the source duration, never drawn past the bar",
  bufferedSourceRanges(timeRanges([[0, 400]]), 100, 150)[0].end === 150,
);
assert(
  "nothing is claimed when the duration is unknown",
  bufferedSourceRanges(timeRanges([[0, 10]]), 0, null).length === 0,
);
assert(
  "nothing is claimed when there is no buffer",
  bufferedSourceRanges(timeRanges([]), 0, 150).length === 0 &&
    bufferedSourceRanges(null, 0, 150).length === 0,
);
assert(
  "an infinite range is dropped rather than painted",
  bufferedSourceRanges(timeRanges([[0, Number.POSITIVE_INFINITY]]), 0, 150).length === 0,
);
assert(
  "a zero-width range is dropped",
  bufferedSourceRanges(timeRanges([[5, 5]]), 0, 150).length === 0,
);

assert(
  "buffer ahead is measured from the playhead inside its own range",
  bufferedAheadOf([{ start: 90, end: 102 }], 95) === 7,
);
assert(
  "a range the playhead is not inside buys nothing",
  bufferedAheadOf([{ start: 120, end: 140 }], 95) === 0,
);
assert(
  "with no buffer there is nothing ahead",
  bufferedAheadOf([], 95) === 0,
);

// ── Downloaded torrent spans ──
//
// These are not the same as media buffer. They come from verified torrent
// pieces, so sparse seeking must render sparse islands instead of a single
// confident full-width track.
assert(
  "downloaded byte islands map onto the source timeline",
  JSON.stringify(
    byteRangesToSourceRanges(
      [
        { start: 0, end: 250 },
        { start: 500, end: 750 },
      ],
      1000,
      100,
    ),
  ) === JSON.stringify([
    { start: 0, end: 25 },
    { start: 50, end: 75 },
  ]),
);
assert(
  "adjacent downloaded byte ranges merge before rendering",
  JSON.stringify(
    byteRangesToSourceRanges(
      [
        { start: 0, end: 250 },
        { start: 250, end: 500 },
      ],
      1000,
      100,
    ),
  ) === JSON.stringify([{ start: 0, end: 50 }]),
);
assert(
  "downloaded mapping makes no claim without duration",
  byteRangesToSourceRanges([{ start: 0, end: 250 }], 1000, null).length === 0,
);
assert(
  "a seek target distinguishes held pieces from gaps",
  sourceTimeInRanges([{ start: 50, end: 75 }], 60) &&
    !sourceTimeInRanges([{ start: 50, end: 75 }], 80),
);

// ── Swarm health ──
//
// The chip must never invent a healthy state. "No data" and "no peers" are
// different answers and the viewer needs to be able to tell them apart.

assert("no sample at all is unknown, not zero", swarmHealth(null) === "unknown");
assert(
  "null peers and null rate is unknown",
  swarmHealth({ peers: null, downloadSpeedBps: null, progress: null, observedAt: 0 }) ===
    "unknown",
);
assert(
  "zero peers is stalled",
  swarmHealth({ peers: 0, downloadSpeedBps: 0, progress: 0, observedAt: 0 }) === "stalled",
);
assert(
  "peers with no bytes yet is thin, not stalled",
  swarmHealth({ peers: 3, downloadSpeedBps: 0, progress: 0, observedAt: 0 }) === "thin",
);
assert(
  "peers and bytes is live",
  swarmHealth({ peers: 3, downloadSpeedBps: 250_000, progress: 0.2, observedAt: 0 }) ===
    "live",
);
assert(
  "a rate below the file bitrate is thin, not green",
  swarmHealth(
    { peers: 4, downloadSpeedBps: 1_200, progress: 0.1, observedAt: 0 },
    500_000,
  ) === "thin",
);
assert(
  "a rate that can sustain the file is live",
  swarmHealth(
    { peers: 4, downloadSpeedBps: 700_000, progress: 0.1, observedAt: 0 },
    500_000,
  ) === "live",
);
assert(
  "a finished torrent is live even with no peers and no rate — it plays off disk",
  swarmHealth({ peers: 0, downloadSpeedBps: 0, progress: 1, observedAt: 0 }) === "live",
);
assert(
  "a finished torrent still says so when the peer count is unknown",
  swarmHealth({ peers: null, downloadSpeedBps: 0, progress: 1, observedAt: 0 }) === "live",
);
assert(
  "completion does not paper over a total absence of data",
  swarmHealth({ peers: null, downloadSpeedBps: null, progress: 1, observedAt: 0 }) ===
    "unknown",
);
assert(
  "a finished torrent's summary says it is playing from disk",
  /disk/i.test(swarmSummary({ peers: 0, downloadSpeedBps: 0, progress: 1, observedAt: 0 })),
  swarmSummary({ peers: 0, downloadSpeedBps: 0, progress: 1, observedAt: 0 }),
);
assert(
  "an unknown peer count says so instead of showing 0",
  peerText(null) === "peers unknown" && peerText(0) === "0 peers" && peerText(1) === "1 peer",
  `${peerText(null)} / ${peerText(0)} / ${peerText(1)}`,
);
assert(
  "an unknown rate says so instead of showing 0 B/s",
  rateText(null) === "rate unknown" && rateText(0).startsWith("0"),
  `${rateText(null)} / ${rateText(0)}`,
);
assert(
  "the spoken summary never claims seeders",
  !/seed/i.test(
    swarmSummary({ peers: 4, downloadSpeedBps: 100, progress: 0.1, observedAt: 0 }),
  ),
  swarmSummary({ peers: 4, downloadSpeedBps: 100, progress: 0.1, observedAt: 0 }),
);
assert(
  "the spoken summary admits ignorance",
  /unknown/i.test(swarmSummary(null)),
  swarmSummary(null),
);

// --- BUG-003: the one loader says what kind of wait this is -----------------
{
  const startupSample = (
    peers: number | null,
    speed: number | null,
    progress: number | null,
  ) => ({ peers, downloadSpeedBps: speed, progress, observedAt: Date.now() });
  assert(
    "loader status says it is finding peers before the swarm is reached",
    loaderStatusFromSamples({ sample: startupSample(0, 0, 0), elapsedSec: 2 }) ===
      "Finding peers…",
  );
  assert(
    "loader status says it is connecting when peers exist but no bytes have arrived",
    loaderStatusFromSamples({ sample: startupSample(3, 0, 0), elapsedSec: 5 }) ===
      "Connecting…",
  );
  assert(
    "loader status says buffering once bytes are arriving",
    loaderStatusFromSamples({ sample: startupSample(3, 42_000, 0), elapsedSec: 5 }) ===
      "Buffering…",
  );
  assert(
    "loader status admits a long no-progress wait",
    loaderStatusFromSamples({ sample: startupSample(0, 0, 0), elapsedSec: 15 }) ===
      "Still working…",
  );
  assert(
    "specific preparation copy wins over generic sample copy",
    loaderStatusFromSamples({
      preparingLabel: "Opening stream",
      sample: startupSample(0, 0, 0),
      elapsedSec: 2,
    }) === "Opening stream…",
  );
}

// --- BUG: seeking a fully-downloaded episode inside a still-partial season
// pack must never replan as "session" and show peer/swarm language -----------
{
  const startupSample = (
    peers: number | null,
    speed: number | null,
    progress: number | null,
  ) => ({ peers, downloadSpeedBps: speed, progress, observedAt: Date.now() });

  // Once the fresh plan has come back proving this file is served from the
  // whole-file (or on-demand vod-segments) strategy, the swarm sample must be
  // ignored entirely — even one still showing live peer/download activity
  // from the REST of the season pack downloading in the background.
  const busySwarmSample = startupSample(6, 250_000, 0.4);
  for (const strategy of ["whole-file", "vod-segments"] as const) {
    const status = loaderStatusFromSamples({
      preparingLabel: "preparing",
      sample: busySwarmSample,
      elapsedSec: 3,
      strategy,
      playbackEstablished: true,
    });
    assert(
      `established seek proven local (${strategy}) shows a neutral seek status, not peer copy`,
      status === "Seeking…",
      status,
    );
    assert(
      `established seek proven local (${strategy}) never mentions peers/connecting/finding`,
      !/peer|connecting|finding/i.test(status),
      status,
    );
  }

  // A cold open (never played before) of an already-local file must not show
  // peer language either — there is no established playback yet, so the copy
  // is the neutral "Preparing…", still never swarm-derived.
  {
    const status = loaderStatusFromSamples({
      preparingLabel: "preparing",
      sample: busySwarmSample,
      elapsedSec: 3,
      strategy: "whole-file",
      playbackEstablished: false,
    });
    assert(
      "a cold open already proven local shows neutral preparing copy, not peer copy",
      status === "Preparing…",
      status,
    );
  }

  {
    const status = loaderStatusFromSamples({
      preparingLabel: "preparing",
      sample: startupSample(0, 0, 0),
      elapsedSec: 2,
      strategy: null,
      playbackEstablished: false,
    });
    assert(
      "an unresolved plan stays neutral even when a stale zero-progress swarm sample exists",
      status === "Preparing…",
      status,
    );
  }

  // While the seek's fresh plan is still in flight (strategy not yet known),
  // an ALREADY-established playback assumes the local continuation the vast
  // majority of seeks are, rather than flashing stale peer/swarm text left
  // over from the sample of a moment ago.
  {
    const status = loaderStatusFromSamples({
      preparingLabel: "preparing",
      sample: busySwarmSample,
      elapsedSec: 3,
      strategy: null,
      playbackEstablished: true,
    });
    assert(
      "an in-flight replan for an already-established playback stays neutral until the new strategy lands",
      status === "Seeking…",
      status,
    );
  }

  // Aggregate torrent peers do not prove this selected file needs the swarm:
  // another episode in the same season pack may still be downloading. Stay
  // neutral until the plan explicitly confirms the session strategy.
  {
    const status = loaderStatusFromSamples({
      preparingLabel: "preparing",
      sample: startupSample(3, 0, 0),
      elapsedSec: 3,
      strategy: null,
      playbackEstablished: false,
    });
    assert(
      "an unresolved cold open does not infer peer dependency from aggregate torrent peers",
      status === "Preparing…",
      status,
    );
  }

  // A genuinely incomplete file — the server confirms `session` even for an
  // established seek — must still show real swarm language, because the seek
  // truly does depend on the swarm fetching new pieces.
  {
    const status = loaderStatusFromSamples({
      preparingLabel: "preparing",
      sample: startupSample(0, 0, 0),
      elapsedSec: 3,
      strategy: "session",
      playbackEstablished: true,
    });
    assert(
      "a genuinely incomplete file (strategy: session) keeps peer/swarm language even mid-playback",
      status === "Finding peers…",
      status,
    );
  }
}

// --- BUG: post-seek jitter investigation needs a smoothness signal ---------
// `videoPlaybackQualitySnapshot` is diagnostic-only instrumentation added
// alongside the per-file completeness fix so a smoothness check can diff
// dropped/total video frame counts across a seek → strategy-switch instead of
// eyeballing a recording. It must never throw and must degrade to an
// all-zero snapshot for elements/environments (like jsdom in unit tests, or
// older browsers) that lack `getVideoPlaybackQuality`.
{
  const missing = videoPlaybackQualitySnapshot(null);
  assert(
    "a null video yields an all-zero snapshot rather than throwing",
    missing.droppedVideoFrames === 0 && missing.totalVideoFrames === 0 && missing.corruptedVideoFrames === 0,
    JSON.stringify(missing),
  );

  const withoutApi = videoPlaybackQualitySnapshot({} as unknown as Pick<HTMLVideoElement, "getVideoPlaybackQuality">);
  assert(
    "an element without getVideoPlaybackQuality yields an all-zero snapshot",
    withoutApi.droppedVideoFrames === 0 && withoutApi.totalVideoFrames === 0,
    JSON.stringify(withoutApi),
  );

  const healthy = videoPlaybackQualitySnapshot({
    getVideoPlaybackQuality: () => ({
      droppedVideoFrames: 3,
      totalVideoFrames: 900,
      corruptedVideoFrames: 0,
      creationTime: 0,
    }),
  } as unknown as Pick<HTMLVideoElement, "getVideoPlaybackQuality">);
  assert(
    "real dropped/total frame counts pass through unchanged",
    healthy.droppedVideoFrames === 3 && healthy.totalVideoFrames === 900,
    JSON.stringify(healthy),
  );

  const throwing = videoPlaybackQualitySnapshot({
    getVideoPlaybackQuality: () => {
      throw new Error("no MSE handle");
    },
  } as unknown as Pick<HTMLVideoElement, "getVideoPlaybackQuality">);
  assert(
    "a throwing implementation degrades to an all-zero snapshot instead of crashing the caller",
    throwing.droppedVideoFrames === 0 && throwing.totalVideoFrames === 0,
    JSON.stringify(throwing),
  );

  // A real-world smoothness check: after a seek that switched strategy to
  // whole-file/vod-segments, a jittery playback would show a growing dropped-
  // frame count between two samples taken a few seconds apart. This proves
  // the two snapshots are independently comparable so that comparison is
  // possible without this module making the smoothness judgment itself.
  let calls = 0;
  const drifting = {
    getVideoPlaybackQuality: () => {
      calls += 1;
      return { droppedVideoFrames: calls === 1 ? 2 : 40, totalVideoFrames: calls === 1 ? 100 : 260, corruptedVideoFrames: 0, creationTime: 0 };
    },
  } as unknown as Pick<HTMLVideoElement, "getVideoPlaybackQuality">;
  const before = videoPlaybackQualitySnapshot(drifting);
  const after = videoPlaybackQualitySnapshot(drifting);
  assert(
    "two snapshots across time can be diffed to reveal a frame-drop spike",
    after.droppedVideoFrames - before.droppedVideoFrames === 38,
    JSON.stringify({ before, after }),
  );
}

// --- I11: exactly one loader — spatially (union) AND temporally (continuous) -
{
  const base = {
    hasVisibleVideo: true,
    activeVideoAdvancing: false,
    seeking: false,
    waiting: false,
    preparing: false,
    checking: false,
    switching: false,
    terminal: false,
    // Post-first-frame is the default for the union cases below; the temporal
    // cases flip this to false to model the prepare→first-frame window.
    playbackStarted: true,
  };
  const cases: Array<{ name: string; args: typeof base; expect: boolean }> = [
    { name: "idle over a visible video shows no loader", args: { ...base }, expect: false },
    { name: "seeking a stalled video shows the one loader", args: { ...base, seeking: true }, expect: true },
    { name: "waiting shows the one loader", args: { ...base, waiting: true }, expect: true },
    { name: "preparing shows the one loader", args: { ...base, preparing: true }, expect: true },
    { name: "checking shows the one loader", args: { ...base, checking: true }, expect: true },
    { name: "no source yet always shows the loader", args: { ...base, hasVisibleVideo: false, playbackStarted: false }, expect: true },
    {
      name: "an advancing picture never gets a loader (motion lease)",
      args: { ...base, activeVideoAdvancing: true, waiting: true, seeking: true, preparing: true },
      expect: false,
    },
    {
      name: "a terminal error owns the surface instead of a loader",
      args: { ...base, terminal: true, waiting: true, seeking: true, preparing: true },
      expect: false,
    },
    {
      name: "seek-while-preparing is still one loader, not two",
      args: { ...base, seeking: true, preparing: true },
      expect: true,
    },
    // Temporal continuity — the cold-start "3 loaders in a row" bug. Every phase
    // between Play-press and the first painted frame must resolve to the SAME
    // true, so the one loader is held on without a single blink.
    {
      name: "TEMPORAL: <video> mounted but first frame not yet painted keeps the one loader (gap closed)",
      args: { ...base, hasVisibleVideo: true, playbackStarted: false },
      expect: true,
    },
    {
      name: "TEMPORAL: no transient flag set yet but not-started still shows the loader (no blink between phases)",
      args: { ...base, hasVisibleVideo: true, playbackStarted: false, waiting: false, seeking: false, preparing: false, checking: false },
      expect: true,
    },
    {
      name: "TEMPORAL: pre-first-frame buffering is the same loader, not a second one",
      args: { ...base, playbackStarted: false, waiting: true },
      expect: true,
    },
    {
      name: "TEMPORAL: the loader flips off exactly once — an idle video after the first frame drops it",
      args: { ...base, playbackStarted: true },
      expect: false,
    },
    {
      name: "TEMPORAL: the first advancing frame drops the loader even before playbackStarted propagates",
      args: { ...base, playbackStarted: false, activeVideoAdvancing: true },
      expect: false,
    },
    {
      name: "SWITCH: an explicit release switch owns the loader even over an advancing outgoing frame",
      args: { ...base, switching: true, activeVideoAdvancing: true, playbackStarted: true },
      expect: true,
    },
    {
      name: "SWITCH: a terminal error still wins over an in-flight switch",
      args: { ...base, switching: true, terminal: true },
      expect: false,
    },
    {
      name: "POST-FIRST-FRAME: a mid-play stall shows the one loader again (transient)",
      args: { ...base, playbackStarted: true, waiting: true },
      expect: true,
    },
  ];
  for (const c of cases) {
    assert(`unified loader — ${c.name}`, shouldShowUnifiedLoader(c.args) === c.expect, String(shouldShowUnifiedLoader(c.args)));
  }
}

// --- SEEK: freeze the displayed playhead until the real position lands -------
assert(
  "timeupdate is adopted when nothing is in flight",
  shouldAdoptTimeUpdate({ seekInFlight: false, hasPendingUserSeek: false }) === true,
);
assert(
  "timeupdate is frozen while a user seek is pending (kills the bounce)",
  shouldAdoptTimeUpdate({ seekInFlight: false, hasPendingUserSeek: true }) === false,
);
assert(
  "timeupdate is frozen during an HLS session restart",
  shouldAdoptTimeUpdate({ seekInFlight: true, hasPendingUserSeek: false }) === false,
);
assert(
  "timeupdate stays frozen when both are true",
  shouldAdoptTimeUpdate({ seekInFlight: true, hasPendingUserSeek: true }) === false,
);
assert(
  "timeupdate is frozen while the viewer is actively scrubbing (no thumb yank mid-drag)",
  shouldAdoptTimeUpdate({ seekInFlight: false, hasPendingUserSeek: false, isUserScrubbing: true }) === false,
);
assert(
  "timeupdate resumes the instant scrubbing ends and nothing else is pending",
  shouldAdoptTimeUpdate({ seekInFlight: false, hasPendingUserSeek: false, isUserScrubbing: false }) === true,
);

// --- I20: a movie must not be treated as a season pack ----------------------
assert(
  "a lone feature is auto-selected",
  selectMainFeatureFile([{ path: "The Last Jedi 2017 1080p.mkv", length: 8_000_000_000, index: 0 }])?.index === 0,
);
assert(
  "a dominant feature wins over sample/extra junk",
  selectMainFeatureFile([
    { path: "sample.mkv", length: 60_000_000, index: 0 },
    { path: "The Last Jedi 2017 1080p.mkv", length: 8_000_000_000, index: 1 },
    { path: "featurette.mp4", length: 300_000_000, index: 2 },
  ])?.index === 1,
);
assert(
  "a genuine multi-film pack (comparable sizes) returns null",
  selectMainFeatureFile([
    { path: "Film A.mkv", length: 4_000_000_000, index: 0 },
    { path: "Film B.mkv", length: 4_100_000_000, index: 1 },
  ]) === null,
);
assert(
  "no video files means nothing to auto-select",
  selectMainFeatureFile([{ path: "readme.txt", length: 1_000, index: 0 }]) === null,
);

// --- file picker labels never leak the raw release path ---------------------
assert(
  "an episode file reads as SxxEyy plus size, never its path",
  fileOptionLabel({ path: "www.Tracker.org/Show S02E05 1080p WEB-DL.mkv", length: 1_200 * 1024 ** 2, index: 0 }, 0) ===
    "S02E05 · 1.2 GB",
);
assert(
  "a non-episode file uses a generic label, never its path or raw index",
  (() => {
    const label = fileOptionLabel({ path: "Some.Movie.2019.1080p.BluRay.x265.mkv", length: 5_000 * 1024 ** 2, index: 3 }, 3);
    return label.startsWith("Video ·") && !/Video 4|BluRay|x265|\.mkv|Some\.Movie/i.test(label);
  })(),
);

// --- I20 upgrade: authoritative primaryVideoIndex drives auto-select ---------
const packWithTwoFeatures: StreamFile[] = [
  { path: "Movie 1080p.mkv", length: 8_000_000_000, index: 0 },
  { path: "Movie 2160p.mkv", length: 20_000_000_000, index: 2 },
  { path: "sample.mkv", length: 60_000_000, index: 4 },
];
assert(
  "the authoritative primaryVideoIndex is honored over the natural-largest heuristic",
  mainFeatureFile(packWithTwoFeatures, 0)?.index === 0,
);
assert(
  "a different authoritative index selects that exact video file",
  mainFeatureFile(packWithTwoFeatures, 2)?.index === 2,
);
assert(
  "a null primaryVideoIndex falls back to the local main-feature heuristic",
  mainFeatureFile(
    [{ path: "The Last Jedi 2017 1080p.mkv", length: 8_000_000_000, index: 0 }],
    null,
  )?.index === 0,
);
assert(
  "an out-of-range primaryVideoIndex falls back to the heuristic rather than picking nothing",
  mainFeatureFile(
    [{ path: "The Last Jedi 2017 1080p.mkv", length: 8_000_000_000, index: 0 }],
    99,
  )?.index === 0,
);
assert(
  "a primaryVideoIndex that points at a non-video file is ignored and the heuristic wins",
  mainFeatureFile(
    [
      { path: "poster.jpg", length: 90_000, index: 0 },
      { path: "The Last Jedi 2017 1080p.mkv", length: 8_000_000_000, index: 1 },
    ],
    0,
  )?.index === 1,
);
assert(
  "a genuine multi-film pack with no authoritative index still returns null (keeps file-select)",
  mainFeatureFile(
    [
      { path: "Film A.mkv", length: 4_000_000_000, index: 0 },
      { path: "Film B.mkv", length: 4_100_000_000, index: 1 },
    ],
    undefined,
  ) === null,
);

// --- I19: structured failure copy is friendly, actionable and mechanism-free -
const MECHANISM = /peer|kbps|\bbyte|%|transcod|remux|\bcodec\b|container|h\.?264|x26[45]|\.mkv|\.mp4|magnet|infohash|torrent|\bpeers?\b|seeder|swarm/i;
const failureCases: Array<{
  failure: StructuredPlaybackFailure;
  affordance: "retry";
}> = [
  { failure: { code: "NO_PEERS", failureClass: "delivery", retryable: true }, affordance: "retry" },
  { failure: { code: "CONNECTION_BLOCKED", failureClass: "delivery", retryable: true }, affordance: "retry" },
  { failure: { code: "STALLED", failureClass: "delivery", retryable: true }, affordance: "retry" },
  { failure: { code: "UNPLAYABLE", failureClass: "playability", retryable: false }, affordance: "retry" },
  { failure: { code: "NOT_FOUND", failureClass: "not-found", retryable: false }, affordance: "retry" },
  { failure: { code: "ENGINE_ERROR", failureClass: "engine", retryable: false }, affordance: "retry" },
  { failure: { code: "ENGINE_ERROR", failureClass: "playability", retryable: false }, affordance: "retry" },
];
for (const { failure, affordance } of failureCases) {
  const copy = playbackFailureCopy(failure);
  assert(
    `${failure.code}/${failure.failureClass} → non-empty headline`,
    typeof copy.headline === "string" && copy.headline.trim().length > 0,
    copy.headline,
  );
  assert(
    `${failure.code}/${failure.failureClass} → headline+detail carry no mechanism words`,
    !MECHANISM.test(copy.headline) && !MECHANISM.test(copy.detail ?? ""),
    `${copy.headline} / ${copy.detail ?? ""}`,
  );
  assert(
    `${failure.code}/${failure.failureClass} → offers the ${affordance} affordance`,
    copy.affordance === affordance,
    copy.affordance,
  );
}
assert(
  "a retryable delivery failure never offers a version switch",
  playbackFailureCopy({ code: "STALLED", failureClass: "delivery", retryable: true }).affordance === "retry",
);
assert(
  "an unplayable release restarts automatic selection through Retry",
  playbackFailureCopy({ code: "UNPLAYABLE", failureClass: "playability", retryable: false }).affordance === "retry",
);

// --- I19: reading a structured failure off a 503 body ------------------------
assert(
  "a well-formed 503 body parses into a structured failure",
  (() => {
    const parsed = structuredFailureFromBody({ code: "NO_PEERS", failureClass: "delivery", retryable: true });
    return parsed?.code === "NO_PEERS" && parsed.failureClass === "delivery" && parsed.retryable === true;
  })(),
);
assert(
  "an unknown code yields no structured failure (nothing to narrate)",
  structuredFailureFromBody({ code: "WAT", failureClass: "delivery", retryable: true }) === null,
);
assert(
  "a missing body yields no structured failure",
  structuredFailureFromBody(null) === null && structuredFailureFromBody(undefined) === null,
);
assert(
  "a body without failureClass defaults to delivery and non-retryable is honored",
  (() => {
    const parsed = structuredFailureFromBody({ code: "ENGINE_ERROR" });
    return parsed?.code === "ENGINE_ERROR" && parsed.failureClass === "delivery" && parsed.retryable === false;
  })(),
);

// --- Task 1: deadEvidenceFromSamples — mirrors classifySwarm dead-swarm rule -

// Helper: build a SwarmSample with all fields measured.
function deadSample(peers = 1, speed = 0, progress = 0) {
  return { peers, downloadSpeedBps: speed, progress, observedAt: Date.now() };
}

assert(
  "deadEvidenceFromSamples: 2 dead samples → true",
  deadEvidenceFromSamples([deadSample(), deadSample()]),
);
assert(
  "deadEvidenceFromSamples: 1 sample only → false (not enough evidence)",
  !deadEvidenceFromSamples([deadSample()]),
);
assert(
  "deadEvidenceFromSamples: 0 samples → false",
  !deadEvidenceFromSamples([]),
);
assert(
  "deadEvidenceFromSamples: unknown peers (null) → false (unknown ≠ dead)",
  !deadEvidenceFromSamples([
    { peers: null, downloadSpeedBps: 0, progress: 0, observedAt: Date.now() },
    { peers: null, downloadSpeedBps: 0, progress: 0, observedAt: Date.now() },
  ]),
);
assert(
  "deadEvidenceFromSamples: 0 peers → false (no peers means swarm not reached, not dead)",
  !deadEvidenceFromSamples([deadSample(0), deadSample(0)]),
);
assert(
  "deadEvidenceFromSamples: speed > 0 → false (bytes flowing, not dead)",
  !deadEvidenceFromSamples([deadSample(2, 50000), deadSample(2, 50000)]),
);
assert(
  "deadEvidenceFromSamples: progress > 0 → false (data arrived earlier)",
  !deadEvidenceFromSamples([deadSample(1, 0, 0.05), deadSample(1, 0, 0.05)]),
);
assert(
  "deadEvidenceFromSamples: null downloadSpeedBps → false (unmeasured)",
  !deadEvidenceFromSamples([
    { peers: 1, downloadSpeedBps: null, progress: 0, observedAt: Date.now() },
    { peers: 1, downloadSpeedBps: null, progress: 0, observedAt: Date.now() },
  ]),
);
assert(
  "deadEvidenceFromSamples: null progress → false (unmeasured)",
  !deadEvidenceFromSamples([
    { peers: 1, downloadSpeedBps: 0, progress: null, observedAt: Date.now() },
    { peers: 1, downloadSpeedBps: 0, progress: null, observedAt: Date.now() },
  ]),
);
assert(
  "deadEvidenceFromSamples: custom minSamples=3, only 2 dead → false",
  !deadEvidenceFromSamples([deadSample(), deadSample()], 3),
);
assert(
  "deadEvidenceFromSamples: custom minSamples=3, 3 dead → true",
  deadEvidenceFromSamples([deadSample(), deadSample(), deadSample()], 3),
);
assert(
  "deadEvidenceFromSamples: one non-dead in a mixed sequence → false",
  !deadEvidenceFromSamples([deadSample(), deadSample(1, 80000), deadSample()]),
);

// --- Task 3: candidatesExhausted copy is honest and avoids false hope --------

assert(
  "STALLED without candidatesExhausted → 'retry' affordance (unchanged)",
  playbackFailureCopy({ code: "STALLED", failureClass: "delivery", retryable: true }).affordance === "retry",
);
assert(
  "STALLED with candidatesExhausted:true → Retry restarts automatic selection",
  playbackFailureCopy({
    code: "STALLED",
    failureClass: "delivery",
    retryable: true,
    candidatesExhausted: true,
  }).affordance === "retry",
);
assert(
  "exhausted headline is non-empty",
  (() => {
    const copy = playbackFailureCopy({
      code: "STALLED",
      failureClass: "delivery",
      retryable: true,
      candidatesExhausted: true,
    });
    return typeof copy.headline === "string" && copy.headline.trim().length > 0;
  })(),
);
assert(
  "exhausted copy contains no mechanism words",
  (() => {
    const copy = playbackFailureCopy({
      code: "STALLED",
      failureClass: "delivery",
      retryable: true,
      candidatesExhausted: true,
    });
    return !MECHANISM.test(copy.headline) && !MECHANISM.test(copy.detail ?? "");
  })(),
);
// "Try again in a moment" and "a moment" are false hope for a genuinely dead
// swarm — the exhausted copy must never say "moment" or "later".
assert(
  "exhausted copy avoids false-hope 'moment'/'later' language",
  (() => {
    const FALSE_HOPE = /moment|later|soon|wait/i;
    const copy = playbackFailureCopy({
      code: "STALLED",
      failureClass: "delivery",
      retryable: true,
      candidatesExhausted: true,
    });
    return !FALSE_HOPE.test(copy.headline) && !FALSE_HOPE.test(copy.detail ?? "");
  })(),
);

function failoverCandidates(count: number) {
  return [
    {
      infoHash: "ACTIVE",
      title: "Active",
      resolution: 1080,
      sourceLabel: "WEB-DL" as const,
      sizeBytes: 1,
      sizeLabel: "1 B",
      codec: "H.264",
      audio: "AAC",
      playability: "direct" as const,
      seeders: 1,
      isCurrent: true,
      verdict: "good" as const,
    },
    ...Array.from({ length: count }, (_, index) => ({
      infoHash: `candidate-${index + 1}`,
      title: `Candidate ${index + 1}`,
      resolution: 1080,
      sourceLabel: "WEB-DL" as const,
      sizeBytes: index + 2,
      sizeLabel: `${index + 2} B`,
      codec: "H.264",
      audio: "AAC",
      playability: "direct" as const,
      seeders: count - index,
      isCurrent: false,
      verdict: index % 4 === 3 ? ("dead" as const) : ("good" as const),
    })),
  ];
}

for (let candidateCount = 0; candidateCount <= 12; candidateCount++) {
  const pool = failoverCandidates(candidateCount);
  const tried = new Set<string>();
  const attempted: string[] = [];
  let candidate = nextAutomaticCandidate(pool, "active", tried);
  while (candidate) {
    attempted.push(candidate.infoHash.toLowerCase());
    candidate = nextAutomaticCandidate(pool, "active", tried);
  }
  assert(
    `automatic failover exhausts all ${candidateCount} unique candidates exactly once`,
    attempted.length === candidateCount &&
      new Set(attempted).size === candidateCount &&
      nextAutomaticCandidate(pool, "active", tried) === null,
  );

  for (let successIndex = 0; successIndex < candidateCount; successIndex++) {
    const successTried = new Set<string>();
    const attemptsBeforeSuccess: string[] = [];
    let selected = nextAutomaticCandidate(pool, "ACTIVE", successTried);
    let prematurelyExhausted = false;
    for (let attemptIndex = 0; attemptIndex <= successIndex; attemptIndex++) {
      if (!selected) {
        prematurelyExhausted = true;
        break;
      }
      attemptsBeforeSuccess.push(selected.infoHash.toLowerCase());
      if (attemptIndex < successIndex) {
        selected = nextAutomaticCandidate(pool, "ACTIVE", successTried);
      }
    }
    assert(
      `automatic failover with ${candidateCount} candidates reaches success at index ${successIndex + 1}`,
      !prematurelyExhausted &&
        attemptsBeforeSuccess.length === successIndex + 1 &&
        new Set(attemptsBeforeSuccess).size === attemptsBeforeSuccess.length,
    );
  }
}

const duplicatePool = failoverCandidates(3);
duplicatePool.push(
  { ...duplicatePool[1], infoHash: duplicatePool[1].infoHash.toUpperCase() },
  { ...duplicatePool[2] },
);
const duplicateTried = new Set<string>();
const duplicateAttempts: string[] = [];
let duplicateCandidate = nextAutomaticCandidate(duplicatePool, "active", duplicateTried);
while (duplicateCandidate) {
  duplicateAttempts.push(duplicateCandidate.infoHash.toLowerCase());
  duplicateCandidate = nextAutomaticCandidate(duplicatePool, "active", duplicateTried);
}
assert(
  "automatic failover deduplicates repeated and case-varied hashes",
  duplicateAttempts.length === 3 && new Set(duplicateAttempts).size === 3,
);

const playerSource = fs.readFileSync("src/components/watch/inline-player.tsx", "utf8");

const releaseResetBlock =
  /if \(activeInfoHash !== resetInfoHash\) \{[\s\S]*?setPlanNonce\(/.exec(playerSource)?.[0] ?? "";
assert(
  "given a release switch, the reset path clears strategy before the next plan",
  /setStrategy\(null\);/.test(releaseResetBlock) &&
    /setStrategyReason\(null\);/.test(releaseResetBlock),
);

const fileResetBlock =
  /if \(effectiveSelectedPath !== resetForPath\) \{[\s\S]*?\n  \}/.exec(playerSource)?.[0] ?? "";
assert(
  "given a selected-file switch, the reset path clears strategy before the next plan",
  /setStrategy\(null\);/.test(fileResetBlock) &&
    /setStrategyReason\(null\);/.test(fileResetBlock),
);

const coldSwarmSample = { peers: 0, downloadSpeedBps: 0, progress: 0, observedAt: 0 };
assert(
  "given a cold swarm on a fresh release, when strategy is null and nothing played yet, the loader stays honest",
  loaderStatusFromSamples({
    preparingLabel: null,
    sample: coldSwarmSample,
    elapsedSec: 1,
    strategy: null,
    playbackEstablished: false,
  }) === "Finding peers…",
);

assert(
  "given a stale proven-local strategy, the loader falsely claims Preparing — which is why the reset clears it",
  loaderStatusFromSamples({
    preparingLabel: null,
    sample: coldSwarmSample,
    elapsedSec: 1,
    strategy: "whole-file",
    playbackEstablished: false,
  }) === "Preparing…",
);

const planFailureBlock =
  /if \(!planRes\.ok\) \{[\s\S]*?\n        \}/.exec(playerSource)?.[0] ?? "";
assert(
  "given a non-503 plan failure, the effect hands off to tryDirectStream instead of a terminal error",
  /probeError === "timeout"/.test(planFailureBlock) &&
    /await tryDirectStream\(activeInfoHash, filePath, controller\.signal\)/.test(planFailureBlock),
);
assert(
  "given a non-503 plan failure, no immediate generic terminal problem is set",
  planFailureBlock.length > 0 && !/setProblem\("generic"\)/.test(planFailureBlock),
);
assert(
  "given a 503 probe timeout, the special auto-failover + probe-wait copy is preserved",
  /planRes\.status === 503[\s\S]*?await attemptAutoFailover\(\)[\s\S]*?setProblem\("stalled"\)/.test(
    planFailureBlock,
  ),
);
assert(
  "given a non-503 plan failure, failover is not looped twice on the same branch",
  (planFailureBlock.match(/attemptAutoFailover\(/g) ?? []).length === 1,
);

const planCatchBlock =
  /\} catch \{\r?\n        \/\/ A network error[\s\S]*?\r?\n      \} finally \{/.exec(playerSource)?.[0] ?? "";
assert(
  "given a fetch exception planning playback, recovery runs instead of an immediate terminal error",
  /await tryDirectStream\(activeInfoHash, filePath, controller\.signal\)/.test(planCatchBlock) &&
    !/setProblem\("generic"\)/.test(planCatchBlock),
);

assert(
  "tryDirectStream is genuinely called, not a dead callback",
  (playerSource.match(/await tryDirectStream\(/g) ?? []).length >= 2 &&
    /const tryDirectStream = useCallback\(/.test(playerSource),
);
assert(
  "the plan-selected default audio track is marked with the full plan identity before updating UI state",
  /planSelectedAudioRef\.current = \{\s*infoHash: activeInfoHash,\s*filePath,\s*planNonce,\s*audioStreamIndex: planData\.plan\.selectedAudioIndex,\s*\};\s*setAudioStreamIndex\(planData\.plan\.selectedAudioIndex\)/.test(
    playerSource,
  ),
);
assert(
  "a plan-derived audio state update is consumed without starting an identical second plan",
  /if \(shouldSuppressPlanEcho\(planSelectedAudioRef\.current, echo\)\) \{[\s\S]*?planSelectedAudioRef\.current = null;\s*return;\s*\}[\s\S]*?planSelectedAudioRef\.current = null;\s*const controller = new AbortController\(\)/.test(
    playerSource,
  ),
);
assert(
  "the elapsed loader copy resets and advances for every visible loader episode",
  /if \(showLoader !== loaderElapsedActive\) \{\s*setLoaderElapsedActive\(showLoader\);\s*setVerboseElapsedSec\(0\);\s*\}[\s\S]*?if \(!showLoader\)[\s\S]*?setInterval\([\s\S]*?\}, 1000\);[\s\S]*?\}, \[showLoader\]\);/.test(
    playerSource,
  ),
);
assert(
  "the elapsed loader timer is not frozen once playback has started",
  !/verboseStartTimeRef\.current = Date\.now\(\)[\s\S]*?\}, \[expanded, activeInfoHash, playbackStarted\]\);/.test(
    playerSource,
  ),
);

const directStreamBlock =
  /const tryDirectStream = useCallback\([\s\S]*?\r?\n    \[attemptAutoFailover\],\r?\n  \);/.exec(playerSource)?.[0] ??
  "";
assert(
  "tryDirectStream handles direct success and escalates structured failures to auto-failover",
  /setPlaybackMode\("direct"\)/.test(directStreamBlock) &&
    /setPlayableSrc\(streamPath\(hash, filePath\)\)/.test(directStreamBlock) &&
    /structuredFailureFromBody/.test(directStreamBlock) &&
    (directStreamBlock.match(/attemptAutoFailover\(\)/g) ?? []).length === 2,
);

// ---------------------------------------------------------------------------
// 4K playback hardening: buffer sizing, seek restarts, callback lifecycle
// ---------------------------------------------------------------------------

assert(
  "given a 1080p source, the buffer budget keeps the tuned 120 MB / 90s back buffer",
  hlsBufferSettingsForSource({ width: 1920, height: 1080 }).maxBufferSize === 120 * 1000 * 1000 &&
    hlsBufferSettingsForSource({ width: 1920, height: 1080 }).backBufferLength === 90,
);

assert(
  "given a 2160p source, the byte budget grows well past the 1080p constant",
  hlsBufferSettingsForSource({ width: 3840, height: 2160 }).maxBufferSize === 600 * 1000 * 1000,
);

assert(
  "given a 2160p source, the back buffer shrinks so history cannot pin memory",
  hlsBufferSettingsForSource({ width: 3840, height: 2160 }).backBufferLength === 30,
);

assert(
  "given anamorphic 4K reporting a short height, width still lifts it into the 4K tier",
  hlsBufferSettingsForSource({ width: 3840, height: 1600 }).maxBufferSize === 600 * 1000 * 1000,
);

assert(
  "given a 1440p source, the budget sits between the 1080p and 4K tiers",
  hlsBufferSettingsForSource({ width: 2560, height: 1440 }).maxBufferSize === 300 * 1000 * 1000 &&
    hlsBufferSettingsForSource({ width: 2560, height: 1440 }).backBufferLength === 45,
);

assert(
  "given an unknown resolution, the budget falls back to the safe 1080p tier",
  hlsBufferSettingsForSource({ width: null, height: null }).maxBufferSize === 120 * 1000 * 1000,
);

assert(
  "given a measured 80 Mbps bitrate, the budget holds ~60s of real bytes",
  hlsBufferSettingsForSource({ width: 3840, height: 2160, bitrateBps: 80_000_000 }).maxBufferSize ===
    600 * 1000 * 1000,
);

assert(
  "given an implausibly low bitrate, the budget never drops below the 1080p floor",
  hlsBufferSettingsForSource({ width: 3840, height: 2160, bitrateBps: 1_000 }).maxBufferSize ===
    120 * 1000 * 1000,
);

assert(
  "given an implausibly high bitrate, the budget is clamped so memory stays bounded",
  hlsBufferSettingsForSource({ width: 3840, height: 2160, bitrateBps: 2_000_000_000 }).maxBufferSize ===
    800 * 1000 * 1000,
);

assert(
  "given a seek target already deep in the buffer, the fragment loader is not restarted",
  hlsSeekNeedsLoadRestart({ buffered: [{ start: 0, end: 60 }], targetSec: 20 }) === false,
);

assert(
  "given a seek target outside the buffer, the fragment loader is restarted",
  hlsSeekNeedsLoadRestart({ buffered: [{ start: 0, end: 60 }], targetSec: 300 }) === true,
);

assert(
  "given a seek target at the very edge of the buffer, the loader restarts rather than starving",
  hlsSeekNeedsLoadRestart({ buffered: [{ start: 0, end: 60 }], targetSec: 59.5 }) === true,
);

assert(
  "given a seek target inside a later island after a gap, the loader restarts",
  hlsSeekNeedsLoadRestart({ buffered: [{ start: 0, end: 10 }], targetSec: 40 }) === true,
);

assert(
  "an automatic hls.js gap nudge never restarts the fragment loader",
  hlsSeekShouldRestartLoader({
    hasUserSeekIntent: false,
    buffered: [],
    targetSec: 40,
  }) === false,
);

assert(
  "an explicit user seek outside the buffer restarts the fragment loader",
  hlsSeekShouldRestartLoader({
    hasUserSeekIntent: true,
    buffered: [{ start: 0, end: 10 }],
    targetSec: 40,
  }) === true,
);

assert(
  "an explicit user seek already buffered does not restart the fragment loader",
  hlsSeekShouldRestartLoader({
    hasUserSeekIntent: true,
    buffered: [{ start: 0, end: 60 }],
    targetSec: 20,
  }) === false,
);

assert(
  "media-element buffered ranges convert to plain ranges, dropping empty spans",
  JSON.stringify(timeRangesToRanges(timeRanges([[0, 10], [10, 10], [20, 35]]))) ===
    JSON.stringify([{ start: 0, end: 10 }, { start: 20, end: 35 }]),
);

assert(
  "a missing buffered list converts to no ranges instead of throwing",
  timeRangesToRanges(null).length === 0,
);

const attachHlsBlock =
  /const attachHls = useCallback\(\(video: HTMLVideoElement \| null\) => \{[\s\S]*?\n  \}, \[[^\]]*\]\);/.exec(
    playerSource,
  )?.[0] ?? "";

assert(
  "attachHls does not depend on playbackRate, so a speed change cannot destroy the hls.js buffer",
  attachHlsBlock.length > 0 && /\}, \[playableSrc, playbackMode\]\);$/.test(attachHlsBlock),
);

assert(
  "attachHls applies the current rate from a ref instead of a reactive dependency",
  /video\.playbackRate = playbackRateRef\.current;/.test(attachHlsBlock),
);

assert(
  "the rate effect owns both the ref mirror and the element write",
  /playbackRateRef\.current = playbackRate;\s*if \(videoRef\.current\) videoRef\.current\.playbackRate = playbackRate;\s*\}, \[playbackRate, playableSrc\]\);/.test(
    playerSource,
  ),
);

assert(
  "the native attach callback is also stable across playbackRate",
  /const attachNativeVideo = useCallback\([\s\S]*?video\.playbackRate = playbackRateRef\.current;\s*\},\s*\[\],\s*\);/.test(
    playerSource,
  ),
);

assert(
  "hls.js buffer options are derived per source, not hardcoded 1080p constants",
  /maxBufferSize: bufferSettings\.maxBufferSize/.test(attachHlsBlock) &&
    /backBufferLength: bufferSettings\.backBufferLength/.test(attachHlsBlock) &&
    /hlsBufferSettingsForSource\(\{/.test(attachHlsBlock),
);

assert(
  "the seek handler requires explicit user intent and consults the buffer before tearing the loader down",
  /const hasUserSeekIntent = requestedSeekRef\.current != null;[\s\S]*?if \(!hlsSeekShouldRestartLoader\(\{\s*hasUserSeekIntent,\s*buffered: timeRangesToRanges\(video\.buffered\),\s*targetSec: target,\s*\}\)\) \{\s*return;\s*\}\s*try \{\s*hls\.stopLoad\(\);\s*hls\.startLoad\(target\);/.test(
    attachHlsBlock,
  ),
);

assert(
  "the source profile used for buffer sizing is reset before each new plan",
  /sourceProfileRef\.current = \{ width: null, height: null, bitrateBps: null \};/.test(playerSource) &&
    /sourceProfileRef\.current = \{\s*width: planData\.probe\.width \?\? null,/.test(playerSource),
);

assert(
  "source changes, cleanup and error recovery survive the rework",
  /hls\.loadSource\(playableSrc\)/.test(attachHlsBlock) &&
    /hlsRef\.current\.destroy\(\)/.test(attachHlsBlock) &&
    /Hls\.ErrorTypes\.NETWORK_ERROR/.test(attachHlsBlock) &&
    /hlsSeekAbortRef\.current = \(\) => \{/.test(attachHlsBlock),
);

// --- Strict disk-vs-swarm loader locality -----------------------------------
// Root cause: strategy `session` can still read a complete local file via
// absolutePath, so strategy alone let a purely local wait render peer copy,
// and startup swarm polling ran for local plans.
{
  const sampleOf = (peers: number | null, speed: number | null, progress: number | null) => ({
    peers,
    downloadSpeedBps: speed,
    progress,
    observedAt: Date.now(),
  });

  assert(
    "an explicit disk answer from the server settles locality",
    planSourceFromPlan({ source: "disk", strategy: "session" }) === "disk",
  );
  assert(
    "an explicit swarm answer is honoured even for a local-looking strategy",
    planSourceFromPlan({ source: "swarm", strategy: "whole-file" }) === "swarm",
  );
  assert(
    "the locality alias is accepted from servers that use it",
    planSourceFromPlan({ locality: "local", strategy: "session" }) === "disk",
  );
  assert(
    "a session plan holding an absolutePath is disk-backed, not swarm-backed",
    planSourceFromPlan({ strategy: "session", absolutePath: "D:/media/Show.S01E01.mkv" }) === "disk",
  );
  assert(
    "a blank absolutePath does not fake disk locality",
    planSourceFromPlan({ strategy: "session", absolutePath: "   " }) === null,
  );
  assert(
    "whole-file still implies disk for older servers with no explicit field",
    planSourceFromPlan({ strategy: "whole-file" }) === "disk",
  );
  assert(
    "a bare session plan stays unknown rather than being guessed as swarm",
    planSourceFromPlan({ strategy: "session" }) === null,
  );
  assert(
    "a missing plan is unknown, not a crash",
    planSourceFromPlan(null) === null,
  );

  // THE regression: a local session with zero peers must never emit peer text.
  for (const elapsed of [0, 3, 15, 120]) {
    for (const sample of [null, sampleOf(0, 0, 0), sampleOf(0, null, null), sampleOf(4, 0, 0)]) {
      for (const established of [false, true]) {
        const status = loaderStatusFromSamples({
          preparingLabel: "preparing",
          sample,
          elapsedSec: elapsed,
          strategy: "session",
          planSource: "disk",
          playbackEstablished: established,
        });
        assert(
          `a local session (elapsed ${elapsed}, established ${established}) never emits peer/connecting copy`,
          !/peer|connecting|finding|swarm/i.test(status),
          status,
        );
        assert(
          `a local session (elapsed ${elapsed}, established ${established}) uses neutral loader copy`,
          status === "Preparing…" || status === "Seeking…" || status === "Still working…",
          status,
        );
      }
    }
  }

  assert(
    "a local session that has run long says still working, not finding peers",
    loaderStatusFromSamples({
      preparingLabel: "preparing",
      sample: sampleOf(0, 0, 0),
      elapsedSec: 30,
      strategy: "session",
      planSource: "disk",
    }) === "Still working…",
  );
  assert(
    "a disk plan mid-playback reads as a seek",
    loaderStatusFromSamples({
      sample: sampleOf(9, 900_000, 0.6),
      elapsedSec: 2,
      strategy: "session",
      planSource: "disk",
      playbackEstablished: true,
    }) === "Seeking…",
  );
  assert(
    "a confirmed swarm session still gets honest peer copy",
    loaderStatusFromSamples({
      preparingLabel: "preparing",
      sample: sampleOf(0, 0, 0),
      elapsedSec: 3,
      strategy: "session",
      planSource: "swarm",
    }) === "Finding peers…",
  );
  assert(
    "the pre-plan default with no evidence at all is neutral, not peer copy",
    loaderStatusFromSamples({}) === "Preparing…",
  );
  assert(
    "the pre-plan default never mentions peers",
    !/peer|connecting/i.test(loaderStatusFromSamples({ elapsedSec: 1 })),
    loaderStatusFromSamples({ elapsedSec: 1 }),
  );
}

assert(
  "the player stores plan locality and feeds it to the loader before sample copy",
  /const \[planSource, setPlanSource\] = useState<PlanSource \| null>\(null\)/.test(playerSource) &&
  /setPlanSource\(resolvedPlanSource\)/.test(playerSource) &&
    /planSource,\s*\r?\n\s*playbackEstablished: playbackStarted,/.test(playerSource),
);

assert(
  "plan locality is cleared on release and file changes so it cannot describe the next wait",
  (playerSource.match(/setPlanSource\(null\)/g) ?? []).length >= 2,
);

assert(
  "startup swarm polling is suppressed and its samples cleared for a disk plan",
  /if \(planSource === "disk"\) \{[\s\S]*?startupSamplesRef\.current = \[\];[\s\S]*?return;[\s\S]*?\}/.test(
    playerSource,
  ) &&
    /if \(resolvedPlanSource === "disk"\) setSwarmSample\(null\);/.test(playerSource) &&
    /playbackStarted, !!streamFailure, attemptAutoFailover, planSource\]/.test(playerSource),
);

// ── Plan-echo suppression: identity-keyed, never a bare audio index ──

type PlanRun = {
  expanded: boolean;
  infoHash: string | null;
  filePath: string | null;
  planNonce: number;
  audioStreamIndex: number | null;
};

/** Mirrors the plan effect's guard exactly, so the rule can be exercised without React. */
function runPlanEffect(state: { armed: PlanAudioEcho | null; plans: number }, run: PlanRun): void {
  if (!run.expanded || !run.filePath || !run.infoHash) {
    state.armed = null;
    return;
  }
  const echo: PlanAudioEcho = {
    infoHash: run.infoHash,
    filePath: run.filePath,
    planNonce: run.planNonce,
    audioStreamIndex: run.audioStreamIndex,
  };
  if (shouldSuppressPlanEcho(state.armed, echo)) {
    state.armed = null;
    return;
  }
  state.armed = null;
  state.plans += 1;
}

const OPEN_RUN: PlanRun = {
  expanded: true,
  infoHash: "aaaa",
  filePath: "Show/S01E01.mkv",
  planNonce: 0,
  audioStreamIndex: null,
};
const ARMED_ECHO: PlanAudioEcho = {
  infoHash: "aaaa",
  filePath: "Show/S01E01.mkv",
  planNonce: 0,
  audioStreamIndex: 3,
};

{
  // A plan-derived audio update suppresses exactly one duplicate re-plan.
  const state = { armed: null as PlanAudioEcho | null, plans: 0 };
  runPlanEffect(state, OPEN_RUN);
  state.armed = { ...ARMED_ECHO };
  runPlanEffect(state, { ...OPEN_RUN, audioStreamIndex: 3 });
  assert(
    "a plan-derived audio index suppresses only the matching duplicate re-plan",
    state.plans === 1 && state.armed === null,
    `plans=${state.plans}`,
  );
  // The viewer picking a track afterwards (new plan generation) must still plan.
  runPlanEffect(state, { ...OPEN_RUN, audioStreamIndex: 3, planNonce: 1 });
  assert(
    "a viewer audio selection after the echo was consumed still plans",
    state.plans === 2,
    `plans=${state.plans}`,
  );
}

{
  // Closing the player while an echo is armed must disarm it, so reopening on
  // the same file/index cannot be swallowed.
  const state = { armed: { ...ARMED_ECHO } as PlanAudioEcho | null, plans: 0 };
  runPlanEffect(state, { ...OPEN_RUN, expanded: false, audioStreamIndex: 3 });
  assert("collapsing the player disarms the plan echo", state.armed === null);
  runPlanEffect(state, { ...OPEN_RUN, audioStreamIndex: 3 });
  assert("reopening the player after a close still plans", state.plans === 1, `plans=${state.plans}`);
}

{
  // Switching file / release / plan generation with an echo still armed must
  // never swallow the required plan.
  const state = { armed: { ...ARMED_ECHO } as PlanAudioEcho | null, plans: 0 };
  runPlanEffect(state, { ...OPEN_RUN, filePath: "Show/S01E02.mkv", audioStreamIndex: 3 });
  assert("switching file cannot be suppressed by a stale echo", state.plans === 1);

  state.armed = { ...ARMED_ECHO };
  runPlanEffect(state, { ...OPEN_RUN, infoHash: "bbbb", audioStreamIndex: 3 });
  assert("switching release cannot be suppressed by a stale echo", state.plans === 2);

  state.armed = { ...ARMED_ECHO };
  runPlanEffect(state, { ...OPEN_RUN, planNonce: 1, audioStreamIndex: 3 });
  assert("a newer plan generation (seek/retry) cannot be suppressed", state.plans === 3);

  state.armed = { ...ARMED_ECHO };
  runPlanEffect(state, { ...OPEN_RUN, filePath: null, audioStreamIndex: 3 });
  assert("a file reset disarms the echo", state.armed === null && state.plans === 3);
}

assert(
  "nothing armed never suppresses",
  shouldSuppressPlanEcho(null, ARMED_ECHO) === false &&
    shouldSuppressPlanEcho(undefined, ARMED_ECHO) === false,
);

assert(
  "the player disarms the plan echo on release/file change, on failed preconditions and after every real plan",
  (playerSource.match(/planSelectedAudioRef\.current = null;/g) ?? []).length >= 4 &&
    /useEffect\(\(\) => \{\s*planSelectedAudioRef\.current = null;\s*\}, \[activeInfoHash, effectiveSelectedPath\]\);/.test(
      playerSource,
    ) &&
    /shouldSuppressPlanEcho\(planSelectedAudioRef\.current, echo\)/.test(playerSource),
);

// ── Bitrate wiring: real values only, resolution tiers otherwise ──

assert(
  "the plan route reports a measured bitrate under probe.bitrate",
  /bitrate: probeBitrateBps\(probeResult!\)/.test(
    fs.readFileSync("src/app/api/playback/plan/route.ts", "utf8"),
  ),
);

assert(
  "the player feeds the plan's bitrate into buffer sizing",
  /bitrateBps: normalizeProbeBitrate\(planData\.probe\.bitrate\)/.test(playerSource),
);

assert(
  "a valid plan bitrate is normalized to bits per second",
  normalizeProbeBitrate(48_000_000) === 48_000_000 && normalizeProbeBitrate("48000000") === 48_000_000,
);

assert(
  "an absent, zero, negative or unparseable bitrate is null (never fabricated)",
  normalizeProbeBitrate(undefined) === null &&
    normalizeProbeBitrate(null) === null &&
    normalizeProbeBitrate(0) === null &&
    normalizeProbeBitrate(-5) === null &&
    normalizeProbeBitrate(Number.NaN) === null &&
    normalizeProbeBitrate("abc") === null,
);

{
  const uhd = { width: 3840, height: 2160 };
  const tiered = hlsBufferSettingsForSource({ ...uhd, bitrateBps: normalizeProbeBitrate(undefined) });
  const measured = hlsBufferSettingsForSource({ ...uhd, bitrateBps: normalizeProbeBitrate(100_000_000) });
  assert(
    "an absent bitrate falls back to the 4K resolution tier",
    tiered.maxBufferSize === 600 * 1000 * 1000,
    String(tiered.maxBufferSize),
  );
  assert(
    "a measured high bitrate sizes the buffer above the resolution tier",
    measured.maxBufferSize === 750 * 1000 * 1000,
    String(measured.maxBufferSize),
  );
  const invalid = hlsBufferSettingsForSource({ ...uhd, bitrateBps: normalizeProbeBitrate("nonsense") });
  assert(
    "an invalid bitrate falls back to the resolution tier rather than starving the buffer",
    invalid.maxBufferSize === tiered.maxBufferSize,
  );
}

// ── Fast episode transitions: identity, exact files, invisible warming ──

assert(
  "the up-next card accepts an optional exact filePath and defaults it to null",
  normalizeUpNextCard({
    title: "Severance",
    label: "S02E02",
    season: 2,
    episode: 2,
    availability: "ready",
    infoHash: "abc",
    filePath: "Pack/S02E02.mkv",
    progress: 1,
  })?.filePath === "Pack/S02E02.mkv" &&
    normalizeUpNextCard({
      title: "Severance",
      label: "S02E02",
      season: 2,
      episode: 2,
      availability: "ready",
      infoHash: "abc",
      progress: 1,
    })?.filePath === null,
);

assert(
  "a malformed or empty up-next payload yields no card rather than a broken one",
  normalizeUpNextCard(null) === null &&
    normalizeUpNextCard({ title: "x" }) === null &&
    normalizeUpNextCard({ title: "x", label: "S1E1", season: 1, episode: 1, infoHash: "", progress: null })
      ?.infoHash === null,
);

assert(
  "an unknown availability degrades to not-fetched instead of being trusted",
  normalizeUpNextCard({
    title: "x",
    label: "S1E1",
    season: 1,
    episode: 1,
    availability: "sort-of",
    infoHash: "abc",
    progress: null,
  })?.availability === "not-fetched",
);

assert(
  "the player's target identity includes season, episode and file — not just the infoHash",
  /const targetIdentity = `\$\{activeInfoHash \?\? ""\}\|\$\{activeSeason \?\? ""\}\|\$\{activeEpisode \?\? ""\}\|\$\{activeFilePath \?\? ""\}`/.test(
    playerSource,
  ),
);

assert(
  "manifest reuse is keyed on the whole target identity, so a same-pack episode change cannot reuse stale media",
  /if \(manifest\?\.infoHash === activeInfoHash && manifestKey === targetIdentity\) \{\s*\r?\n\s*return manifest;/.test(
    playerSource,
  ) &&
    /const activeManifest =\s*\r?\n\s*manifest\?\.infoHash === activeInfoHash && manifestKey === targetIdentity/.test(
      playerSource,
    ),
);

const identityResetBlock =
  /if \(targetIdentity !== resetTargetIdentity\) \{[\s\S]*?setPlanNonce\(/.exec(playerSource)?.[0] ?? "";
assert(
  "a same-hash episode change resets playback state and re-plans",
  /setPlayableSrc\(null\);/.test(identityResetBlock) &&
    /setPlaybackStarted\(false\);/.test(identityResetBlock) &&
    /setStrategy\(null\);/.test(identityResetBlock),
);
assert(
  "a same-hash episode change selects the named file and keeps the manifest it already holds",
  /manifest\.files\.some\(\(file\) => file\.path === activeFilePath\)/.test(identityResetBlock) &&
    /setManifestKey\(known \? targetIdentity : null\);/.test(identityResetBlock) &&
    /if \(!known\) setManifest\(null\);/.test(identityResetBlock) &&
    /setSelectedPath\(known\);/.test(identityResetBlock),
);
assert(
  "a same-pack next keeps the outgoing element until the replacement plan is ready",
  /const keepOutgoingEpisode = shouldPreserveOutgoingEpisode\(/.test(identityResetBlock) &&
    /if \(!keepOutgoingEpisode\) \{\s*setPlayableSrc\(null\);/.test(identityResetBlock) &&
    /if \(!keepOutgoingEpisode && hlsRef\.current\)/.test(playerSource),
);
assert(
  "late events from a preserved outgoing episode cannot write progress onto the new episode",
  /if \(preserveOutgoingEpisode\) return;[\s\S]{0,200}?const filePath = selectedPathRef\.current;/.test(
    playerSource,
  ),
);
assert(
  "a failed plan keeps outgoing progress blocked until direct fallback commits its source",
  !/if \(!planRes\.ok\) \{\s*setPreserveOutgoingEpisode\(false\);/.test(playerSource) &&
    /if \(res\.ok \|\| res\.status === 206\) \{[\s\S]{0,240}?setPreserveOutgoingEpisode\(false\);[\s\S]{0,120}?setPlayableSrc\(/.test(
      playerSource,
    ),
);
assert(
  "embedded subtitles rotate through bounded source-time extraction windows",
  /activeSubtitle\.kind === "embedded"/.test(playerSource) &&
    /subtitleWindowStart\(currentSourceTime\)/.test(playerSource) &&
    /nextWindow - 60/.test(playerSource) &&
    /next window prefetch failed/.test(playerSource),
);
assert(
  "HLS resume seeds source time before subtitle window selection",
  /currentSourceTimeRef\.current = startSec;[\s\S]{0,120}?setCurrentSourceTime\(startSec\);[\s\S]{0,160}?setPlaybackMode\("hls"\)/.test(
    playerSource,
  ),
);
assert(
  "speculative subtitle requests are marked as prefetch work",
  /prefetchSrc[\s\S]{0,260}?prefetch=1/.test(playerSource),
);
assert(
  "obsolete subtitle consumers explicitly cancel server extraction",
  /fetch\(activeSubtitleSrc,\s*\{[\s\S]{0,100}?method:\s*"DELETE"/.test(
    playerSource,
  ) &&
    /fetch\(prefetchSrc,\s*\{[\s\S]{0,100}?method:\s*"DELETE"/.test(
      playerSource,
    ),
);

assert(
  "an advance carries the server's exact filePath into the new target",
  /filePath: next\.filePath \?\? null,/.test(playerSource),
);
assert(
  "an advance still takes a fresh transition token before re-targeting",
  /transitionGenRef\.current \+= 1;[\s\S]{0,600}?setTarget\(\{\s*\r?\n\s*infoHash: next\.infoHash,/.test(
    playerSource,
  ),
);

const warmEffect =
  /const warmedTargetRef = useRef<string \| null>\(null\);[\s\S]*?\}, \[upNextInfoHash, upNextFilePath\]\);/.exec(
    playerSource,
  )?.[0] ?? "";
assert(
  "warming runs at most once per resolved episode+file",
  /const key = `\$\{upNextInfoHash\}\|\$\{upNextFilePath\}`;/.test(warmEffect) &&
    /if \(warmedTargetRef\.current === key\) return;/.test(warmEffect),
);
assert(
  "warming only happens for known media, while the page is visible",
  /if \(!upNextInfoHash \|\| !upNextFilePath\) return;/.test(warmEffect) &&
    /document\.hidden\) return;/.test(warmEffect),
);
assert(
  "warming is abortable and cancels its idle callback on target change or unmount",
  /controller\.abort\(\);/.test(warmEffect) &&
    /cancelIdle\(idleHandle\)/.test(warmEffect) &&
    /window\.clearTimeout\(timer\)/.test(warmEffect),
);
assert(
  "warming asks only for the narrow warm plan and never reads the answer",
  /warm: true,/.test(warmEffect) &&
    /\.catch\(\(\) => \{\}\);/.test(warmEffect) &&
    !/setUpNextLoading|setProblem|setMessage|setPlayableSrc|setTarget|setUpNextError/.test(warmEffect),
);
assert(
  "requestIdleCallback is feature-detected with a timeout fallback",
  /typeof view\.requestIdleCallback === "function"/.test(playerSource) &&
    /window\.setTimeout\(callback, WARM_IDLE_TIMEOUT_MS\)/.test(playerSource),
);

assert(
  "there is no speculative background acquisition that could steal bandwidth from playback",
  !/JSON\.stringify\(\{[^}]*action: "trigger"/.test(playerSource) &&
    !/"\/api\/prewarm"[\s\S]{0,300}action: "trigger"/.test(playerSource),
);
assert(
  "a viewer-initiated fetch of an unheld episode still goes to the on-demand path with stream retention",
  /fetch\("\/api\/library\/ondemand"/.test(playerSource) &&
    /retention: "stream",/.test(playerSource) &&
    /protectHashes: activeInfoHash \? \[activeInfoHash\] : \[\],/.test(playerSource),
);
assert(
  "an out-of-window HLS/VOD replan carries the exact remaining seek delta into hls.js",
  /pendingHlsStartRef\.current = seekPositionInPlannedTimeline\(\s*startSec,\s*planData\.startSec,\s*\);/.test(
    playerSource,
  ) && /startPosition: pendingHlsStartRef\.current,/.test(playerSource),
);
assert(
  "subtitle track mode is re-applied whenever the track URL or seek offset changes",
  /\}, \[activeSubtitle, activeSubtitleSrc, playableSrc, playbackMode\]\);/.test(playerSource),
);
assert(
  "theatre and inline chrome both render the same honest subtitle status",
  (playerSource.match(/data-stream-subtitle-status=\{subtitleStatus\}/g) ?? []).length >= 2 &&
    /const subtitleStatusMessage = subtitleStatusCopy\(subtitleStatus, subtitleNote\);/.test(playerSource),
);
assert(
  "390px controls are shrinkable and the timeline owns a mobile row instead of forcing overflow",
  /data-stream-transport-row[\s\S]{0,180}flex min-w-0 max-w-full items-center/.test(playerSource) &&
    /relative flex min-w-0 flex-1 basis-full items-center sm:basis-auto/.test(playerSource) &&
    /h-8 min-w-0 max-w-full appearance-none/.test(playerSource),
);

const sessionSource = fs.readFileSync("src/lib/media/session.ts", "utf8");
assert(
  "creating an out-of-window seek session force-releases stale offsets for the same exact file",
  /for \(const \[otherKey, other\] of sessions\)[\s\S]*?other\.infoHash === infoHash && other\.filePath === filePath && otherKey !== key[\s\S]*?cleanupSession\(other\);[\s\S]*?sessions\.delete\(otherKey\);/.test(
    sessionSource,
  ),
);

console.log(
  failures === 0
    ? "\nPASS inline-player"
    : `\nFAIL inline-player (${failures})`,
);
process.exit(failures === 0 ? 0 : 1);
