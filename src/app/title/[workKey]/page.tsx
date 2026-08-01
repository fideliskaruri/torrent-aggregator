import type { Metadata } from "next";
import { TitleDetail } from "@/components/title/title-detail";
import { displayTitleFromWorkKey } from "@/components/title/work-key";

export const dynamic = "force-dynamic";

interface TitlePageProps {
  params: Promise<{ workKey: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * `/title/[workKey]` — a page about a title, not a list of releases.
 *
 * The key is enough on its own whenever the work is in the local database. The
 * query string carries what a linking card already knew (`t` title, `y` year,
 * `type` media type, `s` season) so a title we hold no row for still renders
 * with its real name instead of a heading reverse-engineered from a slug.
 *
 * A thin server shell: the payload is one client fetch of local state, which
 * keeps a season change from being a full navigation and keeps this page out
 * of the request path of anything slow.
 */
export async function generateMetadata({
  params,
  searchParams,
}: TitlePageProps): Promise<Metadata> {
  const { workKey } = await params;
  const sp = await searchParams;
  const title =
    firstValue(sp.t)?.trim() || displayTitleFromWorkKey(workKey) || "Title";
  return {
    title,
    description: `Play or get ${title}.`,
  };
}

export default async function TitlePage({
  params,
  searchParams,
}: TitlePageProps) {
  const { workKey } = await params;
  const sp = await searchParams;

  return (
    <TitleDetail
      workKey={workKey}
      title={firstValue(sp.t) ?? null}
      year={intOrNull(firstValue(sp.y))}
      mediaType={firstValue(sp.type) ?? null}
      season={intOrNull(firstValue(sp.s))}
      provider={firstValue(sp.provider) ?? null}
      providerId={firstValue(sp.providerId) ?? null}
      sourceType={firstValue(sp.sourceType) ?? null}
      format={firstValue(sp.format) ?? null}
      seriesHint={firstValue(sp.series) ?? null}
      aliases={allValues(sp.alias)}
    />
  );
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function allValues(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

function intOrNull(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}
