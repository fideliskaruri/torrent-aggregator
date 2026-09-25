import { useDocumentTitle } from "@/hooks/use-document-title";

/** Same content as the default Next.js 404 page, rendered inside the app shell. */
export function NotFoundPage() {
  useDocumentTitle("404: This page could not be found.");
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center text-center">
      <div className="flex items-center">
        <h1 className="mr-5 border-r border-[var(--border-strong)] pr-6 text-2xl font-medium leading-[49px]">
          404
        </h1>
        <h2 className="text-sm font-normal leading-[49px]">This page could not be found.</h2>
      </div>
    </div>
  );
}
