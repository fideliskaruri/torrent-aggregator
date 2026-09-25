/**
 * Browser media capability descriptor.
 *
 * The client sends this on every playback plan request so the server never
 * guesses. The union of canPlayType + MSE + MediaCapabilities lets us know
 * whether the browser can handle a container/codec pair natively, or whether
 * we need to remux/transcode.
 */

/** One container+codec combination the browser can decode. */
export type CodecEntry = {
  /** Full MIME, e.g. 'video/mp4; codecs="hvc1.1.6.L93.B0"' */
  mime: string;
  /** canPlayType result: 'probably' | 'maybe' | '' */
  canPlay: string;
  /** MediaSource.isTypeSupported result */
  mse: boolean;
};

export type ClientCapabilities = {
  /** User-agent string (informational) */
  ua?: string;
  /** Codec support list — what the browser told us it can handle */
  codecs: CodecEntry[];
  /**
   * Whether the browser supports MSE (MediaSource Extensions) at all.
   * Needed for HLS.js which requires MSE.
   */
  mseSupported: boolean;
};

/** Conservative fallback: assume only H.264+AAC in MP4 via MSE. */
export const DEFAULT_CAPABILITIES: ClientCapabilities = {
  codecs: [
    { mime: 'video/mp4; codecs="avc1.640028,mp4a.40.2"', canPlay: "probably", mse: true },
    { mime: 'video/mp4; codecs="avc1.640028"', canPlay: "probably", mse: true },
    { mime: 'audio/mp4; codecs="mp4a.40.2"', canPlay: "probably", mse: true },
  ],
  mseSupported: true,
};

/**
 * Split a MIME into its container family and its RFC 6381 codec tags.
 *
 * `video/mp4` and `audio/mp4` are the same *decoder* family — a codec the
 * browser accepts in one it accepts in the other — so they collapse to `mp4`.
 */
export function parseMime(mime: string): { family: string; tags: string[] } {
  const [head, ...params] = mime.toLowerCase().split(";");
  const subtype = head.trim().split("/")[1] ?? "";
  const family = subtype.replace(/^x-/, "");
  const codecsParam = params
    .map((p) => p.trim())
    .find((p) => p.startsWith("codecs="));
  const raw = codecsParam ? codecsParam.slice("codecs=".length).replace(/^"|"$/g, "") : "";
  const tags = raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  return { family, tags };
}

/**
 * Has the browser attested that it can decode this single codec tag under MSE?
 *
 * The client can only probe a finite list of MIME strings, but the questions the
 * decision engine needs to ask are combinatorial (every video tag × every audio
 * tag). Treating capability as a property of the *codec tag* rather than of the
 * exact probed string is the rule; matching whole strings was an accident of
 * whichever combinations happened to be in the probe list, and silently forced a
 * needless transcode for any pairing that wasn't.
 *
 * Only positive evidence counts, and only from the same container family: a tag
 * appearing in a mime the browser rejected says nothing on its own, because the
 * rejection may have been caused by a different tag in the same string.
 */
export function supportsCodecTag(
  caps: ClientCapabilities,
  tag: string,
  family = "mp4",
): boolean {
  const wanted = tag.toLowerCase();
  return caps.codecs.some((c) => {
    if (!c.mse || c.canPlay === "") return false;
    const parsed = parseMime(c.mime);
    return parsed.family === family && parsed.tags.includes(wanted);
  });
}

/**
 * Check whether the browser claims support for a given MIME type under MSE.
 * This is the gate that matters: direct <video src> can sometimes "play" things
 * MSE rejects, but the HLS.js path needs MSE.
 *
 * Falls back to per-tag attestation when the exact combination was not probed
 * (see `supportsCodecTag`).
 */
export function canDecodeViaMSE(caps: ClientCapabilities, mime: string): boolean {
  const lower = mime.toLowerCase();
  const exact = caps.codecs.some(
    (c) => c.mime.toLowerCase() === lower && c.mse && c.canPlay !== "",
  );
  if (exact) return true;

  // An exact "no" is authoritative — the browser was asked this precise
  // question and said no (this is how `video/x-matroska` stays unsupported).
  const explicitlyRejected = caps.codecs.some(
    (c) => c.mime.toLowerCase() === lower && (!c.mse || c.canPlay === ""),
  );
  if (explicitlyRejected) return false;

  const { family, tags } = parseMime(lower);
  if (tags.length === 0) return false;
  return tags.every((tag) => supportsCodecTag(caps, tag, family));
}

/**
 * Check whether the browser can natively play a MIME type (direct <video src>).
 * canPlayType "probably" or "maybe" both count.
 */
