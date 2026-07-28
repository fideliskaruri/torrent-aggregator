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
  infoHashFromMagnet,
  interpretMediaElementError,
  isUpNextPlayableEnoughToAdvance,
  mainFeatureFile,
  playbackFailureCopy,
  structuredFailureFromBody,
  type StructuredPlaybackFailure,
  nextViewerWaitingState,
  nextSeekIntentAction,
  nextSeekRestartAction,
  playerControlsForMode,
  qualitySelectorEmptyCopy,
  releaseDetailChips,
  resolveVideoFileSelection,
  selectMainFeatureFile,
  selectVideoFiles,
  shouldAdoptTimeUpdate,
  shouldShowFullscreenStatusOverlay,
  shouldShowSeekSpinner,
  shouldShowUnifiedLoader,
  shouldShowViewerBuffering,
  terminalPlaybackCopy,
  streamStateSentence,
  streamPath,
  streamStatusMessage,
  sourceTimeInRanges,
  upNextUnavailableActionLabel,
  upNextStatusSentence,
  type StreamFile,
} from "./inline-player";
import { peerText, rateText, swarmHealth, swarmSummary } from "./swarm-chip";

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
  "preparing state names the viewer state, not the ffmpeg mechanism",
  streamStateSentence({ checking: false, preparing: true, waiting: false, playing: false }) ===
    "Getting it ready…",
);
assert(
  "waiting on an unsustainable stream never says 'stream' or a mechanism",
  streamStateSentence({
    checking: false,
    preparing: false,
    waiting: true,
    playing: false,
    swarm: { peers: 4, downloadSpeedBps: 1_200, progress: 0.15, observedAt: 0 },
    minimumStreamBps: 500_000,
  }) === "This one's slow — still getting it ready.",
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
assert(
  "up-next unavailable action label names the state instead of saying switch here soon",
  upNextUnavailableActionLabel() === "Not fetched yet" &&
    upNextUnavailableActionLabel() !== "Switch here soon",
  upNextUnavailableActionLabel(),
);
assert("quality selector calls good swarms fast", candidateVerdictLabel("good") === "Fast");
assert("quality selector keeps unknown offerable", candidateVerdictLabel("unknown") === "Untested");
assert(
  "quality selector never narrates the transcode mechanism",
  candidatePlayabilityLabel("transcode") === "Plays" &&
    !/convert|remux|transcod/i.test(candidatePlayabilityLabel("transcode")),
);
assert(
  "quality selector shows picture and swarm-relevant shape",
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
  }) === "1080p · WEB-DL · H.264 · DDP · 807 MB",
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

// --- I11: exactly one loader — spatially (union) AND temporally (continuous) -
{
  const base = {
    hasVisibleVideo: true,
    activeVideoAdvancing: false,
    seeking: false,
    waiting: false,
    preparing: false,
    checking: false,
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
  "a non-episode file reads as a plain numbered video, never its path",
  (() => {
    const label = fileOptionLabel({ path: "Some.Movie.2019.1080p.BluRay.x265.mkv", length: 5_000 * 1024 ** 2, index: 3 }, 3);
    return label.startsWith("Video 4") && !/BluRay|x265|\.mkv|Some\.Movie/i.test(label);
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
  affordance: "retry" | "switch";
}> = [
  { failure: { code: "NO_PEERS", failureClass: "delivery", retryable: true }, affordance: "retry" },
  { failure: { code: "CONNECTION_BLOCKED", failureClass: "delivery", retryable: true }, affordance: "retry" },
  { failure: { code: "STALLED", failureClass: "delivery", retryable: true }, affordance: "retry" },
  { failure: { code: "UNPLAYABLE", failureClass: "playability", retryable: false }, affordance: "switch" },
  { failure: { code: "NOT_FOUND", failureClass: "not-found", retryable: false }, affordance: "switch" },
  { failure: { code: "ENGINE_ERROR", failureClass: "engine", retryable: false }, affordance: "retry" },
  { failure: { code: "ENGINE_ERROR", failureClass: "playability", retryable: false }, affordance: "switch" },
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
  "an unplayable release never offers retry-same",
  playbackFailureCopy({ code: "UNPLAYABLE", failureClass: "playability", retryable: false }).affordance === "switch",
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

console.log(
  failures === 0
    ? "\nPASS inline-player"
    : `\nFAIL inline-player (${failures})`,
);
process.exit(failures === 0 ? 0 : 1);
