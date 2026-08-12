/**
 * Strip common torrent noise from titles to improve metadata matching.
 *
 * Kept in a dependency-free module because both server metadata enrichment and
 * client-side release grouping need it. Importing the server enrichment module
 * from a client hook pulls Prisma into the browser bundle.
 */
export function cleanTorrentTitle(title: string): string {
  return title
    .replace(/[\[\(].*?[\]\)]/g, " ")
    .replace(
      /\b(S\d{1,2}\s*-\s*S?\d{1,2}|S\d{1,2}E\d{1,3}(?:\s*-\s*E?\d{1,3})?|S\d{1,2}|E\d{1,3}|EP?\s*\d{1,3}|Season\s*\d+|Complete|Batch)\b/gi,
      " ",
    )
    .replace(
      /\b(1080p|720p|480p|2160p|4K|UHD|HDR10?\+?|DV|HEVC|x265|x264|H\.?26[45]|AV1|WEB-?DL|WEBRip|BluRay|BDRip|BRRip|DVDRip|HDTV|REMUX|PROPER|REPACK|FINAL|INTERNAL|LIMITED|AAC\d?|FLAC|DTS(?:-HD)?|DDP?\d?(?:\.\d)?|EAC3|AC3|Atmos|TrueHD|\d+bit|Dual|Multi|Sub|Dub|NF|AMZN|DSNP|HULU|HMAX|ATVP|iP|CR)\b/gi,
      " ",
    )
    .replace(/[._\-–—|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
