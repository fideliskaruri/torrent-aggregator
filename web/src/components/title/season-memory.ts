import {
  isValidSeason,
  nextRememberedSeasonCookieValue,
  readRememberedSeason,
  REMEMBERED_SEASON_COOKIE_NAME,
} from "@/lib/title/remembered-season";

export function writeRememberedSeasonCookie(workKey: string, season: number): void {
  const current = readCookieRaw(REMEMBERED_SEASON_COOKIE_NAME);
  const next = nextRememberedSeasonCookieValue(current, workKey, season);
  if (next == null) return;
  const oneYearSeconds = 60 * 60 * 24 * 365;
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${REMEMBERED_SEASON_COOKIE_NAME}=${next}; Path=/; Max-Age=${oneYearSeconds}; SameSite=Lax${secure}`;
}

export function readRememberedSeasonFromDocument(workKey: string): number | null {
  return readRememberedSeason(
    readCookieRaw(REMEMBERED_SEASON_COOKIE_NAME),
    workKey,
  );
}

function readCookieRaw(name: string): string | null {
  const prefix = `${name}=`;
  for (const part of document.cookie.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length);
  }
  return null;
}

export function readLegacySeasonFromLocation(): number | null {
  const raw = new URL(window.location.href).searchParams.get("s");
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return isValidSeason(parsed) ? parsed : null;
}

export function removeLegacySeasonFromLocation(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("s")) return;
  url.searchParams.delete("s");
  const query = url.searchParams.toString();
  window.history.replaceState(
    window.history.state,
    "",
    `${url.pathname}${query ? `?${query}` : ""}${url.hash}`,
  );
}
