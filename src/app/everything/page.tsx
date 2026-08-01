import { redirect } from "next/navigation";
import { legacyEverythingRedirectUrl } from "@/lib/search/work-search";

interface EverythingPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
}

/** Compatibility for old bookmarks; discovery now has one title-first home. */
export default async function EverythingPage({
  searchParams,
}: EverythingPageProps) {
  const params = await searchParams;
  const q = first(params.q);
  const scope = first(params.scope).toLowerCase();
  redirect(legacyEverythingRedirectUrl(scope, q));
}
