import type { ReactNode } from "react";
import type { ApiQueryState } from "@/hooks/use-api-query";
import { useStableLoading } from "@/components/ui/use-stable-loading";
import { TfErrorState } from "@/components/tf/error-state";

/** What the boundary reads from a query. `useApiQuery`'s result fits as is. */
export type PageQuery<T> = Pick<ApiQueryState<T>, "data" | "loading" | "error" | "refetch"> & {
  refreshing?: boolean;
};

/**
 * The one loading, error and empty shell for a page or panel that shows a
 * query.
 *
 * - Nothing yet: the page's own skeleton, shown only past the short delay and
 *   then held long enough not to flash (`useStableLoading`).
 * - Failed with nothing on screen: `TfErrorState` with Try again. Never the
 *   empty state: we did not find out whether there is anything.
 * - Failed on a refresh: the data stays, with the error and Try again above it.
 * - Loaded and empty: the page's `TfEmptyState`.
 * - Otherwise: the children.
 */
export function PageQueryBoundary<T>({
  query,
  skeleton,
  errorTitle,
  refreshErrorTitle,
  errorMessage,
  isEmpty = defaultIsEmpty,
  empty,
  children,
  frame = (node) => node,
}: {
  query: PageQuery<T>;
  /** The page's own skeleton shape. `visible` is false during the show delay. */
  skeleton: (visible: boolean) => ReactNode;
  errorTitle: string;
  /** Title when a refresh failed over data already on screen. */
  refreshErrorTitle?: string;
  /** Rewrites the error text, e.g. to add what the page keeps safe. */
  errorMessage?: (error: string) => string;
  isEmpty?: (data: T) => boolean;
  empty?: ReactNode;
  children: (data: T) => ReactNode;
  /** Wraps the error and empty views when they stand in for the whole page. */
  frame?: (node: ReactNode, kind: "error" | "empty") => ReactNode;
}) {
  const { data, loading, error, refetch, refreshing = false } = query;
  const pending = loading && data == null && !error;
  const showSkeleton = useStableLoading(pending);

  if (pending) return <>{skeleton(showSkeleton)}</>;

  const errorView = error ? (
    <TfErrorState
      title={data == null ? errorTitle : (refreshErrorTitle ?? errorTitle)}
      message={errorMessage ? errorMessage(error) : error}
      onRetry={refetch}
      retrying={refreshing}
    />
  ) : null;

  // A signed-out 401 settles with no data and no error: that is empty.
  if (data == null) return <>{frame(errorView ?? empty ?? null, errorView ? "error" : "empty")}</>;
  if (isEmpty(data) && empty != null) {
    return <>{frame(errorView ?? empty, errorView ? "error" : "empty")}</>;
  }
  return (
    <>
      {errorView}
      {children(data)}
    </>
  );
}

function defaultIsEmpty(data: unknown): boolean {
  return Array.isArray(data) && data.length === 0;
}
