const RELEASE_TOKENS =
  /\b(\d{3,4}p|4k|uhd|hdr(?:10)?\+?|dolby ?vision|x26[45]|h\.?26[45]|hevc|avc|aac(?:5\.1|2\.0)?|ac-?3|e-?ac-?3|ddp?5\.1|dts(?:-hd)?|flac|opus|web-?dl|web-?rip|b[dr]rip|blu-?ray|hdtv|dvdrip|remux|repack|proper|multi|dual ?audio|subbed|dubbed|10 ?bits?|8 ?bits?|amzn|dsnp|hmax|atvp|hulu|pcok|stan|crav|telesync|telecine|hdcam|hdts|screener|dvdscr|workprint|mp4|mkv|avi|m4v|xvid|divx)\b/gi;
const FILE_EXTENSION = /\.(mkv|mp4|avi|m4v|mov|webm|ts|m2ts|mpe?g|iso)$/i;
const SITE_PREFIX = /^\s*(?:\[[^\]]*\]|\([^)]*\)|www\.[^\s]+\s*-)\s*/i;
const BRACKET_GROUP = /\[[^\]]*\]/g;
const PAREN_NOISE = /\((?![^)]*\b(?:19|20)\d{2}\b)[^)]*\)/g;
const TRAILING_GROUP = /\s-[A-Za-z0-9]+$/;
const SIZE_TOKEN = /\b\d+(?:[.,]\d+)?\s?[KMGT]i?B\b/gi;
const TRAILING_SHOUTED_GROUP = /\s+-\s*[A-Z][A-Z0-9]{1,19}$/;
const DOUBLED_SEPARATOR = /\s+-(?:\s*-)+\s*/g;

export function cleanDisplayTitle(raw: string): string {
  const original = raw.trim();
  if (!original) return original;

  let out = original;
  for (let i = 0; i < 3; i++) {
    const next = out.replace(SITE_PREFIX, "");
    if (next === out || !next.trim()) break;
    out = next;
  }
  out = out.replace(FILE_EXTENSION, "");
  const dotSeparated = !/\s/.test(out);
  const beforeTokens = out;
  out = out.replace(RELEASE_TOKENS, " ");
  out = out.replace(SIZE_TOKEN, " ");
  if (dotSeparated) out = out.replace(/[._]+/g, " ");
  out = out.replace(BRACKET_GROUP, " ").replace(PAREN_NOISE, " ");
  out = out.replace(RELEASE_TOKENS, " ");
  const afterTokens = out;
  out = out.replace(SIZE_TOKEN, " ");
  const strippedNoise = afterTokens !== beforeTokens || out !== afterTokens;
  out = out.replace(/\s+/g, " ").trim();
  out = out.replace(DOUBLED_SEPARATOR, " - ").replace(/\s+-\s*$/, "");
  if (dotSeparated) out = out.replace(TRAILING_GROUP, "");
  if (strippedNoise) {
    out = out.replace(TRAILING_SHOUTED_GROUP, "").replace(TRAILING_SHOUTED_GROUP, "");
  }
  out = out
    .replace(/\s+/g, " ")
    .replace(/^[\s._-]+/, "")
    .replace(/[\s._-]+$/, "")
    .trim();
  return out || original;
}
