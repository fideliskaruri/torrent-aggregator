/**
 * Pull a usable magnet URI out of Web Share Target query params.
 *
 * Share payloads are noisy: some apps put the magnet in `url`, others in
 * `text`, sometimes wrapped in prose or a longer message. We accept the first
 * well-formed magnet and ignore everything else.
 */

const MAGNET_RE = /magnet:\?[^\s"'<>]+/i;

/** Decode once; a broken percent-encoding is left as-is so the regex still runs. */
function decodeLoose(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

/**
 * Extract the first magnet URI from share-target `url` / `text` / `title` fields.
 * Returns null when nothing looks like a magnet.
 */
export function magnetFromShare(input: {
  url?: string | null;
  text?: string | null;
  title?: string | null;
}): string | null {
  const chunks = [input.url, input.text, input.title]
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => decodeLoose(v.trim()));

  for (const chunk of chunks) {
    if (/^magnet:\?/i.test(chunk)) {
      return chunk;
    }
    const match = MAGNET_RE.exec(chunk);
    if (match) return match[0];
  }
  return null;
}
