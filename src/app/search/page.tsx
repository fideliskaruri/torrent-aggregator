import { redirect } from "next/navigation";

interface SearchRedirectProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * Legacy /search URLs redirect to home with the same query string.
 * Results render on `/` next to the main search bar.
 */
export default async function SearchRedirectPage({
  searchParams,
}: SearchRedirectProps) {
  const params = await searchParams;
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const v of value) qs.append(key, v);
    } else {
      qs.set(key, value);
    }
  }
  const q = qs.toString();
  redirect(q ? `/?${q}` : "/");
}
