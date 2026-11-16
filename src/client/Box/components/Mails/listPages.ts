/**
 * Paged loading for the mail lists (`/headers/:account` and `/unified`).
 *
 * A list's query data stays the flat array of the mails loaded so far. The
 * first request in a session asks for one page; scrolling appends the next
 * page from the server's cursor; a refetch asks again for as many rows as are
 * loaded, so it refreshes the list without shrinking it.
 */

import { MailHeaderData } from "common";
import type { HeadersPageGetResponse } from "server";
import { call } from "client";
import { queryClient } from "../../../lib/queryClient";
import { withoutPendingDeletes } from "./pendingDeletes";

/** Mails asked for per request. */
export const LIST_PAGE_SIZE = 100;

/** Largest refetch, matching the server's cap on `limit`. */
const MAX_REFETCH = 10_000;

interface ListPageState {
  /** Cursor of the next page; null once the last page is loaded. */
  next: string | null;
  /** A request for the next page is in flight. */
  loadingNext: boolean;
  /** The account count the list was last checked against while incomplete. */
  countBaseline?: number;
}

const states = new Map<string, ListPageState>();

const withParams = (url: string, params: Record<string, string>) =>
  url + (url.includes("?") ? "&" : "?") + new URLSearchParams(params).toString();

const requestPage = async (url: string, limit: number, cursor?: string) => {
  const params: Record<string, string> = { limit: String(limit) };
  if (cursor) params.cursor = cursor;
  const { status, body, message } = await call.get<HeadersPageGetResponse>(
    withParams(url, params)
  );
  if (status !== "success" || !body) throw new Error(message);
  return {
    mails: withoutPendingDeletes(body.headers.map((d) => new MailHeaderData(d))),
    next: body.next_cursor
  };
};

/** True while the server has rows after the loaded ones. */
export const hasNextListPage = (url: string) => !!states.get(url)?.next;

/** True once the list has been fetched and every page of it is loaded. */
export const isListComplete = (url: string) => states.get(url)?.next === null;

/**
 * The query function for a paged list: one page on the first request in this
 * session, otherwise as many rows as are already loaded.
 */
export const fetchList = async (url: string): Promise<MailHeaderData[]> => {
  const state = states.get(url);
  const loaded = state
    ? queryClient.getQueryData<MailHeaderData[]>(url)?.length ?? 0
    : 0;
  const limit = Math.min(Math.max(LIST_PAGE_SIZE, loaded), MAX_REFETCH);
  const { mails, next } = await requestPage(url, limit);
  states.set(url, { ...state, next, loadingNext: false });
  return mails;
};

/** Appends the next page to the list's query data. No-op without one or while one loads. */
export const fetchNextListPage = async (url: string): Promise<void> => {
  const state = states.get(url);
  if (!state?.next || state.loadingNext) return;
  state.loadingNext = true;
  try {
    const { mails, next } = await requestPage(url, LIST_PAGE_SIZE, state.next);
    queryClient.setQueryData<MailHeaderData[]>(url, (loaded = []) => {
      const ids = new Set(loaded.map((m) => m.id));
      return [...loaded, ...mails.filter((m) => !ids.has(m.id))];
    });
    state.next = next;
  } finally {
    state.loadingNext = false;
  }
};

/**
 * How many mails the account counts say the list is missing. A complete list
 * is compared with the count directly. An incomplete one is missing rows by
 * design, so only a change in the count since the last check counts as new
 * mail.
 */
export const missingFromList = (
  url: string,
  countInAccounts: number,
  countInList: number
): number => {
  const state = states.get(url);
  if (!state || state.next === null) return countInAccounts - countInList;
  const baseline = state.countBaseline ?? countInAccounts;
  state.countBaseline = countInAccounts;
  return countInAccounts - baseline;
};
