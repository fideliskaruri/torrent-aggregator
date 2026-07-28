import type { SearchResponse } from "@/lib/torrents/types";

/** Fetch enough ranked results that scrolling feels like a flow, not a teaser. */
export const DEFAULT_PAGE_SIZE = 200;

export interface SearchQueryInput {
  query: string;
  page: number;
  pageSize: number;
  category?: string;
  minSeeders?: string;
  releaseKind?: string;
  resolution?: string;
  codec?: string;
  maxSizeGb?: string;
  sources?: string;
  refresh?: boolean;
}

/**
 * Build the `/api/search` query string for a single page fetch.
 *
 * `page`/`pageSize` are always sent so the server returns the matching ranked
 * slice — the ordering is decided server-side, so paging never re-ranks.
 */
export function buildSearchQuery(input: SearchQueryInput): string {
  const params = new URLSearchParams({
    q: input.query,
    page: String(input.page),
    pageSize: String(input.pageSize),
  });
  if (input.category && input.category !== "all")
    params.set("category", input.category);
  if (input.minSeeders) params.set("minSeeders", input.minSeeders);
  if (input.releaseKind) params.set("releaseKind", input.releaseKind);
  if (input.resolution) params.set("resolution", input.resolution);
  if (input.codec) params.set("codec", input.codec);
  if (input.maxSizeGb) {
    const bytes = Math.round(parseFloat(input.maxSizeGb) * 1e9);
    if (Number.isFinite(bytes)) params.set("maxSize", String(bytes));
  }
  if (input.sources) params.set("sources", input.sources);
  if (input.refresh) params.set("refresh", "1");
  return params.toString();
}

export interface ResultPageView {
  totalCount: number;
  totalPages: number;
  currentPage: number;
  pageSize: number;
  rangeStart: number;
  rangeEnd: number;
  /** "1–200 of 305" style label, or "0 results" when empty. */
  label: string;
}

type PageViewData = Pick<
  SearchResponse,
  "totalCount" | "totalPages" | "page" | "pageSize" | "results"
>;

/**
 * Derive the "X–Y of Z" view-model rendered in the toolbar and pagination bar.
 *
 * The server response is the source of truth for `page`/`pageSize`/`totalCount`;
 * `requestedPage`/`fallbackPageSize` only cover the first render before a
 * response has arrived.
 */
export function resultPageView(
  data: PageViewData | null,
  requestedPage: number,
  fallbackPageSize: number,
): ResultPageView {
  const pageSize = data?.pageSize ?? fallbackPageSize;
  const totalCount = data?.totalCount ?? data?.results.length ?? 0;
  const totalPages = data?.totalPages ?? 0;
  const currentPage = data?.page ?? requestedPage;
  const rangeStart =
    totalCount === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const rangeEnd = Math.min(currentPage * pageSize, totalCount);
  const label =
    totalCount === 0
      ? "0 results"
      : `${rangeStart}\u2013${rangeEnd} of ${totalCount}`;
  return {
    totalCount,
    totalPages,
    currentPage,
    pageSize,
    rangeStart,
    rangeEnd,
    label,
  };
}
