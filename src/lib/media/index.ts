/**
 * Media playback layer — public API.
 *
 * The playback ladder:
 *   direct          → container + codecs all native. Zero CPU.
 *   remux           → codecs fine, container wrong (MKV→fMP4). ~0% CPU.
 *   transcode-audio → video fine, audio not (DTS/TrueHD). Copy video.
 *   transcode-full  → video codec unsupported. Full re-encode.
 */
export type { ProbeResult, ProbeStream, ProbeOutcome, ProbeError } from "./probe";
export type { ClientCapabilities, CodecEntry } from "./capabilities";
export type { PlaybackPlan, PlaybackRung, AudioPlan, DecideOptions } from "./decide";
export type { Session, SessionState } from "./session";

export {
  probeUrl,
  parseProbeOutput,
  normalizeCodecName,
  normalizeContainer,
  streamUrl,
  requestOrigin,
  resolveFfprobePath,
  FfBinaryMissingError,
} from "./probe";
export { videoStream, primaryAudioStream, audioStreams, isHDR } from "./probe";
export {
  parseCapabilities,
  DEFAULT_CAPABILITIES,
  supportsContainer,
  canDecodeViaMSE,
  fmp4Mime,
  videoCodecTag,
  audioCodecTag,
} from "./capabilities";
export { decidePlayback } from "./decide";
export {
  getOrCreateSession,
  unrefSession,
  stopSession,
  getSessionById,
  stopAllSessions,
  listSessions,
  buildFfmpegArgs,
  waitForSessionFile,
  cleanupStaleSessionDirs,
  installSessionCleanup,
  resolveFfmpegPath,
  sessionsDir,
  SEGMENT_SECONDS,
} from "./session";