export function canPlayNatively(caps: ClientCapabilities, mime: string): boolean {
  const lower = mime.toLowerCase();
  return caps.codecs.some(
    (c) => c.mime.toLowerCase() === lower && c.canPlay !== "",
  );
}

/** Container families the browser can ingest directly. */
export function supportsContainer(caps: ClientCapabilities, container: string): boolean {
  const lc = container.toLowerCase();
  if (lc === "mp4" || lc === "mov") {
    return caps.codecs.some((c) => {
      const m = c.mime.toLowerCase();
      return (m.startsWith("video/mp4") || m.startsWith("audio/mp4")) && c.mse;
    });
  }
  if (lc === "webm") {
    return caps.codecs.some((c) => c.mime.toLowerCase().startsWith("video/webm") && c.mse);
  }
  // MKV (matroska) is never MSE-compatible even when the codecs inside are.
  if (lc === "matroska" || lc === "mkv") return false;
  // TS can work under MSE but not progressive in most browsers.
  if (lc === "mpegts" || lc === "ts") return false;
  return false;
}

/**
 * Build the codec MIME string for an fMP4 container with the given video+audio.
 * This is what we ask MSE about when planning a remux.
 */
export function fmp4Mime(
  videoCodec: string | null,
  audioCodec: string | null,
  videoProfile?: string | null,
): string {
  const parts: string[] = [];
  if (videoCodec) parts.push(videoCodecTag(videoCodec, videoProfile ?? null));
  if (audioCodec) parts.push(audioCodecTag(audioCodec));
  if (parts.length === 0) return "video/mp4";
  return `video/mp4; codecs="${parts.join(",")}"`;
}

/**
 * Map probe video codec + profile to an RFC 6381 codec tag.
 *
 * The profile matters: a 10-bit HEVC stream is Main 10 (profile 2, tag
 * `hvc1.2.4.*`), and asking MSE about the 8-bit Main tag for a Main 10 stream
 * is asking the wrong question. Every 10-bit HDR x265 release hits this path.
 */
export function videoCodecTag(codec: string, profile: string | null = null): string {
  const lc = codec.toLowerCase();
  const prof = profile?.toLowerCase() ?? "";
  if (lc === "h264" || lc === "avc1" || lc === "avc") return "avc1.640028";
  if (lc === "hevc" || lc === "h265" || lc === "hvc1" || lc === "hev1") {
    // "Main 10", "Main 10 Intra", "Rext" 10-bit variants all need profile 2.
    const isTenBit = prof.includes("10") || prof.includes("rext");
    return isTenBit ? "hvc1.2.4.L120.B0" : "hvc1.1.6.L93.B0";
  }
  if (lc === "av1") return "av01.0.05M.08";
  if (lc === "vp9") return "vp09.00.10.08";
  if (lc === "vp8") return "vp8";
  return lc;
}

/** Map probe audio codec names to approximate codec string tags. */
export function audioCodecTag(codec: string): string {
  const lc = codec.toLowerCase();
  if (lc === "aac" || lc === "mp4a") return "mp4a.40.2";
  if (lc === "ac3" || lc === "ac-3") return "ac-3";
  if (lc === "eac3" || lc === "ec-3" || lc === "e-ac-3") return "ec-3";
  if (lc === "opus") return "opus";
  if (lc === "flac") return "flac";
  if (lc === "vorbis") return "vorbis";
  if (lc === "mp3" || lc === "mp2") return "mp4a.40.34";
  return lc;
}

/**
 * Validate and parse capabilities from a request body.
 * Returns DEFAULT_CAPABILITIES when input is absent or malformed.
 */
export function parseCapabilities(body: unknown): ClientCapabilities {
  if (!body || typeof body !== "object") return DEFAULT_CAPABILITIES;
  const obj = body as Record<string, unknown>;

  const codecs: CodecEntry[] = [];
  if (Array.isArray(obj.codecs)) {
    for (const entry of obj.codecs) {
      if (
        entry &&
        typeof entry === "object" &&
        typeof (entry as Record<string, unknown>).mime === "string" &&
        typeof (entry as Record<string, unknown>).canPlay === "string" &&
        typeof (entry as Record<string, unknown>).mse === "boolean"
      ) {
        codecs.push({
          mime: (entry as Record<string, unknown>).mime as string,
          canPlay: (entry as Record<string, unknown>).canPlay as string,
          mse: (entry as Record<string, unknown>).mse as boolean,
        });
      }
    }
  }

  const mseSupported =
    typeof obj.mseSupported === "boolean" ? obj.mseSupported : codecs.length > 0;

  if (codecs.length === 0) return DEFAULT_CAPABILITIES;

  return {
    ua: typeof obj.ua === "string" ? obj.ua : undefined,
    codecs,
    mseSupported,
  };
}
