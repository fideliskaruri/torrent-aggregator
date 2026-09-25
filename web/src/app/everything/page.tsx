import { Navigate, useSearchParams } from "react-router";
import { legacyEverythingRedirectUrl } from "@/lib/search/work-search";

/** Compatibility for old bookmarks; discovery now has one title-first home. */
export default function EverythingPage() {
  const [params] = useSearchParams();
  const q = params.get("q")?.trim() ?? "";
  const scope = (params.get("scope")?.trim() ?? "").toLowerCase();
  return <Navigate replace to={legacyEverythingRedirectUrl(scope, q)} />;
}
