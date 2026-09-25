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
 * Hosts `next/image` is configured to optimise (`next.config.ts`
 * `images.remotePatterns`).
 *
 * A poster URL can be anything a metadata provider handed us, and `next/image`
 * hard-fails on a host it was not told about — one stray URL would blank a
 * whole rail. So the rule is by *host*, not by rail: known host → optimised
 * `next/image`, anything else → a plain `<img>` that can only ever fail to its
 * own fallback.
 */
/**
 * Hosts `next/image` is allowed to optimise.
 *
 * MUST stay in sync with `remotePatterns` in `next.config.ts`. A host listed
 * here but missing there does not degrade gracefully — `next/image` rejects
 * the request and the poster fails outright. The reverse (there but not here)
 * is safe: the URL simply falls through to a plain `<img>`.
 *
 * Optimising these is not cosmetic. A TVmaze `original_untouched` poster is
 * ~1.3 MB; served raw into a 124px tile a single rail would pull tens of
 * megabytes, which is exactly the load time this product is trying to win.
 */
export const OPTIMIZED_IMAGE_HOSTS = new Set([
  "image.tmdb.org",
  "s4.anilist.co",
  "static.tvmaze.com",
]);

/**
 * iTunes artwork is served from `is1-ssl` … `is5-ssl.mzstatic.com`, and which
 * shard serves a given asset is not stable, so this is matched by suffix
 * rather than enumerated.
 */
export const OPTIMIZED_HOST_SUFFIXES = [".mzstatic.com"];

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
