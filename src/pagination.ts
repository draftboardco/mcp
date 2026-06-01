import type { PaginatedResponse } from "./types.js";

export interface PageResult<T> {
  items: T[];
  /** Total matched items reported by the API (may exceed what was fetched). */
  total: number;
  /** True if a cap stopped us before exhausting all pages. */
  truncated: boolean;
  pagesFetched: number;
}

/**
 * Fetch successive pages until `nextPage === 0`, the item cap is reached, or the
 * page cap is hit. Bounded by design so an outcome tool can never run away.
 */
export async function fetchAllPages<R extends PaginatedResponse, T>(
  fetchPage: (pageNumber: number) => Promise<R>,
  extract: (response: R) => T[],
  opts: { resultPerPage?: number; maxItems?: number; maxPages?: number } = {},
): Promise<PageResult<T>> {
  const maxItems = opts.maxItems ?? 500;
  const maxPages = opts.maxPages ?? 20;
  const items: T[] = [];
  let total = 0;
  let pagesFetched = 0;
  let pageNumber = 1;
  let truncated = false;

  for (;;) {
    const response = await fetchPage(pageNumber);
    pagesFetched += 1;
    const pageItems = extract(response) ?? [];
    if (typeof response.count === "number") total = response.count;
    items.push(...pageItems);

    const next = response.nextPage ?? 0;
    const morePages = next > 0 && next !== pageNumber;

    // Check "no more pages" BEFORE the caps: a final page that lands exactly on a
    // cap is complete, not truncated.
    if (!morePages) break;
    if (items.length >= maxItems) {
      truncated = true;
      break;
    }
    if (pagesFetched >= maxPages) {
      truncated = true;
      break;
    }
    pageNumber = next;
  }

  // If the API reports more total than we actually collected, we're truncated.
  if (total > items.length) truncated = true;

  return { items, total: total || items.length, truncated, pagesFetched };
}
