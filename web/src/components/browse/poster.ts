/**
 * Poster presentation helpers.
 *
 * Torrent releases usually have no artwork at all, so the no-poster case is the
 * common case, not the error case. A broken-image glyph is unacceptable; every
 * card without art gets a deterministic tinted tile with the title's initial,
 * which looks intentional in a grid and never shifts layout.
 *
 * Pure and DOM-free: `browse-ui.test.ts` drives it as a table.
 */

/**
 * Known metadata-provider image hosts. Posters from these hosts render with
 * the fill/priority treatment; anything else gets a plain `<img>` that can
 * only ever fail to its own fallback.
 */
const OPTIMIZED_IMAGE_HOSTS = new Set([
  "image.tmdb.org",
  "s4.anilist.co",
  "static.tvmaze.com",
]);

/**
 * iTunes artwork is served from `is1-ssl` … `is5-ssl.mzstatic.com`, and which
 * shard serves a given asset is not stable, so this is matched by suffix
 * rather than enumerated.
 */
const OPTIMIZED_HOST_SUFFIXES = [".mzstatic.com"];

export function isOptimizableImageUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    if (OPTIMIZED_IMAGE_HOSTS.has(parsed.hostname)) return true;
    return OPTIMIZED_HOST_SUFFIXES.some((suffix) =>
      parsed.hostname.endsWith(suffix),
    );
  } catch {
    // Relative or malformed URLs are served as-is by a plain <img>.
    return false;
  }
}

/** The letter drawn on a missing poster. Never blank. */
export function posterInitial(title: string): string {
  for (const char of title.trim()) {
    if (/[\p{L}\p{N}]/u.test(char)) return char.toUpperCase();
  }
  return "?";
}

/**
 * Tints for the no-poster tile, mixed from design tokens so the palette stays
 * inside the theme — no raw hex, and no decorative gradient.
 */
const POSTER_TINTS = [
  "color-mix(in srgb, var(--accent) 12%, var(--bg-muted))",
  "color-mix(in srgb, var(--info) 14%, var(--bg-muted))",
  "color-mix(in srgb, var(--success) 11%, var(--bg-muted))",
  "color-mix(in srgb, var(--danger) 11%, var(--bg-muted))",
  "color-mix(in srgb, var(--accent-text) 9%, var(--bg-muted))",
  "var(--bg-muted)",
] as const;

/**
 * A stable tint per title, so the same show keeps the same tile between renders
 * and between visits. Order in the rail must not change what a card looks like.
 */
export function posterTint(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return POSTER_TINTS[hash % POSTER_TINTS.length];
}
