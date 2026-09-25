import { useParams, useSearchParams } from "react-router";
import { TitleDetail } from "@/components/title/title-detail";
import { displayTitleFromWorkKey } from "@/components/title/work-key";
import { useDocumentTitle } from "@/hooks/use-document-title";
import {
  readRememberedSeason,
  REMEMBERED_SEASON_COOKIE_NAME,
} from "@/lib/title/remembered-season";

/**
 * `/title/:workKey` — a page about a title, not a list of releases.
 *
 * The key is enough on its own whenever the work is in the local database. The
 * query string carries what a linking card already knew (`t` title, `y` year,
 * `type` media type) so a title we hold no row for still renders
 * with its real name instead of a heading reverse-engineered from a slug.
 *
 * The Next.js shell read the `tf_season` cookie server-side; here it is read
 * from `document.cookie`. The payload is still one client fetch in TitleDetail.
 */
export default function TitlePage() {
  const { workKey = "" } = useParams<{ workKey: string }>();
  const [sp] = useSearchParams();
  const title =
    sp.get("t")?.trim() || displayTitleFromWorkKey(workKey) || "Title";
  useDocumentTitle(title, `Play or get ${title}.`);

  const rememberedSeason = readRememberedSeason(
    readCookie(REMEMBERED_SEASON_COOKIE_NAME),
    workKey,
  );

  return (
    <TitleDetail
      // A different work is a different page: Next.js re-mounted the dynamic segment.
      key={workKey}
      workKey={workKey}
      title={sp.get("t")}
      year={intOrNull(sp.get("y"))}
      mediaType={sp.get("type")}
      legacySeason={intOrNull(sp.get("s"))}
      provider={sp.get("provider")}
      providerId={sp.get("providerId")}
      sourceType={sp.get("sourceType")}
      format={sp.get("format")}
      seriesHint={sp.get("series")}
      aliases={sp.getAll("alias")}
      rememberedSeason={rememberedSeason}
    />
  );
}

function readCookie(name: string): string | null {
  for (const part of document.cookie.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

function intOrNull(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}
