"use client";

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { Check, Copy, Loader2, Play, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn, formatBytes } from "@/lib/utils";

export type StreamFile = {
  path: string;
  length: number;
  index: number;
};

type StreamManifest = {
  files: StreamFile[];
  clientType?: string;
};

export type StreamProgress = {
  totalBytes?: number | null;
  downloadedBytes?: number | null;
  progress?: number | null;
  peers?: number | null;
};

type InlinePlayerProps = {
  infoHash: string;
  title: string;
  progress?: StreamProgress;
  className?: string;
};

const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".m4v",
  ".mkv",
  ".webm",
  ".mov",
  ".avi",
  ".ts",
  ".m2ts",
  ".mpg",
  ".mpeg",
]);

// Only WebVTT can drive a <track> element. `.srt` is included because the
// stream route converts it to WebVTT on the way out; `.ass`/`.ssa` are not,
// because their styling model has no faithful VTT equivalent and a silently
// broken track is worse than no track.
const SUBTITLE_EXTENSIONS = new Set([".vtt", ".srt"]);
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

type StreamProblem =
  | "browser-error"
  | "no-audio"
  | "wrong-client"
  | "metadata"
  | "stalled"
  | "missing"
  | "range"
  | "generic";

type AudioTracksVideo = HTMLVideoElement & {
  audioTracks?: { length: number };
  // Chrome and Edge do not implement HTMLMediaElement.audioTracks at all, so the
  // spec API silently never fires there. These non-standard counters are the only
  // way those browsers will admit that an audio stream failed to decode.
  webkitAudioDecodedByteCount?: number;
  webkitVideoDecodedByteCount?: number;
};

function extensionOf(path: string) {
  const clean = path.split(/[\\/]/).pop() ?? path;
  const dot = clean.lastIndexOf(".");
  return dot >= 0 ? clean.slice(dot).toLowerCase() : "";
}

function basenameWithoutExtension(path: string) {
  const clean = path.replace(/\\/g, "/");
  const slash = clean.lastIndexOf("/");
  const filename = slash >= 0 ? clean.slice(slash + 1) : clean;
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(0, dot).toLowerCase() : filename.toLowerCase();
}

function directoryOf(path: string) {
  const clean = path.replace(/\\/g, "/");
  const slash = clean.lastIndexOf("/");
  return slash >= 0 ? clean.slice(0, slash).toLowerCase() : "";
}

export function isVideoFile(path: string) {
  return VIDEO_EXTENSIONS.has(extensionOf(path));
}

export function selectVideoFiles(files: StreamFile[]) {
  return files.filter((file) => isVideoFile(file.path));
}

export function findSidecarSubtitle(files: StreamFile[], videoPath: string) {
  const videoBase = basenameWithoutExtension(videoPath);
  const videoDir = directoryOf(videoPath);
  return files.find(
    (file) =>
      directoryOf(file.path) === videoDir &&
      basenameWithoutExtension(file.path) === videoBase &&
      SUBTITLE_EXTENSIONS.has(extensionOf(file.path)),
  );
}

