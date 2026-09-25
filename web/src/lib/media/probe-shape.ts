// Pure probe-shape helpers only: a pure helper must not live in the module that owns a binary or subprocess,
// because importing the helper drags the launcher into every bundle that touches it.

/** Typed probe result — everything the playback decision needs. */
export type ProbeStream = {
  index: number;
  codecType: "video" | "audio" | "subtitle" | "data" | string;
  codec: string;
  profile: string | null;
  /** Raw ffprobe pix_fmt, e.g. yuv420p / yuv420p10le. Drives 10-bit detection. */
  pixFmt: string | null;
  width: number | null;
  height: number | null;
  colorTransfer: string | null;
  colorPrimaries: string | null;
  channels: number | null;
  channelLayout: string | null;
  language: string | null;
  title: string | null;
  /** ffprobe disposition.default; used only when no preferred language matches. */
  dispositionDefault?: boolean;
  bitRate: number | null;
  sampleRate: number | null;
};

// ── Convenience helpers for the decision engine ──

// ── Container normalization ──
