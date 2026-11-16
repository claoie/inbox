import { isUuid } from "common";
import type { ListCursor } from "server";

/** Largest page one request may ask for — the size the unpaged list returns. */
export const MAX_PAGE_SIZE = 10_000;

export interface ListPageResponse<T> {
  /** Pass back as `?cursor=` for the rows after these; null on the last page. */
  next_cursor: string | null;
  headers: T[];
}

// `timestamptz::text`, e.g. `2026-11-15 02:55:04.123456+00`.
const PG_TIMESTAMPTZ_TEXT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2}){0,2}$/;

export const encodeListCursor =(cursor: ListCursor | null): string | null =>
  cursor ? Buffer.from(JSON.stringify(cursor)).toString("base64url") : null;

const decodeListCursor = (value: string): ListCursor | null => {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString());
    if (!parsed || typeof parsed !== "object") return null;
    const { date, id } = parsed as Record<string, unknown>;
    if (typeof date !== "string" || !PG_TIMESTAMPTZ_TEXT.test(date)) return null;
    if (!isUuid(id)) return null;
    return { date, id };
  } catch {
    return null;
  }
};

export type ListPageParams =
  | { paged: false }
  | { paged: true; limit: number; after?: ListCursor }
  | { error: string };

/**
 * Reads `?limit=` and `?cursor=`. Without `limit` the route answers with the
 * whole list as before; with it, one page and the cursor of the next.
 */
export const parseListPageParams = (query: Record<string, unknown>): ListPageParams => {
  const { limit, cursor } = query;
  if (limit === undefined) {
    return cursor === undefined
      ? { paged: false }
      : { error: "`cursor` needs `limit`." };
  }
  const size = typeof limit === "string" && /^\d+$/.test(limit) ? Number(limit) : NaN;
  if (!(size >= 1 && size <= MAX_PAGE_SIZE)) {
    return { error: `Invalid \`limit\` parameter: expected 1-${MAX_PAGE_SIZE}.` };
  }
  if (cursor === undefined) return { paged: true, limit: size };
  const after = typeof cursor === "string" ? decodeListCursor(cursor) : null;
  if (!after) return { error: "Invalid `cursor` parameter." };
  return { paged: true, limit: size, after };
};