export function encodeStreamFilePath(filePath: string) {
  return filePath
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

export function streamPath(infoHash: string, filePath: string) {
  return `/api/stream/${encodeURIComponent(infoHash)}/${encodeStreamFilePath(filePath)}`;
}

function base32ToHex(value: string) {
  let bits = "";
  for (const raw of value.toUpperCase()) {
    const idx = BASE32_ALPHABET.indexOf(raw);
    if (idx < 0) return null;
    bits += idx.toString(2).padStart(5, "0");
  }

  let hex = "";
  for (let i = 0; i + 4 <= bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex.length >= 40 ? hex.slice(0, 40) : null;
}

export function infoHashFromMagnet(magnet: string | null | undefined) {
  if (!magnet) return null;
  const matches = magnet.match(/(?:^|[?&])xt=([^&]+)/gi) ?? [];
  for (const match of matches) {
    const raw = match.replace(/^[?&]?xt=/i, "");
    const decoded = decodeURIComponent(raw).replace(/^urn:btih:/i, "");
    if (/^[a-f0-9]{40}$/i.test(decoded)) return decoded.toLowerCase();
    if (/^[a-z2-7]{32}$/i.test(decoded)) return base32ToHex(decoded);
  }
  return null;
}

export function streamStatusMessage(status: number): {
  problem: StreamProblem;
  message: string;
} {
  if (status === 409) {
    return {
      problem: "wrong-client",
      message: "Streaming only works with the built-in engine.",
    };
  }
  if (status === 425) {
    return {
      problem: "metadata",
      message: "Torrent metadata is still resolving. Try again in a moment.",
    };
  }
  if (status === 503) {
    return {
      problem: "stalled",
      message: "No peers are currently sending this part.",
    };
  }
  if (status === 404) {
    return {
      problem: "missing",
      message:
        "This release isn't in the built-in engine — download it first, then play.",
    };
  }
  if (status === 416) {
    return {
      problem: "range",
      message: "The browser could not request a playable byte range.",
    };
  }
  return {
    problem: "generic",
    message: "The stream is not available right now.",
  };
}

export function bufferingLabel(progress?: StreamProgress) {
  const total = progress?.totalBytes ?? null;
  const downloaded =
    progress?.downloadedBytes ??
    (total != null && progress?.progress != null
      ? Math.max(0, Math.min(total, total * progress.progress))
      : null);
  const peers = progress?.peers;
  const peerText =
    peers == null ? "" : ` · ${peers} ${peers === 1 ? "peer" : "peers"}`;

  if (downloaded != null && total != null) {
    return `buffering — ${formatBytes(downloaded)} / ${formatBytes(total)}${peerText}`;
  }
  if (downloaded != null) {
    return `buffering — ${formatBytes(downloaded)} downloaded${peerText}`;
  }
  if (progress?.progress != null) {
    return `buffering — ${Math.round(progress.progress * 1000) / 10}% downloaded${peerText}`;
  }
  return `buffering — waiting for torrent pieces${peerText}`;
}

async function readJson<T>(res: Response): Promise<T | null> {
  const text = await res.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function InlineStreamPlayer({
  infoHash,
  title,
  progress,
  className,
}: InlinePlayerProps) {
  const panelId = useId();
  const [expanded, setExpanded] = useState(false);
  const [manifest, setManifest] = useState<StreamManifest | null>(null);
  const [manifestLoading, setManifestLoading] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [problem, setProblem] = useState<StreamProblem | null>(null);
  const [playableSrc, setPlayableSrc] = useState<string | null>(null);
  const [checkingStream, setCheckingStream] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [copied, setCopied] = useState(false);

  const videoFiles = useMemo(
    () => (manifest ? selectVideoFiles(manifest.files) : []),
    [manifest],
  );
  const selectedFile = videoFiles.find((file) => file.path === selectedPath);
  const subtitle = useMemo(
    () =>
      manifest && selectedPath
        ? findSidecarSubtitle(manifest.files, selectedPath)
        : undefined,
    [manifest, selectedPath],
  );

  const copyUrl = useCallback(
    async (path: string) => {
      const url = `${window.location.origin}${streamPath(infoHash, path)}`;
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setMessage("Stream URL copied.");
      window.setTimeout(() => setCopied(false), 1600);
    },
    [infoHash],
  );

  const loadManifest = useCallback(async () => {
    if (manifest) return manifest;
    setManifestLoading(true);
    setMessage(null);
    setProblem(null);
    try {
      const res = await fetch(`/api/stream/${encodeURIComponent(infoHash)}`);
      if (!res.ok) {
        const mapped = streamStatusMessage(res.status);
        setProblem(mapped.problem);
        setMessage(mapped.message);
        return null;
      }
      const data = await readJson<StreamManifest>(res);
      if (data?.clientType && data.clientType !== "builtin") {
        setProblem("wrong-client");
        setMessage("Streaming only works with the built-in engine.");
        return null;
      }
      const files = Array.isArray(data?.files) ? data.files : [];
      const next = { files, clientType: data?.clientType };
      setManifest(next);
      const videos = selectVideoFiles(files);
      if (videos.length === 1) setSelectedPath(videos[0].path);
      if (videos.length === 0) {
        setProblem("missing");
        setMessage("No video file was listed for this torrent.");
      }
      return next;
    } catch {
      setProblem("generic");
      setMessage("Could not reach the stream endpoint.");
      return null;
    } finally {
      setManifestLoading(false);
    }
  }, [infoHash, manifest]);

  const copySelected = useCallback(async () => {
    const loaded = await loadManifest();
    if (!loaded) return;
    const videos = selectVideoFiles(loaded.files);
    const path = selectedPath ?? (videos.length === 1 ? videos[0].path : null);
    if (!path) {
      setExpanded(true);
      setMessage("Pick a file, then copy its stream URL.");
      return;
    }
    try {
      await copyUrl(path);
    } catch {
      setProblem("generic");
      setMessage("Could not copy the stream URL.");
    }
  }, [copyUrl, loadManifest, selectedPath]);

  const toggleExpanded = useCallback(async () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    void loadManifest();
  }, [expanded, loadManifest]);

  useEffect(() => {
    if (!expanded || !selectedPath) return;
    const controller = new AbortController();
    const path = selectedPath;

    void (async () => {
      setPlayableSrc(null);
      setWaiting(false);
      setCheckingStream(true);
      setProblem(null);
      setMessage(null);
      try {
        const res = await fetch(streamPath(infoHash, path), {
          headers: { Range: "bytes=0-0" },
          signal: controller.signal,
        });
        await res.body?.cancel().catch(() => {});
        if (controller.signal.aborted) return;
        if (res.ok || res.status === 206) {
          setPlayableSrc(streamPath(infoHash, path));
          return;
        }
        const mapped = streamStatusMessage(res.status);
        setProblem(mapped.problem);
        setMessage(mapped.message);
      } catch {
        if (!controller.signal.aborted) {
          setProblem("generic");
          setMessage("Could not check the stream.");
        }
      } finally {
        if (!controller.signal.aborted) setCheckingStream(false);
      }
    })();

    return () => controller.abort();
  }, [expanded, infoHash, selectedPath]);

  const reportNoAudio = useCallback(() => {
    setProblem("no-audio");
    setMessage(
      "This file's audio can't be decoded in a browser (usually Dolby AC-3/E-AC-3 or DTS). The video is fine — open it in your player for sound.",
    );
    setPlayableSrc(null);
  }, []);

  // Safari and Firefox implement audioTracks, so a zero-length track list is a
  // definitive answer as soon as metadata lands.
  const checkAudioTracks = useCallback(
    (video: HTMLVideoElement) => {
      const el = video as AudioTracksVideo;
      if (el.readyState > 0 && "audioTracks" in el && el.audioTracks?.length === 0) {
        reportNoAudio();
      }
    },
    [reportNoAudio],
  );

  // Chrome and Edge only reveal an undecodable audio stream by decoding video
  // bytes while the audio byte counter stays pinned at zero. Wait for real
  // playback progress before believing it: the counters are both 0 before the
  // first frames land, so checking any earlier reports every file as silent.
  const checkDecodedAudio = useCallback(
    (video: HTMLVideoElement) => {
      const el = video as AudioTracksVideo;
      if (typeof el.webkitAudioDecodedByteCount !== "number") return;
      if (typeof el.webkitVideoDecodedByteCount !== "number") return;
      if (el.paused || el.currentTime < 2) return;
      if (el.webkitVideoDecodedByteCount <= 0) return;
      if (el.webkitAudioDecodedByteCount > 0) return;
      reportNoAudio();
    },
    [reportNoAudio],
  );

  return (
    <div
      className={cn("w-full space-y-2", className)}
      data-inline-player
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => void toggleExpanded()}
          aria-expanded={expanded}
          aria-controls={panelId}
          data-stream-play-toggle
        >
          <Play className="h-3.5 w-3.5" />
          {expanded ? "Hide player" : "Play"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => void copySelected()}
          data-stream-copy
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? "Copied" : "Copy stream URL"}
        </Button>
      </div>

      {expanded ? (
        <div
          id={panelId}
          className="rounded-lg border border-[var(--border)] bg-[var(--bg)] p-2.5 space-y-2 motion-safe:animate-[inline-player-expand_140ms_ease-out]"
        >
          <style>{`
            @keyframes inline-player-expand {
              from { opacity: 0; transform: translateY(-4px); }
              to { opacity: 1; transform: translateY(0); }
            }
            @media (prefers-reduced-motion: reduce) {
              [data-inline-player] [id="${panelId}"] { animation: none; }
            }
          `}</style>

          {manifestLoading ? (
            <p className="flex items-center gap-2 text-[12px] text-[var(--text-tertiary)]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Resolving files…
            </p>
          ) : null}

          {videoFiles.length > 1 ? (
            <label className="block space-y-1 text-[11px] text-[var(--text-tertiary)]">
              File
              <select
                value={selectedPath ?? ""}
                onChange={(e) => setSelectedPath(e.target.value || null)}
                className="h-8 w-full rounded-md border border-[var(--border)] bg-[var(--bg-muted)] px-2 text-[12px] text-[var(--text)]"
              >
                <option value="">Pick a video file…</option>
                {videoFiles.map((file) => (
                  <option key={file.index} value={file.path}>
                    {file.path} · {formatBytes(file.length)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          {message ? (
            <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-[var(--text-secondary)]">
              {problem === "browser-error" || problem === "no-audio" ? (
                <X className="h-3.5 w-3.5 text-[var(--danger)]" />
              ) : null}
              <span>{message}</span>
              {selectedPath ? (
                <button
                  type="button"
                  className="font-medium text-[var(--accent-text)] hover:underline"
                  onClick={() => void copySelected()}
                >
                  Open in your player →
                </button>
              ) : null}
            </div>
          ) : null}

          {checkingStream ? (
            <p className="flex items-center gap-2 text-[12px] text-[var(--text-tertiary)]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Checking stream…
            </p>
          ) : null}

          {playableSrc && selectedFile ? (
            <div className="space-y-1.5">
              <video
                key={playableSrc}
                controls
                preload="metadata"
                className="w-full rounded-md bg-black"
                src={playableSrc}
                title={title}
                onError={() => {
                  setProblem("browser-error");
                  setMessage("This release won't play in the browser.");
                  setPlayableSrc(null);
                }}
                onWaiting={() => setWaiting(true)}
                onPlaying={() => setWaiting(false)}
                onCanPlay={() => setWaiting(false)}
                onLoadedMetadata={(e) => checkAudioTracks(e.currentTarget)}
                onLoadedData={(e) => checkAudioTracks(e.currentTarget)}
                onTimeUpdate={(e) => checkDecodedAudio(e.currentTarget)}
              >
                {subtitle ? (
                  <track
                    kind="subtitles"
                    src={streamPath(infoHash, subtitle.path)}
                    label="Sidecar subtitles"
                    default
                  />
                ) : null}
              </video>
              {waiting ? (
                <p className="text-[12px] text-[var(--text-tertiary)] tabular-nums">
                  {bufferingLabel(progress)}
                </p>
              ) : null}
              <p className="text-[11px] text-[var(--text-tertiary)] truncate">
                {selectedFile.path} · {formatBytes(selectedFile.length)}
              </p>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
